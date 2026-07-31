import {
  GrantType,
  OAuthError,
  type AuthRequest,
  type TokenExchangeCallbackOptions,
  type TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { randomToken, sha256Base64Url } from "./crypto";
import type { HubSpotAccessProps, HubSpotGrantProps, RuntimeConfig } from "./types";

const MAX_BROKER_RESPONSE_BYTES = 1024 * 1024;
const MAX_HUBSPOT_SCOPE_COUNT = 100;
const BROKER_TIMEOUT_MS = 30_000;
export const HUBSPOT_AUTHORIZATION_ORIGIN = "https://app.hubspot.com";
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_SECRET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const BROKER_CREDENTIAL_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/;

type Fetcher = typeof fetch;
type UnattenuatedHubSpotGrant = Omit<HubSpotGrantProps, "effectiveScopes">;

export interface BrokerSession {
  sessionId: string;
  authorizationUrl: string;
  expiresIn: number;
  interval: number;
  brokerRole: "remote";
}

export class BrokerOAuthError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: string;

  constructor(status: number, code: string, retryAfter?: string) {
    super(code);
    this.name = "BrokerOAuthError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum
    ? Number(value)
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value)
    || value.length > MAX_HUBSPOT_SCOPE_COUNT
    || value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) return undefined;
  const normalized = value.map((entry) => String(entry).trim());
  return new Set(normalized).size === normalized.length ? normalized : undefined;
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (
    left.length !== right.length
    || new Set(left).size !== left.length
    || new Set(right).size !== right.length
  ) return false;
  const expected = new Set(left);
  return right.every((value) => expected.has(value));
}

function brokerEndpoint(config: RuntimeConfig, pathname: string): string {
  const endpoint = new URL(pathname, `${config.brokerUrl}/`);
  if (endpoint.origin !== config.brokerUrl || endpoint.pathname !== pathname || endpoint.search || endpoint.hash) {
    throw new BrokerOAuthError(500, "invalid_broker_configuration");
  }
  return endpoint.href;
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    try {
      await response.body?.cancel();
    } catch {
      // The media-type check is authoritative.
    }
    throw new BrokerOAuthError(502, "invalid_broker_response");
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BROKER_RESPONSE_BYTES) {
    try {
      await response.body?.cancel();
    } catch {
      // The size check is authoritative even if the remote stream is unusable.
    }
    throw new BrokerOAuthError(502, "broker_response_too_large");
  }

  const reader = response.body?.getReader();
  if (!reader) throw new BrokerOAuthError(502, "invalid_broker_response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BROKER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new BrokerOAuthError(502, "broker_response_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BrokerOAuthError) throw error;
    throw new BrokerOAuthError(502, "invalid_broker_response");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BrokerOAuthError(502, "invalid_broker_response");
  }
}

async function brokerRequest(
  config: RuntimeConfig,
  pathname: string,
  body: Record<string, unknown>,
  fetcher: Fetcher,
  bearer?: string,
): Promise<{ response: Response; payload?: unknown }> {
  let response: Response;
  try {
    response = await fetcher(brokerEndpoint(config, pathname), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(BROKER_TIMEOUT_MS),
    });
  } catch {
    throw new BrokerOAuthError(502, "broker_unavailable");
  }
  if (response.status >= 300 && response.status < 400) {
    try {
      await response.body?.cancel();
    } catch {
      // Redirect rejection is authoritative.
    }
    throw new BrokerOAuthError(502, "broker_redirect_rejected");
  }
  if (response.status === 204) return { response };

  const payload = await readLimitedJson(response);
  if (!response.ok) {
    const code = isRecord(payload) ? nonEmptyString(payload.error) : undefined;
    throw new BrokerOAuthError(
      response.status,
      code && /^[A-Za-z0-9._-]{1,80}$/.test(code) ? code : "broker_oauth_error",
      response.headers.get("retry-after") ?? undefined,
    );
  }
  return { response, payload };
}

function validateAuthorizationUrl(
  value: string,
  sessionId: string,
  codeChallenge: string,
  config: RuntimeConfig,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrokerOAuthError(502, "invalid_broker_session_response");
  }
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  let redirect: URL;
  try {
    redirect = new URL(redirectUri);
  } catch {
    throw new BrokerOAuthError(502, "invalid_broker_session_response");
  }
  const requiredScopes = (url.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean);
  const optionalScopes = (url.searchParams.get("optional_scope") ?? "").split(/\s+/).filter(Boolean);
  if (
    url.origin !== HUBSPOT_AUTHORIZATION_ORIGIN
    || url.pathname !== "/oauth/authorize"
    || url.username
    || url.password
    || url.hash
    || url.searchParams.getAll("state").length !== 1
    || url.searchParams.get("state") !== sessionId
    || url.searchParams.getAll("client_id").length !== 1
    || url.searchParams.get("client_id") !== config.hubSpotClientId
    || url.searchParams.getAll("redirect_uri").length !== 1
    || redirect.origin !== config.brokerUrl
    || redirect.pathname !== "/v1/oauth/callback"
    || redirect.username
    || redirect.password
    || redirect.search
    || redirect.hash
    || url.searchParams.getAll("code_challenge").length !== 1
    || url.searchParams.get("code_challenge") !== codeChallenge
    || url.searchParams.getAll("code_challenge_method").length !== 1
    || url.searchParams.get("code_challenge_method") !== "S256"
    || url.searchParams.getAll("scope").length !== 1
    || url.searchParams.getAll("optional_scope").length !== (config.hubSpotOptionalScopes.length ? 1 : 0)
    || !sameStringSet(requiredScopes, config.hubSpotRequiredScopes)
    || !sameStringSet(optionalScopes, config.hubSpotOptionalScopes)
    || url.searchParams.has("client_secret")
    || url.searchParams.has("code")
    || url.searchParams.has("code_verifier")
  ) {
    throw new BrokerOAuthError(502, "invalid_broker_session_response");
  }
  return url.href;
}

export async function startBrokerSession(
  codeChallenge: string,
  consumeSecretHash: string,
  config: RuntimeConfig,
  fetcher: Fetcher = fetch,
): Promise<BrokerSession> {
  if (!SESSION_ID_PATTERN.test(codeChallenge) || !SESSION_ID_PATTERN.test(consumeSecretHash)) {
    throw new BrokerOAuthError(400, "invalid_broker_session_proof");
  }
  const { response, payload } = await brokerRequest(config, "/v1/oauth/sessions", {
    codeChallenge,
    consumeSecretHash,
    completionRedirectUri: config.callbackUrl,
    optionalScopes: [...config.hubSpotOptionalScopes],
  }, fetcher);
  if (response.status !== 201 || !isRecord(payload)) {
    throw new BrokerOAuthError(502, "invalid_broker_session_response");
  }
  const sessionId = nonEmptyString(payload.sessionId);
  const authorizationUrl = nonEmptyString(payload.authorizationUrl);
  const expiresIn = positiveInteger(payload.expiresIn, 600);
  const interval = positiveInteger(payload.interval, 60);
  if (
    payload.brokerRole !== "remote"
    || !sessionId
    || !SESSION_ID_PATTERN.test(sessionId)
    || !authorizationUrl
    || authorizationUrl.length > 8192
    || !expiresIn
    || !interval
  ) {
    throw new BrokerOAuthError(502, "invalid_broker_session_response");
  }
  return {
    sessionId,
    authorizationUrl: validateAuthorizationUrl(authorizationUrl, sessionId, codeChallenge, config),
    expiresIn,
    interval,
    brokerRole: "remote",
  };
}

export async function createUpstreamPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(48);
  return { verifier, challenge: await sha256Base64Url(verifier) };
}

function parseBrokerGrant(payload: unknown): UnattenuatedHubSpotGrant {
  if (!isRecord(payload)) throw new BrokerOAuthError(502, "invalid_broker_token_response");
  const accessToken = nonEmptyString(payload.accessToken);
  const refreshToken = nonEmptyString(payload.refreshToken);
  const brokerCredential = nonEmptyString(payload.brokerCredential);
  const expiresIn = positiveInteger(payload.expiresIn, 86_400);
  const hubId = positiveInteger(payload.hubId);
  const userId = positiveInteger(payload.userId);
  const scopes = stringArray(payload.scopes);
  const clientId = nonEmptyString(payload.clientId);
  const hubDomain = nonEmptyString(payload.hubDomain);
  if (
    !accessToken
    || !refreshToken
    || !brokerCredential
    || !BROKER_CREDENTIAL_PATTERN.test(brokerCredential)
    || !expiresIn
    || !hubId
    || !userId
    || !scopes
    || !clientId
    || typeof payload.isUserLevel !== "boolean"
    || (hubDomain && (hubDomain.length > 255 || /[\u0000-\u001f\u007f]/.test(hubDomain)))
  ) {
    throw new BrokerOAuthError(502, "invalid_broker_token_response");
  }
  return {
    version: 1,
    accessToken,
    refreshToken,
    brokerCredential,
    accessTokenExpiresAtMs: Date.now() + expiresIn * 1000,
    hubId,
    userId,
    ...(hubDomain ? { hubDomain } : {}),
    scopes,
    isUserLevel: payload.isUserLevel,
    clientId,
  };
}

function loggedScopeCode(scope: string): string {
  return /^[A-Za-z0-9._:-]{1,200}$/.test(scope) ? scope : "redacted_scope_identifier";
}

function logGrantScopes(event: "hubspot_grant_scope_attenuated" | "hubspot_grant_scope_rejected", scopes: string[]): void {
  for (const scope of scopes) {
    console.warn(JSON.stringify({ event, code: loggedScopeCode(scope) }));
  }
}

function attenuateConfiguredGrant(
  grant: UnattenuatedHubSpotGrant | HubSpotGrantProps,
  config: RuntimeConfig,
): HubSpotGrantProps {
  if (grant.clientId !== config.hubSpotClientId) {
    throw new BrokerOAuthError(403, "hubspot_token_identity_invalid");
  }
  if (config.hubSpotRequiredScopes.some((scope) => !grant.scopes.includes(scope))) {
    throw new BrokerOAuthError(403, "hubspot_required_scope_missing");
  }
  const appScopeCeiling = new Set(config.hubSpotAppScopeCeiling);
  const outsideAppCeiling = grant.scopes.filter((scope) => !appScopeCeiling.has(scope));
  if (outsideAppCeiling.length) {
    logGrantScopes("hubspot_grant_scope_rejected", outsideAppCeiling);
    throw new BrokerOAuthError(403, "hubspot_unexpected_scope");
  }
  if (config.hubSpotRequireUserLevel && !grant.isUserLevel) {
    throw new BrokerOAuthError(403, "hubspot_user_level_token_required");
  }
  const configuredScopes = new Set([...config.hubSpotRequiredScopes, ...config.hubSpotOptionalScopes]);
  const effectiveScopes = grant.scopes.filter((scope) => configuredScopes.has(scope));
  const retainedScopes = grant.scopes.filter((scope) => !configuredScopes.has(scope));
  const previousEffectiveScopes = "effectiveScopes" in grant ? grant.effectiveScopes : undefined;
  if (retainedScopes.length && (!previousEffectiveScopes || !sameStringSet(previousEffectiveScopes, effectiveScopes))) {
    logGrantScopes("hubspot_grant_scope_attenuated", retainedScopes);
  }
  return { ...grant, effectiveScopes };
}

async function revokeBrokerCredentials(
  refreshToken: string,
  brokerCredential: string,
  config: RuntimeConfig,
  fetcher: Fetcher,
): Promise<void> {
  const { response } = await brokerRequest(config, "/v1/oauth/tokens/revoke", {
    refreshToken,
    brokerCredential,
  }, fetcher);
  if (response.status !== 204) throw new BrokerOAuthError(502, "invalid_broker_revoke_response");
}

async function bestEffortRevokePayload(
  payload: unknown,
  config: RuntimeConfig,
  fetcher: Fetcher,
): Promise<void> {
  if (!isRecord(payload)) return;
  const refreshToken = nonEmptyString(payload.refreshToken);
  const brokerCredential = nonEmptyString(payload.brokerCredential);
  if (!refreshToken || !brokerCredential || !BROKER_CREDENTIAL_PATTERN.test(brokerCredential)) return;
  try {
    await revokeBrokerCredentials(refreshToken, brokerCredential, config, fetcher);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "broker_compensating_revoke_failed",
      code: error instanceof BrokerOAuthError ? error.code : "unexpected_error",
    }));
  }
}

export async function exchangeBrokerSession(
  sessionId: string,
  completionGrant: string,
  consumeSecret: string,
  codeVerifier: string,
  config: RuntimeConfig,
  fetcher: Fetcher = fetch,
): Promise<HubSpotGrantProps> {
  if (!SESSION_ID_PATTERN.test(sessionId) || !SESSION_SECRET_PATTERN.test(completionGrant)) {
    throw new BrokerOAuthError(400, "invalid_broker_completion");
  }
  if (!SESSION_SECRET_PATTERN.test(consumeSecret) || !PKCE_VERIFIER_PATTERN.test(codeVerifier)) {
    throw new BrokerOAuthError(400, "invalid_broker_session_proof");
  }
  const { response, payload } = await brokerRequest(
    config,
    `/v1/oauth/sessions/${sessionId}/exchange`,
    { codeVerifier, completionGrant },
    fetcher,
    consumeSecret,
  );
  if (response.status !== 200) throw new BrokerOAuthError(502, "invalid_broker_exchange_response");
  try {
    return attenuateConfiguredGrant(parseBrokerGrant(payload), config);
  } catch (error) {
    await bestEffortRevokePayload(payload, config, fetcher);
    throw error;
  }
}

function assertRefreshContinuity(current: HubSpotGrantProps, refreshed: HubSpotGrantProps): void {
  if (
    refreshed.hubId !== current.hubId
    || refreshed.userId !== current.userId
    || refreshed.clientId !== current.clientId
    || refreshed.isUserLevel !== current.isUserLevel
    || Boolean(current.hubDomain && refreshed.hubDomain && refreshed.hubDomain !== current.hubDomain)
    || !sameStringSet(refreshed.scopes, current.scopes)
    || !sameStringSet(refreshed.effectiveScopes, current.effectiveScopes)
  ) {
    throw new BrokerOAuthError(403, "hubspot_refresh_identity_changed");
  }
}

export async function refreshHubSpotGrant(
  current: HubSpotGrantProps,
  config: RuntimeConfig,
  fetcher: Fetcher = fetch,
): Promise<HubSpotGrantProps> {
  const { response, payload } = await brokerRequest(config, "/v1/oauth/tokens/refresh", {
    refreshToken: current.refreshToken,
    brokerCredential: current.brokerCredential,
    expectedHubId: String(current.hubId),
  }, fetcher);
  if (response.status !== 200) throw new BrokerOAuthError(502, "invalid_broker_refresh_response");
  try {
    const refreshed = attenuateConfiguredGrant(parseBrokerGrant(payload), config);
    assertRefreshContinuity(current, refreshed);
    return !refreshed.hubDomain && current.hubDomain
      ? { ...refreshed, hubDomain: current.hubDomain }
      : refreshed;
  } catch (error) {
    await bestEffortRevokePayload(payload, config, fetcher);
    throw error;
  }
}

export async function revokeBrokerGrant(
  grant: HubSpotGrantProps,
  config: RuntimeConfig,
  fetcher: Fetcher = fetch,
): Promise<void> {
  await revokeBrokerCredentials(grant.refreshToken, grant.brokerCredential, config, fetcher);
}

export function toAccessProps(
  props: HubSpotGrantProps,
  mcpClientId: string,
  mcpScopes: string[],
  mcpAccessTokenExpiresAtMs: number,
): HubSpotAccessProps {
  return {
    version: 1,
    accessToken: props.accessToken,
    accessTokenExpiresAtMs: props.accessTokenExpiresAtMs,
    hubId: props.hubId,
    userId: props.userId,
    ...(props.hubDomain ? { hubDomain: props.hubDomain } : {}),
    scopes: [...props.effectiveScopes],
    isUserLevel: props.isUserLevel,
    clientId: props.clientId,
    mcpClientId,
    mcpScopes: [...mcpScopes],
    mcpAccessTokenExpiresAtMs,
  };
}

export function validateGrantProps(value: unknown): HubSpotGrantProps {
  if (!isRecord(value)) throw new OAuthError("invalid_grant", { description: "The upstream grant is unavailable." });
  const accessToken = nonEmptyString(value.accessToken);
  const refreshToken = nonEmptyString(value.refreshToken);
  const brokerCredential = nonEmptyString(value.brokerCredential);
  const hubId = positiveInteger(value.hubId);
  const userId = positiveInteger(value.userId);
  const expiresAt = positiveInteger(value.accessTokenExpiresAtMs);
  const scopes = stringArray(value.scopes);
  const effectiveScopes = value.effectiveScopes === undefined ? scopes : stringArray(value.effectiveScopes);
  const clientId = nonEmptyString(value.clientId);
  if (
    value.version !== 1
    || !accessToken
    || !refreshToken
    || !brokerCredential
    || !BROKER_CREDENTIAL_PATTERN.test(brokerCredential)
    || !hubId
    || !userId
    || !expiresAt
    || !scopes
    || !effectiveScopes
    || !clientId
    || typeof value.isUserLevel !== "boolean"
  ) {
    throw new OAuthError("invalid_grant", { description: "The upstream grant is unavailable." });
  }
  const hubDomain = nonEmptyString(value.hubDomain);
  return {
    version: 1,
    accessToken,
    refreshToken,
    brokerCredential,
    accessTokenExpiresAtMs: expiresAt,
    hubId,
    userId,
    ...(hubDomain ? { hubDomain } : {}),
    scopes,
    effectiveScopes,
    isUserLevel: value.isUserLevel,
    clientId,
  };
}

function oauthErrorFromBroker(error: BrokerOAuthError): OAuthError {
  if (error.status === 429) {
    return new OAuthError("temporarily_unavailable", {
      description: "The OAuth broker temporarily rate limited token refresh.",
      statusCode: 429,
      headers: { "Retry-After": error.retryAfter ?? "60" },
    });
  }
  if ([400, 401, 403, 409, 410].includes(error.status)) {
    return new OAuthError("invalid_grant", { description: "The HubSpot authorization must be renewed." });
  }
  return new OAuthError("temporarily_unavailable", {
    description: "The OAuth broker is temporarily unavailable.",
    statusCode: 503,
  });
}

export async function handleTokenExchange(
  options: TokenExchangeCallbackOptions,
  config: RuntimeConfig,
  fetcher: Fetcher = fetch,
): Promise<TokenExchangeCallbackResult> {
  if (options.grantType === GrantType.TOKEN_EXCHANGE || options.grantType === GrantType.JWT_BEARER) {
    throw new OAuthError("unsupported_grant_type", { description: "This token exchange grant is disabled." });
  }

  let props = validateGrantProps(options.props);
  try {
    props = attenuateConfiguredGrant(props, config);
  } catch (error) {
    if (error instanceof BrokerOAuthError) {
      await bestEffortRevokePayload(props, config, fetcher);
      throw oauthErrorFromBroker(error);
    }
    throw error;
  }
  const remainingSeconds = Math.floor((props.accessTokenExpiresAtMs - Date.now()) / 1000);
  if (remainingSeconds <= config.mcpAccessTokenTtlSeconds + 30) {
    try {
      props = await refreshHubSpotGrant(props, config, fetcher);
    } catch (error) {
      if (error instanceof BrokerOAuthError) throw oauthErrorFromBroker(error);
      throw new OAuthError("temporarily_unavailable", { description: "The OAuth broker is temporarily unavailable.", statusCode: 503 });
    }
  }

  const updatedRemainingSeconds = Math.floor((props.accessTokenExpiresAtMs - Date.now()) / 1000);
  const accessTokenTTL = Math.min(config.mcpAccessTokenTtlSeconds, updatedRemainingSeconds - 30);
  if (accessTokenTTL < 60) {
    throw new OAuthError("temporarily_unavailable", {
      description: "The upstream authorization could not be renewed.",
      statusCode: 503,
    });
  }
  return {
    newProps: props,
    accessTokenProps: toAccessProps(
      props,
      options.clientId,
      options.requestedScope,
      Date.now() + accessTokenTTL * 1000,
    ),
    accessTokenTTL,
  };
}

export function allowedMcpScopes(request: AuthRequest, config: RuntimeConfig): string[] {
  const supported = new Set(["hsapi.read", ...(config.remoteWritesEnabled ? ["hsapi.write"] : [])]);
  return request.scope.filter((scope) => supported.has(scope));
}
