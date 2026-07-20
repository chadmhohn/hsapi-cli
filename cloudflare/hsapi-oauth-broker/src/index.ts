import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";

const SERVICE_NAME = "hsapi-oauth-broker";
const SESSION_TTL_SECONDS = 10 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1_000;
const CALLBACK_TTL_MS = 2 * 60 * 1_000;
const RETRY_AFTER_SECONDS = 1;
const MAX_REQUEST_JSON_BODY_BYTES = 64 * 1024;
const MAX_UPSTREAM_JSON_BODY_BYTES = 1024 * 1024;
const HUBSPOT_UPSTREAM_TIMEOUT_MS = 20 * 1_000;
const HUBSPOT_TOKEN_URL = "https://api.hubspot.com/oauth/2026-03/token";
const HUBSPOT_REVOKE_URL =
  "https://api.hubspot.com/oauth/2026-03/token/revoke";
const BASE64URL_SHA256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const CONSUME_SECRET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const BROKER_SESSION_START_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ACCOUNT_ID_PATTERN = /^[1-9][0-9]*$/;
const CLIENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BROKER_CREDENTIAL_PATTERN = /^v1\.([A-Za-z0-9_-]{43})$/;
const CONFIGURATION_PLACEHOLDER_PATTERN =
  /\b(?:replace|changeme|placeholder)\b/i;

type JsonRecord = Record<string, unknown>;

type SessionStatus =
  | "awaiting_callback"
  | "authorization_error"
  | "authorization_ready"
  | "exchanging"
  | "completed";

interface SessionRow extends Record<string, SqlStorageValue> {
  status: SessionStatus;
  consume_secret_hash: string | null;
  code_challenge: string | null;
  oauth_configuration_hash: string | null;
  authorization_code: string | null;
  oauth_error: string | null;
  created_at: number;
  expires_at: number;
  exchange_started_at: number | null;
  exchange_attempt_id: string | null;
}

type CallbackResult =
  | "stored"
  | "already_received"
  | "expired"
  | "unavailable";

type BeginExchangeResult =
  | {
      kind: "ready";
      authorizationCode: string;
      attemptId: string;
    }
  | { kind: "pending" }
  | { kind: "authorization_error"; oauthError: string }
  | { kind: "unauthorized" }
  | { kind: "configuration_changed" }
  | { kind: "in_progress" }
  | { kind: "consumed" }
  | { kind: "expired" };

interface HubSpotToken {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  hubId?: number;
  userId?: number;
  scopes?: string[];
}

interface RuntimeConfiguration {
  accountId: string;
  clientId: string;
  clientSecret: string;
  sessionStartKey: string;
  redirectUri: string;
  requiredScopes: string[];
  optionalScopes: string[];
  signingKey: string;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers?: HeadersInit;

  constructor(
    status: number,
    code: string,
    message: string,
    headers?: HeadersInit,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

class UpstreamOAuthError extends Error {
  readonly upstreamStatus: number;
  readonly oauthError?: string;

  constructor(upstreamStatus: number, oauthError?: string) {
    super("HubSpot rejected the OAuth request.");
    this.name = "UpstreamOAuthError";
    this.upstreamStatus = upstreamStatus;
    this.oauthError = oauthError;
  }
}

export class OAuthSession extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS oauth_session (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          status TEXT NOT NULL,
          consume_secret_hash TEXT,
          code_challenge TEXT,
          oauth_configuration_hash TEXT,
          authorization_code TEXT,
          oauth_error TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          exchange_started_at INTEGER,
          exchange_attempt_id TEXT
        )
      `);
      const columns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(oauth_session)")
        .toArray();
      if (!columns.some((column) => column.name === "oauth_configuration_hash")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE oauth_session ADD COLUMN oauth_configuration_hash TEXT",
        );
      }
      if (!columns.some((column) => column.name === "exchange_attempt_id")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE oauth_session ADD COLUMN exchange_attempt_id TEXT",
        );
      }
    });
  }

  async createSession(
    consumeSecretHash: string,
    codeChallenge: string,
    oauthConfigurationHash: string,
    createdAt: number,
    expiresAt: number,
  ): Promise<boolean> {
    const existing = this.readSession();
    if (existing && existing.expires_at > createdAt) {
      return false;
    }

    this.ctx.storage.sql.exec("DELETE FROM oauth_session");
    this.ctx.storage.sql.exec(
      `INSERT INTO oauth_session (
         singleton,
         status,
         consume_secret_hash,
         code_challenge,
         oauth_configuration_hash,
         authorization_code,
         oauth_error,
         created_at,
         expires_at,
         exchange_started_at,
         exchange_attempt_id
       ) VALUES (1, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL)`,
      "awaiting_callback",
      consumeSecretHash,
      codeChallenge,
      oauthConfigurationHash,
      createdAt,
      expiresAt,
    );
    await this.ctx.storage.setAlarm(expiresAt);
    return true;
  }

  async recordAuthorizationCode(
    code: string,
    oauthConfigurationHash: string,
    now: number,
  ): Promise<CallbackResult> {
    const session = this.readSession();
    if (!session) {
      return "unavailable";
    }
    if (session.expires_at <= now) {
      return "expired";
    }
    if (
      session.oauth_configuration_hash === null ||
      !timingSafeEqualBase64Url(
        oauthConfigurationHash,
        session.oauth_configuration_hash,
      )
    ) {
      return "unavailable";
    }
    if (session.status === "authorization_ready") {
      return "already_received";
    }
    if (session.status !== "awaiting_callback") {
      return "unavailable";
    }

    const expiresAt = Math.min(
      session.expires_at,
      now + CALLBACK_TTL_MS,
    );
    this.ctx.storage.sql.exec(
      `UPDATE oauth_session
       SET status = ?,
           authorization_code = ?,
           oauth_error = NULL,
           expires_at = ?
       WHERE singleton = 1`,
      "authorization_ready",
      code,
      expiresAt,
    );
    await this.ctx.storage.setAlarm(expiresAt);
    return "stored";
  }

  async recordAuthorizationError(
    oauthError: string,
    oauthConfigurationHash: string,
    now: number,
  ): Promise<CallbackResult> {
    const session = this.readSession();
    if (!session) {
      return "unavailable";
    }
    if (session.expires_at <= now) {
      return "expired";
    }
    if (
      session.oauth_configuration_hash === null ||
      !timingSafeEqualBase64Url(
        oauthConfigurationHash,
        session.oauth_configuration_hash,
      )
    ) {
      return "unavailable";
    }
    if (
      session.status === "authorization_error" ||
      session.status === "authorization_ready"
    ) {
      return "already_received";
    }
    if (session.status !== "awaiting_callback") {
      return "unavailable";
    }

    const expiresAt = Math.min(
      session.expires_at,
      now + CALLBACK_TTL_MS,
    );
    this.ctx.storage.sql.exec(
      `UPDATE oauth_session
       SET status = ?,
           oauth_error = ?,
           authorization_code = NULL,
           expires_at = ?
       WHERE singleton = 1`,
      "authorization_error",
      oauthError,
      expiresAt,
    );
    await this.ctx.storage.setAlarm(expiresAt);
    return "stored";
  }

  beginExchange(
    consumeSecretHash: string,
    codeChallenge: string,
    oauthConfigurationHash: string,
    now: number,
  ): BeginExchangeResult {
    const session = this.readSession();
    if (!session) {
      return { kind: "unauthorized" };
    }

    const secretMatches =
      session.consume_secret_hash !== null &&
      timingSafeEqualBase64Url(
        consumeSecretHash,
        session.consume_secret_hash,
      );
    const challengeMatches =
      session.code_challenge !== null &&
      timingSafeEqualBase64Url(codeChallenge, session.code_challenge);
    if (!secretMatches || !challengeMatches) {
      return { kind: "unauthorized" };
    }
    const configurationMatches =
      session.oauth_configuration_hash !== null &&
      timingSafeEqualBase64Url(
        oauthConfigurationHash,
        session.oauth_configuration_hash,
      );
    if (!configurationMatches) {
      return { kind: "configuration_changed" };
    }
    if (session.expires_at <= now) {
      return { kind: "expired" };
    }
    if (session.status === "awaiting_callback") {
      return { kind: "pending" };
    }
    if (session.status === "authorization_error") {
      return {
        kind: "authorization_error",
        oauthError: session.oauth_error ?? "authorization_denied",
      };
    }
    if (session.status === "completed") {
      return { kind: "consumed" };
    }
    if (session.status === "exchanging") {
      return { kind: "in_progress" };
    }

    if (!session.authorization_code) {
      return { kind: "pending" };
    }

    const attemptId = randomToken(32);
    const transition = this.ctx.storage.sql.exec(
      `UPDATE oauth_session
       SET status = ?, exchange_started_at = ?, exchange_attempt_id = ?
       WHERE singleton = 1 AND status = ?`,
      "exchanging",
      now,
      attemptId,
      "authorization_ready",
    );
    if (transition.rowsWritten !== 1) {
      return { kind: "in_progress" };
    }
    return {
      kind: "ready",
      authorizationCode: session.authorization_code,
      attemptId,
    };
  }

  finishExchange(attemptId: string, succeeded: boolean): boolean {
    if (!SESSION_ID_PATTERN.test(attemptId)) {
      return false;
    }
    const transition = this.ctx.storage.sql.exec(
      `UPDATE oauth_session
       SET status = ?,
           authorization_code = NULL,
           oauth_error = ?,
           exchange_started_at = NULL,
           exchange_attempt_id = NULL
       WHERE singleton = 1
         AND status = ?
         AND exchange_attempt_id = ?`,
      "completed",
      succeeded ? null : "exchange_failed",
      "exchanging",
      attemptId,
    );
    return transition.rowsWritten === 1;
  }

  override async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM oauth_session");
    await this.ctx.storage.deleteAlarm();
  }

  private readSession(): SessionRow | undefined {
    return this.ctx.storage.sql
      .exec<SessionRow>(
        `SELECT
           status,
           consume_secret_hash,
           code_challenge,
           oauth_configuration_hash,
           authorization_code,
           oauth_error,
           created_at,
           expires_at,
           exchange_started_at,
           exchange_attempt_id
         FROM oauth_session
         WHERE singleton = 1`,
      )
      .toArray()[0];
  }
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/healthz") {
    requireMethod(request, "GET");
    return jsonResponse({
      ok: true,
      service: SERVICE_NAME,
      environment: env.ENVIRONMENT,
      ready: isRuntimeConfigured(env),
    });
  }

  if (url.pathname === "/v1/oauth/sessions") {
    requireMethod(request, "POST");
    return startSession(request, env);
  }

  if (url.pathname === "/v1/oauth/callback") {
    requireMethod(request, "GET");
    return receiveCallback(request, url, env);
  }

  if (url.pathname === "/v1/oauth/complete") {
    requireMethod(request, "GET");
    return callbackPage(true, 200);
  }

  const exchangeMatch = url.pathname.match(
    /^\/v1\/oauth\/sessions\/([A-Za-z0-9_-]{43})\/exchange$/,
  );
  if (exchangeMatch) {
    requireMethod(request, "POST");
    const sessionId = exchangeMatch[1];
    if (!sessionId) {
      throw new HttpError(400, "invalid_session", "Invalid session.");
    }
    return exchangeSession(request, env, sessionId);
  }

  if (url.pathname === "/v1/oauth/tokens/refresh") {
    requireMethod(request, "POST");
    return refreshToken(request, env);
  }

  if (url.pathname === "/v1/oauth/tokens/revoke") {
    requireMethod(request, "POST");
    return revokeToken(request, env);
  }

  throw new HttpError(404, "not_found", "Endpoint not found.");
}

async function startSession(request: Request, env: Env): Promise<Response> {
  const config = requireRuntimeConfiguration(env);
  requireSessionStartCredential(request, config.sessionStartKey);
  const body = await readJsonRecord(request);
  rejectUnknownKeys(body, [
    "accountId",
    "codeChallenge",
    "consumeSecretHash",
  ]);

  const codeChallenge = requireString(body, "codeChallenge");
  const consumeSecretHash = requireString(body, "consumeSecretHash");
  const requestedAccountId = optionalString(body, "accountId");

  if (!BASE64URL_SHA256_PATTERN.test(codeChallenge)) {
    throw new HttpError(
      400,
      "invalid_code_challenge",
      "codeChallenge must be an RFC 7636 S256 base64url digest.",
    );
  }
  if (!BASE64URL_SHA256_PATTERN.test(consumeSecretHash)) {
    throw new HttpError(
      400,
      "invalid_consume_secret_hash",
      "consumeSecretHash must be a base64url SHA-256 digest.",
    );
  }
  if (
    requestedAccountId !== undefined &&
    requestedAccountId !== config.accountId
  ) {
    throw new HttpError(
      400,
      "account_not_allowed",
      "The requested HubSpot account is not allowed by this broker.",
    );
  }

  const sourceKey = request.headers.get("CF-Connecting-IP") ?? "unknown";
  await enforceRateLimit(env, `start:${sourceKey}`);

  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  const configurationHash = await oauthConfigurationHash(config);
  let sessionId = "";
  let created = false;
  for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
    sessionId = randomToken(32);
    const stub = sessionNamespace(env).getByName(sessionId);
    created = await stub.createSession(
      consumeSecretHash,
      codeChallenge,
      configurationHash,
      now,
      expiresAt,
    );
  }
  if (!created) {
    throw new HttpError(
      503,
      "session_unavailable",
      "Unable to allocate an OAuth session.",
    );
  }

  return jsonResponse(
    {
      sessionId,
      authorizationUrl: buildAuthorizationUrl(
        config,
        sessionId,
        codeChallenge,
      ),
      expiresIn: SESSION_TTL_SECONDS,
      interval: RETRY_AFTER_SECONDS,
    },
    201,
  );
}

async function receiveCallback(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  if (!SESSION_ID_PATTERN.test(state)) {
    return callbackPage(false, 400);
  }
  const codes = url.searchParams.getAll("code");
  const oauthErrors = url.searchParams.getAll("error");
  const hasSingleCode =
    codes.length === 1 && oauthErrors.length === 0;
  const hasSingleError =
    codes.length === 0 && oauthErrors.length === 1;
  if (
    url.searchParams.getAll("state").length !== 1 ||
    (!hasSingleCode && !hasSingleError)
  ) {
    return callbackPage(false, 400);
  }

  await enforceRateLimit(
    env,
    `callback-ip:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
  );
  await enforceRateLimit(env, `callback-state:${state}`);
  const stub = sessionNamespace(env).getByName(state);
  const config = requireRuntimeConfiguration(env);
  const configurationHash = await oauthConfigurationHash(config);
  const oauthError = oauthErrors[0];
  let result: CallbackResult;

  if (oauthError !== undefined && oauthError.length > 0) {
    result = await stub.recordAuthorizationError(
      sanitizeOAuthError(oauthError),
      configurationHash,
      Date.now(),
    );
  } else {
    const code = codes[0];
    if (!code || code.length > 8_192) {
      return callbackPage(false, 400);
    }
    result = await stub.recordAuthorizationCode(
      code,
      configurationHash,
      Date.now(),
    );
  }

  if (result === "expired" || result === "unavailable") {
    return callbackPage(false, 410);
  }
  return completionRedirect();
}

async function exchangeSession(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  const config = requireRuntimeConfiguration(env);
  const rawConsumeSecret = requireBearerToken(request);
  if (!CONSUME_SECRET_PATTERN.test(rawConsumeSecret)) {
    throw new HttpError(
      401,
      "invalid_session_credential",
      "Invalid session credential.",
    );
  }

  const body = await readJsonRecord(request);
  rejectUnknownKeys(body, ["codeVerifier"]);
  const codeVerifier = requireString(body, "codeVerifier");
  if (!PKCE_VERIFIER_PATTERN.test(codeVerifier)) {
    throw new HttpError(
      400,
      "invalid_code_verifier",
      "codeVerifier is not a valid RFC 7636 verifier.",
    );
  }

  const [consumeSecretHash, codeChallenge] = await Promise.all([
    sha256Base64Url(rawConsumeSecret),
    sha256Base64Url(codeVerifier),
  ]);
  const configurationHash = await oauthConfigurationHash(config);
  await enforceRateLimit(
    env,
    `exchange-ip:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
  );
  await enforceRateLimit(env, `exchange:${sessionId}`);

  const stub = sessionNamespace(env).getByName(sessionId);
  const exchange = await stub.beginExchange(
    consumeSecretHash,
    codeChallenge,
    configurationHash,
    Date.now(),
  );

  if (exchange.kind === "pending") {
    return jsonResponse(
      { status: "pending" },
      202,
      { "Retry-After": String(RETRY_AFTER_SECONDS) },
    );
  }
  if (exchange.kind === "authorization_error") {
    throw new HttpError(
      400,
      exchange.oauthError,
      "HubSpot authorization was not completed.",
    );
  }
  if (exchange.kind === "unauthorized") {
    throw new HttpError(
      401,
      "invalid_session_credential",
      "Invalid session credential.",
    );
  }
  if (exchange.kind === "configuration_changed") {
    throw new HttpError(
      409,
      "session_configuration_changed",
      "The OAuth broker configuration changed; start a new session.",
    );
  }
  if (exchange.kind === "in_progress") {
    throw new HttpError(
      409,
      "exchange_in_progress",
      "Token exchange is already in progress.",
      { "Retry-After": String(RETRY_AFTER_SECONDS) },
    );
  }
  if (exchange.kind === "consumed") {
    throw new HttpError(
      409,
      "session_consumed",
      "This OAuth session has already been consumed.",
    );
  }
  if (exchange.kind === "expired") {
    throw new HttpError(
      410,
      "session_expired",
      "This OAuth session is unavailable or expired.",
    );
  }

  let issuedRefreshToken: string | undefined;
  try {
    const signingKey = await importSigningKey(config.signingKey);
    const token = await requestHubSpotToken(config, {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: exchange.authorizationCode,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
    });
    issuedRefreshToken = token.refreshToken;
    assertAllowedAccount(config, token);
    const brokerCredential = await issueBrokerCredential(
      signingKey,
      token.refreshToken,
    );
    const committed = await stub.finishExchange(
      exchange.attemptId,
      true,
    );
    if (!committed) {
      throw new HttpError(
        409,
        "exchange_superseded",
        "The OAuth exchange no longer belongs to this session.",
      );
    }
    const response = jsonResponse({
      ...token,
      brokerCredential,
    });
    issuedRefreshToken = undefined;
    return response;
  } catch (error) {
    try {
      await stub.finishExchange(exchange.attemptId, false);
    } catch {
      // Preserve the primary exchange failure.
    }
    if (issuedRefreshToken !== undefined) {
      await bestEffortRevokeHubSpotRefreshToken(
        config,
        issuedRefreshToken,
      );
    }
    throw error;
  }
}

async function refreshToken(request: Request, env: Env): Promise<Response> {
  const config = requireRuntimeConfiguration(env);
  const body = await readJsonRecord(request);
  rejectUnknownKeys(body, ["brokerCredential", "refreshToken"]);
  const refreshTokenValue = requireString(body, "refreshToken");
  const brokerCredential = requireString(body, "brokerCredential");
  const signingKey = await importSigningKey(config.signingKey);

  const refreshTokenDigest = await sha256Base64Url(refreshTokenValue);
  await enforceRateLimit(
    env,
    `refresh-ip:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
  );
  await enforceRateLimit(env, `refresh:${refreshTokenDigest}`);
  if (
    !(await verifyBrokerCredential(
      signingKey,
      refreshTokenValue,
      brokerCredential,
    ))
  ) {
    throw new HttpError(
      401,
      "invalid_broker_credential",
      "Invalid broker credential.",
    );
  }

  let issuedRefreshToken: string | undefined;
  try {
    const token = await requestHubSpotToken(
      config,
      {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshTokenValue,
      },
      refreshTokenValue,
    );
    issuedRefreshToken = token.refreshToken;
    assertAllowedAccount(config, token);
    const replacementCredential = await issueBrokerCredential(
      signingKey,
      token.refreshToken,
    );
    const response = jsonResponse({
      ...token,
      brokerCredential: replacementCredential,
    });
    issuedRefreshToken = undefined;
    return response;
  } catch (error) {
    if (issuedRefreshToken !== undefined) {
      await bestEffortRevokeHubSpotRefreshToken(
        config,
        issuedRefreshToken,
      );
    }
    throw error;
  }
}

async function revokeToken(request: Request, env: Env): Promise<Response> {
  const config = requireRuntimeConfiguration(env);
  const body = await readJsonRecord(request);
  rejectUnknownKeys(body, ["brokerCredential", "refreshToken"]);
  const refreshTokenValue = requireString(body, "refreshToken");
  const brokerCredential = requireString(body, "brokerCredential");
  const signingKey = await importSigningKey(config.signingKey);

  const refreshTokenDigest = await sha256Base64Url(refreshTokenValue);
  await enforceRateLimit(
    env,
    `revoke-ip:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
  );
  await enforceRateLimit(env, `revoke:${refreshTokenDigest}`);
  if (
    !(await verifyBrokerCredential(
      signingKey,
      refreshTokenValue,
      brokerCredential,
    ))
  ) {
    throw new HttpError(
      401,
      "invalid_broker_credential",
      "Invalid broker credential.",
    );
  }

  await revokeHubSpotRefreshToken(config, refreshTokenValue);
  return emptyResponse(204);
}

async function revokeHubSpotRefreshToken(
  config: RuntimeConfiguration,
  refreshTokenValue: string,
): Promise<void> {
  await withHubSpotOAuthResponse(
    HUBSPOT_REVOKE_URL,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        token: refreshTokenValue,
        token_type_hint: "refresh_token",
      }),
    },
    async (response) => {
      if (!response.ok) {
        throw await upstreamError(response);
      }
      if (response.body) {
        await response.body.cancel();
      }
    },
  );
}

async function bestEffortRevokeHubSpotRefreshToken(
  config: RuntimeConfiguration,
  refreshTokenValue: string,
): Promise<void> {
  try {
    await revokeHubSpotRefreshToken(config, refreshTokenValue);
  } catch {
    // Never mask the primary exchange error with cleanup failure.
  }
}

async function requestHubSpotToken(
  config: RuntimeConfiguration,
  parameters: Record<string, string>,
  fallbackRefreshToken?: string,
): Promise<HubSpotToken> {
  return withHubSpotOAuthResponse(
    HUBSPOT_TOKEN_URL,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(parameters),
    },
    async (response) => {
      if (!response.ok) {
        throw await upstreamError(response);
      }
      const payload = await readLimitedUpstreamJson(response);
      return normalizeHubSpotToken(payload, fallbackRefreshToken);
    },
  );
}

async function withHubSpotOAuthResponse<T>(
  input: string,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    HUBSPOT_UPSTREAM_TIMEOUT_MS,
  );
  try {
    let response: Response;
    try {
      response = await fetch(input, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "hubspot_oauth_transport_failed",
          phase: "fetch",
          kind: controller.signal.aborted ? "timeout" : "network",
          errorName: error instanceof Error ? error.name : typeof error,
        }),
      );
      throw new UpstreamOAuthError(
        502,
        controller.signal.aborted ? "upstream_timeout" : "upstream_network_error",
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new UpstreamOAuthError(502, "upstream_redirect");
    }
    return await consume(response);
  } catch (error) {
    if (error instanceof UpstreamOAuthError || error instanceof HttpError) {
      throw error;
    }
    console.error(
      JSON.stringify({
        event: "hubspot_oauth_transport_failed",
        phase: "consume",
        kind: "unexpected",
        errorName: error instanceof Error ? error.name : typeof error,
      }),
    );
    throw new UpstreamOAuthError(
      502,
      "upstream_response_error",
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readLimitedUpstreamJson(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new UpstreamOAuthError(502, "invalid_upstream_response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UPSTREAM_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new UpstreamOAuthError(502, "upstream_response_too_large");
      }
      chunks.push(value);
    }
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
    throw new UpstreamOAuthError(502, "invalid_upstream_response");
  }
}

function normalizeHubSpotToken(
  payload: unknown,
  fallbackRefreshToken?: string,
): HubSpotToken {
  if (!isJsonRecord(payload)) {
    throw new UpstreamOAuthError(502, "invalid_upstream_response");
  }
  const accessToken = nonEmptyString(payload.access_token);
  const refreshTokenValue =
    nonEmptyString(payload.refresh_token) ?? fallbackRefreshToken;
  const expiresIn = finiteNumber(payload.expires_in);
  const tokenType = nonEmptyString(payload.token_type);
  if (
    !accessToken ||
    !refreshTokenValue ||
    expiresIn === undefined ||
    !Number.isInteger(expiresIn) ||
    expiresIn <= 0 ||
    !tokenType
  ) {
    throw new UpstreamOAuthError(502, "invalid_upstream_response");
  }

  const result: HubSpotToken = {
    accessToken,
    refreshToken: refreshTokenValue,
    expiresIn,
    tokenType,
  };
  const hubId = finiteNumber(payload.hub_id);
  const userId = finiteNumber(payload.user_id);
  const scopes = stringArray(payload.scopes);
  if (hubId !== undefined) {
    result.hubId = hubId;
  }
  if (userId !== undefined) {
    result.userId = userId;
  }
  if (scopes !== undefined) {
    result.scopes = scopes;
  }
  return result;
}

async function upstreamError(response: Response): Promise<UpstreamOAuthError> {
  let oauthError: string | undefined;
  try {
    const payload = await readLimitedUpstreamJson(response);
    if (isJsonRecord(payload)) {
      oauthError = sanitizeOAuthError(
        nonEmptyString(payload.error) ?? "hubspot_oauth_error",
      );
    }
  } catch {
    oauthError = "hubspot_oauth_error";
  }
  return new UpstreamOAuthError(response.status, oauthError);
}

function assertAllowedAccount(
  config: RuntimeConfiguration,
  token: HubSpotToken,
): void {
  if (token.hubId === undefined) {
    throw new UpstreamOAuthError(502, "missing_hub_id");
  }
  if (
    String(token.hubId) !== config.accountId
  ) {
    throw new HttpError(
      403,
      "account_mismatch",
      "HubSpot returned a token for a different account.",
    );
  }
}

function buildAuthorizationUrl(
  config: RuntimeConfiguration,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL(
    `/oauth/${encodeURIComponent(config.accountId)}/authorize`,
    "https://app.hubspot.com",
  );
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.requiredScopes.join(" "));
  if (config.optionalScopes.length > 0) {
    url.searchParams.set(
      "optional_scope",
      config.optionalScopes.join(" "),
    );
  }
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function issueBrokerCredential(
  signingKey: CryptoKey,
  refreshTokenValue: string,
): Promise<string> {
  const payload = await brokerCredentialPayload(refreshTokenValue);
  const signature = await crypto.subtle.sign("HMAC", signingKey, payload);
  return `v1.${base64UrlFromBytes(new Uint8Array(signature))}`;
}

async function verifyBrokerCredential(
  signingKey: CryptoKey,
  refreshTokenValue: string,
  credential: string,
): Promise<boolean> {
  const match = credential.match(BROKER_CREDENTIAL_PATTERN);
  const signatureText = match?.[1];
  if (!signatureText) {
    return false;
  }
  const payload = await brokerCredentialPayload(refreshTokenValue);
  const signature = base64UrlToBytes(signatureText);
  return crypto.subtle.verify("HMAC", signingKey, signature, payload);
}

async function brokerCredentialPayload(
  refreshTokenValue: string,
): Promise<Uint8Array> {
  const tokenDigest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(refreshTokenValue),
    ),
  );
  const version = new TextEncoder().encode("hsapi-oauth-broker:v1:");
  const payload = new Uint8Array(version.length + tokenDigest.length);
  payload.set(version);
  payload.set(tokenDigest, version.length);
  return payload;
}

async function importSigningKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64UrlFromBytes(new Uint8Array(digest));
}

async function oauthConfigurationHash(
  config: RuntimeConfiguration,
): Promise<string> {
  return sha256Base64Url(
    JSON.stringify({
      version: 1,
      accountId: config.accountId,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      requiredScopes: config.requiredScopes,
      optionalScopes: config.optionalScopes,
    }),
  );
}

function timingSafeEqualBase64Url(left: string, right: string): boolean {
  try {
    const leftBytes = base64UrlToBytes(left);
    const rightBytes = base64UrlToBytes(right);
    if (leftBytes.byteLength !== rightBytes.byteLength) {
      return false;
    }
    return timingSafeEqual(leftBytes, rightBytes);
  } catch {
    return false;
  }
}

function timingSafeEqualText(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

function sessionNamespace(
  env: Env,
): DurableObjectNamespace<OAuthSession> {
  return env.OAUTH_SESSIONS as DurableObjectNamespace<OAuthSession>;
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlFromBytes(bytes);
}

async function enforceRateLimit(env: Env, key: string): Promise<void> {
  const result = await env.AUTH_RATE_LIMITER.limit({ key });
  if (!result.success) {
    throw new HttpError(
      429,
      "rate_limited",
      "Too many requests.",
      { "Retry-After": "60" },
    );
  }
}

function requireRuntimeConfiguration(env: Env): RuntimeConfiguration {
  const clientId = String(env.HUBSPOT_CLIENT_ID ?? "").trim();
  const clientSecret = String(env.HUBSPOT_CLIENT_SECRET ?? "").trim();
  const sessionStartKey = String(env.BROKER_SESSION_START_KEY ?? "").trim();
  const redirectUri = String(env.HUBSPOT_REDIRECT_URI ?? "").trim();
  const accountId = String(env.HUBSPOT_ACCOUNT_ID ?? "").trim();
  const signingKey = String(env.BROKER_SIGNING_KEY ?? "");
  const requiredScopes = parseConfiguredScopes(env.HUBSPOT_REQUIRED_SCOPES);
  const optionalScopes = parseConfiguredScopes(env.HUBSPOT_OPTIONAL_SCOPES);
  const requiredScopeSet = new Set(requiredScopes ?? []);
  const secretsAreDistinct =
    !timingSafeEqualText(clientSecret, signingKey) &&
    !timingSafeEqualText(clientSecret, sessionStartKey) &&
    !timingSafeEqualText(signingKey, sessionStartKey);

  if (
    !CLIENT_ID_PATTERN.test(clientId) ||
    clientId === "00000000-0000-4000-8000-000000000001" ||
    !ACCOUNT_ID_PATTERN.test(accountId) ||
    clientSecret.length < 8 ||
    !BROKER_SESSION_START_KEY_PATTERN.test(sessionStartKey) ||
    signingKey.length < 32 ||
    requiredScopes === undefined ||
    optionalScopes === undefined ||
    requiredScopes.length === 0 ||
    !requiredScopes.includes("oauth") ||
    optionalScopes.includes("oauth") ||
    optionalScopes.some((scope) => requiredScopeSet.has(scope)) ||
    !secretsAreDistinct ||
    !isAllowedRedirectUri(redirectUri)
  ) {
    throw new HttpError(
      503,
      "broker_not_configured",
      "The OAuth broker is not fully configured.",
    );
  }
  return {
    accountId,
    clientId,
    clientSecret,
    sessionStartKey,
    redirectUri,
    requiredScopes,
    optionalScopes,
    signingKey,
  };
}

function isRuntimeConfigured(env: Env): boolean {
  try {
    requireRuntimeConfiguration(env);
    return true;
  } catch {
    return false;
  }
}

function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !CONFIGURATION_PLACEHOLDER_PATTERN.test(value) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/v1/oauth/callback" &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          (url.hostname === "localhost" || url.hostname === "127.0.0.1")))
    );
  } catch {
    return false;
  }
}

function parseConfiguredScopes(value: unknown): string[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const scopes = value
    .split(/[\s,]+/u)
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (
    new Set(scopes).size !== scopes.length ||
    !scopes.every(
      (scope) =>
        scope.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(scope),
    )
  ) {
    return undefined;
  }
  return scopes;
}

function requireMethod(request: Request, expected: string): void {
  if (request.method !== expected) {
    throw new HttpError(
      405,
      "method_not_allowed",
      "Method not allowed.",
      { Allow: expected },
    );
  }
}

async function readJsonRecord(request: Request): Promise<JsonRecord> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json.",
    );
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_REQUEST_JSON_BODY_BYTES
  ) {
    throw new HttpError(
      413,
      "request_too_large",
      "Request body is too large.",
    );
  }

  const text = await readBodyText(request, MAX_REQUEST_JSON_BODY_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON.");
  }
  if (!isJsonRecord(parsed)) {
    throw new HttpError(
      400,
      "invalid_json",
      "Request body must be a JSON object.",
    );
  }
  return parsed;
}

async function readBodyText(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) {
    return "";
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(
        413,
        "request_too_large",
        "Request body is too large.",
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: false,
  }).decode(bytes);
}

function rejectUnknownKeys(body: JsonRecord, allowed: string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw new HttpError(
      400,
      "unknown_field",
      "Request body contains an unknown field.",
    );
  }
}

function requireString(body: JsonRecord, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(
      400,
      "invalid_request",
      `${key} must be a non-empty string.`,
    );
  }
  return value;
}

function optionalString(body: JsonRecord, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(
      400,
      "invalid_request",
      `${key} must be a non-empty string when provided.`,
    );
  }
  return value;
}

function requireBearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer ([A-Za-z0-9\-._~]+)$/i);
  const token = match?.[1];
  if (!token) {
    throw new HttpError(
      401,
      "missing_session_credential",
      "A Bearer session credential is required.",
      { "WWW-Authenticate": "Bearer" },
    );
  }
  return token;
}

function requireSessionStartCredential(
  request: Request,
  expectedKey: string,
): void {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  const presentedKey = match?.[1];
  if (
    !presentedKey ||
    !timingSafeEqualBase64Url(presentedKey, expectedKey)
  ) {
    throw new HttpError(
      401,
      "invalid_broker_client",
      "A valid broker client credential is required to start OAuth.",
      { "WWW-Authenticate": "Bearer" },
    );
  }
}

function sanitizeOAuthError(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "_")
    .slice(0, 80);
  return sanitized || "authorization_error";
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
    ? value
    : undefined;
}

function securityHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

function jsonResponse(
  payload: unknown,
  status = 200,
  additionalHeaders?: HeadersInit,
): Response {
  const headers = securityHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (additionalHeaders) {
    const additions = new Headers(additionalHeaders);
    additions.forEach((value, key) => headers.set(key, value));
  }
  return Response.json(payload, { status, headers });
}

function emptyResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: securityHeaders(),
  });
}

function completionRedirect(): Response {
  const headers = securityHeaders();
  headers.set("Location", "/v1/oauth/complete");
  return new Response(null, {
    status: 303,
    headers,
  });
}

function callbackPage(success: boolean, status: number): Response {
  const headers = securityHeaders();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  const heading = success
    ? "HubSpot authorization complete"
    : "HubSpot authorization was not completed";
  const detail = success
    ? "You can close this window and return to hsapi."
    : "Return to hsapi for the next step or retry the login.";
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>${heading}</title><body><main><h1>${heading}</h1><p>${detail}</p></main></body></html>`,
    { status, headers },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse(
          { error: error.code, message: error.message },
          error.status,
          error.headers,
        );
      }
      if (error instanceof UpstreamOAuthError) {
        return jsonResponse(
          {
            error: "hubspot_oauth_error",
            oauthError: error.oauthError,
            upstreamStatus: error.upstreamStatus,
          },
          error.upstreamStatus >= 500 ? 502 : error.upstreamStatus,
        );
      }

      // Never log exceptions, request URLs, bodies, codes, or tokens here.
      console.error(
        JSON.stringify({ event: "broker_request_failed", kind: "internal" }),
      );
      return jsonResponse(
        { error: "internal_error", message: "Internal server error." },
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;
