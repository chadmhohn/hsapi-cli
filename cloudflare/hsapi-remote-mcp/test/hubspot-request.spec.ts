import { describe, expect, it, vi } from "vitest";
import {
  confirmationBinding,
  executeHubSpotRequest,
  RemoteExecutionError,
  requestPreview,
  requestUrl,
} from "../src/hubspot-request";
import type { HubSpotAccessProps, RemoteRequestPlan } from "../src/types";

const props: HubSpotAccessProps = {
  version: 1,
  accessToken: "upstream-hubspot-token",
  accessTokenExpiresAtMs: Date.now() + 600_000,
  hubId: 123,
  userId: 456,
  scopes: ["crm.objects.contacts.read"],
  isUserLevel: true,
  clientId: "12345678-1234-4234-8234-123456789012",
  mcpClientId: "downstream-mcp-client",
  mcpScopes: ["hsapi.read"],
  mcpAccessTokenExpiresAtMs: Date.now() + 600_000,
};

function plan(overrides: Partial<RemoteRequestPlan> = {}): RemoteRequestPlan {
  return {
    endpointId: "objects.list",
    family: "crm",
    method: "GET",
    path: "/crm/objects/2026-03/contacts",
    query: { after: ["10"], limit: ["25"] },
    risk: "read",
    readOnlyPost: false,
    requiredHubSpotScopes: ["crm.objects.contacts.read"],
    downstreamScope: "hsapi.read",
    feature: "crm",
    ...overrides,
  };
}

describe("HubSpot request execution boundary", () => {
  it("pins the origin and emits only a redacted preview", () => {
    expect(requestUrl(plan())).toBe("https://api.hubapi.com/crm/objects/2026-03/contacts?after=10&limit=25");
    const preview = requestPreview(plan());
    expect(preview.authorization).toBe("HubSpot OAuth bearer [REDACTED]");
    expect(JSON.stringify(preview)).not.toContain(props.accessToken);
  });

  it("sends only the upstream HubSpot token and does not expose downstream auth", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ results: [] }, {
      headers: { "x-hubspot-correlation-id": "corr-123" },
    })) as unknown as typeof fetch;

    const response = await executeHubSpotRequest(plan(), props, fetcher);
    expect(response).toMatchObject({ ok: true, status: 200, correlationId: "corr-123" });
    const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/api\.hubapi\.com\//);
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer upstream-hubspot-token");
    expect(JSON.stringify(init)).not.toContain(props.mcpClientId);
  });

  it("rejects redirects and oversized responses", async () => {
    const redirectFetcher = vi.fn().mockResolvedValue(new Response("", {
      status: 302,
      headers: { location: "https://attacker.example/token" },
    })) as unknown as typeof fetch;
    await expect(executeHubSpotRequest(plan(), props, redirectFetcher)).rejects.toMatchObject({
      code: "unexpected_redirect",
    });

    const largeFetcher = vi.fn().mockResolvedValue(new Response("small", {
      headers: { "content-length": String(1024 * 1024 + 1) },
    })) as unknown as typeof fetch;
    await expect(executeHubSpotRequest(plan(), props, largeFetcher)).rejects.toMatchObject({
      code: "response_too_large",
    });

    const streamedLargeResponse = new Response("x".repeat(1024 * 1024 + 1));
    streamedLargeResponse.headers.delete("content-length");
    const streamedLargeFetcher = vi.fn().mockResolvedValue(streamedLargeResponse) as unknown as typeof fetch;
    await expect(executeHubSpotRequest(plan(), props, streamedLargeFetcher)).rejects.toMatchObject({
      code: "response_too_large",
    });
  });

  it("retries reads but never retries a mutation", async () => {
    let retryBodyCancelled = false;
    const retryBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("busy"));
      },
      cancel() {
        retryBodyCancelled = true;
      },
    });
    const readFetcher = vi.fn()
      .mockResolvedValueOnce(new Response(retryBody, { status: 503, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(Response.json({ results: [] })) as unknown as typeof fetch;
    await executeHubSpotRequest(plan(), props, readFetcher);
    expect(readFetcher).toHaveBeenCalledTimes(2);
    expect(retryBodyCancelled).toBe(true);

    const writeFetcher = vi.fn().mockResolvedValue(new Response("busy", { status: 503 })) as unknown as typeof fetch;
    const response = await executeHubSpotRequest(plan({
      endpointId: "objects.create",
      method: "POST",
      risk: "mutation",
      readOnlyPost: false,
      downstreamScope: "hsapi.write",
      body: { properties: { email: "person@example.com" } },
    }), props, writeFetcher);
    expect(writeFetcher).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(503);
  });

  it("binds mutation confirmation to account, user, policy revision, and exact request", () => {
    const binding = confirmationBinding(plan({
      endpointId: "objects.create",
      method: "POST",
      risk: "mutation",
      downstreamScope: "hsapi.write",
    }), props, "revision-1");
    expect(binding).toMatchObject({
      revision: "revision-1",
      hubId: 123,
      userId: 456,
      endpointId: "objects.create",
      family: "crm",
      risk: "mutation",
      downstreamScope: "hsapi.write",
    });
    expect(binding).not.toHaveProperty("accessToken");
  });
});
