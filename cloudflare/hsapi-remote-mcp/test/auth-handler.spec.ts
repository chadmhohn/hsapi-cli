import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";
import { downstreamAuthRequestError } from "../src/auth-handler";
import type { RuntimeConfig } from "../src/types";

const config: RuntimeConfig = {
  environment: "test",
  publicOrigin: "https://mcp.example.com",
  publicHostname: "mcp.example.com",
  resourceUrl: "https://mcp.example.com/mcp",
  callbackUrl: "https://mcp.example.com/hubspot/callback",
  allowedOriginHostnames: ["mcp.example.com"],
  mcpAccessTokenTtlSeconds: 900,
  remoteWritesEnabled: false,
  hubSpotRequireUserLevel: true,
  brokerUrl: "https://hsapi-oauth.groundworkrevops.com",
  hubSpotClientId: "12345678-1234-4234-8234-123456789012",
  hubSpotRequiredScopes: ["oauth"],
  hubSpotOptionalScopes: ["crm.objects.contacts.read"],
  hubSpotAppScopeCeiling: ["oauth", "crm.objects.contacts.read"],
  stateEncryptionKey: "test-only-state-key-that-is-long-enough",
};

function authRequest(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    responseType: "code",
    clientId: "mcp-client",
    redirectUri: "https://client.example/callback",
    scope: ["hsapi.read"],
    state: "downstream-state",
    codeChallenge: "A".repeat(43),
    codeChallengeMethod: "S256",
    resource: config.resourceUrl,
    ...overrides,
  };
}

describe("downstream OAuth authorization validation", () => {
  it("requires a complete S256 PKCE challenge", () => {
    expect(downstreamAuthRequestError(authRequest(), config)).toBeUndefined();
    expect(downstreamAuthRequestError(authRequest({ codeChallenge: undefined }), config)).toBe("invalid_request");
    expect(downstreamAuthRequestError(authRequest({ codeChallengeMethod: "plain" }), config)).toBe("invalid_request");
    expect(downstreamAuthRequestError(authRequest({ codeChallenge: "A".repeat(42) }), config)).toBe("invalid_request");
    expect(downstreamAuthRequestError(authRequest({ codeChallenge: `${"A".repeat(42)}~` }), config)).toBe("invalid_request");
  });

  it("requires exactly the advertised MCP resource audience", () => {
    expect(downstreamAuthRequestError(authRequest({ resource: undefined }), config)).toBe("invalid_request");
    expect(downstreamAuthRequestError(authRequest({ resource: "https://mcp.example.com/" }), config)).toBe("invalid_request");
    expect(downstreamAuthRequestError(authRequest({ resource: [config.resourceUrl] }), config)).toBe("invalid_request");
  });

  it("rejects unknown, duplicate, and disabled downstream scopes", () => {
    expect(downstreamAuthRequestError(authRequest({ scope: [] }), config)).toBe("invalid_scope");
    expect(downstreamAuthRequestError(authRequest({ scope: ["hsapi.read", "unknown"] }), config)).toBe("invalid_scope");
    expect(downstreamAuthRequestError(authRequest({ scope: ["hsapi.read", "hsapi.read"] }), config)).toBe("invalid_scope");
    expect(downstreamAuthRequestError(authRequest({ scope: ["hsapi.write"] }), config)).toBe("invalid_scope");
    expect(downstreamAuthRequestError(
      authRequest({ scope: ["hsapi.read", "hsapi.write"] }),
      { ...config, remoteWritesEnabled: true },
    )).toBeUndefined();
  });
});
