import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Worker public surface", () => {
  it("serves minimal, no-store service metadata", async () => {
    const response = await SELF.fetch("http://localhost:8787/");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      name: "HSAPI Remote MCP",
      mcp: "http://localhost:8787/mcp",
      authorization: "OAuth 2.1 with HubSpot upstream OAuth",
      serviceKeyAccepted: false,
    });
  });

  it("advertises the current protocol version on health checks", async () => {
    const response = await SELF.fetch("http://localhost:8787/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      service: "hsapi-remote-mcp",
      protocolVersion: "2026-07-28",
      capabilityRevision: "2026-07-30.5",
      remoteWritesEnabled: true,
      environment: "local",
    });
  });

  it("rejects requests whose URL origin does not match the configured canonical origin", async () => {
    const response = await SELF.fetch("https://attacker.example/healthz");
    expect(response.status).toBe(421);
  });

  it("rejects an invalid MCP bearer before the request reaches a tool handler", async () => {
    const response = await SELF.fetch("http://localhost:8787/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer invalid-test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata");
  });
});
