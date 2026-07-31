import { GrantType, type TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it, vi } from "vitest";
import {
  exchangeBrokerSession,
  handleTokenExchange,
  refreshHubSpotGrant,
  revokeBrokerGrant,
  startBrokerSession,
  toAccessProps,
} from "../src/hubspot-oauth";
import type { HubSpotGrantProps, RuntimeConfig } from "../src/types";

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
  brokerUrl: "https://remote-oauth.example.com",
  hubSpotClientId: "12345678-1234-4234-8234-123456789012",
  hubSpotRequiredScopes: ["oauth"],
  hubSpotOptionalScopes: ["crm.objects.contacts.read"],
  hubSpotAppScopeCeiling: ["oauth", "crm.objects.contacts.read"],
  stateEncryptionKey: "test-only-state-key-that-is-long-enough",
};

const sessionId = "S".repeat(43);
const completionGrant = "G".repeat(43);
const consumeSecret = "K".repeat(64);
const codeVerifier = "V".repeat(64);
const brokerCredential = `v1.${"B".repeat(43)}`;

function authorizationUrl(codeChallenge: string): string {
  const url = new URL("https://app.hubspot.com/oauth/authorize");
  url.searchParams.set("client_id", config.hubSpotClientId);
  url.searchParams.set("redirect_uri", `${config.brokerUrl}/v1/oauth/callback`);
  url.searchParams.set("scope", config.hubSpotRequiredScopes.join(" "));
  url.searchParams.set("optional_scope", config.hubSpotOptionalScopes.join(" "));
  url.searchParams.set("state", sessionId);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}

function brokerTokenResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    accessToken: "upstream-access-token",
    refreshToken: "upstream-refresh-token",
    brokerCredential,
    expiresIn: 1800,
    hubId: 12345,
    userId: 67890,
    scopes: ["oauth", "crm.objects.contacts.read"],
    clientId: config.hubSpotClientId,
    isUserLevel: true,
    hubDomain: "example.hubspot.com",
    ...overrides,
  });
}

const currentGrant: HubSpotGrantProps = {
  version: 1,
  accessToken: "old-access",
  refreshToken: "old-refresh",
  brokerCredential: `v1.${"C".repeat(43)}`,
  accessTokenExpiresAtMs: Date.now() + 1_000,
  hubId: 12345,
  userId: 67890,
  hubDomain: "example.hubspot.com",
  scopes: ["oauth", "crm.objects.contacts.read"],
  effectiveScopes: ["oauth", "crm.objects.contacts.read"],
  isUserLevel: true,
  clientId: config.hubSpotClientId,
};

function tokenExchangeOptions(props: HubSpotGrantProps): TokenExchangeCallbackOptions {
  return {
    grantType: GrantType.REFRESH_TOKEN,
    clientId: "downstream-client",
    userId: "opaque-user",
    grantId: "downstream-grant",
    scope: ["hsapi.read"],
    requestedScope: ["hsapi.read"],
    props,
  };
}

describe("broker-backed HubSpot OAuth boundary", () => {
  it("starts a public broker session with exact remote callback, scope subset, and PKCE proofs", async () => {
    const challenge = "C".repeat(43);
    const consumeHash = "H".repeat(43);
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      sessionId,
      brokerRole: "remote",
      authorizationUrl: authorizationUrl(challenge),
      expiresIn: 600,
      interval: 1,
    }, { status: 201 })) as unknown as typeof fetch;

    const session = await startBrokerSession(challenge, consumeHash, config, fetcher);
    expect(session).toMatchObject({ sessionId, expiresIn: 600, interval: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe(`${config.brokerUrl}/v1/oauth/sessions`);
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({
      codeChallenge: challenge,
      consumeSecretHash: consumeHash,
      completionRedirectUri: config.callbackUrl,
      optionalScopes: config.hubSpotOptionalScopes,
    });
  });

  it("rejects a local-role broker before opening HubSpot authorization", async () => {
    const challenge = "C".repeat(43);
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      sessionId,
      brokerRole: "local",
      authorizationUrl: authorizationUrl(challenge),
      expiresIn: 600,
      interval: 1,
    }, { status: 201 })) as unknown as typeof fetch;

    await expect(
      startBrokerSession(challenge, "H".repeat(43), config, fetcher),
    ).rejects.toMatchObject({
      code: "invalid_broker_session_response",
      status: 502,
    });
  });

  it("rejects a broker authorization URL that does not match the configured HubSpot client", async () => {
    const challenge = "C".repeat(43);
    const tampered = new URL(authorizationUrl(challenge));
    tampered.searchParams.set("client_id", "87654321-1234-4234-8234-123456789012");
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      sessionId,
      brokerRole: "remote",
      authorizationUrl: tampered.href,
      expiresIn: 600,
      interval: 1,
    }, { status: 201 })) as unknown as typeof fetch;

    await expect(startBrokerSession(challenge, "H".repeat(43), config, fetcher)).rejects.toMatchObject({
      code: "invalid_broker_session_response",
      status: 502,
    });
  });

  it("rejects duplicate authorization scopes that substitute for a configured scope", async () => {
    const challenge = "C".repeat(43);
    const tampered = new URL(authorizationUrl(challenge));
    tampered.searchParams.set("scope", "oauth oauth");
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      sessionId,
      brokerRole: "remote",
      authorizationUrl: tampered.href,
      expiresIn: 600,
      interval: 1,
    }, { status: 201 })) as unknown as typeof fetch;

    await expect(startBrokerSession(challenge, "H".repeat(43), {
      ...config,
      hubSpotRequiredScopes: ["oauth", "crm.objects.companies.read"],
    }, fetcher)).rejects.toMatchObject({ code: "invalid_broker_session_response" });
  });

  it("rejects duplicate single-valued authorization URL parameters", async () => {
    const challenge = "C".repeat(43);
    const tampered = new URL(authorizationUrl(challenge));
    tampered.searchParams.append("code_challenge_method", "S256");
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      sessionId,
      brokerRole: "remote",
      authorizationUrl: tampered.href,
      expiresIn: 600,
      interval: 1,
    }, { status: 201 })) as unknown as typeof fetch;

    await expect(startBrokerSession(challenge, "H".repeat(43), config, fetcher)).rejects.toMatchObject({
      code: "invalid_broker_session_response",
    });
  });

  it("exchanges the one-time completion grant through the broker without URL secrets", async () => {
    const fetcher = vi.fn().mockResolvedValue(brokerTokenResponse()) as unknown as typeof fetch;

    const grant = await exchangeBrokerSession(sessionId, completionGrant, consumeSecret, codeVerifier, config, fetcher);
    expect(grant).toMatchObject({
      hubId: 12345,
      userId: 67890,
      brokerCredential,
      isUserLevel: true,
      clientId: config.hubSpotClientId,
    });
    const [requestUrl, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe(`${config.brokerUrl}/v1/oauth/sessions/${sessionId}/exchange`);
    expect(requestUrl).not.toContain(completionGrant);
    expect(requestUrl).not.toContain(consumeSecret);
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${consumeSecret}`);
    expect(JSON.parse(String(init.body))).toEqual({ codeVerifier, completionGrant });
  });

  it("refreshes with expected account binding and accepts rotated broker credentials", async () => {
    const fetcher = vi.fn().mockResolvedValue(brokerTokenResponse({
      refreshToken: "rotated-refresh",
      brokerCredential: `v1.${"R".repeat(43)}`,
    })) as unknown as typeof fetch;

    const refreshed = await refreshHubSpotGrant(currentGrant, config, fetcher);
    expect(refreshed.refreshToken).toBe("rotated-refresh");
    expect(refreshed.brokerCredential).toBe(`v1.${"R".repeat(43)}`);
    const [requestUrl, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe(`${config.brokerUrl}/v1/oauth/tokens/refresh`);
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({
      refreshToken: currentGrant.refreshToken,
      brokerCredential: currentGrant.brokerCredential,
      expectedHubId: String(currentGrant.hubId),
    });
  });

  it("preserves the prior optional hub domain when a refresh omits it", async () => {
    const fetcher = vi.fn().mockResolvedValue(brokerTokenResponse({ hubDomain: undefined })) as unknown as typeof fetch;
    await expect(refreshHubSpotGrant(currentGrant, config, fetcher)).resolves.toMatchObject({
      hubDomain: currentGrant.hubDomain,
      hubId: currentGrant.hubId,
      userId: currentGrant.userId,
    });
  });

  it("revokes a rotated token when refresh identity continuity fails", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(brokerTokenResponse({ userId: 99999 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 })) as unknown as typeof fetch;

    await expect(refreshHubSpotGrant(currentGrant, config, fetcher)).rejects.toMatchObject({
      code: "hubspot_refresh_identity_changed",
      status: 403,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [revokeUrl, revokeInit] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[1] as [string, RequestInit];
    expect(revokeUrl).toBe(`${config.brokerUrl}/v1/oauth/tokens/revoke`);
    expect(JSON.parse(String(revokeInit.body))).toEqual({
      refreshToken: "upstream-refresh-token",
      brokerCredential,
    });
  });

  it("requires user-level broker identity and compensates by revoking a rejected grant", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(brokerTokenResponse({ isUserLevel: false }))
      .mockResolvedValueOnce(new Response(null, { status: 204 })) as unknown as typeof fetch;

    await expect(exchangeBrokerSession(sessionId, completionGrant, consumeSecret, codeVerifier, config, fetcher)).rejects.toMatchObject({
      code: "hubspot_user_level_token_required",
      status: 403,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("accepts a valid broker token response larger than 64 KiB", async () => {
    const fetcher = vi.fn().mockResolvedValue(brokerTokenResponse({ padding: "x".repeat(70 * 1024) })) as unknown as typeof fetch;
    await expect(exchangeBrokerSession(sessionId, completionGrant, consumeSecret, codeVerifier, config, fetcher)).resolves.toMatchObject({
      hubId: 12345,
      userId: 67890,
    });
  });

  it("bounds streamed broker responses at 1 MiB even without content length", async () => {
    const response = new Response(JSON.stringify({ padding: "x".repeat(1024 * 1024) }), {
      headers: { "content-type": "application/json" },
    });
    response.headers.delete("content-length");
    const fetcher = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;

    await expect(exchangeBrokerSession(sessionId, completionGrant, consumeSecret, codeVerifier, config, fetcher)).rejects.toMatchObject({
      code: "broker_response_too_large",
      status: 502,
    });
  });

  it("rejects a token that omits a configured required scope and revokes it", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(brokerTokenResponse({ scopes: ["crm.objects.contacts.read"] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 })) as unknown as typeof fetch;

    await expect(exchangeBrokerSession(sessionId, completionGrant, consumeSecret, codeVerifier, config, fetcher)).rejects.toMatchObject({
      code: "hubspot_required_scope_missing",
      status: 403,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves broker-approved retained scopes but attenuates them out of remote access", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const retainedConfig: RuntimeConfig = {
      ...config,
      hubSpotAppScopeCeiling: [...config.hubSpotAppScopeCeiling, "crm.objects.contacts.write"],
    };
    const fetcher = vi.fn().mockResolvedValue(brokerTokenResponse({
      scopes: ["oauth", "crm.objects.contacts.read", "crm.objects.contacts.write"],
    })) as unknown as typeof fetch;

    const grant = await exchangeBrokerSession(
      sessionId,
      completionGrant,
      consumeSecret,
      codeVerifier,
      retainedConfig,
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(grant.scopes).toEqual(["oauth", "crm.objects.contacts.read", "crm.objects.contacts.write"]);
    expect(grant.effectiveScopes).toEqual(["oauth", "crm.objects.contacts.read"]);
    expect(toAccessProps(grant, "downstream-client", ["hsapi.read"], Date.now() + 60_000).scopes).toEqual([
      "oauth",
      "crm.objects.contacts.read",
    ]);
    expect(warning).toHaveBeenCalledWith(JSON.stringify({
      event: "hubspot_grant_scope_attenuated",
      code: "crm.objects.contacts.write",
    }));
  });

  it("rejects and revokes a broker grant containing scopes outside the app ceiling", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(brokerTokenResponse({
        scopes: ["oauth", "crm.objects.contacts.read", "crm.objects.companies.read"],
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 })) as unknown as typeof fetch;

    await expect(exchangeBrokerSession(sessionId, completionGrant, consumeSecret, codeVerifier, config, fetcher)).rejects.toMatchObject({
      code: "hubspot_unexpected_scope",
      status: 403,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(JSON.stringify({
      event: "hubspot_grant_scope_rejected",
      code: "crm.objects.companies.read",
    }));
    expect(JSON.stringify(warning.mock.calls)).not.toContain("test-access-token");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("test-refresh-token");
  });

  it("redacts malformed unexpected scope identifiers from logs", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(brokerTokenResponse({
        scopes: ["oauth", "crm.objects.contacts.read", "malformed scope\nvalue"],
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 })) as unknown as typeof fetch;

    await expect(exchangeBrokerSession(sessionId, completionGrant, consumeSecret, codeVerifier, config, fetcher)).rejects.toMatchObject({
      code: "hubspot_unexpected_scope",
      status: 403,
    });
    expect(warning).toHaveBeenCalledWith(JSON.stringify({
      event: "hubspot_grant_scope_rejected",
      code: "redacted_scope_identifier",
    }));
    expect(JSON.stringify(warning.mock.calls)).not.toContain("malformed scope");
  });

  it("never copies refresh or broker credentials into access-token properties", () => {
    const access = toAccessProps(currentGrant, "downstream-client", ["hsapi.read"], Date.now() + 60_000);
    expect(access).not.toHaveProperty("refreshToken");
    expect(access).not.toHaveProperty("brokerCredential");
    expect(access).toMatchObject({
      accessToken: "old-access",
      mcpClientId: "downstream-client",
      mcpScopes: ["hsapi.read"],
    });
  });

  it("uses the broker revoke endpoint for compensating cleanup", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 })) as unknown as typeof fetch;
    await revokeBrokerGrant(currentGrant, config, fetcher);
    const [requestUrl, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe(`${config.brokerUrl}/v1/oauth/tokens/revoke`);
    expect(JSON.parse(String(init.body))).toEqual({
      refreshToken: currentGrant.refreshToken,
      brokerCredential: currentGrant.brokerCredential,
    });
  });

  it("does not rotate a fresh upstream grant on every downstream refresh", async () => {
    const freshGrant = { ...currentGrant, accessTokenExpiresAtMs: Date.now() + 20 * 60 * 1000 };
    const fetcher = vi.fn().mockRejectedValue(new Error("fetch must not run")) as unknown as typeof fetch;

    const result = await handleTokenExchange(tokenExchangeOptions(freshGrant), config, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.accessTokenTTL).toBe(900);
    expect(result.newProps).toEqual(freshGrant);
  });

  it("attenuates a fresh stored grant when remote scope configuration tightens", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const freshGrant = { ...currentGrant, accessTokenExpiresAtMs: Date.now() + 20 * 60 * 1000 };
    const fetcher = vi.fn().mockRejectedValue(new Error("fetch must not run")) as unknown as typeof fetch;

    const result = await handleTokenExchange(tokenExchangeOptions(freshGrant), {
      ...config,
      hubSpotOptionalScopes: [],
    }, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect((result.newProps as HubSpotGrantProps).scopes).toEqual(["oauth", "crm.objects.contacts.read"]);
    expect((result.newProps as HubSpotGrantProps).effectiveScopes).toEqual(["oauth"]);
    expect((result.accessTokenProps as { scopes: string[] }).scopes).toEqual(["oauth"]);
    expect(warning).toHaveBeenCalledWith(JSON.stringify({
      event: "hubspot_grant_scope_attenuated",
      code: "crm.objects.contacts.read",
    }));
  });

  it("upgrades a stored pre-attenuation grant without broadening remote access", async () => {
    const freshLegacyGrant = {
      ...currentGrant,
      accessTokenExpiresAtMs: Date.now() + 20 * 60 * 1000,
      effectiveScopes: undefined,
    } as unknown as HubSpotGrantProps;
    const fetcher = vi.fn().mockRejectedValue(new Error("fetch must not run")) as unknown as typeof fetch;

    const result = await handleTokenExchange(tokenExchangeOptions(freshLegacyGrant), {
      ...config,
      hubSpotOptionalScopes: [],
    }, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect((result.newProps as HubSpotGrantProps).effectiveScopes).toEqual(["oauth"]);
    expect((result.accessTokenProps as { scopes: string[] }).scopes).toEqual(["oauth"]);
  });

  it("revokes a stored grant when a tightened app ceiling rejects its actual scopes", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const freshGrant = { ...currentGrant, accessTokenExpiresAtMs: Date.now() + 20 * 60 * 1000 };
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 })) as unknown as typeof fetch;

    await expect(handleTokenExchange(tokenExchangeOptions(freshGrant), {
      ...config,
      hubSpotAppScopeCeiling: ["oauth"],
      hubSpotOptionalScopes: [],
    }, fetcher)).rejects.toMatchObject({ code: "invalid_grant" });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe(`${config.brokerUrl}/v1/oauth/tokens/revoke`);
    expect(JSON.parse(String(init.body))).toEqual({
      refreshToken: freshGrant.refreshToken,
      brokerCredential: freshGrant.brokerCredential,
    });
    expect(warning).toHaveBeenCalledWith(JSON.stringify({
      event: "hubspot_grant_scope_rejected",
      code: "crm.objects.contacts.read",
    }));
  });

  it("refreshes through the broker before the upstream lifetime is too short", async () => {
    const fetcher = vi.fn().mockResolvedValue(brokerTokenResponse({
      refreshToken: "rotated-refresh",
      brokerCredential: `v1.${"R".repeat(43)}`,
    })) as unknown as typeof fetch;

    const result = await handleTokenExchange(tokenExchangeOptions(currentGrant), config, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.accessTokenTTL).toBe(900);
    expect((result.newProps as HubSpotGrantProps).refreshToken).toBe("rotated-refresh");
  });
});
