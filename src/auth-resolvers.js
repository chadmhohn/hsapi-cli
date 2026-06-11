// Auth resolution: portal/oauth/developer profile parsing from config,
// OAuth + developer client-credentials token caches (0600 files), refresh
// flows, and per-request credential + metadata resolution.
const fs = require('fs');
const path = require('path');
const {
  fail,
} = require('./runtime');
const {
  assertConfigObject,
  configString,
  expandUserPath,
} = require('./flags');
const {
  AUTH_FAMILIES,
  DEVELOPER_AUTH_SUBTYPES,
  endpointAuthRequirement,
} = require('./auth');

const OAUTH_TOKEN_CACHE_SCHEMA = 'hsapi.oauthTokenCache.v1';
const DEVELOPER_CLIENT_CREDENTIALS_TOKEN_CACHE_SCHEMA = 'hsapi.developerClientCredentialsTokenCache.v1';
const OAUTH_TOKEN_REFRESH_SKEW_MS = 60 * 1000;

function maybeResolvePortalBearerProfile(portal, portalName) {
  if (portal.auth !== undefined) assertConfigObject(portal.auth, `Portal "${portalName}" auth`);
  const explicitPortalBearer = portal.auth
    && Object.prototype.hasOwnProperty.call(portal.auth, 'portalBearer')
    ? portal.auth.portalBearer
    : undefined;

  if (explicitPortalBearer !== undefined) {
    const portalBearer = assertConfigObject(explicitPortalBearer, `Portal "${portalName}" auth.portalBearer`);
    const tokenEnv = configString(portalBearer.tokenEnv);
    if (!tokenEnv) {
      fail(`Portal "${portalName}" auth.portalBearer.tokenEnv must be a non-empty environment variable name.`);
    }
    return {
      family: AUTH_FAMILIES.PORTAL_BEARER,
      tokenEnv,
      profileField: 'auth.portalBearer.tokenEnv',
      provenance: 'explicit_profile',
      kind: configString(portalBearer.kind)
    };
  }

  const tokenEnv = configString(portal.tokenEnv);
  if (tokenEnv) {
    return {
      family: AUTH_FAMILIES.PORTAL_BEARER,
      tokenEnv,
      profileField: 'tokenEnv',
      provenance: 'legacy_profile',
      kind: null
    };
  }

  return null;
}

function resolvePortalBearerProfile(portal, portalName) {
  const portalBearer = maybeResolvePortalBearerProfile(portal, portalName);
  if (portalBearer) return portalBearer;
  fail(`Portal "${portalName}" is missing auth.portalBearer.tokenEnv or legacy tokenEnv. Named profiles must declare a profile-specific portal bearer token env var.`);
}

function resolveOAuthProfile(portal, portalName) {
  if (portal.auth !== undefined) assertConfigObject(portal.auth, `Portal "${portalName}" auth`);
  const rawOAuth = portal.auth
    && Object.prototype.hasOwnProperty.call(portal.auth, 'oauth')
    ? portal.auth.oauth
    : undefined;
  if (rawOAuth === undefined) return null;

  const oauth = assertConfigObject(rawOAuth, `Portal "${portalName}" auth.oauth`);
  const clientIdEnv = configString(oauth.clientIdEnv);
  const clientSecretEnv = configString(oauth.clientSecretEnv);
  const refreshTokenEnv = configString(oauth.refreshTokenEnv);
  const tokenCachePath = configString(oauth.tokenCachePath);
  if (!clientIdEnv) fail(`Portal "${portalName}" auth.oauth.clientIdEnv must be a non-empty environment variable name.`);
  if (!clientSecretEnv) fail(`Portal "${portalName}" auth.oauth.clientSecretEnv must be a non-empty environment variable name.`);
  if (!refreshTokenEnv) fail(`Portal "${portalName}" auth.oauth.refreshTokenEnv must be a non-empty environment variable name.`);
  if (!tokenCachePath) fail(`Portal "${portalName}" auth.oauth.tokenCachePath must be a non-empty cache path outside the package.`);

  return {
    family: AUTH_FAMILIES.OAUTH,
    clientIdEnv,
    clientSecretEnv,
    refreshTokenEnv,
    tokenCachePath: expandUserPath(tokenCachePath),
    tokenCachePathDisplay: tokenCachePath,
    tokenUrlPath: configString(oauth.tokenUrlPath) || '/oauth/2026-03/token',
    profileField: 'auth.oauth',
    provenance: 'explicit_profile'
  };
}

function optionalProfileEnv(config, key, label) {
  if (!Object.prototype.hasOwnProperty.call(config, key)) return null;
  const envName = configString(config[key]);
  if (!envName) fail(`${label}.${key} must be a non-empty environment variable name when present.`);
  return envName;
}

function resolveDeveloperProfile(portal, portalName) {
  if (portal.auth !== undefined) assertConfigObject(portal.auth, `Portal "${portalName}" auth`);
  const rawDeveloper = portal.auth
    && Object.prototype.hasOwnProperty.call(portal.auth, 'developer')
    ? portal.auth.developer
    : undefined;
  if (rawDeveloper === undefined) return null;

  const label = `Portal "${portalName}" auth.developer`;
  const developer = assertConfigObject(rawDeveloper, label);
  const tokenCachePath = configString(developer.tokenCachePath);
  return {
    family: AUTH_FAMILIES.DEVELOPER,
    personalAccessKeyEnv: optionalProfileEnv(developer, 'personalAccessKeyEnv', label),
    developerApiKeyEnv: optionalProfileEnv(developer, 'developerApiKeyEnv', label),
    appIdEnv: optionalProfileEnv(developer, 'appIdEnv', label),
    clientIdEnv: optionalProfileEnv(developer, 'clientIdEnv', label),
    clientSecretEnv: optionalProfileEnv(developer, 'clientSecretEnv', label),
    tokenCachePath: tokenCachePath ? expandUserPath(tokenCachePath) : null,
    tokenCachePathDisplay: tokenCachePath || null,
    tokenUrlPath: configString(developer.tokenUrlPath) || '/oauth/2026-03/token',
    profileField: 'auth.developer',
    provenance: 'explicit_profile'
  };
}

function resolveProfileDefaultFamily(portal, portalName) {
  if (!portal.auth || portal.auth.defaultFamily === undefined) return null;
  const family = configString(portal.auth.defaultFamily);
  if (!family || !Object.values(AUTH_FAMILIES).includes(family)) {
    fail(`Portal "${portalName}" auth.defaultFamily must be one of ${Object.values(AUTH_FAMILIES).join(', ')}.`);
  }
  return family;
}

function portalTokenEnv(portal, portalName) {
  return resolvePortalBearerProfile(portal, portalName).tokenEnv;
}

function resolvePortal(config, flags) {
  const portalName = flags.portal || process.env.HSAPI_PORTAL || config.default;
  if (!portalName) {
    fail('No portal selected and config has no default portal.');
  }
  const portal = config.portals[portalName];
  if (!portal) {
    fail(`Unknown portal "${portalName}". Run: hsapi profiles list`);
  }
  const portalBearer = maybeResolvePortalBearerProfile(portal, portalName);
  const oauth = resolveOAuthProfile(portal, portalName);
  const developer = resolveDeveloperProfile(portal, portalName);
  if (!portalBearer && !oauth && !developer) {
    fail(`Portal "${portalName}" is missing auth.portalBearer.tokenEnv, auth.oauth, auth.developer, or legacy tokenEnv. Named profiles must declare at least one explicit credential family.`);
  }
  const tokenEnv = portalBearer ? portalBearer.tokenEnv : null;
  const token = tokenEnv ? process.env[tokenEnv] : null;
  return {
    name: portalName,
    label: portal.label || portalName,
    portalId: portal.portalId || null,
    baseUrl: portal.baseUrl || 'https://api.hubapi.com',
    tokenEnv,
    token,
    portalBearer,
    oauth,
    developer,
    authDefaultFamily: resolveProfileDefaultFamily(portal, portalName),
    knownPlanLabel: portal.knownPlanLabel || null,
    knownPlanSource: portal.knownPlanSource || null,
    subscriptions: Array.isArray(portal.subscriptions) ? portal.subscriptions : []
  };
}

function readOAuthTokenCache(tokenCachePath) {
  if (!tokenCachePath || !fs.existsSync(tokenCachePath)) {
    return { status: 'missing', cache: null, error: null };
  }
  try {
    const cache = JSON.parse(fs.readFileSync(tokenCachePath, 'utf8'));
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
      return { status: 'invalid', cache: null, error: 'Cache file must contain a JSON object.' };
    }
    return { status: 'read', cache, error: null };
  } catch (error) {
    return { status: 'invalid', cache: null, error: error.message };
  }
}

function oauthCacheAccessToken(cache) {
  if (!cache || typeof cache !== 'object') return null;
  return configString(cache.accessToken) || configString(cache.access_token);
}

function oauthCacheExpiresAt(cache) {
  if (!cache || typeof cache !== 'object') return null;
  return configString(cache.expiresAt) || configString(cache.expires_at);
}

function oauthCacheRefreshedAt(cache) {
  if (!cache || typeof cache !== 'object') return null;
  return configString(cache.refreshedAt) || configString(cache.refreshed_at);
}

function oauthCacheTokenType(cache) {
  if (!cache || typeof cache !== 'object') return null;
  return configString(cache.tokenType) || configString(cache.token_type);
}

function oauthCacheHasExpectedSchema(cache) {
  if (!cache || typeof cache !== 'object') return false;
  if (cache.schema !== OAUTH_TOKEN_CACHE_SCHEMA) return false;
  return cache.family === undefined || cache.family === AUTH_FAMILIES.OAUTH;
}

function oauthCacheStatus(cacheRead, nowMs = Date.now()) {
  if (!cacheRead || cacheRead.status === 'missing') return 'missing';
  if (cacheRead.status === 'invalid') return 'invalid';
  const cache = cacheRead.cache;
  if (!oauthCacheHasExpectedSchema(cache)) return 'invalid';
  if (!oauthCacheAccessToken(cache)) return 'invalid';
  const expiresAt = oauthCacheExpiresAt(cache);
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(expiresAtMs)) return 'invalid';
  return expiresAtMs > nowMs + OAUTH_TOKEN_REFRESH_SKEW_MS ? 'usable' : 'expired';
}

function redactedOAuthTokenCacheContract(source, cacheRead = readOAuthTokenCache(source.tokenCachePath), nowMs = Date.now()) {
  const cache = cacheRead.cache;
  const expiresAt = oauthCacheExpiresAt(cache);
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;
  const contract = {
    schema: OAUTH_TOKEN_CACHE_SCHEMA,
    path: source.tokenCachePathDisplay || source.tokenCachePath,
    present: cacheRead.status !== 'missing',
    status: oauthCacheStatus(cacheRead, nowMs),
    redacted: true,
    accessToken: oauthCacheAccessToken(cache) ? 'REDACTED' : null,
    tokenType: oauthCacheTokenType(cache),
    expiresAt,
    expiresInSeconds: Number.isFinite(expiresAtMs) ? Math.max(Math.floor((expiresAtMs - nowMs) / 1000), 0) : null,
    refreshedAt: oauthCacheRefreshedAt(cache)
  };
  if (cacheRead.error) contract.error = cacheRead.error;
  return contract;
}

function usableOAuthCacheToken(cacheRead) {
  return oauthCacheStatus(cacheRead) === 'usable' ? oauthCacheAccessToken(cacheRead.cache) : null;
}

function readDeveloperClientCredentialsTokenCache(tokenCachePath) {
  if (!tokenCachePath || !fs.existsSync(tokenCachePath)) {
    return { status: 'missing', cache: null, error: null };
  }
  try {
    const cache = JSON.parse(fs.readFileSync(tokenCachePath, 'utf8'));
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
      return { status: 'invalid', cache: null, error: 'Cache file must contain a JSON object.' };
    }
    return { status: 'read', cache, error: null };
  } catch (error) {
    return { status: 'invalid', cache: null, error: error.message };
  }
}

function developerClientCredentialsCacheSubtype(cache) {
  if (!cache || typeof cache !== 'object') return null;
  return configString(cache.subtype) || configString(cache.authSubtype);
}

function developerClientCredentialsCacheScopes(cache) {
  if (!cache || typeof cache !== 'object') return [];
  const source = cache.source && typeof cache.source === 'object' ? cache.source : {};
  const credentialSource = cache.credentialSource && typeof cache.credentialSource === 'object'
    ? cache.credentialSource
    : {};
  const scopes = source.scopes || credentialSource.scopes || cache.scopes;
  return Array.isArray(scopes) ? scopes.filter((scope) => typeof scope === 'string' && scope.trim()).map((scope) => scope.trim()) : [];
}

function stringArraysEqual(left, right) {
  const leftValues = Array.isArray(left) ? left : [];
  const rightValues = Array.isArray(right) ? right : [];
  return leftValues.length === rightValues.length
    && leftValues.every((value, index) => value === rightValues[index]);
}

function developerClientCredentialsCacheMatchesSource(cache, source, portal) {
  if (!cache || typeof cache !== 'object') return false;
  if (cache.schema !== DEVELOPER_CLIENT_CREDENTIALS_TOKEN_CACHE_SCHEMA) return false;
  if (cache.family !== AUTH_FAMILIES.DEVELOPER) return false;
  if (developerClientCredentialsCacheSubtype(cache) !== DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS) return false;
  if (cache.grantType !== 'client_credentials') return false;

  const cachePortal = cache.portal && typeof cache.portal === 'object' ? cache.portal : {};
  if (cachePortal.baseUrl && cachePortal.baseUrl !== portal.baseUrl) return false;

  const cacheSource = cache.source && typeof cache.source === 'object'
    ? cache.source
    : (cache.credentialSource && typeof cache.credentialSource === 'object' ? cache.credentialSource : {});
  const cachedTokenUrlPath = configString(cacheSource.tokenUrlPath);
  const cachedTokenEndpoint = configString(cacheSource.tokenEndpoint);
  const expectedTokenEndpoint = new URL(source.tokenUrlPath, portal.baseUrl).toString();
  if (cachedTokenUrlPath && cachedTokenUrlPath !== source.tokenUrlPath) return false;
  if (!cachedTokenUrlPath && cachedTokenEndpoint && cachedTokenEndpoint !== expectedTokenEndpoint) return false;
  return cacheSource.clientIdEnv === source.clientIdEnv
    && cacheSource.clientSecretEnv === source.clientSecretEnv
    && stringArraysEqual(developerClientCredentialsCacheScopes(cache), source.scopes);
}

function developerClientCredentialsCacheStatus(source, portal, cacheRead, nowMs = Date.now()) {
  if (!cacheRead || cacheRead.status === 'missing') return 'missing';
  if (cacheRead.status === 'invalid') return 'invalid';
  const cache = cacheRead.cache;
  if (!developerClientCredentialsCacheMatchesSource(cache, source, portal)) return 'mismatched';
  if (!oauthCacheAccessToken(cache)) return 'invalid';
  const expiresAt = oauthCacheExpiresAt(cache);
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(expiresAtMs)) return 'invalid';
  return expiresAtMs > nowMs + OAUTH_TOKEN_REFRESH_SKEW_MS ? 'usable' : 'expired';
}

function redactedDeveloperClientCredentialsTokenCacheContract(source, portal, cacheRead = readDeveloperClientCredentialsTokenCache(source.tokenCachePath), nowMs = Date.now()) {
  const cache = cacheRead.cache;
  const expiresAt = oauthCacheExpiresAt(cache);
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;
  const contract = {
    schema: DEVELOPER_CLIENT_CREDENTIALS_TOKEN_CACHE_SCHEMA,
    path: source.tokenCachePathDisplay || source.tokenCachePath,
    present: cacheRead.status !== 'missing',
    status: developerClientCredentialsCacheStatus(source, portal, cacheRead, nowMs),
    redacted: true,
    accessToken: oauthCacheAccessToken(cache) ? 'REDACTED' : null,
    tokenType: oauthCacheTokenType(cache),
    expiresAt,
    expiresInSeconds: Number.isFinite(expiresAtMs) ? Math.max(Math.floor((expiresAtMs - nowMs) / 1000), 0) : null,
    refreshedAt: oauthCacheRefreshedAt(cache)
  };
  if (cacheRead.error) contract.error = cacheRead.error;
  return contract;
}

function usableDeveloperClientCredentialsCacheToken(source, portal, cacheRead) {
  return developerClientCredentialsCacheStatus(source, portal, cacheRead) === 'usable'
    ? oauthCacheAccessToken(cacheRead.cache)
    : null;
}

function oauthEnvValues(source, portalName) {
  const missing = [];
  const clientId = process.env[source.clientIdEnv];
  const clientSecret = process.env[source.clientSecretEnv];
  const refreshToken = process.env[source.refreshTokenEnv];
  if (!clientId) missing.push(source.clientIdEnv);
  if (!clientSecret) missing.push(source.clientSecretEnv);
  if (!refreshToken) missing.push(source.refreshTokenEnv);
  if (missing.length) {
    fail(`Missing OAuth refresh environment variable${missing.length === 1 ? '' : 's'} for portal "${portalName}": ${missing.join(', ')}.`);
  }
  return { clientId, clientSecret, refreshToken };
}

function hubSpotResponseClass(status) {
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  if (status >= 300 && status < 400) return '3xx';
  return `${Math.floor(status / 100)}xx`;
}

function hubSpotResponseCategory(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return configString(payload.category)
    || configString(payload.error)
    || configString(payload.errorType)
    || configString(payload.status);
}

function oauthTokenCacheFromRefreshPayload(payload, source, refreshedAtMs = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('OAuth refresh failed: HubSpot token response was not a JSON object.');
  }
  const accessToken = configString(payload.access_token) || configString(payload.accessToken);
  if (!accessToken) {
    fail('OAuth refresh failed: HubSpot token response did not include access_token.');
  }
  const rawExpiresIn = payload.expires_in === undefined ? payload.expiresIn : payload.expires_in;
  const expiresIn = Number(rawExpiresIn);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    fail('OAuth refresh failed: HubSpot token response did not include a positive expires_in value.');
  }
  return {
    schema: OAUTH_TOKEN_CACHE_SCHEMA,
    family: AUTH_FAMILIES.OAUTH,
    tokenType: configString(payload.token_type) || configString(payload.tokenType) || 'bearer',
    accessToken,
    expiresIn,
    expiresAt: new Date(refreshedAtMs + expiresIn * 1000).toISOString(),
    refreshedAt: new Date(refreshedAtMs).toISOString(),
    source: {
      clientIdEnv: source.clientIdEnv,
      refreshTokenEnv: source.refreshTokenEnv
    }
  };
}

function writeOAuthTokenCache(tokenCachePath, cache) {
  const dir = path.dirname(tokenCachePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(dir, `.${path.basename(tokenCachePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, tokenCachePath);
  try {
    fs.chmodSync(tokenCachePath, 0o600);
  } catch (_error) {
    // Best-effort only; some filesystems do not support chmod.
  }
}

function writeDeveloperClientCredentialsTokenCache(tokenCachePath, cache) {
  const dir = path.dirname(tokenCachePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(dir, `.${path.basename(tokenCachePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, tokenCachePath);
  try {
    fs.chmodSync(tokenCachePath, 0o600);
  } catch (_error) {
    // Best-effort only; some filesystems do not support chmod.
  }
}

async function refreshOAuthCredential(portal, source) {
  const env = oauthEnvValues(source, portal.name);
  const tokenUrl = new URL(source.tokenUrlPath, portal.baseUrl);
  let response;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: env.clientId,
        client_secret: env.clientSecret,
        refresh_token: env.refreshToken
      })
    });
  } catch (error) {
    fail(`OAuth refresh failed for portal "${portal.name}": network_error ${error.message}`);
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = text;
    }
  }

  if (!response.ok) {
    const responseClass = hubSpotResponseClass(response.status);
    const category = hubSpotResponseCategory(payload);
    const categoryText = category ? ` category ${category}` : '';
    fail(`OAuth refresh failed for portal "${portal.name}": HubSpot ${responseClass} response${categoryText} (${response.status} ${response.statusText || 'HTTP error'}).`);
  }

  const cache = oauthTokenCacheFromRefreshPayload(payload, source);
  writeOAuthTokenCache(source.tokenCachePath, cache);
  return {
    token: cache.accessToken,
    source,
    tokenCache: redactedOAuthTokenCacheContract(source, { status: 'read', cache, error: null }),
    cacheStatus: 'refreshed'
  };
}

async function resolveOAuthCredential(portal, auth) {
  if (auth.required === false) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} does not require auth; refusing to send OAuth credentials.`);
  }
  if (auth.family !== AUTH_FAMILIES.OAUTH) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${auth.family || '<none>'}; OAuth credentials can only satisfy ${AUTH_FAMILIES.OAUTH} endpoints.`);
  }
  if (!portal.oauth) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${AUTH_FAMILIES.OAUTH}; portal "${portal.name}" is missing auth.oauth clientIdEnv, clientSecretEnv, refreshTokenEnv, and tokenCachePath.`);
  }

  const cacheRead = readOAuthTokenCache(portal.oauth.tokenCachePath);
  const cachedToken = usableOAuthCacheToken(cacheRead);
  if (cachedToken) {
    return {
      token: cachedToken,
      source: portal.oauth,
      tokenCache: redactedOAuthTokenCacheContract(portal.oauth, cacheRead),
      cacheStatus: 'cache_hit'
    };
  }
  return refreshOAuthCredential(portal, portal.oauth);
}

function developerAuthLabel(auth) {
  return `${AUTH_FAMILIES.DEVELOPER}/${auth.subtype || '<missing-subtype>'}`;
}

function requireDeveloperProfile(portal, auth) {
  if (!portal.developer) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth ${developerAuthLabel(auth)}; portal "${portal.name}" is missing auth.developer.`);
  }
  return portal.developer;
}

function requireDeveloperSourceEnv(portal, auth, key, profileField) {
  const developer = requireDeveloperProfile(portal, auth);
  const envName = developer[key];
  if (!envName) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth ${developerAuthLabel(auth)}; portal "${portal.name}" is missing ${profileField}.`);
  }
  return envName;
}

function requireDeveloperEnvValue(portal, auth, key, profileField, label) {
  const envName = requireDeveloperSourceEnv(portal, auth, key, profileField);
  const value = process.env[envName];
  if (!value) {
    fail(`Missing ${label}. Set ${envName} for portal "${portal.name}".`);
  }
  return { envName, value };
}

function authQueryParams(auth) {
  return Array.isArray(auth.queryParams) ? auth.queryParams : [];
}

function requireDeveloperApiKeyQueryMetadata(auth) {
  if (!authQueryParams(auth).includes('hapikey')) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth ${developerAuthLabel(auth)} but its auth.queryParams metadata does not include hapikey.`);
  }
}

function requireDeveloperClientCredentialsScopes(auth) {
  const scopes = Array.isArray(auth.scopes)
    ? auth.scopes.filter((scope) => typeof scope === 'string' && scope.trim()).map((scope) => scope.trim())
    : [];
  if (!scopes.length) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth ${developerAuthLabel(auth)} but its catalog metadata must declare auth.scopes or requiredScopes for the client-credentials token request.`);
  }
  return scopes;
}

function requireDeveloperClientCredentialsSource(portal, auth) {
  const developer = requireDeveloperProfile(portal, auth);
  const scopes = requireDeveloperClientCredentialsScopes(auth);
  if (!developer.clientIdEnv) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth ${developerAuthLabel(auth)}; portal "${portal.name}" is missing auth.developer.clientIdEnv.`);
  }
  if (!developer.clientSecretEnv) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth ${developerAuthLabel(auth)}; portal "${portal.name}" is missing auth.developer.clientSecretEnv.`);
  }
  if (!developer.tokenCachePath) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth ${developerAuthLabel(auth)}; portal "${portal.name}" is missing auth.developer.tokenCachePath.`);
  }
  if (portal.oauth && portal.oauth.tokenCachePath === developer.tokenCachePath) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth ${developerAuthLabel(auth)}; portal "${portal.name}" auth.developer.tokenCachePath must be separate from auth.oauth.tokenCachePath.`);
  }
  return {
    type: DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS,
    name: 'developer_client_credentials',
    profileField: 'auth.developer',
    provenance: developer.provenance,
    grantType: 'client_credentials',
    clientIdEnv: developer.clientIdEnv,
    clientSecretEnv: developer.clientSecretEnv,
    tokenCachePath: developer.tokenCachePath,
    tokenCachePathDisplay: developer.tokenCachePathDisplay,
    tokenUrlPath: developer.tokenUrlPath,
    scopes,
    redacted: true
  };
}

function developerCredentialSourceForAuth(portal, auth) {
  if (auth.subtype === DEVELOPER_AUTH_SUBTYPES.DEVELOPER_API_KEY) {
    requireDeveloperApiKeyQueryMetadata(auth);
    const developerApiKeyEnv = requireDeveloperSourceEnv(
      portal,
      auth,
      'developerApiKeyEnv',
      'auth.developer.developerApiKeyEnv'
    );
    const source = {
      type: DEVELOPER_AUTH_SUBTYPES.DEVELOPER_API_KEY,
      name: developerApiKeyEnv,
      profileField: 'auth.developer.developerApiKeyEnv',
      provenance: portal.developer.provenance,
      queryParams: {
        hapikey: {
          type: 'env',
          name: developerApiKeyEnv,
          redacted: true
        }
      },
      redacted: true
    };
    if (authQueryParams(auth).includes('appId')) {
      const appIdEnv = requireDeveloperSourceEnv(portal, auth, 'appIdEnv', 'auth.developer.appIdEnv');
      source.appIdEnv = appIdEnv;
      source.queryParams.appId = {
        type: 'env',
        name: appIdEnv,
        redacted: true
      };
    }
    return source;
  }

  if (auth.subtype === DEVELOPER_AUTH_SUBTYPES.PERSONAL_ACCESS_KEY) {
    const personalAccessKeyEnv = requireDeveloperSourceEnv(
      portal,
      auth,
      'personalAccessKeyEnv',
      'auth.developer.personalAccessKeyEnv'
    );
    return {
      type: DEVELOPER_AUTH_SUBTYPES.PERSONAL_ACCESS_KEY,
      name: personalAccessKeyEnv,
      profileField: 'auth.developer.personalAccessKeyEnv',
      provenance: portal.developer.provenance,
      redacted: true
    };
  }

  if (auth.subtype === DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS) {
    const source = requireDeveloperClientCredentialsSource(portal, auth);
    return {
      type: source.type,
      name: source.name,
      profileField: source.profileField,
      provenance: source.provenance,
      grantType: source.grantType,
      clientIdEnv: source.clientIdEnv,
      clientSecretEnv: source.clientSecretEnv,
      tokenCachePath: source.tokenCachePathDisplay || source.tokenCachePath,
      tokenUrlPath: source.tokenUrlPath,
      scopes: [...source.scopes],
      tokenCache: redactedDeveloperClientCredentialsTokenCacheContract(source, portal),
      redacted: true
    };
  }

  fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${AUTH_FAMILIES.DEVELOPER}; auth.subtype "${auth.subtype || '<missing>'}" is not supported.`);
}

function developerClientCredentialsEnvValues(source, portalName) {
  const missing = [];
  const clientId = process.env[source.clientIdEnv];
  const clientSecret = process.env[source.clientSecretEnv];
  if (!clientId) missing.push(source.clientIdEnv);
  if (!clientSecret) missing.push(source.clientSecretEnv);
  if (missing.length) {
    fail(`Missing developer client-credentials environment variable${missing.length === 1 ? '' : 's'} for portal "${portalName}": ${missing.join(', ')}.`);
  }
  return { clientId, clientSecret };
}

function developerClientCredentialsTokenCacheFromPayload(payload, source, portal, refreshedAtMs = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('Developer client-credentials refresh failed: HubSpot token response was not a JSON object.');
  }
  const accessToken = configString(payload.access_token) || configString(payload.accessToken);
  if (!accessToken) {
    fail('Developer client-credentials refresh failed: HubSpot token response did not include access_token.');
  }
  const rawExpiresIn = payload.expires_in === undefined ? payload.expiresIn : payload.expires_in;
  const expiresIn = Number(rawExpiresIn);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    fail('Developer client-credentials refresh failed: HubSpot token response did not include a positive expires_in value.');
  }
  return {
    schema: DEVELOPER_CLIENT_CREDENTIALS_TOKEN_CACHE_SCHEMA,
    family: AUTH_FAMILIES.DEVELOPER,
    subtype: DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS,
    grantType: 'client_credentials',
    tokenType: configString(payload.token_type) || configString(payload.tokenType) || 'bearer',
    accessToken,
    expiresIn,
    expiresAt: new Date(refreshedAtMs + expiresIn * 1000).toISOString(),
    refreshedAt: new Date(refreshedAtMs).toISOString(),
    portal: {
      name: portal.name,
      portalId: portal.portalId,
      baseUrl: portal.baseUrl
    },
    source: {
      clientIdEnv: source.clientIdEnv,
      clientSecretEnv: source.clientSecretEnv,
      tokenUrlPath: source.tokenUrlPath,
      scopes: [...source.scopes]
    }
  };
}

function developerClientCredentialsFailureMessage(source) {
  return `Developer client-credentials refresh failed for required scopes: ${source.scopes.join(', ')}.`;
}

async function refreshDeveloperClientCredentialsCredential(portal, source) {
  const env = developerClientCredentialsEnvValues(source, portal.name);
  const tokenUrl = new URL(source.tokenUrlPath, portal.baseUrl);
  const body = {
    grant_type: 'client_credentials',
    client_id: env.clientId,
    client_secret: env.clientSecret,
    scope: source.scopes.join(' ')
  };
  let response;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(body)
    });
  } catch (error) {
    fail(`Developer client-credentials refresh failed for portal "${portal.name}": network_error ${error.message}`);
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = text;
    }
  }

  if (!response.ok) {
    const responseClass = hubSpotResponseClass(response.status);
    const category = hubSpotResponseCategory(payload);
    const categoryText = category ? ` category ${category}` : '';
    fail(`${developerClientCredentialsFailureMessage(source)} HubSpot ${responseClass} response${categoryText} (${response.status} ${response.statusText || 'HTTP error'}).`);
  }

  const cache = developerClientCredentialsTokenCacheFromPayload(payload, source, portal);
  writeDeveloperClientCredentialsTokenCache(source.tokenCachePath, cache);
  return {
    placement: 'bearer',
    token: cache.accessToken,
    source: {
      type: DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS,
      grantType: 'client_credentials',
      clientIdEnv: source.clientIdEnv,
      clientSecretEnv: source.clientSecretEnv,
      tokenCachePath: source.tokenCachePathDisplay || source.tokenCachePath,
      scopes: [...source.scopes]
    },
    tokenCache: redactedDeveloperClientCredentialsTokenCacheContract(source, portal, { status: 'read', cache, error: null }),
    cacheStatus: 'refreshed'
  };
}

async function resolveDeveloperClientCredentialsCredential(portal, auth) {
  const source = requireDeveloperClientCredentialsSource(portal, auth);
  const cacheRead = readDeveloperClientCredentialsTokenCache(source.tokenCachePath);
  const cachedToken = usableDeveloperClientCredentialsCacheToken(source, portal, cacheRead);
  if (cachedToken) {
    return {
      placement: 'bearer',
      token: cachedToken,
      source: {
        type: DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS,
        grantType: 'client_credentials',
        clientIdEnv: source.clientIdEnv,
        clientSecretEnv: source.clientSecretEnv,
        tokenCachePath: source.tokenCachePathDisplay || source.tokenCachePath,
        scopes: [...source.scopes]
      },
      tokenCache: redactedDeveloperClientCredentialsTokenCacheContract(source, portal, cacheRead),
      cacheStatus: 'cache_hit'
    };
  }
  return refreshDeveloperClientCredentialsCredential(portal, source);
}

async function resolveDeveloperCredential(portal, auth) {
  if (auth.required === false) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} does not require auth; refusing to send developer credentials.`);
  }
  if (auth.family !== AUTH_FAMILIES.DEVELOPER) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${auth.family || '<none>'}; developer credentials can only satisfy ${AUTH_FAMILIES.DEVELOPER} endpoints.`);
  }

  if (auth.subtype === DEVELOPER_AUTH_SUBTYPES.DEVELOPER_API_KEY) {
    requireDeveloperApiKeyQueryMetadata(auth);
    const developerApiKey = requireDeveloperEnvValue(
      portal,
      auth,
      'developerApiKeyEnv',
      'auth.developer.developerApiKeyEnv',
      'HubSpot developer API key'
    );
    const query = { hapikey: developerApiKey.value };
    const source = {
      type: DEVELOPER_AUTH_SUBTYPES.DEVELOPER_API_KEY,
      developerApiKeyEnv: developerApiKey.envName
    };
    if (authQueryParams(auth).includes('appId')) {
      const appId = requireDeveloperEnvValue(
        portal,
        auth,
        'appIdEnv',
        'auth.developer.appIdEnv',
        'HubSpot developer app ID'
      );
      query.appId = appId.value;
      source.appIdEnv = appId.envName;
    }
    return {
      placement: 'query',
      query,
      source
    };
  }

  if (auth.subtype === DEVELOPER_AUTH_SUBTYPES.PERSONAL_ACCESS_KEY) {
    const personalAccessKey = requireDeveloperEnvValue(
      portal,
      auth,
      'personalAccessKeyEnv',
      'auth.developer.personalAccessKeyEnv',
      'HubSpot personal access key'
    );
    return {
      placement: 'bearer',
      token: personalAccessKey.value,
      source: {
        type: DEVELOPER_AUTH_SUBTYPES.PERSONAL_ACCESS_KEY,
        personalAccessKeyEnv: personalAccessKey.envName
      }
    };
  }

  if (auth.subtype === DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS) {
    return resolveDeveloperClientCredentialsCredential(portal, auth);
  }

  fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${AUTH_FAMILIES.DEVELOPER}; auth.subtype "${auth.subtype || '<missing>'}" is not supported.`);
}

async function resolveRequestCredential(portal, auth) {
  if (auth.required === false) return null;
  if (auth.family === AUTH_FAMILIES.PORTAL_BEARER) return resolvePortalBearerCredential(portal, auth);
  if (auth.family === AUTH_FAMILIES.OAUTH) return resolveOAuthCredential(portal, auth);
  if (auth.family === AUTH_FAMILIES.DEVELOPER) return resolveDeveloperCredential(portal, auth);
  fail(`Endpoint ${auth.endpointId || '<unknown>'} requires unsupported auth family ${auth.family || '<none>'}.`);
}

function credentialSourceForAuth(portal, auth) {
  if (auth.required === false) return null;
  if (auth.family === AUTH_FAMILIES.PORTAL_BEARER) {
    if (!portal.portalBearer) {
      fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${AUTH_FAMILIES.PORTAL_BEARER}; portal "${portal.name}" is missing auth.portalBearer.tokenEnv or legacy tokenEnv.`);
    }
    const source = portal.portalBearer;
    const credentialSource = {
      type: 'env',
      name: source.tokenEnv,
      profileField: source.profileField,
      provenance: source.provenance
    };
    if (source.kind) credentialSource.kind = source.kind;
    return credentialSource;
  }
  if (auth.family === AUTH_FAMILIES.OAUTH) {
    if (portal.oauthCommandCredentials) {
      return {
        type: 'command_flags_or_env',
        name: 'oauth_command_credentials',
        redacted: true
      };
    }
    if (!portal.oauth) {
      fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${AUTH_FAMILIES.OAUTH}; portal "${portal.name}" is missing auth.oauth clientIdEnv, clientSecretEnv, refreshTokenEnv, and tokenCachePath.`);
    }
    return {
      type: 'oauth_refresh_token',
      name: portal.oauth.refreshTokenEnv,
      profileField: portal.oauth.profileField,
      provenance: portal.oauth.provenance,
      clientIdEnv: portal.oauth.clientIdEnv,
      clientSecretEnv: portal.oauth.clientSecretEnv,
      refreshTokenEnv: portal.oauth.refreshTokenEnv,
      tokenCache: redactedOAuthTokenCacheContract(portal.oauth),
      redacted: true
    };
  }
  if (auth.family === AUTH_FAMILIES.DEVELOPER) {
    return developerCredentialSourceForAuth(portal, auth);
  }
  return null;
}

function requestAuthMetadata(portal, endpoint) {
  const auth = endpointAuthRequirement(endpoint, {
    defaultFamily: AUTH_FAMILIES.PORTAL_BEARER,
    defaultSubtype: 'private_app_or_static_app',
    defaultProvenance: 'generic_request_default'
  });
  return {
    required: auth.required,
    family: auth.family,
    subtype: auth.subtype || null,
    fallback: auth.fallback,
    provenance: auth.provenance,
    endpointId: auth.endpointId,
    queryParams: auth.queryParams,
    scopes: auth.scopes,
    reason: auth.reason || null,
    credentialSource: credentialSourceForAuth(portal, auth)
  };
}

function resolvePortalBearerCredential(portal, auth) {
  if (auth.required === false) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} does not require auth; refusing to send portal bearer credentials.`);
  }
  if (auth.family !== AUTH_FAMILIES.PORTAL_BEARER) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${auth.family || '<none>'}; portal bearer credentials can only satisfy ${AUTH_FAMILIES.PORTAL_BEARER} endpoints.`);
  }
  if (!portal.portalBearer) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${AUTH_FAMILIES.PORTAL_BEARER}; portal "${portal.name}" is missing auth.portalBearer.tokenEnv or legacy tokenEnv.`);
  }
  if (!portal.token) {
    fail(`Missing HubSpot token. Set ${portal.tokenEnv} for portal "${portal.name}".`);
  }
  return {
    token: portal.token,
    source: portal.portalBearer
  };
}

module.exports = {
  DEVELOPER_CLIENT_CREDENTIALS_TOKEN_CACHE_SCHEMA,
  OAUTH_TOKEN_CACHE_SCHEMA,
  OAUTH_TOKEN_REFRESH_SKEW_MS,
  authQueryParams,
  credentialSourceForAuth,
  developerAuthLabel,
  developerClientCredentialsCacheMatchesSource,
  developerClientCredentialsCacheScopes,
  developerClientCredentialsCacheStatus,
  developerClientCredentialsCacheSubtype,
  developerClientCredentialsEnvValues,
  developerClientCredentialsFailureMessage,
  developerClientCredentialsTokenCacheFromPayload,
  developerCredentialSourceForAuth,
  hubSpotResponseCategory,
  hubSpotResponseClass,
  maybeResolvePortalBearerProfile,
  oauthCacheAccessToken,
  oauthCacheExpiresAt,
  oauthCacheHasExpectedSchema,
  oauthCacheRefreshedAt,
  oauthCacheStatus,
  oauthCacheTokenType,
  oauthEnvValues,
  oauthTokenCacheFromRefreshPayload,
  optionalProfileEnv,
  portalTokenEnv,
  readDeveloperClientCredentialsTokenCache,
  readOAuthTokenCache,
  redactedDeveloperClientCredentialsTokenCacheContract,
  redactedOAuthTokenCacheContract,
  refreshDeveloperClientCredentialsCredential,
  refreshOAuthCredential,
  requestAuthMetadata,
  requireDeveloperApiKeyQueryMetadata,
  requireDeveloperClientCredentialsScopes,
  requireDeveloperClientCredentialsSource,
  requireDeveloperEnvValue,
  requireDeveloperProfile,
  requireDeveloperSourceEnv,
  resolveDeveloperClientCredentialsCredential,
  resolveDeveloperCredential,
  resolveDeveloperProfile,
  resolveOAuthCredential,
  resolveOAuthProfile,
  resolvePortal,
  resolvePortalBearerCredential,
  resolvePortalBearerProfile,
  resolveProfileDefaultFamily,
  resolveRequestCredential,
  stringArraysEqual,
  usableDeveloperClientCredentialsCacheToken,
  usableOAuthCacheToken,
  writeDeveloperClientCredentialsTokenCache,
  writeOAuthTokenCache,
};
