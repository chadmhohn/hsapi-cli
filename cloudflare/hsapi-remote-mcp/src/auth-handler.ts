import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { AuthorizationStateConsumeResult } from "./authorization-state";
import { opaqueUserId, randomToken, sha256Base64Url } from "./crypto";
import {
  allowedMcpScopes,
  BrokerOAuthError,
  createUpstreamPkce,
  exchangeBrokerSession,
  HUBSPOT_AUTHORIZATION_ORIGIN,
  revokeBrokerGrant,
  startBrokerSession,
} from "./hubspot-oauth";
import { readConfig } from "./config";
import { REMOTE_CAPABILITY_REVISION } from "./remote-policy";
import type { ConsentRecord, HandlerEnv, HubSpotGrantProps, UpstreamStateRecord } from "./types";

const CONSENT_TTL_SECONDS = 10 * 60;
const FLOW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

type AuthorizationStage = "consent" | "upstream";
type SameSite = "Lax" | "None";

interface FlowCookieNames {
  lax: string;
  partitioned: string;
}

type UpstreamConsumeResult = AuthorizationStateConsumeResult | { status: "proof_missing" };

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlResponse(body: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": DEFAULT_HTML_CSP,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function consentContentSecurityPolicy(request: AuthRequest, brokerOrigin: string): string {
  const formActionSources = new Set(["'self'", HUBSPOT_AUTHORIZATION_ORIGIN, brokerOrigin]);
  try {
    const redirectOrigin = new URL(request.redirectUri).origin;
    if (redirectOrigin !== "null") formActionSources.add(redirectOrigin);
  } catch {
    // parseAuthRequest and the registered-client lookup validate redirectUri;
    // keep the fixed fail-closed sources if a future provider behaves differently.
  }
  return `default-src 'none'; style-src 'unsafe-inline'; form-action ${[...formActionSources].join(" ")}; frame-ancestors 'none'; base-uri 'none'`;
}

function cookieHeader(
  name: string,
  value: string,
  sameSite: SameSite,
  partitioned: boolean,
  maxAge = CONSENT_TTL_SECONDS,
): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=${sameSite}${partitioned ? "; Partitioned" : ""}`;
}

function clearCookieHeader(name: string, sameSite: SameSite, partitioned: boolean): string {
  return cookieHeader(name, "", sameSite, partitioned, 0);
}

function requestCookieValues(request: Request, name: string): string[] {
  const source = request.headers.get("cookie") ?? "";
  const values: string[] = [];
  for (const part of source.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      values.push(decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      // A malformed cookie is never considered a valid browser proof.
    }
  }
  return values;
}

function redirect(location: string, status = 302, cookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status, headers });
}

function oauthErrorRedirect(
  request: AuthRequest,
  error: string,
  status = 302,
  cookies: string[] = [],
): Response {
  const target = new URL(request.redirectUri);
  target.searchParams.set("error", error);
  if (request.state) target.searchParams.set("state", request.state);
  return redirect(target.href, status, cookies);
}

function logAuthorizationRejection(stage: AuthorizationStage, reason: string): void {
  console.warn(JSON.stringify({ event: `oauth_${stage}_rejected`, reason }));
}

function authorizationExpired(stage: AuthorizationStage, reason: string): Response {
  logAuthorizationRejection(stage, reason);
  const heading = stage === "consent" ? "Authorization expired" : "OAuth state expired";
  return htmlResponse(`<h1>${heading}</h1><p>Return to your MCP client and start again.</p>`, 400);
}

async function upstreamCookieNames(sessionId: string): Promise<FlowCookieNames> {
  const suffix = await sha256Base64Url(`upstream-cookie:${sessionId}`);
  return {
    lax: `__Host-hsapi_upstream_lax_${suffix}`,
    partitioned: `__Host-hsapi_upstream_partitioned_${suffix}`,
  };
}

function setUpstreamCookieHeaders(names: FlowCookieNames, browserBinding: string): string[] {
  return [
    cookieHeader(names.lax, browserBinding, "Lax", false),
    cookieHeader(names.partitioned, browserBinding, "None", true),
  ];
}

function clearUpstreamCookieHeaders(names: FlowCookieNames): string[] {
  return [
    clearCookieHeader(names.lax, "Lax", false),
    clearCookieHeader(names.partitioned, "None", true),
  ];
}

function validAuthRequest(value: unknown): value is AuthRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AuthRequest>;
  return candidate.responseType === "code"
    && typeof candidate.clientId === "string"
    && typeof candidate.redirectUri === "string"
    && Array.isArray(candidate.scope)
    && candidate.scope.every((scope) => typeof scope === "string")
    && typeof candidate.state === "string"
    && typeof candidate.codeChallenge === "string"
    && typeof candidate.codeChallengeMethod === "string"
    && typeof candidate.resource === "string";
}

export function downstreamAuthRequestError(
  request: AuthRequest,
  config: ReturnType<typeof readConfig>,
): "invalid_request" | "invalid_scope" | undefined {
  if (
    request.responseType !== "code"
    || !request.clientId
    || !request.redirectUri
    || !request.state
    || request.state.length > 2048
    || /[\u0000-\u001f\u007f]/.test(request.state)
    || request.codeChallengeMethod !== "S256"
    || typeof request.codeChallenge !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge)
    || typeof request.resource !== "string"
    || request.resource !== config.resourceUrl
  ) return "invalid_request";

  const supported = new Set(["hsapi.read", ...(config.remoteWritesEnabled ? ["hsapi.write"] : [])]);
  if (
    request.scope.length === 0
    || new Set(request.scope).size !== request.scope.length
    || request.scope.some((scope) => !supported.has(scope))
  ) return "invalid_scope";
  return undefined;
}

function parseConsentRecord(value: string | null | undefined): ConsentRecord | undefined {
  if (!value) return undefined;
  try {
    const record = JSON.parse(value) as ConsentRecord;
    if (record.version !== 1 || !Number.isSafeInteger(record.createdAtMs) || !validAuthRequest(record.request)) return undefined;
    return record;
  } catch {
    return undefined;
  }
}

function parseUpstreamStateRecord(value: string | null | undefined): UpstreamStateRecord | undefined {
  if (!value) return undefined;
  try {
    const record = JSON.parse(value) as UpstreamStateRecord;
    if (
      record.version !== 1
      || !Number.isSafeInteger(record.createdAtMs)
      || !/^[A-Za-z0-9_-]{43}$/.test(record.sessionId)
      || !/^[A-Za-z0-9_-]{43,128}$/.test(record.consumeSecret)
      || !/^[A-Za-z0-9._~-]{43,128}$/.test(record.codeVerifier)
      || !validAuthRequest(record.request)
    ) return undefined;
    return record;
  } catch {
    return undefined;
  }
}

function clientDisplayName(client: ClientInfo | null, clientId: string): string {
  const name = client && typeof client.clientName === "string" ? client.clientName.trim() : "";
  return (name || `MCP client ${clientId.slice(0, 12)}`).slice(0, 160);
}

async function authorizationStateStub(env: HandlerEnv, kind: "consent" | "upstream", id: string) {
  return env.AUTHORIZATION_STATE.getByName(`${kind}:${await sha256Base64Url(id)}`);
}

async function storeAuthorizationState(
  env: HandlerEnv,
  kind: "consent" | "upstream",
  id: string,
  record: ConsentRecord | UpstreamStateRecord,
  proofHash: string,
): Promise<boolean> {
  const stub = await authorizationStateStub(env, kind, id);
  return stub.create(JSON.stringify(record), proofHash, record.createdAtMs + CONSENT_TTL_SECONDS * 1000);
}

async function consumeAuthorizationState(
  env: HandlerEnv,
  kind: "consent" | "upstream",
  id: string,
  proofHash: string,
): Promise<AuthorizationStateConsumeResult> {
  const stub = await authorizationStateStub(env, kind, id);
  return stub.consumeIfProof(proofHash);
}

function renderConsent(
  clientName: string,
  request: AuthRequest,
  writesEnabled: boolean,
  consentId: string,
  csrf: string,
): string {
  const scopes = request.scope.map((scope) => {
    const description = scope === "hsapi.read"
      ? "Read the HubSpot records and account metadata allowed by this connection."
      : scope === "hsapi.write"
        ? writesEnabled
          ? "Create or update explicitly supported HubSpot records after a separate mutation confirmation."
          : "Write access was requested, but this deployment currently has remote writes disabled."
        : "This requested permission is not supported and will not be granted.";
    return `<li><code>${escapeHtml(scope)}</code><br><span>${escapeHtml(description)}</span></li>`;
  }).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize HSAPI</title><style>
body{font-family:system-ui,sans-serif;max-width:44rem;margin:4rem auto;padding:0 1.25rem;color:#17202a}main{border:1px solid #d8dee4;border-radius:12px;padding:1.5rem}code{font-weight:650}li{margin:.8rem 0}.actions{display:flex;gap:.75rem;margin-top:1.5rem}button{border:0;border-radius:8px;padding:.7rem 1rem;font-weight:650;cursor:pointer}.approve{background:#ff7a59;color:#111}.deny{background:#e8ebef;color:#222}.note{color:#57606a;font-size:.92rem}</style></head>
<body><main><h1>Connect ${escapeHtml(clientName)} to HubSpot</h1>
<p>The connector will open HubSpot so you can choose an account. The remote service never accepts a ServiceKey or private-app token.</p>
<ul>${scopes || "<li>No MCP permissions were requested.</li>"}</ul>
<p class="note">The MCP client receives an HSAPI token, not your HubSpot access token. Mutations remain preview-first.</p>
<p class="note">After authorization, you will return to the registered MCP redirect URI: <code>${escapeHtml(request.redirectUri)}</code></p>
<form method="post" action="/authorize"><input type="hidden" name="consentId" value="${escapeHtml(consentId)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<div class="actions"><button class="approve" name="action" value="approve" type="submit">Continue to HubSpot</button>
<button class="deny" name="action" value="deny" type="submit">Cancel</button></div></form></main></body></html>`;
}

export async function authorizeGet(request: Request, env: HandlerEnv): Promise<Response> {
  const config = readConfig(env);
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch {
    return htmlResponse("<h1>Invalid OAuth authorization request</h1>", 400);
  }
  if (downstreamAuthRequestError(oauthRequest, config)) {
    return htmlResponse("<h1>Invalid OAuth authorization request</h1><p>Return to your MCP client and start again with S256 PKCE and the advertised MCP resource.</p>", 400);
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) return htmlResponse("<h1>Unknown MCP client</h1>", 400);

  const consentId = randomToken();
  const csrf = randomToken();
  const record: ConsentRecord = {
    version: 1,
    createdAtMs: Date.now(),
    request: oauthRequest,
  };
  if (!await storeAuthorizationState(env, "consent", consentId, record, await sha256Base64Url(csrf))) {
    return htmlResponse("<h1>Authorization temporarily unavailable</h1><p>Return to your MCP client and try again.</p>", 503);
  }
  return htmlResponse(
    renderConsent(clientDisplayName(client, oauthRequest.clientId), oauthRequest, config.remoteWritesEnabled, consentId, csrf),
    200,
    {
      // Fetch serializes a basic form POST's Origin as `null` under
      // `no-referrer`. `strict-origin` preserves the tuple Origin for this
      // HTTPS form POST while sending only the origin as Referer.
      "referrer-policy": "strict-origin",
      // Chromium applies form-action to redirect targets. Permit only the
      // validated HubSpot and broker origins plus this client's registered
      // redirect origin in addition to the same-origin consent POST.
      "content-security-policy": consentContentSecurityPolicy(oauthRequest, config.brokerUrl),
    },
  );
}

function exactFormValue(form: FormData, name: "consentId" | "csrf" | "action"): string | undefined {
  const values = form.getAll(name);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : undefined;
}

function exactConsentForm(form: FormData): { consentId: string; csrf: string; action: "approve" | "deny" } | undefined {
  const keys = [...form.keys()];
  if (keys.length !== 3 || keys.some((key) => !["consentId", "csrf", "action"].includes(key))) return undefined;
  const consentId = exactFormValue(form, "consentId");
  const csrf = exactFormValue(form, "csrf");
  const action = exactFormValue(form, "action");
  if (!consentId || !csrf || (action !== "approve" && action !== "deny")) return undefined;
  return { consentId, csrf, action };
}

export async function authorizePost(
  request: Request,
  env: HandlerEnv,
  brokerFetcher: typeof fetch = fetch,
): Promise<Response> {
  const config = readConfig(env);
  if (request.headers.get("origin") !== config.publicOrigin) {
    logAuthorizationRejection("consent", "origin_mismatch");
    return htmlResponse("<h1>Invalid authorization request</h1>", 400);
  }
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  const contentLength = Number(request.headers.get("content-length"));
  if (mediaType !== "application/x-www-form-urlencoded" || (Number.isFinite(contentLength) && contentLength > 16_384)) {
    logAuthorizationRejection("consent", "invalid_content_type_or_length");
    return htmlResponse("<h1>Invalid authorization request</h1>", 400);
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    logAuthorizationRejection("consent", "invalid_form_encoding");
    return htmlResponse("<h1>Invalid authorization request</h1>", 400);
  }
  const submitted = exactConsentForm(form);
  if (!submitted) return authorizationExpired("consent", "invalid_form_fields");
  if (!FLOW_TOKEN_PATTERN.test(submitted.consentId) || !FLOW_TOKEN_PATTERN.test(submitted.csrf)) {
    return authorizationExpired("consent", "invalid_form_proof");
  }

  const consumed = await consumeAuthorizationState(
    env,
    "consent",
    submitted.consentId,
    await sha256Base64Url(submitted.csrf),
  );
  if (consumed.status !== "consumed") return authorizationExpired("consent", `state_${consumed.status}`);
  const record = parseConsentRecord(consumed.payload);
  if (!record || Date.now() - record.createdAtMs > CONSENT_TTL_SECONDS * 1000) {
    return authorizationExpired("consent", "state_invalid");
  }
  if (submitted.action === "deny") return oauthErrorRedirect(record.request, "access_denied", 303);

  const requestError = downstreamAuthRequestError(record.request, config);
  if (requestError) return oauthErrorRedirect(record.request, requestError, 303);
  if (!allowedMcpScopes(record.request, config).length) return oauthErrorRedirect(record.request, "invalid_scope", 303);
  const browserBinding = randomToken();
  const consumeSecret = randomToken(48);
  const pkce = await createUpstreamPkce();
  let session;
  try {
    session = await startBrokerSession(
      pkce.challenge,
      await sha256Base64Url(consumeSecret),
      config,
      brokerFetcher,
    );
  } catch (error) {
    console.warn(JSON.stringify({
      event: "broker_session_start_failed",
      code: error instanceof BrokerOAuthError ? error.code : "unexpected_error",
    }));
    return oauthErrorRedirect(record.request, "server_error", 303);
  }
  const upstreamRecord: UpstreamStateRecord = {
    version: 1,
    createdAtMs: Date.now(),
    sessionId: session.sessionId,
    consumeSecret,
    codeVerifier: pkce.verifier,
    request: record.request,
  };
  if (!await storeAuthorizationState(
    env,
    "upstream",
    session.sessionId,
    upstreamRecord,
    await sha256Base64Url(browserBinding),
  )) {
    return oauthErrorRedirect(record.request, "server_error", 303);
  }
  const cookieNames = await upstreamCookieNames(session.sessionId);
  return redirect(
    session.authorizationUrl,
    303,
    setUpstreamCookieHeaders(cookieNames, browserBinding),
  );
}

async function consumeUpstreamState(
  request: Request,
  env: HandlerEnv,
  state: string,
  names: FlowCookieNames,
): Promise<UpstreamConsumeResult> {
  const candidates: string[] = [];
  for (const name of [names.lax, names.partitioned]) {
    const values = requestCookieValues(request, name);
    if (values.length === 1 && FLOW_TOKEN_PATTERN.test(values[0] ?? "")) candidates.push(values[0]!);
  }
  const uniqueCandidates = [...new Set(candidates)];
  if (!uniqueCandidates.length) return { status: "proof_missing" };

  let lastResult: AuthorizationStateConsumeResult = { status: "proof_mismatch" };
  for (const candidate of uniqueCandidates) {
    lastResult = await consumeAuthorizationState(env, "upstream", state, await sha256Base64Url(candidate));
    if (lastResult.status !== "proof_mismatch") return lastResult;
  }
  return lastResult;
}

export async function hubSpotCallback(
  request: Request,
  env: HandlerEnv,
  brokerFetcher: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  if (url.searchParams.getAll("state").length !== 1 || !FLOW_TOKEN_PATTERN.test(state)) {
    logAuthorizationRejection("upstream", "invalid_state_parameter");
    return htmlResponse("<h1>Invalid OAuth state</h1>", 400);
  }
  const cookieNames = await upstreamCookieNames(state);
  const consumed = await consumeUpstreamState(request, env, state, cookieNames);
  if (consumed.status !== "consumed") return authorizationExpired("upstream", `state_${consumed.status}`);
  const record = parseUpstreamStateRecord(consumed.payload);
  if (
    !record
    || record.sessionId !== state
    || Date.now() - record.createdAtMs > CONSENT_TTL_SECONDS * 1000
  ) return authorizationExpired("upstream", "state_invalid");
  const clearedCookies = clearUpstreamCookieHeaders(cookieNames);
  const oauthErrors = url.searchParams.getAll("error");
  const completionGrants = url.searchParams.getAll("completion_grant");
  if (oauthErrors.length === 1 && oauthErrors[0] && completionGrants.length === 0) {
    return oauthErrorRedirect(record.request, "access_denied", 302, clearedCookies);
  }
  const completionGrant = completionGrants.length === 1 ? completionGrants[0] : "";
  if (oauthErrors.length !== 0 || !completionGrant || !/^[A-Za-z0-9_-]{43,128}$/.test(completionGrant)) {
    return oauthErrorRedirect(record.request, "server_error", 302, clearedCookies);
  }

  const config = readConfig(env);
  let props: HubSpotGrantProps | undefined;
  try {
    props = await exchangeBrokerSession(
      record.sessionId,
      completionGrant,
      record.consumeSecret,
      record.codeVerifier,
      config,
      brokerFetcher,
    );
    const grantedScopes = allowedMcpScopes(record.request, config);
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: record.request,
      userId: await opaqueUserId(config.stateEncryptionKey, props.hubId, props.userId),
      metadata: { provider: "hubspot", capabilityRevision: "2026-07-29.1" },
      scope: grantedScopes,
      props,
      revokeExistingGrants: true,
    });
    return redirect(redirectTo, 302, clearedCookies);
  } catch (error) {
    if (props) {
      try {
        await revokeBrokerGrant(props, config, brokerFetcher);
      } catch (cleanupError) {
        console.warn(JSON.stringify({
          event: "broker_completion_revoke_failed",
          code: cleanupError instanceof BrokerOAuthError ? cleanupError.code : "unexpected_error",
        }));
      }
    }
    const event = error instanceof BrokerOAuthError ? error.code : "authorization_completion_failed";
    console.warn(JSON.stringify({ event: "hubspot_authorization_failed", code: event }));
    return oauthErrorRedirect(record.request, "server_error", 302, clearedCookies);
  }
}

export class DefaultHandler extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const env = this.env as HandlerEnv;
    const url = new URL(request.url);
    if (url.pathname === "/authorize" && request.method === "GET") return authorizeGet(request, env);
    if (url.pathname === "/authorize" && request.method === "POST") return authorizePost(request, env);
    if (url.pathname === "/hubspot/callback" && request.method === "GET") return hubSpotCallback(request, env);
    if (url.pathname === "/healthz" && request.method === "GET") {
      const config = readConfig(env);
      return Response.json({
        ok: true,
        service: "hsapi-remote-mcp",
        protocolVersion: "2026-07-28",
        capabilityRevision: REMOTE_CAPABILITY_REVISION,
        remoteWritesEnabled: config.remoteWritesEnabled,
        environment: config.environment,
      });
    }
    if (url.pathname === "/" && request.method === "GET") {
      return Response.json({
        name: "HSAPI Remote MCP",
        mcp: new URL("/mcp", url.origin).href,
        authorization: "OAuth 2.1 with HubSpot upstream OAuth",
        serviceKeyAccepted: false,
      }, { headers: { "cache-control": "no-store" } });
    }
    return new Response("Not found.", { status: 404 });
  }
}
