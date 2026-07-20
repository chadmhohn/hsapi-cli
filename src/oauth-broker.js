// Hosted OAuth broker transport. The broker owns the HubSpot app credentials;
// the CLI owns PKCE material, the one-time session consume secret, and the
// resulting per-user token cache. Response errors are deliberately reduced to
// status + a short machine code so broker responses cannot echo credentials.
const { configString } = require('./flags');

// HubSpot does not define a maximum access-token size. Keep a defensive whole-
// response bound without assuming today's token length is permanent.
const BROKER_RESPONSE_LIMIT_BYTES = 1024 * 1024;
// Keep the client timeout longer than the Worker's bounded HubSpot upstream
// timeout so a sanitized broker error arrives before the CLI aborts.
const BROKER_REQUEST_TIMEOUT_MS = 40000;
const BROKER_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HUBSPOT_AUTHORIZE_ORIGIN = 'https://app.hubspot.com';

function brokerEndpoint(source, relativePath) {
  const base = new URL(source.brokerUrl);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return new URL(String(relativePath).replace(/^\/+/, ''), base);
}

function brokerErrorCode(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const candidate = configString(payload.code) || configString(payload.error);
  return candidate && /^[A-Za-z0-9._-]{1,80}$/.test(candidate) ? candidate : null;
}

function brokerHttpError(action, response, payload) {
  const code = brokerErrorCode(payload);
  const codeText = code ? ` code ${code}` : '';
  return new Error(`${action}: hosted OAuth broker returned HTTP ${response.status}${codeText}.`);
}

async function readLimitedJson(response, action) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > BROKER_RESPONSE_LIMIT_BYTES) {
        await reader.cancel();
        throw new Error(`${action}: hosted OAuth broker response exceeded ${BROKER_RESPONSE_LIMIT_BYTES} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) return null;
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (_error) {
    throw new Error(`${action}: hosted OAuth broker returned an invalid JSON response.`);
  }
}

async function brokerJsonRequest(source, relativePath, options = {}) {
  const action = options.action || 'Hosted OAuth broker request failed';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BROKER_REQUEST_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  const headers = {
    Accept: 'application/json'
  };
  let body;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;

  let response;
  let payload;
  try {
    response = await fetch(brokerEndpoint(source, relativePath), {
      method: options.method || 'POST',
      headers,
      body,
      signal: controller.signal,
      redirect: 'error'
    });
    payload = response.status === 204 ? null : await readLimitedJson(response, action);
  } catch (error) {
    if (controller.signal.aborted || (error && error.name === 'AbortError')) {
      throw new Error(`${action}: hosted OAuth broker request timed out.`);
    }
    if (error && typeof error.message === 'string' && error.message.startsWith(`${action}:`)) {
      throw error;
    }
    throw new Error(`${action}: network_error contacting the configured hosted OAuth broker.`);
  } finally {
    clearTimeout(timer);
  }

  return { response, payload };
}

function requiredBrokerString(payload, field, action) {
  const value = payload && configString(payload[field]);
  if (!value) {
    throw new Error(`${action}: hosted OAuth broker response did not include ${field}.`);
  }
  return value;
}

function brokerTokenScopes(payload) {
  const raw = payload.scopes === undefined ? payload.scope : payload.scopes;
  const candidates = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(/[\s,]+/) : []);
  return [...new Set(candidates
    .filter((scope) => typeof scope === 'string')
    .map((scope) => scope.trim())
    .filter((scope) => scope && scope.length <= 256))]
    .slice(0, 256);
}

function brokerTokenMetadataId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  return normalized && /^[A-Za-z0-9_-]{1,128}$/.test(normalized) ? normalized : null;
}

function validateHubSpotAuthorizationUrl(url, sessionId, accountId, action) {
  const expectedPath = accountId
    ? `/oauth/${encodeURIComponent(String(accountId))}/authorize`
    : '/oauth/authorize';
  if (
    url.origin !== HUBSPOT_AUTHORIZE_ORIGIN
    || url.pathname !== expectedPath
    || url.username
    || url.password
    || url.hash
    || url.searchParams.get('state') !== sessionId
    || !url.searchParams.get('client_id')
    || !url.searchParams.get('redirect_uri')
    || url.searchParams.has('client_secret')
    || url.searchParams.has('code')
    || url.searchParams.has('code_verifier')
  ) {
    throw new Error(`${action}: hosted OAuth broker returned an untrusted HubSpot authorizationUrl.`);
  }
}

function normalizedBrokerTokenPayload(payload, action) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${action}: hosted OAuth broker returned an invalid token response.`);
  }
  const accessToken = configString(payload.accessToken) || configString(payload.access_token);
  const refreshToken = configString(payload.refreshToken) || configString(payload.refresh_token);
  const brokerCredential = configString(payload.brokerCredential) || configString(payload.broker_credential);
  const rawExpiresIn = payload.expiresIn === undefined ? payload.expires_in : payload.expiresIn;
  const expiresIn = Number(rawExpiresIn);
  if (!accessToken || !Number.isInteger(expiresIn) || expiresIn <= 0 || !brokerCredential) {
    throw new Error(`${action}: hosted OAuth broker returned an incomplete token response.`);
  }
  return {
    accessToken,
    refreshToken: refreshToken || null,
    brokerCredential,
    expiresIn,
    tokenType: configString(payload.tokenType) || configString(payload.token_type) || 'bearer',
    scopes: brokerTokenScopes(payload),
    hubId: brokerTokenMetadataId(payload.hubId === undefined ? payload.hub_id : payload.hubId),
    userId: brokerTokenMetadataId(payload.userId === undefined ? payload.user_id : payload.userId)
  };
}

async function startHostedBrokerLogin(source, input) {
  const action = 'auth login broker session start failed';
  const { response, payload } = await brokerJsonRequest(source, 'v1/oauth/sessions', {
    action,
    bearer: input.brokerStartKey,
    body: {
      codeChallenge: input.codeChallenge,
      consumeSecretHash: input.consumeSecretHash,
      ...(input.accountId ? { accountId: String(input.accountId) } : {})
    }
  });
  if (response.status !== 201 && response.status !== 200) {
    throw brokerHttpError(action, response, payload);
  }
  const sessionId = requiredBrokerString(payload, 'sessionId', action);
  if (!BROKER_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`${action}: hosted OAuth broker returned an invalid sessionId.`);
  }
  const authorizationUrl = requiredBrokerString(payload, 'authorizationUrl', action);
  let parsedAuthorizationUrl;
  try {
    parsedAuthorizationUrl = new URL(authorizationUrl);
  } catch (_error) {
    throw new Error(`${action}: hosted OAuth broker returned an invalid authorizationUrl.`);
  }
  validateHubSpotAuthorizationUrl(
    parsedAuthorizationUrl,
    sessionId,
    input.accountId,
    action
  );
  const rawExpiresIn = Number(payload.expiresIn);
  const rawInterval = Number(payload.interval);
  return {
    sessionId,
    authorizationUrl: parsedAuthorizationUrl,
    expiresIn: Number.isInteger(rawExpiresIn) && rawExpiresIn > 0 ? rawExpiresIn : null,
    intervalSeconds: Number.isInteger(rawInterval) && rawInterval > 0 ? rawInterval : null
  };
}

async function exchangeHostedBrokerLogin(source, input) {
  const action = 'auth login broker token exchange failed';
  const sessionPath = `v1/oauth/sessions/${encodeURIComponent(input.sessionId)}/exchange`;
  const { response, payload } = await brokerJsonRequest(source, sessionPath, {
    action,
    bearer: input.consumeSecret,
    body: {
      codeVerifier: input.codeVerifier
    }
  });
  if (response.status === 202) {
    const rawInterval = payload && Number(payload.interval);
    return {
      status: 'pending',
      intervalSeconds: Number.isInteger(rawInterval) && rawInterval > 0 ? rawInterval : null
    };
  }
  if (response.status !== 200) throw brokerHttpError(action, response, payload);
  return {
    status: 'complete',
    token: normalizedBrokerTokenPayload(payload, action)
  };
}

async function refreshHostedBrokerTokens(source, input) {
  const action = 'OAuth refresh through hosted broker failed';
  const { response, payload } = await brokerJsonRequest(source, 'v1/oauth/tokens/refresh', {
    action,
    body: {
      refreshToken: input.refreshToken,
      brokerCredential: input.brokerCredential
    }
  });
  if (response.status !== 200) throw brokerHttpError(action, response, payload);
  return normalizedBrokerTokenPayload(payload, action);
}

async function revokeHostedBrokerTokens(source, input) {
  const action = 'OAuth revocation through hosted broker failed';
  const { response, payload } = await brokerJsonRequest(source, 'v1/oauth/tokens/revoke', {
    action,
    body: {
      refreshToken: input.refreshToken,
      brokerCredential: input.brokerCredential
    }
  });
  if (response.status !== 204 && response.status !== 200) {
    throw brokerHttpError(action, response, payload);
  }
}

module.exports = {
  BROKER_REQUEST_TIMEOUT_MS,
  BROKER_RESPONSE_LIMIT_BYTES,
  brokerEndpoint,
  brokerErrorCode,
  validateHubSpotAuthorizationUrl,
  exchangeHostedBrokerLogin,
  normalizedBrokerTokenPayload,
  refreshHostedBrokerTokens,
  revokeHostedBrokerTokens,
  startHostedBrokerLogin,
};
