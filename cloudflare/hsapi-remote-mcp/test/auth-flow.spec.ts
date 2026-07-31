import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeGet, authorizePost, hubSpotCallback } from "../src/auth-handler";
import type { HandlerEnv } from "../src/types";

const ORIGIN = "http://localhost:8787";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
let brokerSessionNumber = 0;

function authRequest(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    responseType: "code",
    clientId: "grok-test-client",
    redirectUri: "https://grok.example/oauth/callback",
    scope: ["hsapi.read"],
    state: "grok-downstream-state",
    codeChallenge: "A".repeat(43),
    codeChallengeMethod: "S256",
    resource: `${ORIGIN}/mcp`,
    ...overrides,
  };
}

function testEnv(request = authRequest()) {
  const completeAuthorization = vi.fn(async () => ({
    redirectTo: `${request.redirectUri}?code=downstream-code&state=${request.state}`,
  }));
  const oauthProvider = {
    parseAuthRequest: vi.fn(async () => request),
    lookupClient: vi.fn(async () => ({ clientName: "Grok test connector" })),
    completeAuthorization,
  };
  return {
    handlerEnv: { ...env, OAUTH_PROVIDER: oauthProvider } as unknown as HandlerEnv,
    completeAuthorization,
  };
}

function hiddenValue(html: string, name: "consentId" | "csrf"): string {
  const match = html.match(new RegExp(`name="${name}" value="([A-Za-z0-9_-]+)"`));
  if (!match?.[1]) throw new Error(`Missing ${name} hidden value.`);
  return match[1];
}

async function beginConsent(handlerEnv: HandlerEnv) {
  const response = await authorizeGet(new Request(`${ORIGIN}/authorize`), handlerEnv);
  const html = await response.text();
  return {
    response,
    html,
    consentId: hiddenValue(html, "consentId"),
    csrf: hiddenValue(html, "csrf"),
  };
}

function consentRequest(
  entries: Array<[string, string]>,
  origin: string | null = ORIGIN,
): Request {
  const body = new URLSearchParams();
  for (const [name, value] of entries) body.append(name, value);
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  if (origin !== null) headers.set("origin", origin);
  return new Request(`${ORIGIN}/authorize`, { method: "POST", headers, body });
}

function validConsentEntries(flow: { consentId: string; csrf: string }): Array<[string, string]> {
  return [
    ["consentId", flow.consentId],
    ["csrf", flow.csrf],
    ["action", "approve"],
  ];
}

function responseSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (headers.getSetCookie) return headers.getSetCookie();
  const combined = response.headers.get("set-cookie");
  return combined ? [combined] : [];
}

function parsedCookies(response: Response): Array<{ name: string; value: string; header: string }> {
  return responseSetCookies(response).map((header) => {
    const match = header.match(/^([^=]+)=([^;]*);/);
    if (!match?.[1] || match[2] === undefined) throw new Error("Malformed test Set-Cookie header.");
    return { name: match[1], value: decodeURIComponent(match[2]), header };
  });
}

function createBrokerFetcher() {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (requestUrl.pathname === "/v1/oauth/sessions") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        codeChallenge: string;
        optionalScopes: string[];
      };
      const sessionId = String.fromCharCode(66 + brokerSessionNumber).repeat(43);
      brokerSessionNumber += 1;
      const authorizationUrl = new URL("https://app.hubspot.com/oauth/authorize");
      authorizationUrl.searchParams.set("client_id", env.HUBSPOT_CLIENT_ID);
      authorizationUrl.searchParams.set("redirect_uri", `${env.HUBSPOT_BROKER_URL}/v1/oauth/callback`);
      authorizationUrl.searchParams.set("scope", env.HUBSPOT_REQUIRED_SCOPES);
      if (body.optionalScopes.length) authorizationUrl.searchParams.set("optional_scope", body.optionalScopes.join(" "));
      authorizationUrl.searchParams.set("state", sessionId);
      authorizationUrl.searchParams.set("code_challenge", body.codeChallenge);
      authorizationUrl.searchParams.set("code_challenge_method", "S256");
      return Response.json({ sessionId, brokerRole: "remote", authorizationUrl: authorizationUrl.href, expiresIn: 600, interval: 1 }, { status: 201 });
    }
    if (/^\/v1\/oauth\/sessions\/[A-Za-z0-9_-]{43}\/exchange$/.test(requestUrl.pathname)) {
      const scopes = `${env.HUBSPOT_REQUIRED_SCOPES} ${env.HUBSPOT_OPTIONAL_SCOPES}`.split(/\s+/).filter(Boolean);
      return Response.json({
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        brokerCredential: `v1.${"C".repeat(43)}`,
        expiresIn: 3600,
        hubId: 123456,
        userId: 654321,
        scopes,
        clientId: env.HUBSPOT_CLIENT_ID,
        isUserLevel: true,
      });
    }
    throw new Error(`Unexpected broker request path: ${requestUrl.pathname}`);
  }) as typeof fetch;
}

describe("browser-compatible authorization flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a one-time hidden CSRF proof and exact registered redirect URI without a consent cookie", async () => {
    const { handlerEnv } = testEnv();
    const flow = await beginConsent(handlerEnv);

    expect(flow.response.status).toBe(200);
    expect(flow.consentId).toMatch(TOKEN_PATTERN);
    expect(flow.csrf).toMatch(TOKEN_PATTERN);
    expect(flow.html).toContain("https://grok.example/oauth/callback");
    expect(responseSetCookies(flow.response)).toEqual([]);
    expect(flow.response.headers.get("referrer-policy")).toBe("strict-origin");
    expect(flow.response.headers.get("content-security-policy")).toBe(
      `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://app.hubspot.com ${new URL(env.HUBSPOT_BROKER_URL).origin} https://grok.example; frame-ancestors 'none'; base-uri 'none'`,
    );
  });

  it("accepts a cookie-less consent POST and redirects with 303 plus dual per-session cookies", async () => {
    const { handlerEnv } = testEnv();
    const flow = await beginConsent(handlerEnv);
    const response = await authorizePost(
      consentRequest(validConsentEntries(flow)),
      handlerEnv,
      createBrokerFetcher(),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("location")).toMatch(/^https:\/\/app\.hubspot\.com\/oauth\/authorize\?/);
    const cookies = parsedCookies(response);
    expect(cookies).toHaveLength(2);
    expect(cookies[0]?.name).not.toBe(cookies[1]?.name);
    expect(cookies[0]?.value).toBe(cookies[1]?.value);
    expect(cookies.some(({ header }) => /SameSite=Lax/i.test(header) && !/Partitioned/i.test(header))).toBe(true);
    expect(cookies.some(({ header }) => /SameSite=None/i.test(header) && /Partitioned/i.test(header))).toBe(true);
    expect(cookies.every(({ header }) => /HttpOnly/i.test(header) && /Secure/i.test(header) && /Path=\//i.test(header))).toBe(true);
  });

  it("uses 303 when a consent POST denies authorization", async () => {
    const { handlerEnv } = testEnv();
    const flow = await beginConsent(handlerEnv);
    const entries = validConsentEntries(flow).map(([name, value]) => [
      name,
      name === "action" ? "deny" : value,
    ] as [string, string]);
    const response = await authorizePost(consentRequest(entries), handlerEnv, createBrokerFetcher());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("error=access_denied");
  });

  it("keeps parallel consent flows independent", async () => {
    const { handlerEnv } = testEnv();
    const first = await beginConsent(handlerEnv);
    const second = await beginConsent(handlerEnv);
    expect(first.consentId).not.toBe(second.consentId);
    expect(first.csrf).not.toBe(second.csrf);

    const broker = createBrokerFetcher();
    const firstResponse = await authorizePost(consentRequest(validConsentEntries(first)), handlerEnv, broker);
    const secondResponse = await authorizePost(consentRequest(validConsentEntries(second)), handlerEnv, broker);
    expect(firstResponse.status).toBe(303);
    expect(secondResponse.status).toBe(303);
    expect(parsedCookies(firstResponse).map(({ name }) => name)).not.toEqual(
      parsedCookies(secondResponse).map(({ name }) => name),
    );
  });

  it("does not burn state for missing or wrong CSRF, but rejects replay after success", async () => {
    const { handlerEnv } = testEnv();
    const flow = await beginConsent(handlerEnv);
    const missing = validConsentEntries(flow).filter(([name]) => name !== "csrf");
    expect((await authorizePost(consentRequest(missing), handlerEnv, createBrokerFetcher())).status).toBe(400);

    const wrong = validConsentEntries(flow).map(([name, value]) => [name, name === "csrf" ? "Z".repeat(43) : value] as [string, string]);
    expect((await authorizePost(consentRequest(wrong), handlerEnv, createBrokerFetcher())).status).toBe(400);

    const broker = createBrokerFetcher();
    expect((await authorizePost(consentRequest(validConsentEntries(flow)), handlerEnv, broker)).status).toBe(303);
    expect((await authorizePost(consentRequest(validConsentEntries(flow)), handlerEnv, broker)).status).toBe(400);
  });

  it("rejects missing, null, or cross-site Origin without burning consent state", async () => {
    const { handlerEnv } = testEnv();
    const flow = await beginConsent(handlerEnv);
    const entries = validConsentEntries(flow);
    const missingOrigin = await authorizePost(consentRequest(entries, null), handlerEnv, createBrokerFetcher());
    expect(missingOrigin.status).toBe(400);
    expect(missingOrigin.headers.get("referrer-policy")).toBe("no-referrer");
    expect(missingOrigin.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect((await authorizePost(consentRequest(entries, "null"), handlerEnv, createBrokerFetcher())).status).toBe(400);
    expect((await authorizePost(consentRequest(entries, "https://attacker.example"), handlerEnv, createBrokerFetcher())).status).toBe(400);
    expect((await authorizePost(consentRequest(entries), handlerEnv, createBrokerFetcher())).status).toBe(303);
  });

  it("rejects duplicate form fields without burning consent state", async () => {
    const { handlerEnv } = testEnv();
    const flow = await beginConsent(handlerEnv);
    const duplicate = [...validConsentEntries(flow), ["csrf", flow.csrf]] as Array<[string, string]>;
    expect((await authorizePost(consentRequest(duplicate), handlerEnv, createBrokerFetcher())).status).toBe(400);
    expect((await authorizePost(consentRequest(validConsentEntries(flow)), handlerEnv, createBrokerFetcher())).status).toBe(303);
  });

  it("requires either per-session browser cookie proof without burning state on missing or wrong proof", async () => {
    const { handlerEnv, completeAuthorization } = testEnv();
    const flow = await beginConsent(handlerEnv);
    const broker = createBrokerFetcher();
    const upstream = await authorizePost(consentRequest(validConsentEntries(flow)), handlerEnv, broker);
    const cookies = parsedCookies(upstream);
    const location = new URL(upstream.headers.get("location")!);
    const state = location.searchParams.get("state")!;
    const completionGrant = "G".repeat(43);
    const callbackUrl = `${ORIGIN}/hubspot/callback?state=${state}&completion_grant=${completionGrant}`;

    expect((await hubSpotCallback(new Request(callbackUrl), handlerEnv, broker)).status).toBe(400);
    expect((await hubSpotCallback(new Request(callbackUrl, {
      headers: { cookie: `${cookies[0]!.name}=${"W".repeat(43)}` },
    }), handlerEnv, broker)).status).toBe(400);

    const fallback = cookies.find(({ header }) => /Partitioned/i.test(header))!;
    const success = await hubSpotCallback(new Request(callbackUrl, {
      headers: { cookie: `${fallback.name}=${encodeURIComponent(fallback.value)}` },
    }), handlerEnv, broker);
    expect(success.status).toBe(302);
    expect(success.headers.get("location")).toContain("https://grok.example/oauth/callback?code=downstream-code");
    expect(completeAuthorization).toHaveBeenCalledTimes(1);
    const cleared = responseSetCookies(success);
    expect(cleared).toHaveLength(2);
    expect(cleared.every((header) => /Max-Age=0/i.test(header))).toBe(true);
    expect(cleared.some((header) => /SameSite=Lax/i.test(header) && !/Partitioned/i.test(header))).toBe(true);
    expect(cleared.some((header) => /SameSite=None/i.test(header) && /Partitioned/i.test(header))).toBe(true);
    expect(cleared.every((header) => /HttpOnly/i.test(header) && /Secure/i.test(header) && /Path=\//i.test(header))).toBe(true);

    expect((await hubSpotCallback(new Request(callbackUrl, {
      headers: { cookie: `${fallback.name}=${encodeURIComponent(fallback.value)}` },
    }), handlerEnv, broker)).status).toBe(400);
  });

  it("accepts the per-session SameSite=Lax primary cookie proof", async () => {
    const { handlerEnv, completeAuthorization } = testEnv();
    const flow = await beginConsent(handlerEnv);
    const broker = createBrokerFetcher();
    const upstream = await authorizePost(consentRequest(validConsentEntries(flow)), handlerEnv, broker);
    const primary = parsedCookies(upstream).find(({ header }) => /SameSite=Lax/i.test(header))!;
    const state = new URL(upstream.headers.get("location")!).searchParams.get("state")!;
    const callbackUrl = `${ORIGIN}/hubspot/callback?state=${state}&completion_grant=${"H".repeat(43)}`;

    const success = await hubSpotCallback(new Request(callbackUrl, {
      headers: { cookie: `${primary.name}=${encodeURIComponent(primary.value)}` },
    }), handlerEnv, broker);
    expect(success.status).toBe(302);
    expect(completeAuthorization).toHaveBeenCalledTimes(1);
  });

  it("emits reason-only rejection logs without flow identifiers or proofs", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { handlerEnv } = testEnv();
    const flow = await beginConsent(handlerEnv);
    await authorizePost(consentRequest(validConsentEntries(flow), "https://attacker.example"), handlerEnv, createBrokerFetcher());

    expect(warning).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(warning.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(payload).toEqual({ event: "oauth_consent_rejected", reason: "origin_mismatch" });
    expect(JSON.stringify(payload)).not.toContain(flow.consentId);
    expect(JSON.stringify(payload)).not.toContain(flow.csrf);
  });
});
