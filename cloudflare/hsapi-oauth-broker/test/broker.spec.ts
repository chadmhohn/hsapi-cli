import { env } from "cloudflare:workers";
import {
  reset,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

interface StartResponse {
  sessionId: string;
  authorizationUrl: string;
  expiresIn: number;
  interval: number;
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  brokerCredential: string;
  expiresIn: number;
  tokenType: string;
  hubId?: number;
  userId?: number;
  scopes?: string[];
}

interface ExchangeReady {
  kind: "ready";
  authorizationCode: string;
  attemptId: string;
}

interface OAuthSessionTestStub {
  createSession(
    consumeSecretHash: string,
    codeChallenge: string,
    oauthConfigurationHash: string,
    createdAt: number,
    expiresAt: number,
  ): Promise<boolean>;
  recordAuthorizationCode(
    code: string,
    oauthConfigurationHash: string,
    now: number,
  ): Promise<string>;
  beginExchange(
    consumeSecretHash: string,
    codeChallenge: string,
    oauthConfigurationHash: string,
    now: number,
  ): Promise<
    | ExchangeReady
    | { kind: "pending" }
    | { kind: "authorization_error"; oauthError: string }
    | { kind: "unauthorized" }
    | { kind: "configuration_changed" }
    | { kind: "in_progress" }
    | { kind: "consumed" }
    | { kind: "expired" }
  >;
  finishExchange(attemptId: string, succeeded: boolean): Promise<boolean>;
}

const verifier = "v".repeat(64);
const consumeSecret = "s".repeat(64);
const brokerSessionStartKey = "b".repeat(43);
const reusedConfigurationSecret = "r".repeat(43);

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("hsapi OAuth broker", () => {
  it("creates a server-scoped session and authenticates polling", async () => {
    const unauthenticatedStart = await postJson(
      "/v1/oauth/sessions",
      {
        accountId: "123456789",
        codeChallenge: await sha256Base64Url(verifier),
        consumeSecretHash: await sha256Base64Url(consumeSecret),
      },
      "192.0.2.9",
    );
    expect(unauthenticatedStart.status).toBe(401);
    expect(await unauthenticatedStart.json()).toMatchObject({
      error: "invalid_broker_client",
    });

    const start = await startSession();

    expect(start.expiresIn).toBe(600);
    expect(start.interval).toBe(1);
    expect(start.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const authorizationUrl = new URL(start.authorizationUrl);
    expect(authorizationUrl.pathname).toBe(
      "/oauth/123456789/authorize",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe("oauth");
    const optionalScopes = (
      authorizationUrl.searchParams.get("optional_scope") ?? ""
    ).split(" ");
    expect(optionalScopes).toHaveLength(49);
    expect(optionalScopes).toContain("cpq.quotes.write");
    expect(optionalScopes).toContain(
      "crm.objects.marketing_events.write",
    );
    expect(authorizationUrl.searchParams.get("state")).toBe(start.sessionId);
    expect(authorizationUrl.searchParams.get("code_challenge")).toBe(
      await sha256Base64Url(verifier),
    );
    expect(start.authorizationUrl).not.toContain(consumeSecret);

    const unauthenticatedPoll = await exchange(
      start.sessionId,
      "x".repeat(64),
      verifier,
    );
    expect(unauthenticatedPoll.status).toBe(401);

    const pendingPoll = await exchange(
      start.sessionId,
      consumeSecret,
      verifier,
    );
    expect(pendingPoll.status).toBe(202);
    expect(await pendingPoll.json()).toEqual({ status: "pending" });
    expect(pendingPoll.headers.get("cache-control")).toContain("no-store");
  });

  it("exchanges once, refreshes with an HMAC credential, and revokes", async () => {
    const upstreamRequests: URLSearchParams[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const parameters = new URLSearchParams(String(init?.body ?? ""));
        upstreamRequests.push(parameters);
        if (parameters.get("token_type_hint") === "refresh_token") {
          return new Response(null, { status: 204 });
        }
        if (parameters.get("grant_type") === "refresh_token") {
          return Response.json({
            access_token: "access-token-2",
            refresh_token: "refresh-token-2",
            expires_in: 1800,
            token_type: "bearer",
            hub_id: 123456789,
            user_id: 222,
            scopes: ["oauth", "cpq.quotes.write"],
          });
        }
        return Response.json({
          access_token: "access-token-1",
          refresh_token: "refresh-token-1",
          expires_in: 1800,
          token_type: "bearer",
          hub_id: 123456789,
          user_id: 111,
          scopes: ["oauth", "crm.objects.marketing_events.write"],
        });
      },
    );

    const start = await startSession();
    const callback = await dispatch(
      `https://broker.test/v1/oauth/callback?code=authorization-code&state=${start.sessionId}`,
      { headers: { "CF-Connecting-IP": "192.0.2.20" } },
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/v1/oauth/complete");
    expect(callback.headers.get("cache-control")).toContain("no-store");
    const completePage = await dispatch(
      "https://broker.test/v1/oauth/complete",
    );
    expect(completePage.status).toBe(200);
    expect(await completePage.text()).not.toContain("authorization-code");

    const exchanged = await exchange(
      start.sessionId,
      consumeSecret,
      verifier,
    );
    expect(exchanged.status).toBe(200);
    const initial = await exchanged.json<TokenResponse>();
    expect(initial).toMatchObject({
      accessToken: "access-token-1",
      refreshToken: "refresh-token-1",
      expiresIn: 1800,
      tokenType: "bearer",
      hubId: 123456789,
      userId: 111,
      scopes: ["oauth", "crm.objects.marketing_events.write"],
    });
    expect(initial.brokerCredential).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/);

    const replay = await exchange(
      start.sessionId,
      consumeSecret,
      verifier,
    );
    expect(replay.status).toBe(409);

    const invalidRefresh = await postJson("/v1/oauth/tokens/refresh", {
      refreshToken: initial.refreshToken,
      brokerCredential: `v1.${"A".repeat(43)}`,
    });
    expect(invalidRefresh.status).toBe(401);

    const refreshedResponse = await postJson("/v1/oauth/tokens/refresh", {
      refreshToken: initial.refreshToken,
      brokerCredential: initial.brokerCredential,
    });
    expect(refreshedResponse.status).toBe(200);
    const refreshed = await refreshedResponse.json<TokenResponse>();
    expect(refreshed.refreshToken).toBe("refresh-token-2");
    expect(refreshed.brokerCredential).not.toBe(initial.brokerCredential);
    expect(refreshed.scopes).toEqual(["oauth", "cpq.quotes.write"]);

    const revoked = await postJson("/v1/oauth/tokens/revoke", {
      refreshToken: refreshed.refreshToken,
      brokerCredential: refreshed.brokerCredential,
    });
    expect(revoked.status).toBe(204);

    expect(upstreamRequests.map((request) => request.get("grant_type"))).toEqual([
      "authorization_code",
      "refresh_token",
      null,
    ]);
  });

  it("makes a failed upstream exchange terminal instead of replaying the code", async () => {
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json(
          { error: "temporarily_unavailable" },
          { status: 503 },
        ),
      );
    const start = await startSession();
    const callback = await dispatch(
      `https://broker.test/v1/oauth/callback?code=single-use-code&state=${start.sessionId}`,
      { headers: { "CF-Connecting-IP": "192.0.2.21" } },
    );
    expect(callback.status).toBe(303);

    const failed = await exchange(
      start.sessionId,
      consumeSecret,
      verifier,
    );
    expect(failed.status).toBe(502);
    expect(upstream).toHaveBeenCalledTimes(1);

    const replay = await exchange(
      start.sessionId,
      consumeSecret,
      verifier,
    );
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      error: "session_consumed",
    });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("revokes a newly issued token when post-exchange validation fails", async () => {
    const upstreamRequests: URLSearchParams[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const parameters = new URLSearchParams(String(init?.body ?? ""));
        upstreamRequests.push(parameters);
        if (parameters.get("token_type_hint") === "refresh_token") {
          return new Response(null, { status: 204 });
        }
        return Response.json({
          access_token: "wrong-account-access",
          refresh_token: "wrong-account-refresh",
          expires_in: 1800,
          token_type: "bearer",
          hub_id: 999999999,
        });
      },
    );
    const start = await startSession();
    expect(
      (
        await dispatch(
          `https://broker.test/v1/oauth/callback?code=wrong-account-code&state=${start.sessionId}`,
          { headers: { "CF-Connecting-IP": "192.0.2.25" } },
        )
      ).status,
    ).toBe(303);

    const failed = await exchange(
      start.sessionId,
      consumeSecret,
      verifier,
    );
    expect(failed.status).toBe(403);
    expect(await failed.json()).toMatchObject({
      error: "account_mismatch",
    });
    expect(upstreamRequests).toHaveLength(2);
    expect(upstreamRequests[1]?.get("token")).toBe(
      "wrong-account-refresh",
    );
    expect(upstreamRequests[1]?.get("token_type_hint")).toBe(
      "refresh_token",
    );
  });

  it("revokes a newly issued token when post-refresh validation fails", async () => {
    const upstreamRequests: URLSearchParams[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const parameters = new URLSearchParams(String(init?.body ?? ""));
        upstreamRequests.push(parameters);
        if (parameters.get("token_type_hint") === "refresh_token") {
          return new Response(null, { status: 204 });
        }
        if (parameters.get("grant_type") === "refresh_token") {
          return Response.json({
            access_token: "wrong-account-refresh-access",
            refresh_token: "wrong-account-refresh-token",
            expires_in: 1800,
            token_type: "bearer",
            hub_id: 999999999,
          });
        }
        return Response.json({
          access_token: "initial-access",
          refresh_token: "initial-refresh",
          expires_in: 1800,
          token_type: "bearer",
          hub_id: 123456789,
        });
      },
    );

    const start = await startSession();
    expect(
      (
        await dispatch(
          `https://broker.test/v1/oauth/callback?code=refresh-cleanup-code&state=${start.sessionId}`,
          { headers: { "CF-Connecting-IP": "192.0.2.26" } },
        )
      ).status,
    ).toBe(303);
    const exchanged = await exchange(
      start.sessionId,
      consumeSecret,
      verifier,
    );
    expect(exchanged.status).toBe(200);
    const initial = await exchanged.json<TokenResponse>();

    const failed = await postJson("/v1/oauth/tokens/refresh", {
      refreshToken: initial.refreshToken,
      brokerCredential: initial.brokerCredential,
    });
    expect(failed.status).toBe(403);
    expect(await failed.json()).toMatchObject({
      error: "account_mismatch",
    });
    expect(upstreamRequests).toHaveLength(3);
    expect(upstreamRequests[2]?.get("token")).toBe(
      "wrong-account-refresh-token",
    );
    expect(upstreamRequests[2]?.get("token_type_hint")).toBe(
      "refresh_token",
    );
  });

  it("allows large tokens up to the 1 MiB upstream JSON cap", async () => {
    let accessTokenSize = 80 * 1024;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        access_token: "a".repeat(accessTokenSize),
        refresh_token: "refresh-token",
        expires_in: 1800,
        token_type: "bearer",
          hub_id: 123456789,
      }),
    );

    const acceptedStart = await startSession();
    expect(
      (
        await dispatch(
          `https://broker.test/v1/oauth/callback?code=large-code&state=${acceptedStart.sessionId}`,
          { headers: { "CF-Connecting-IP": "192.0.2.23" } },
        )
      ).status,
    ).toBe(303);
    const accepted = await exchange(
      acceptedStart.sessionId,
      consumeSecret,
      verifier,
    );
    expect(accepted.status).toBe(200);
    expect(
      (await accepted.json<TokenResponse>()).accessToken,
    ).toHaveLength(accessTokenSize);

    accessTokenSize = 1024 * 1024 + 1;
    const rejectedStart = await startSession();
    expect(
      (
        await dispatch(
          `https://broker.test/v1/oauth/callback?code=oversized-code&state=${rejectedStart.sessionId}`,
          { headers: { "CF-Connecting-IP": "192.0.2.24" } },
        )
      ).status,
    ).toBe(303);
    const rejected = await exchange(
      rejectedStart.sessionId,
      consumeSecret,
      verifier,
    );
    expect(rejected.status).toBe(502);
    expect(await rejected.json()).toMatchObject({
      error: "hubspot_oauth_error",
      oauthError: "upstream_response_too_large",
    });
  });

  it("uses attempt CAS so stale completion cannot alter replacement state", async () => {
    const start = await startSession();
    const callback = await dispatch(
      `https://broker.test/v1/oauth/callback?code=old-code&state=${start.sessionId}`,
      { headers: { "CF-Connecting-IP": "192.0.2.22" } },
    );
    expect(callback.status).toBe(303);

    const stub = env.OAUTH_SESSIONS.getByName(
      start.sessionId,
    ) as unknown as OAuthSessionTestStub;
    const consumeHash = await sha256Base64Url(consumeSecret);
    const challenge = await sha256Base64Url(verifier);
    const configurationHash = await testConfigurationHash(env);
    const oldAttempt = await stub.beginExchange(
      consumeHash,
      challenge,
      configurationHash,
      Date.now(),
    );
    expect(oldAttempt.kind).toBe("ready");
    if (oldAttempt.kind !== "ready") {
      throw new Error("Expected the original exchange attempt to start.");
    }

    const timedRetry = await stub.beginExchange(
      consumeHash,
      challenge,
      configurationHash,
      Date.now() + 60_000,
    );
    expect(timedRetry).toEqual({ kind: "in_progress" });

    const replacementCreatedAt = Date.now() + 11 * 60 * 1_000;
    expect(
      await stub.createSession(
        consumeHash,
        challenge,
        configurationHash,
        replacementCreatedAt,
        replacementCreatedAt + 10 * 60 * 1_000,
      ),
    ).toBe(true);
    expect(
      await stub.recordAuthorizationCode(
        "replacement-code",
        configurationHash,
        replacementCreatedAt + 1,
      ),
    ).toBe("stored");
    const replacementAttempt = await stub.beginExchange(
      consumeHash,
      challenge,
      configurationHash,
      replacementCreatedAt + 2,
    );
    expect(replacementAttempt.kind).toBe("ready");
    if (replacementAttempt.kind !== "ready") {
      throw new Error("Expected the replacement exchange attempt to start.");
    }
    expect(replacementAttempt.attemptId).not.toBe(oldAttempt.attemptId);

    expect(await stub.finishExchange(oldAttempt.attemptId, true)).toBe(false);
    expect(
      await stub.beginExchange(
        consumeHash,
        challenge,
        configurationHash,
        replacementCreatedAt + 3,
      ),
    ).toEqual({ kind: "in_progress" });

    expect(
      await stub.finishExchange(replacementAttempt.attemptId, false),
    ).toBe(true);
    expect(
      await stub.beginExchange(
        consumeHash,
        challenge,
        configurationHash,
        replacementCreatedAt + 4,
      ),
    ).toEqual({ kind: "consumed" });
  });

  it("keeps authorization errors private until an authenticated exchange", async () => {
    const start = await startSession();
    const callback = await dispatch(
      `https://broker.test/v1/oauth/callback?error=access_denied&state=${start.sessionId}`,
      { headers: { "CF-Connecting-IP": "192.0.2.30" } },
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/v1/oauth/complete");

    const probe = await exchange(
      start.sessionId,
      "x".repeat(64),
      verifier,
    );
    expect(probe.status).toBe(401);

    const authenticated = await exchange(
      start.sessionId,
      consumeSecret,
      verifier,
    );
    expect(authenticated.status).toBe(400);
    expect(await authenticated.json()).toMatchObject({
      error: "access_denied",
    });
  });

  it("rejects ambiguous or duplicated callback parameters", async () => {
    const first = await startSession();
    const ambiguous = await dispatch(
      `https://broker.test/v1/oauth/callback?code=one&error=access_denied&state=${first.sessionId}`,
      { headers: { "CF-Connecting-IP": "192.0.2.31" } },
    );
    expect(ambiguous.status).toBe(400);

    const stillUsable = await dispatch(
      `https://broker.test/v1/oauth/callback?code=one&state=${first.sessionId}`,
      { headers: { "CF-Connecting-IP": "192.0.2.32" } },
    );
    expect(stillUsable.status).toBe(303);

    const second = await startSession();
    const duplicateCode = await dispatch(
      `https://broker.test/v1/oauth/callback?code=one&code=two&error=access_denied&state=${second.sessionId}`,
      { headers: { "CF-Connecting-IP": "192.0.2.33" } },
    );
    expect(duplicateCode.status).toBe(400);

    const third = await startSession();
    const duplicateState = await dispatch(
      `https://broker.test/v1/oauth/callback?code=one&state=${third.sessionId}&state=${third.sessionId}`,
      { headers: { "CF-Connecting-IP": "192.0.2.34" } },
    );
    expect(duplicateState.status).toBe(400);
  });

  it("validates PKCE syntax and authenticates the stored challenge", async () => {
    const invalidChallenge = await postJson(
      "/v1/oauth/sessions",
      {
        accountId: "123456789",
        codeChallenge: "not-a-sha256-challenge",
        consumeSecretHash: await sha256Base64Url(consumeSecret),
      },
      "192.0.2.35",
      brokerSessionStartKey,
    );
    expect(invalidChallenge.status).toBe(400);
    expect(await invalidChallenge.json()).toMatchObject({
      error: "invalid_code_challenge",
    });

    const start = await startSession();
    const callback = await dispatch(
      `https://broker.test/v1/oauth/callback?code=authorization-code&state=${start.sessionId}`,
      { headers: { "CF-Connecting-IP": "192.0.2.36" } },
    );
    expect(callback.status).toBe(303);

    const invalidVerifier = await exchange(
      start.sessionId,
      consumeSecret,
      "short",
    );
    expect(invalidVerifier.status).toBe(400);
    expect(await invalidVerifier.json()).toMatchObject({
      error: "invalid_code_verifier",
    });

    const wrongVerifier = await exchange(
      start.sessionId,
      consumeSecret,
      "w".repeat(64),
    );
    expect(wrongVerifier.status).toBe(401);
    expect(await wrongVerifier.json()).toMatchObject({
      error: "invalid_session_credential",
    });
  });

  it("binds callback and exchange to the session's OAuth configuration", async () => {
    const start = await startSession();
    const changedEnv = {
      ...env,
      HUBSPOT_CLIENT_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    } as unknown as Env;
    const changedCallback = await dispatchWithEnv(
      `https://broker.test/v1/oauth/callback?code=authorization-code&state=${start.sessionId}`,
      changedEnv,
      { headers: { "CF-Connecting-IP": "192.0.2.37" } },
    );
    expect(changedCallback.status).toBe(410);

    const callback = await dispatch(
      `https://broker.test/v1/oauth/callback?code=authorization-code&state=${start.sessionId}`,
      { headers: { "CF-Connecting-IP": "192.0.2.38" } },
    );
    expect(callback.status).toBe(303);

    const changedExchange = await exchangeWithEnv(
      start.sessionId,
      consumeSecret,
      verifier,
      changedEnv,
    );
    expect(changedExchange.status).toBe(409);
    expect(await changedExchange.json()).toMatchObject({
      error: "session_configuration_changed",
    });
  });

  it.each(["code", "error"] as const)(
    "persists the shortened callback expiry for a stored %s",
    async (callbackKind) => {
      const start = await startSession();
      const callbackParameters =
        callbackKind === "code"
          ? "code=authorization-code"
          : "error=access_denied";
      const callback = await dispatch(
        `https://broker.test/v1/oauth/callback?${callbackParameters}&state=${start.sessionId}`,
        { headers: { "CF-Connecting-IP": "192.0.2.40" } },
      );
      expect(callback.status).toBe(303);

      const stub = env.OAUTH_SESSIONS.getByName(
        start.sessionId,
      ) as unknown as {
        beginExchange(
          consumeSecretHash: string,
          codeChallenge: string,
          oauthConfigurationHash: string,
          now: number,
        ): Promise<unknown>;
      };
      const exchange = await stub.beginExchange(
        await sha256Base64Url(consumeSecret),
        await sha256Base64Url(verifier),
        await testConfigurationHash(env),
        Date.now() + 3 * 60 * 1_000,
      );
      expect(exchange).toEqual({ kind: "expired" });
    },
  );

  it.each([
    "https://hsapi-oauth-broker-production.REPLACE.workers.dev/v1/oauth/callback",
    "https://user:password@broker.test/v1/oauth/callback",
    "https://broker.test/v1/oauth/callback?environment=test",
    "https://broker.test/v1/oauth/callback#fragment",
    "https://broker.test/v1/oauth/not-the-callback",
  ])("rejects an unsafe configured redirect URI: %s", async (redirectUri) => {
    const invalidEnv = {
      ...env,
      HUBSPOT_REDIRECT_URI: redirectUri,
    } as unknown as Env;
    const health = await worker.fetch(
      new Request("https://broker.test/healthz"),
      invalidEnv,
    );
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ready: false });

    const response = await worker.fetch(
      new Request("https://broker.test/v1/oauth/sessions", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "192.0.2.41",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          accountId: "123456789",
          codeChallenge: await sha256Base64Url(verifier),
          consumeSecretHash: await sha256Base64Url(consumeSecret),
        }),
      }),
      invalidEnv,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "broker_not_configured",
    });
  });

  it.each([
    [
      "malformed client ID",
      { HUBSPOT_CLIENT_ID: "not-a-hubspot-client-id" },
    ],
    [
      "invalid optional scope",
      { HUBSPOT_OPTIONAL_SCOPES: "crm.objects.contacts.read invalid/scope" },
    ],
    [
      "duplicate optional scope",
      {
        HUBSPOT_OPTIONAL_SCOPES:
          "crm.objects.contacts.read crm.objects.contacts.read",
      },
    ],
    [
      "required/optional scope overlap",
      {
        HUBSPOT_REQUIRED_SCOPES: "oauth crm.objects.contacts.read",
        HUBSPOT_OPTIONAL_SCOPES: "crm.objects.contacts.read",
      },
    ],
    [
      "oauth as an optional scope",
      { HUBSPOT_OPTIONAL_SCOPES: "oauth crm.objects.contacts.read" },
    ],
  ])("rejects invalid OAuth configuration: %s", async (_name, overrides) => {
    const invalidEnv = {
      ...env,
      ...overrides,
    } as unknown as Env;
    const health = await worker.fetch(
      new Request("https://broker.test/healthz"),
      invalidEnv,
    );
    expect(await health.json()).toMatchObject({ ready: false });

    const response = await worker.fetch(
      new Request("https://broker.test/v1/oauth/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${brokerSessionStartKey}`,
          "CF-Connecting-IP": "192.0.2.42",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          accountId: "123456789",
          codeChallenge: await sha256Base64Url(verifier),
          consumeSecretHash: await sha256Base64Url(consumeSecret),
        }),
      }),
      invalidEnv,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "broker_not_configured",
    });
  });

  it.each([
    [
      "HubSpot client secret and broker signing key",
      {
        HUBSPOT_CLIENT_SECRET: reusedConfigurationSecret,
        BROKER_SIGNING_KEY: reusedConfigurationSecret,
      },
    ],
    [
      "HubSpot client secret and session-start key",
      {
        HUBSPOT_CLIENT_SECRET: reusedConfigurationSecret,
        BROKER_SESSION_START_KEY: reusedConfigurationSecret,
      },
    ],
    [
      "broker signing key and session-start key",
      {
        BROKER_SIGNING_KEY: reusedConfigurationSecret,
        BROKER_SESSION_START_KEY: reusedConfigurationSecret,
      },
    ],
  ])("rejects reuse between %s", async (_name, overrides) => {
    const invalidEnv = {
      ...env,
      ...overrides,
    } as unknown as Env;
    const health = await worker.fetch(
      new Request("https://broker.test/healthz"),
      invalidEnv,
    );
    expect(await health.json()).toMatchObject({ ready: false });

    const response = await worker.fetch(
      new Request("https://broker.test/v1/oauth/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${brokerSessionStartKey}`,
          "CF-Connecting-IP": "192.0.2.43",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          accountId: "123456789",
          codeChallenge: await sha256Base64Url(verifier),
          consumeSecretHash: await sha256Base64Url(consumeSecret),
        }),
      }),
      invalidEnv,
    );
    expect(response.status).toBe(503);
    const responseText = await response.text();
    expect(responseText).not.toContain(reusedConfigurationSecret);
    expect(JSON.parse(responseText)).toMatchObject({
      error: "broker_not_configured",
    });
  });

  it("removes session data when its alarm fires", async () => {
    const start = await startSession();
    const stub = env.OAUTH_SESSIONS.getByName(start.sessionId);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const response = await exchange(
      start.sessionId,
      consumeSecret,
      verifier,
    );
    expect(response.status).toBe(401);
  });
});

async function startSession(): Promise<StartResponse> {
  const response = await postJson(
    "/v1/oauth/sessions",
    {
      accountId: "123456789",
      codeChallenge: await sha256Base64Url(verifier),
      consumeSecretHash: await sha256Base64Url(consumeSecret),
    },
    "192.0.2.10",
    brokerSessionStartKey,
  );
  expect(response.status).toBe(201);
  return response.json<StartResponse>();
}

async function exchange(
  sessionId: string,
  secret: string,
  codeVerifier: string,
): Promise<Response> {
  return exchangeWithEnv(
    sessionId,
    secret,
    codeVerifier,
    env,
  );
}

async function exchangeWithEnv(
  sessionId: string,
  secret: string,
  codeVerifier: string,
  targetEnv: Env,
): Promise<Response> {
  return dispatchWithEnv(
    `https://broker.test/v1/oauth/sessions/${sessionId}/exchange`,
    targetEnv,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "CF-Connecting-IP": "192.0.2.11",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ codeVerifier }),
    },
  );
}

async function postJson(
  path: string,
  body: Record<string, string>,
  sourceIp = "192.0.2.12",
  bearer?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "CF-Connecting-IP": sourceIp,
    "Content-Type": "application/json",
  };
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  }
  return dispatch(`https://broker.test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function dispatch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  return dispatchWithEnv(input, env, init);
}

async function dispatchWithEnv(
  input: string,
  targetEnv: Env,
  init?: RequestInit,
): Promise<Response> {
  return worker.fetch(new Request(input, init), targetEnv);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    ),
  );
  let binary = "";
  for (const byte of digest) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

async function testConfigurationHash(targetEnv: Env): Promise<string> {
  const parseScopes = (value: string): string[] =>
    value.split(/[\s,]+/u).filter(Boolean);
  return sha256Base64Url(
    JSON.stringify({
      version: 1,
      accountId: String(targetEnv.HUBSPOT_ACCOUNT_ID).trim(),
      clientId: String(targetEnv.HUBSPOT_CLIENT_ID).trim(),
      redirectUri: String(targetEnv.HUBSPOT_REDIRECT_URI).trim(),
      requiredScopes: parseScopes(targetEnv.HUBSPOT_REQUIRED_SCOPES),
      optionalScopes: parseScopes(targetEnv.HUBSPOT_OPTIONAL_SCOPES),
    }),
  );
}
