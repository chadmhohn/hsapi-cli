import type { HubSpotAccessProps, RemoteRequestPlan } from "./types";

const HUBSPOT_API_ORIGIN = "https://api.hubapi.com";
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class RemoteExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RemoteExecutionError";
    this.code = code;
  }
}

export function requestUrl(plan: RemoteRequestPlan): string {
  const url = new URL(plan.path, HUBSPOT_API_ORIGIN);
  for (const key of Object.keys(plan.query).sort()) {
    for (const value of plan.query[key]) url.searchParams.append(key, value);
  }
  if (url.origin !== HUBSPOT_API_ORIGIN || !url.pathname.startsWith("/")) {
    throw new RemoteExecutionError("invalid_request_target", "The catalog request target is invalid.");
  }
  if (url.href.length > 8192) throw new RemoteExecutionError("request_url_too_large", "The request URL exceeds the remote limit.");
  return url.href;
}

export function requestPreview(plan: RemoteRequestPlan): Record<string, unknown> {
  return {
    endpointId: plan.endpointId,
    method: plan.method,
    url: requestUrl(plan),
    ...(plan.body !== undefined ? { body: plan.body } : {}),
    risk: plan.risk,
    readOnlyPost: plan.readOnlyPost,
    requiredHubSpotScopes: plan.requiredHubSpotScopes,
    downstreamScope: plan.downstreamScope,
    authorization: "HubSpot OAuth bearer [REDACTED]",
  };
}

export function confirmationBinding(plan: RemoteRequestPlan, props: HubSpotAccessProps, revision: string): Record<string, unknown> {
  return {
    revision,
    hubId: props.hubId,
    userId: props.userId,
    mcpClientId: props.mcpClientId,
    mcpAccessTokenExpiresAtMs: props.mcpAccessTokenExpiresAtMs,
    endpointId: plan.endpointId,
    family: plan.family,
    method: plan.method,
    path: plan.path,
    query: plan.query,
    body: plan.body ?? null,
    risk: plan.risk,
    readOnlyPost: plan.readOnlyPost,
    requiredHubSpotScopes: plan.requiredHubSpotScopes,
    downstreamScope: plan.downstreamScope,
  };
}

function isRetryable(plan: RemoteRequestPlan): boolean {
  return plan.method === "GET" || plan.method === "HEAD" || (plan.method === "POST" && plan.readOnlyPost);
}

function retryDelayMs(response: Response): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) return Math.min(Number(retryAfter) * 1000, 2000);
  return 250;
}

async function readLimitedBody(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    try {
      await response.body?.cancel();
    } catch {
      // The declared size is already sufficient to reject the response.
    }
    throw new RemoteExecutionError("response_too_large", "HubSpot returned more than the 1 MiB remote response limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RemoteExecutionError("response_too_large", "HubSpot returned more than the 1 MiB remote response limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A failed retry response is discarded regardless of stream state.
  }
}

function responseData(response: Response, text: string): unknown {
  if (!text) return null;
  if ((response.headers.get("content-type") ?? "").toLowerCase().includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      return { parseError: true, text };
    }
  }
  return { text };
}

function safeCorrelationId(response: Response): string | null {
  const value = response.headers.get("x-hubspot-correlation-id") ?? response.headers.get("x-request-id");
  return value && /^[A-Za-z0-9._:-]{1,160}$/.test(value) ? value : null;
}

export async function executeHubSpotRequest(
  plan: RemoteRequestPlan,
  props: HubSpotAccessProps,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  if ((plan.method === "GET" || plan.method === "HEAD") && plan.body !== undefined) {
    throw new RemoteExecutionError("body_not_allowed", `${plan.method} requests cannot include a body.`);
  }
  const body = plan.body === undefined ? undefined : JSON.stringify(plan.body);
  let response: Response | undefined;
  const attempts = isRetryable(plan) ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      response = await fetcher(requestUrl(plan), {
        method: plan.method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${props.accessToken}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(25_000),
      });
    } catch {
      if (attempt + 1 >= attempts) throw new RemoteExecutionError("hubspot_unavailable", "HubSpot is temporarily unavailable.");
      continue;
    }
    if (attempt + 1 < attempts && [429, 502, 503, 504].includes(response.status)) {
      await cancelResponseBody(response);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response!)));
      continue;
    }
    break;
  }
  if (!response) throw new RemoteExecutionError("hubspot_unavailable", "HubSpot is temporarily unavailable.");
  if (response.status >= 300 && response.status < 400) {
    await cancelResponseBody(response);
    throw new RemoteExecutionError("unexpected_redirect", "HubSpot returned an unexpected redirect.");
  }
  const text = await readLimitedBody(response);
  return {
    ok: response.ok,
    status: response.status,
    endpointId: plan.endpointId,
    correlationId: safeCorrelationId(response),
    data: responseData(response, text),
  };
}
