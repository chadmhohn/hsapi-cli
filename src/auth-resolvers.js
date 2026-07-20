// Auth resolution: portal/oauth/developer profile parsing from config,
// OAuth + developer client-credentials token caches (0600 files), refresh
// flows, and per-request credential + metadata resolution.
const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const {
  fail,
} = require('./runtime');
const {
  assertConfigObject,
  readJsonFile,
  configString,
  expandUserPath,
} = require('./flags');
const {
  PACKAGE_ROOT,
  defaultUserConfigPath,
  resolvePortalConfigPath,
} = require('./config-paths');
const {
  AUTH_FAMILIES,
  DEVELOPER_AUTH_SUBTYPES,
  TOKEN_AUDIENCES,
  DEFAULT_TOKEN_AUDIENCE,
  endpointAuthRequirement,
  optionalStringArray,
} = require('./auth');
const {
  refreshHostedBrokerTokens,
} = require('./oauth-broker');

function loadConfig() {
  const configPath = resolvePortalConfigPath();
  if (!fs.existsSync(configPath)) {
    const userConfigPath = defaultUserConfigPath();
    const setupGuidePath = path.join(PACKAGE_ROOT, 'docs', 'hubspot-api-context', 'portal-auth-setup.md');
    const serviceKeySamplePath = path.join(PACKAGE_ROOT, 'examples', 'portals.sample.json');
    const hostedOAuthSamplePath = path.join(PACKAGE_ROOT, 'examples', 'portals.oauth-hosted.sample.json');
    const explicitConfigPath = configString(process.env.HSAPI_PORTALS_CONFIG);
    const selectedMessage = explicitConfigPath
      ? `HSAPI_PORTALS_CONFIG points to a file that does not exist: ${configPath}`
      : `No portal config was found at the per-user default: ${userConfigPath}`;
    fail(
      `${selectedMessage}. Read the installed setup guide: ${setupGuidePath}. `
      + `Choose the ServiceKey template at ${serviceKeySamplePath} or the hosted OAuth template at ${hostedOAuthSamplePath}, `
      + `copy it to a private external path such as ${userConfigPath}, or set HSAPI_PORTALS_CONFIG to an existing config file. `
      + 'hsapi does not create or overwrite portal configs automatically.'
    );
  }
  const config = readJsonFile(configPath);
  if (!config.portals || typeof config.portals !== 'object') {
    fail(`Portal config missing "portals" object: ${configPath}`);
  }
  return { configPath, config };
}

const OAUTH_TOKEN_CACHE_SCHEMA = 'hsapi.oauthTokenCache.v2';
// v1 caches predate persisted refresh tokens (issue #78). They are still
// readable: oauthCacheHasExpectedSchema accepts both so an existing access
// token keeps working until the next refresh rewrites the cache as v2.
const OAUTH_TOKEN_CACHE_SCHEMA_V1 = 'hsapi.oauthTokenCache.v1';
const SUPPORTED_OAUTH_TOKEN_CACHE_SCHEMAS = new Set([
  OAUTH_TOKEN_CACHE_SCHEMA,
  OAUTH_TOKEN_CACHE_SCHEMA_V1
]);
const DEVELOPER_CLIENT_CREDENTIALS_TOKEN_CACHE_SCHEMA = 'hsapi.developerClientCredentialsTokenCache.v1';
const OAUTH_TOKEN_REFRESH_SKEW_MS = 60 * 1000;
const OAUTH_TOKEN_REQUEST_TIMEOUT_MS = 30 * 1000;
const OAUTH_REFRESH_LOCK_WAIT_TIMEOUT_MS = OAUTH_TOKEN_REQUEST_TIMEOUT_MS + 15 * 1000;
const OAUTH_REFRESH_LOCK_STALE_MS = OAUTH_TOKEN_REQUEST_TIMEOUT_MS + 15 * 1000;
const OAUTH_REFRESH_LOCK_POLL_MIN_MS = 40;
const OAUTH_REFRESH_LOCK_POLL_JITTER_MS = 80;
const OAUTH_REFRESH_LOCK_SCHEMA = 'hsapi.oauthRefreshLock.v1';
const oauthRefreshProcessQueues = new Map();
const oauthRefreshActiveOwners = new Set();
const OAUTH_MODES = Object.freeze({
  LOCAL: 'local',
  HOSTED_BROKER: 'hosted_broker'
});
const DEFAULT_HOSTED_OAUTH_BROKER_URL =
  'https://hsapi-oauth.groundworkrevops.com';

function oauthClientIdFingerprint(clientId) {
  const normalized = configString(clientId);
  return normalized
    ? createHash('sha256').update(normalized, 'utf8').digest('hex')
    : null;
}

function oauthCacheClientIdFingerprint(cache) {
  if (!cache || typeof cache !== 'object') return null;
  const cacheSource = cache.source
    && typeof cache.source === 'object'
    && !Array.isArray(cache.source)
    ? cache.source
    : {};
  return configString(cacheSource.clientIdFingerprint);
}

function hostedBrokerUrl(rawUrl, portalName) {
  if (!rawUrl) {
    fail(`Portal "${portalName}" auth.oauth.brokerUrl must be a non-empty HTTPS URL when auth.oauth.mode is "${OAUTH_MODES.HOSTED_BROKER}".`);
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_error) {
    fail(`Portal "${portalName}" auth.oauth.brokerUrl must be a valid HTTPS URL.`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    fail(`Portal "${portalName}" auth.oauth.brokerUrl must use HTTPS and must not contain URL credentials, a query string, or a fragment.`);
  }
  return parsed.toString().replace(/\/+$/, '');
}

function optionalOAuthPortalId(rawPortalId, portalName) {
  if (rawPortalId === undefined || rawPortalId === null) return null;
  const portalId = String(rawPortalId).trim();
  if (!/^[1-9][0-9]*$/.test(portalId)) {
    fail(`Portal "${portalName}" portalId must be a numeric HubSpot account ID when provided.`);
  }
  return portalId;
}

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
  const mode = configString(oauth.mode) || OAUTH_MODES.LOCAL;
  if (!Object.values(OAUTH_MODES).includes(mode)) {
    fail(`Portal "${portalName}" auth.oauth.mode must be one of ${Object.values(OAUTH_MODES).join(', ')}.`);
  }
  const clientIdEnv = mode === OAUTH_MODES.LOCAL ? configString(oauth.clientIdEnv) : null;
  const clientSecretEnv = mode === OAUTH_MODES.LOCAL ? configString(oauth.clientSecretEnv) : null;
  // refreshTokenEnv is optional (issue #78): login-based profiles persist the
  // refresh token to the per-user token cache, so an env var is not required.
  const refreshTokenEnv = mode === OAUTH_MODES.LOCAL ? configString(oauth.refreshTokenEnv) : null;
  const tokenCachePath = configString(oauth.tokenCachePath);
  if (mode === OAUTH_MODES.LOCAL && !clientIdEnv) fail(`Portal "${portalName}" auth.oauth.clientIdEnv must be a non-empty environment variable name.`);
  if (mode === OAUTH_MODES.LOCAL && !clientSecretEnv) fail(`Portal "${portalName}" auth.oauth.clientSecretEnv must be a non-empty environment variable name.`);
  if (!tokenCachePath) fail(`Portal "${portalName}" auth.oauth.tokenCachePath must be a non-empty cache path outside the package.`);

  // Optional interactive-login fields (issue #77). Only required when running
  // `hsapi auth login`; absence here is fine for refresh-token-only profiles.
  const redirectUrl = mode === OAUTH_MODES.LOCAL ? configString(oauth.redirectUrl) : null;
  const scopes = optionalStringArray(oauth.scopes, 'auth.oauth.scopes', `Portal "${portalName}"`);
  const optionalScopes = optionalStringArray(oauth.optionalScopes, 'auth.oauth.optionalScopes', `Portal "${portalName}"`);
  const authorizeUrlBase = mode === OAUTH_MODES.LOCAL
    ? (configString(oauth.authorizeUrlBase) || 'https://app.hubspot.com')
    : null;
  const brokerUrl = mode === OAUTH_MODES.HOSTED_BROKER
    ? hostedBrokerUrl(
      configString(oauth.brokerUrl) || DEFAULT_HOSTED_OAUTH_BROKER_URL,
      portalName
    )
    : null;
  const portalId = optionalOAuthPortalId(portal.portalId, portalName);

  return {
    family: AUTH_FAMILIES.OAUTH,
    mode,
    brokerUrl,
    portalId,
    clientIdEnv,
    clientSecretEnv,
    refreshTokenEnv: refreshTokenEnv || null,
    tokenCachePath: expandUserPath(tokenCachePath),
    tokenCachePathDisplay: tokenCachePath,
    tokenUrlPath: mode === OAUTH_MODES.LOCAL
      ? (configString(oauth.tokenUrlPath) || '/oauth/2026-03/token')
      : null,
    redirectUrl: redirectUrl || null,
    scopes,
    optionalScopes,
    authorizeUrlBase,
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
  const resolvedOAuth = resolveOAuthProfile(portal, portalName);
  const portalId = resolvedOAuth
    ? resolvedOAuth.portalId
    : (portal.portalId ? String(portal.portalId).trim() : null);
  const oauth = resolvedOAuth;
  const developer = resolveDeveloperProfile(portal, portalName);
  if (!portalBearer && !oauth && !developer) {
    fail(`Portal "${portalName}" is missing auth.portalBearer.tokenEnv, auth.oauth, auth.developer, or legacy tokenEnv. Named profiles must declare at least one explicit credential family.`);
  }
  const tokenEnv = portalBearer ? portalBearer.tokenEnv : null;
  const token = tokenEnv ? process.env[tokenEnv] : null;
  return {
    name: portalName,
    label: portal.label || portalName,
    portalId,
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
  } catch (_error) {
    return { status: 'invalid', cache: null, error: 'Cache file is not valid JSON.' };
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

function oauthCacheRefreshToken(cache) {
  if (!cache || typeof cache !== 'object') return null;
  return configString(cache.refreshToken) || configString(cache.refresh_token);
}

function isPathInside(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalPathWithMissingTail(inputPath) {
  let cursor = path.resolve(inputPath);
  const missingTail = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missingTail.unshift(path.basename(cursor));
    cursor = parent;
  }
  const realBase = fs.existsSync(cursor)
    ? (fs.realpathSync.native ? fs.realpathSync.native(cursor) : fs.realpathSync(cursor))
    : cursor;
  return path.resolve(realBase, ...missingTail);
}

function tokenCachePathIsOutsidePackage(tokenCachePath) {
  if (!tokenCachePath) return false;
  const lexicalInside = isPathInside(PACKAGE_ROOT, tokenCachePath);
  const canonicalInside = isPathInside(
    canonicalPathWithMissingTail(PACKAGE_ROOT),
    canonicalPathWithMissingTail(tokenCachePath)
  );
  return !lexicalInside && !canonicalInside;
}

function assertTokenCacheOutsidePackage(tokenCachePath, label = 'Token cache') {
  if (!tokenCachePath) fail(`${label} path is required.`);
  if (!tokenCachePathIsOutsidePackage(tokenCachePath)) {
    fail(`${label} must live outside the hsapi package: ${tokenCachePath}`);
  }
}

function oauthCacheBrokerCredential(cache) {
  if (!cache || typeof cache !== 'object') return null;
  return configString(cache.brokerCredential) || configString(cache.broker_credential);
}

function safeOAuthMetadataId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  return normalized && /^[A-Za-z0-9_-]{1,128}$/.test(normalized) ? normalized : null;
}

function positiveHubSpotAccountId(value) {
  const normalized = safeOAuthMetadataId(value);
  return normalized && /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}

function oauthMetadataScopes(source) {
  if (!source || typeof source !== 'object') return [];
  const raw = source.scopes === undefined ? source.scope : source.scopes;
  const candidates = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(/[\s,]+/) : []);
  return [...new Set(candidates
    .filter((scope) => typeof scope === 'string')
    .map((scope) => scope.trim())
    .filter((scope) => scope && scope.length <= 256))]
    .slice(0, 256);
}

function oauthCacheHubId(cache) {
  if (!cache || typeof cache !== 'object') return null;
  return safeOAuthMetadataId(cache.hubId === undefined ? cache.hub_id : cache.hubId);
}

function oauthCacheUserId(cache) {
  if (!cache || typeof cache !== 'object') return null;
  return safeOAuthMetadataId(cache.userId === undefined ? cache.user_id : cache.userId);
}

function comparableBrokerUrl(value) {
  const raw = configString(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      return null;
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    return null;
  }
}

function oauthCacheProfileMatch(cache, source) {
  if (!cache || typeof cache !== 'object' || !source) {
    return { ok: true, reason: null };
  }
  const cacheSource = cache.source
    && typeof cache.source === 'object'
    && !Array.isArray(cache.source)
    ? cache.source
    : {};
  const cachedMode = configString(cacheSource.mode);
  const expectedPortalId = safeOAuthMetadataId(source.portalId);
  const cachedSourcePortalId = safeOAuthMetadataId(cacheSource.portalId);
  const tokenHubId = oauthCacheHubId(cache);

  if (source.mode === OAUTH_MODES.HOSTED_BROKER) {
    const hostedTokenHubId = positiveHubSpotAccountId(tokenHubId);
    const hostedSourcePortalId = positiveHubSpotAccountId(cachedSourcePortalId);
    if (cachedMode !== OAUTH_MODES.HOSTED_BROKER) {
      return { ok: false, reason: 'oauth_mode_mismatch' };
    }
    if (
      comparableBrokerUrl(cacheSource.brokerUrl)
      !== comparableBrokerUrl(source.brokerUrl)
    ) {
      return { ok: false, reason: 'broker_url_mismatch' };
    }
    if (!oauthCacheBrokerCredential(cache)) {
      return { ok: false, reason: 'broker_credential_missing' };
    }
    if (!hostedTokenHubId) {
      return {
        ok: false,
        reason: tokenHubId ? 'token_portal_id_invalid' : 'token_portal_id_missing'
      };
    }
    if (!hostedSourcePortalId) {
      return {
        ok: false,
        reason: cachedSourcePortalId
          ? 'cache_source_portal_id_invalid'
          : 'cache_source_portal_id_missing'
      };
    }
    if (expectedPortalId && hostedTokenHubId !== expectedPortalId) {
      return {
        ok: false,
        reason: 'portal_id_mismatch'
      };
    }
    if (
      expectedPortalId
      && hostedSourcePortalId !== expectedPortalId
    ) {
      return { ok: false, reason: 'cache_source_portal_id_mismatch' };
    }
    if (hostedTokenHubId !== hostedSourcePortalId) {
      return {
        ok: false,
        reason: 'cache_token_portal_id_mismatch'
      };
    }
  } else {
    if (cachedMode && cachedMode !== OAUTH_MODES.LOCAL) {
      return { ok: false, reason: 'oauth_mode_mismatch' };
    }
    const expectedClientIdFingerprint = oauthClientIdFingerprint(
      source.clientIdEnv ? process.env[source.clientIdEnv] : null
    );
    if (!expectedClientIdFingerprint) {
      return { ok: false, reason: 'client_id_unavailable' };
    }
    const cachedClientIdFingerprint = oauthCacheClientIdFingerprint(cache);
    if (!cachedClientIdFingerprint) {
      // Legacy local caches predate app-identity binding. They remain readable
      // for redacted diagnostics/logout, but are never accepted for live API
      // use: the user must authenticate again to create a bound cache.
      return { ok: false, reason: 'client_id_fingerprint_missing' };
    }
    if (!/^[a-f0-9]{64}$/.test(cachedClientIdFingerprint)) {
      return { ok: false, reason: 'client_id_fingerprint_invalid' };
    }
    if (cachedClientIdFingerprint !== expectedClientIdFingerprint) {
      return { ok: false, reason: 'client_id_mismatch' };
    }
  }

  if (
    expectedPortalId
    && cachedSourcePortalId
    && cachedSourcePortalId !== expectedPortalId
  ) {
    return { ok: false, reason: 'cache_source_portal_id_mismatch' };
  }
  if (expectedPortalId && tokenHubId && tokenHubId !== expectedPortalId) {
    return { ok: false, reason: 'portal_id_mismatch' };
  }
  return { ok: true, reason: null };
}

function oauthCacheHasExpectedSchema(cache) {
  if (!cache || typeof cache !== 'object') return false;
  if (!SUPPORTED_OAUTH_TOKEN_CACHE_SCHEMAS.has(cache.schema)) return false;
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
  const baseStatus = oauthCacheStatus(cacheRead, nowMs);
  const profileMatch = oauthCacheProfileMatch(cache, source);
  const contract = {
    schema: OAUTH_TOKEN_CACHE_SCHEMA,
    path: source.tokenCachePathDisplay || source.tokenCachePath,
    present: cacheRead.status !== 'missing',
    status: baseStatus !== 'missing' && !profileMatch.ok ? 'invalid' : baseStatus,
    profileMatch: profileMatch.ok,
    profileMismatchReason: profileMatch.reason,
    clientIdBound: source.mode === OAUTH_MODES.HOSTED_BROKER
      ? null
      : Boolean(oauthCacheClientIdFingerprint(cache)),
    redacted: true,
    accessToken: oauthCacheAccessToken(cache) ? 'REDACTED' : null,
    refreshToken: oauthCacheRefreshToken(cache) ? 'REDACTED' : null,
    brokerCredential: oauthCacheBrokerCredential(cache) ? 'REDACTED' : null,
    tokenType: oauthCacheTokenType(cache),
    scopes: oauthMetadataScopes(cache),
    hubId: oauthCacheHubId(cache),
    userId: oauthCacheUserId(cache),
    expiresAt,
    expiresInSeconds: Number.isFinite(expiresAtMs) ? Math.max(Math.floor((expiresAtMs - nowMs) / 1000), 0) : null,
    refreshedAt: oauthCacheRefreshedAt(cache)
  };
  if (cacheRead.error) contract.error = cacheRead.error;
  return contract;
}

function usableOAuthCacheToken(cacheRead, source = null) {
  const profileMatch = source
    ? oauthCacheProfileMatch(cacheRead && cacheRead.cache, source)
    : { ok: true };
  return oauthCacheStatus(cacheRead) === 'usable' && profileMatch.ok
    ? oauthCacheAccessToken(cacheRead.cache)
    : null;
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
  } catch (_error) {
    return { status: 'invalid', cache: null, error: 'Cache file is not valid JSON.' };
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

function oauthEnvValues(source, portalName, cacheRead = null) {
  if (source.mode === OAUTH_MODES.HOSTED_BROKER) {
    fail(`OAuth refresh for portal "${portalName}" is configured for hosted_broker mode; refusing to read local OAuth client credentials.`);
  }
  const missing = [];
  const clientId = process.env[source.clientIdEnv];
  const clientSecret = process.env[source.clientSecretEnv];
  if (!clientId) missing.push(source.clientIdEnv);
  if (!clientSecret) missing.push(source.clientSecretEnv);
  // The refresh token comes from the persisted cache first (issue #78), then
  // falls back to the configured refreshTokenEnv. client_id/client_secret are
  // always env-sourced.
  const resolvedCacheRead = cacheRead || readOAuthTokenCache(source.tokenCachePath);
  const cachedRefreshToken = oauthCacheRefreshToken(resolvedCacheRead && resolvedCacheRead.cache);
  const envRefreshToken = source.refreshTokenEnv ? configString(process.env[source.refreshTokenEnv]) : null;
  const refreshToken = cachedRefreshToken || envRefreshToken;
  const refreshTokenSource = cachedRefreshToken ? 'cache' : (envRefreshToken ? 'env' : null);

  if (missing.length) {
    fail(`Missing OAuth refresh environment variable${missing.length === 1 ? '' : 's'} for portal "${portalName}": ${missing.join(', ')}.`);
  }
  if (!refreshToken) {
    fail(`No refresh token available for portal "${portalName}". Run: hsapi auth login --portal ${portalName}`);
  }
  return { clientId, clientSecret, refreshToken, refreshTokenSource };
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

function oauthTokenCacheFromRefreshPayload(
  payload,
  source,
  refreshedAtMs = Date.now(),
  priorRefreshToken = null,
  priorCache = null,
  resolvedClientId = null
) {
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
  // HubSpot returns a refresh_token on the authorization_code exchange. On a
  // refresh_token grant it may omit it, so fall back to the prior refresh
  // token (rotation: prefer the response's value when present). Issue #78.
  const responseRefreshToken = configString(payload.refresh_token) || configString(payload.refreshToken);
  const refreshToken = responseRefreshToken || configString(priorRefreshToken) || null;
  const responseBrokerCredential = configString(payload.broker_credential) || configString(payload.brokerCredential);
  const brokerCredential = responseBrokerCredential || oauthCacheBrokerCredential(priorCache);
  const responseScopes = oauthMetadataScopes(payload);
  const scopes = responseScopes.length ? responseScopes : oauthMetadataScopes(priorCache);
  const hubId = safeOAuthMetadataId(payload.hubId === undefined ? payload.hub_id : payload.hubId)
    || oauthCacheHubId(priorCache);
  const userId = safeOAuthMetadataId(payload.userId === undefined ? payload.user_id : payload.userId)
    || oauthCacheUserId(priorCache);
  const clientIdFingerprint = source.mode === OAUTH_MODES.HOSTED_BROKER
    ? null
    : oauthClientIdFingerprint(
      resolvedClientId || (source.clientIdEnv ? process.env[source.clientIdEnv] : null)
    );
  if (source.mode !== OAUTH_MODES.HOSTED_BROKER && !clientIdFingerprint) {
    fail('OAuth token cache write refused: the configured OAuth client ID is unavailable for app-identity binding.');
  }
  const knownCacheFields = new Set([
    'schema',
    'family',
    'tokenType',
    'token_type',
    'accessToken',
    'access_token',
    'refreshToken',
    'refresh_token',
    'brokerCredential',
    'broker_credential',
    'scopes',
    'scope',
    'hubId',
    'hub_id',
    'userId',
    'user_id',
    'expiresIn',
    'expires_in',
    'expiresAt',
    'expires_at',
    'refreshedAt',
    'refreshed_at',
    'source'
  ]);
  const preserved = {};
  if (priorCache && typeof priorCache === 'object' && !Array.isArray(priorCache)) {
    for (const [key, value] of Object.entries(priorCache)) {
      if (!knownCacheFields.has(key)) preserved[key] = value;
    }
  }
  const rawPriorSource = priorCache
    && priorCache.source
    && typeof priorCache.source === 'object'
    && !Array.isArray(priorCache.source)
    ? priorCache.source
    : {};
  const knownSourceFields = new Set([
    'mode',
    'brokerUrl',
    'portalId',
    'clientIdEnv',
    'clientIdFingerprint',
    'refreshTokenEnv'
  ]);
  const priorSource = {};
  for (const [key, value] of Object.entries(rawPriorSource)) {
    if (!knownSourceFields.has(key)) priorSource[key] = value;
  }
  const sourceMetadata = source.mode === OAUTH_MODES.HOSTED_BROKER
    ? {
      mode: OAUTH_MODES.HOSTED_BROKER,
      brokerUrl: source.brokerUrl,
      portalId: safeOAuthMetadataId(source.portalId)
        || hubId
        || safeOAuthMetadataId(rawPriorSource.portalId)
        || null
    }
    : {
      mode: OAUTH_MODES.LOCAL,
      portalId: source.portalId || null,
      clientIdEnv: source.clientIdEnv,
      clientIdFingerprint,
      refreshTokenEnv: source.refreshTokenEnv || null
    };
  const cache = {
    ...preserved,
    schema: OAUTH_TOKEN_CACHE_SCHEMA,
    family: AUTH_FAMILIES.OAUTH,
    tokenType: configString(payload.token_type) || configString(payload.tokenType) || 'bearer',
    accessToken,
    expiresIn,
    expiresAt: new Date(refreshedAtMs + expiresIn * 1000).toISOString(),
    refreshedAt: new Date(refreshedAtMs).toISOString(),
    source: {
      ...priorSource,
      ...sourceMetadata
    }
  };
  if (refreshToken) cache.refreshToken = refreshToken;
  if (brokerCredential) cache.brokerCredential = brokerCredential;
  if (scopes.length) cache.scopes = scopes;
  if (hubId) cache.hubId = hubId;
  if (userId) cache.userId = userId;
  return cache;
}

function writeOAuthTokenCache(tokenCachePath, cache) {
  assertTokenCacheOutsidePackage(tokenCachePath, 'OAuth token cache');
  const dir = path.dirname(tokenCachePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(dir, `.${path.basename(tokenCachePath)}.${process.pid}.${Date.now()}.tmp`);
  let renamed = false;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, tokenCachePath);
    renamed = true;
  } finally {
    if (!renamed && fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (_error) {
        // Preserve the original write/rename error. The temp file was created
        // with the same restrictive mode and contains no filename credentials.
      }
    }
  }
  try {
    fs.chmodSync(tokenCachePath, 0o600);
  } catch (_error) {
    // Best-effort only; some filesystems do not support chmod.
  }
}

function writeDeveloperClientCredentialsTokenCache(tokenCachePath, cache) {
  assertTokenCacheOutsidePackage(tokenCachePath, 'Developer client-credentials token cache');
  const dir = path.dirname(tokenCachePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(dir, `.${path.basename(tokenCachePath)}.${process.pid}.${Date.now()}.tmp`);
  let renamed = false;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, tokenCachePath);
    renamed = true;
  } finally {
    if (!renamed && fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (_error) {
        // Preserve the original write/rename error. The temp file was created
        // with the same restrictive mode and contains no filename credentials.
      }
    }
  }
  try {
    fs.chmodSync(tokenCachePath, 0o600);
  } catch (_error) {
    // Best-effort only; some filesystems do not support chmod.
  }
}

function oauthRefreshLockPath(tokenCachePath) {
  return `${tokenCachePath}.refresh.lock`;
}

function oauthRefreshLockKey(tokenCachePath) {
  const resolvedPath = path.resolve(tokenCachePath);
  let canonicalPath = resolvedPath;
  try {
    const realParent = fs.realpathSync.native(path.dirname(resolvedPath));
    canonicalPath = path.join(realParent, path.basename(resolvedPath));
  } catch (_error) {
    // The cache parent is created before lock acquisition, but path.resolve is
    // still a stable fallback if realpath is unavailable on this filesystem.
  }
  return process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
}

function oauthRefreshDelay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForOAuthRefreshTurn(previousTurn) {
  let timer = null;
  try {
    return await Promise.race([
      previousTurn.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), OAUTH_REFRESH_LOCK_WAIT_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withOAuthTokenCacheProcessLock(tokenCachePath, portalName, action) {
  const key = oauthRefreshLockKey(tokenCachePath);
  const previousTurn = oauthRefreshProcessQueues.get(key) || Promise.resolve();
  let releaseTurn;
  const thisTurn = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  oauthRefreshProcessQueues.set(key, thisTurn);

  try {
    if (!await waitForOAuthRefreshTurn(previousTurn)) {
      fail(`Timed out waiting for another OAuth token-cache operation for portal "${portalName}". Retry the command.`);
    }
    return await action();
  } finally {
    releaseTurn();
    if (oauthRefreshProcessQueues.get(key) === thisTurn) {
      oauthRefreshProcessQueues.delete(key);
    }
  }
}

function readOAuthRefreshLockSnapshot(lockPath) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return null;
  }

  let metadata = null;
  // Lock metadata is intentionally tiny and credential-free. Refuse to read an
  // unexpectedly large file so a corrupt sidecar cannot cause an unbounded
  // allocation while another process is waiting.
  if (stat.size >= 0 && stat.size <= 4096) {
    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed;
      }
    } catch (_error) {
      metadata = null;
    }
  }
  return { stat, metadata };
}

function oauthRefreshLockProcessIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    // EPERM means the process exists but cannot be signalled. Treat all other
    // platform-specific failures as "possibly alive" rather than stealing.
    return true;
  }
}

function oauthRefreshLockSnapshotIsStale(snapshot, nowMs = Date.now()) {
  if (!snapshot) return false;
  const metadata = snapshot.metadata;
  const pid = metadata && Number(metadata.pid);
  const owner = metadata && typeof metadata.owner === 'string'
    ? metadata.owner
    : null;

  if (Number.isInteger(pid) && pid > 0) {
    if (pid === process.pid) {
      // A same-process owner not present in the active set is an orphan from an
      // interrupted prior refresh and can be reclaimed immediately.
      return !owner || !oauthRefreshActiveOwners.has(owner);
    }
    const processAlive = oauthRefreshLockProcessIsAlive(pid);
    if (processAlive === false) return true;
    if (processAlive === true) return false;
  }

  const ageMs = Math.max(0, nowMs - snapshot.stat.mtimeMs);
  return ageMs >= OAUTH_REFRESH_LOCK_STALE_MS;
}

function sameOAuthRefreshLockSnapshot(left, right) {
  if (!left || !right) return false;
  const leftOwner = left.metadata && left.metadata.owner;
  const rightOwner = right.metadata && right.metadata.owner;
  if (leftOwner || rightOwner) return leftOwner === rightOwner;
  return left.stat.dev === right.stat.dev
    && left.stat.ino === right.stat.ino
    && left.stat.size === right.stat.size
    && left.stat.mtimeMs === right.stat.mtimeMs;
}

function tryRemoveStaleOAuthRefreshLock(lockPath) {
  const observed = readOAuthRefreshLockSnapshot(lockPath);
  if (!oauthRefreshLockSnapshotIsStale(observed)) return false;

  // Re-check immediately before the atomic rename. This prevents an observation
  // of an old lock from deleting a replacement created by a newer owner.
  const current = readOAuthRefreshLockSnapshot(lockPath);
  if (
    !sameOAuthRefreshLockSnapshot(observed, current)
    || !oauthRefreshLockSnapshotIsStale(current)
  ) {
    return false;
  }

  const quarantinePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    fs.renameSync(lockPath, quarantinePath);
  } catch (error) {
    if (error && ['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code)) return false;
    return false;
  }

  const moved = readOAuthRefreshLockSnapshot(quarantinePath);
  if (!sameOAuthRefreshLockSnapshot(current, moved)) {
    // The fixed path changed in the narrow interval before rename. Restore the
    // marker when possible and leave it alone rather than risking two refreshes.
    try {
      if (!fs.existsSync(lockPath)) fs.renameSync(quarantinePath, lockPath);
    } catch (_error) {
      // Another owner may already have acquired the fixed path.
    }
    return false;
  }

  try {
    fs.unlinkSync(quarantinePath);
  } catch (_error) {
    // A quarantined stale marker no longer blocks acquisition.
  }
  return true;
}

async function acquireOAuthRefreshFileLock(tokenCachePath, portalName) {
  const lockPath = oauthRefreshLockPath(tokenCachePath);
  const owner = randomUUID();
  const deadlineMs = Date.now() + OAUTH_REFRESH_LOCK_WAIT_TIMEOUT_MS;

  while (true) {
    let handle = null;
    try {
      handle = fs.openSync(lockPath, 'wx', 0o600);
      const acquiredAt = new Date().toISOString();
      fs.writeFileSync(handle, `${JSON.stringify({
        schema: OAUTH_REFRESH_LOCK_SCHEMA,
        owner,
        pid: process.pid,
        acquiredAt
      })}\n`, 'utf8');
      fs.fsyncSync(handle);
      try {
        fs.chmodSync(lockPath, 0o600);
      } catch (_error) {
        // Best-effort only; some filesystems do not support chmod.
      }
      oauthRefreshActiveOwners.add(owner);
      return { handle, lockPath, owner };
    } catch (error) {
      if (handle !== null) {
        try {
          fs.closeSync(handle);
        } catch (_error) {
          // Best-effort cleanup after a partial acquisition.
        }
        try {
          fs.unlinkSync(lockPath);
        } catch (_error) {
          // A later stale-lock pass can reclaim a partial marker.
        }
      }
      if (!error || error.code !== 'EEXIST') {
        fail(`Unable to acquire the OAuth token-cache lock for portal "${portalName}".`);
      }
    }

    if (tryRemoveStaleOAuthRefreshLock(lockPath)) continue;
    if (Date.now() >= deadlineMs) {
      fail(`Timed out waiting for another OAuth token-cache operation for portal "${portalName}". Retry the command.`);
    }
    const jitterMs = Math.floor(Math.random() * OAUTH_REFRESH_LOCK_POLL_JITTER_MS);
    await oauthRefreshDelay(OAUTH_REFRESH_LOCK_POLL_MIN_MS + jitterMs);
  }
}

async function releaseOAuthRefreshFileLock(lock) {
  if (!lock) return;
  try {
    fs.closeSync(lock.handle);
  } catch (_error) {
    // The owner check below still prevents deleting another process's lock.
  }

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = readOAuthRefreshLockSnapshot(lock.lockPath);
      if (!snapshot) return;
      if (!snapshot.metadata || snapshot.metadata.owner !== lock.owner) return;
      try {
        fs.unlinkSync(lock.lockPath);
        return;
      } catch (error) {
        if (!error || !['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) return;
        await oauthRefreshDelay(10 * (attempt + 1));
      }
    }
  } finally {
    oauthRefreshActiveOwners.delete(lock.owner);
  }
}

async function withOAuthTokenCacheMutationLock(tokenCachePath, portalName, action) {
  assertTokenCacheOutsidePackage(tokenCachePath, 'OAuth token cache');
  fs.mkdirSync(path.dirname(tokenCachePath), { recursive: true, mode: 0o700 });
  return withOAuthTokenCacheProcessLock(tokenCachePath, portalName, async () => {
    const lock = await acquireOAuthRefreshFileLock(tokenCachePath, portalName);
    try {
      return await action();
    } finally {
      await releaseOAuthRefreshFileLock(lock);
    }
  });
}

function requireOAuthCacheProfileMatch(portal, source, cacheRead) {
  if (!cacheRead || cacheRead.status !== 'read') return;
  const match = oauthCacheProfileMatch(cacheRead.cache, source);
  if (!match.ok) {
    const guidance = match.reason === 'client_id_unavailable'
      ? `Set ${source.clientIdEnv}, then run: hsapi auth login --portal ${portal.name}`
      : match.reason === 'client_id_fingerprint_missing'
        ? `This legacy cache is not bound to an OAuth client app. Re-authenticate with: hsapi auth login --portal ${portal.name}`
        : match.reason === 'client_id_mismatch'
          ? `The configured OAuth client ID belongs to a different app. Re-authenticate with: hsapi auth login --portal ${portal.name}`
          : `Run: hsapi auth login --portal ${portal.name}`;
    fail(`OAuth token cache does not match portal "${portal.name}" (${match.reason}). Refusing to use or forward cached credentials. ${guidance}`);
  }
}

async function refreshOAuthCredentialUnlocked(portal, source, cacheRead) {
  requireOAuthCacheProfileMatch(portal, source, cacheRead);
  if (source.mode === OAUTH_MODES.HOSTED_BROKER) {
    const priorCache = cacheRead && cacheRead.cache;
    const refreshToken = oauthCacheRefreshToken(priorCache);
    const brokerCredential = oauthCacheBrokerCredential(priorCache);
    if (!refreshToken || !brokerCredential) {
      fail(`OAuth refresh through hosted broker is unavailable for portal "${portal.name}" because the token cache is missing its broker-bound refresh credentials. Run: hsapi auth login --portal ${portal.name}`);
    }
    let payload;
    try {
      payload = await refreshHostedBrokerTokens(source, {
        refreshToken,
        brokerCredential,
        expectedHubId: oauthCacheHubId(priorCache)
          || safeOAuthMetadataId(source.portalId)
          || null
      });
    } catch (error) {
      fail(`${error.message} Re-authenticate with: hsapi auth login --portal ${portal.name}`);
    }
    const cache = oauthTokenCacheFromRefreshPayload(payload, source, Date.now(), refreshToken, priorCache);
    if (!oauthCacheBrokerCredential(cache)) {
      fail(`OAuth refresh through hosted broker failed for portal "${portal.name}": broker response did not include a brokerCredential.`);
    }
    requireOAuthCacheProfileMatch(portal, source, { status: 'read', cache, error: null });
    writeOAuthTokenCache(source.tokenCachePath, cache);
    return {
      token: cache.accessToken,
      source,
      tokenCache: redactedOAuthTokenCacheContract(source, { status: 'read', cache, error: null }),
      cacheStatus: 'refreshed'
    };
  }
  const env = oauthEnvValues(source, portal.name, cacheRead);
  const tokenUrl = new URL(source.tokenUrlPath, portal.baseUrl);
  let response;
  let text;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_TOKEN_REQUEST_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
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
    text = await response.text();
  } catch (_error) {
    fail(`OAuth refresh failed for portal "${portal.name}": network_error contacting HubSpot OAuth.`);
  } finally {
    clearTimeout(timer);
  }

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

  // Preserve the refresh token across refreshes: HubSpot may rotate it (use the
  // new value) or omit it (keep the one we used). Issue #78.
  const cache = oauthTokenCacheFromRefreshPayload(
    payload,
    source,
    Date.now(),
    env.refreshToken,
    cacheRead.cache,
    env.clientId
  );
  requireOAuthCacheProfileMatch(portal, source, { status: 'read', cache, error: null });
  writeOAuthTokenCache(source.tokenCachePath, cache);
  return {
    token: cache.accessToken,
    source,
    tokenCache: redactedOAuthTokenCacheContract(source, { status: 'read', cache, error: null }),
    cacheStatus: 'refreshed'
  };
}

async function refreshOAuthCredential(portal, source, _priorCacheRead = null) {
  return withOAuthTokenCacheMutationLock(source.tokenCachePath, portal.name, async () => {
    // The cache must be re-read only after both the in-process and cross-process
    // locks are held. A preceding caller may have rotated the refresh token and
    // persisted a fresh access token while this caller was waiting.
    const cacheRead = readOAuthTokenCache(source.tokenCachePath);
    requireOAuthCacheProfileMatch(portal, source, cacheRead);
    const cachedToken = usableOAuthCacheToken(cacheRead, source);
    if (cachedToken) {
      return {
        token: cachedToken,
        source,
        tokenCache: redactedOAuthTokenCacheContract(source, cacheRead),
        cacheStatus: 'cache_hit'
      };
    }
    return refreshOAuthCredentialUnlocked(portal, source, cacheRead);
  });
}

async function resolveOAuthCredential(portal, auth) {
  if (auth.required === false) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} does not require auth; refusing to send OAuth credentials.`);
  }
  if (auth.family !== AUTH_FAMILIES.OAUTH) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${auth.family || '<none>'}; OAuth credentials can only satisfy ${AUTH_FAMILIES.OAUTH} endpoints.`);
  }
  if (!portal.oauth) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${AUTH_FAMILIES.OAUTH}; portal "${portal.name}" is missing an auth.oauth profile.`);
  }

  assertTokenCacheOutsidePackage(portal.oauth.tokenCachePath, 'OAuth token cache');
  const cacheRead = readOAuthTokenCache(portal.oauth.tokenCachePath);
  requireOAuthCacheProfileMatch(portal, portal.oauth, cacheRead);
  const cachedToken = usableOAuthCacheToken(cacheRead, portal.oauth);
  if (cachedToken) {
    return {
      token: cachedToken,
      source: portal.oauth,
      tokenCache: redactedOAuthTokenCacheContract(portal.oauth, cacheRead),
      cacheStatus: 'cache_hit'
    };
  }
  return refreshOAuthCredential(portal, portal.oauth, cacheRead);
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
  assertTokenCacheOutsidePackage(source.tokenCachePath, 'Developer client-credentials token cache');
  const env = developerClientCredentialsEnvValues(source, portal.name);
  const tokenUrl = new URL(source.tokenUrlPath, portal.baseUrl);
  const body = {
    grant_type: 'client_credentials',
    client_id: env.clientId,
    client_secret: env.clientSecret,
    scope: source.scopes.join(' ')
  };
  let response;
  let text;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_TOKEN_REQUEST_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(body)
    });
    text = await response.text();
  } catch (_error) {
    fail(`Developer client-credentials refresh failed for portal "${portal.name}": network_error contacting HubSpot OAuth.`);
  } finally {
    clearTimeout(timer);
  }

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
  assertTokenCacheOutsidePackage(source.tokenCachePath, 'Developer client-credentials token cache');
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

// Least-privilege credential routing (issue #80). The chosen credential follows
// the endpoint's tokenAudience and the portal's configured identities:
//   1. auth.required === false              -> no credential.
//   2. user audience + portal has OAuth     -> ALWAYS OAuth. Once a portal has
//      an OAuth identity, user-audience endpoints use it; if the OAuth token is
//      missing/expired/unrefreshable, resolveOAuthCredential fails loudly with
//      the `hsapi auth login` message - we never silently fall back to a
//      higher-privilege (portal_bearer/developer) credential.
//   3. admin audience + portal has OAuth but NO portal_bearer and NO developer
//      -> hard-fail with an actionable "configure auth.portalBearer" message,
//      rather than over-privileging an admin call onto the user identity.
//   4. otherwise                            -> dispatch by auth.family exactly
//      as before. A portal_bearer-only profile (no OAuth) therefore behaves
//      identically to pre-#80 in every case.
function requestTokenAudience(auth) {
  return auth.tokenAudience || DEFAULT_TOKEN_AUDIENCE;
}

// Resolve the credential family that will actually satisfy this request, after
// applying the least-privilege routing. Returns one of AUTH_FAMILIES, or throws
// the admin-only-oauth hard-fail. Shared by resolveRequestCredential (execution)
// and credentialSourceForAuth (previews/--show-request) so both agree on the
// chosen identity. Issue #80.
function effectiveCredentialFamily(portal, auth) {
  const tokenAudience = requestTokenAudience(auth);

  // Once a portal has an OAuth identity, user-audience endpoints ALWAYS use it,
  // regardless of the endpoint's declared family, and never fall back.
  if (tokenAudience === TOKEN_AUDIENCES.USER && portal.oauth) {
    return AUTH_FAMILIES.OAUTH;
  }

  // Admin-audience endpoints must not be over-privileged onto a user identity:
  // an OAuth-only portal with no non-user credential is a hard failure.
  if (
    tokenAudience === TOKEN_AUDIENCES.ADMIN
    && portal.oauth
    && !portal.portalBearer
    && !portal.developer
  ) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires a non-user (admin) token; portal "${portal.name}" only has an OAuth identity. Configure auth.portalBearer (a private-app/service-key token) to run admin operations (custom objects, schemas, owners, pipelines, deletes, etc.).`);
  }

  return auth.family;
}

async function resolveRequestCredential(portal, auth) {
  if (auth.required === false) return null;

  const family = effectiveCredentialFamily(portal, auth);

  if (family === AUTH_FAMILIES.PORTAL_BEARER) return resolvePortalBearerCredential(portal, auth);
  if (family === AUTH_FAMILIES.OAUTH) {
    // Force the OAuth resolver's family check to pass even when the endpoint's
    // declared family was portal_bearer (user-audience promotion).
    return resolveOAuthCredential(portal, { ...auth, family: AUTH_FAMILIES.OAUTH });
  }
  if (family === AUTH_FAMILIES.DEVELOPER) return resolveDeveloperCredential(portal, auth);
  fail(`Endpoint ${auth.endpointId || '<unknown>'} requires unsupported auth family ${auth.family || '<none>'}.`);
}

function credentialSourceForAuth(portal, auth) {
  if (auth.required === false) return null;
  // Mirror the execution-time routing so --show-request / previews report the
  // identity a call will actually use, including user-audience OAuth promotion
  // and the admin-only-oauth hard-fail. Issue #80.
  const tokenAudience = requestTokenAudience(auth);
  const family = effectiveCredentialFamily(portal, auth);
  const promoted = family !== auth.family;
  if (family === AUTH_FAMILIES.PORTAL_BEARER) {
    if (!portal.portalBearer) {
      fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${AUTH_FAMILIES.PORTAL_BEARER}; portal "${portal.name}" is missing auth.portalBearer.tokenEnv or legacy tokenEnv.`);
    }
    const source = portal.portalBearer;
    const credentialSource = {
      type: 'env',
      identity: 'admin',
      tokenAudience,
      name: source.tokenEnv,
      profileField: source.profileField,
      provenance: source.provenance
    };
    if (source.kind) credentialSource.kind = source.kind;
    return credentialSource;
  }
  if (family === AUTH_FAMILIES.OAUTH) {
    if (portal.oauthCommandCredentials) {
      return {
        type: 'command_flags_or_env',
        identity: 'user',
        tokenAudience,
        name: 'oauth_command_credentials',
        redacted: true
      };
    }
    if (!portal.oauth) {
      fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${AUTH_FAMILIES.OAUTH}; portal "${portal.name}" is missing an auth.oauth profile.`);
    }
    const oauthCacheRead = readOAuthTokenCache(portal.oauth.tokenCachePath);
    const cacheHasRefreshToken = Boolean(oauthCacheRefreshToken(oauthCacheRead.cache));
    const cacheHasBrokerCredential = Boolean(oauthCacheBrokerCredential(oauthCacheRead.cache));
    if (portal.oauth.mode === OAUTH_MODES.HOSTED_BROKER) {
      const credentialSource = {
        type: 'oauth_hosted_broker',
        identity: 'user',
        tokenAudience,
        name: 'oauth_token_cache',
        profileField: portal.oauth.profileField,
        provenance: portal.oauth.provenance,
        mode: portal.oauth.mode,
        brokerUrl: portal.oauth.brokerUrl,
        refreshTokenSource: cacheHasRefreshToken ? 'cache' : 'none',
        brokerCredentialSource: cacheHasBrokerCredential ? 'cache' : 'none',
        tokenCache: redactedOAuthTokenCacheContract(portal.oauth, oauthCacheRead),
        redacted: true
      };
      if (promoted) credentialSource.routedFromFamily = auth.family;
      return credentialSource;
    }
    const refreshTokenEnv = portal.oauth.refreshTokenEnv || null;
    // Reflect where the refresh token comes from without emitting undefined for
    // login-based profiles (refreshTokenEnv === null). Issue #78.
    const refreshTokenSource = cacheHasRefreshToken
      ? 'cache'
      : (refreshTokenEnv && process.env[refreshTokenEnv] ? 'env' : 'none');
    const credentialSource = {
      type: 'oauth_refresh_token',
      identity: 'user',
      tokenAudience,
      name: refreshTokenEnv || 'oauth_token_cache',
      profileField: portal.oauth.profileField,
      provenance: portal.oauth.provenance,
      clientIdEnv: portal.oauth.clientIdEnv,
      clientSecretEnv: portal.oauth.clientSecretEnv,
      refreshTokenEnv,
      refreshTokenSource,
      tokenCache: redactedOAuthTokenCacheContract(portal.oauth, oauthCacheRead),
      redacted: true
    };
    // Flag when a user-audience endpoint declared portal_bearer but was routed
    // to the portal's OAuth identity, so the preview is unambiguous.
    if (promoted) credentialSource.routedFromFamily = auth.family;
    return credentialSource;
  }
  if (family === AUTH_FAMILIES.DEVELOPER) {
    return {
      ...developerCredentialSourceForAuth(portal, auth),
      identity: 'admin',
      tokenAudience
    };
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
    tokenAudience: auth.required === false ? auth.tokenAudience : requestTokenAudience(auth),
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
  DEFAULT_HOSTED_OAUTH_BROKER_URL,
  assertTokenCacheOutsidePackage,
  loadConfig,
  DEVELOPER_CLIENT_CREDENTIALS_TOKEN_CACHE_SCHEMA,
  OAUTH_MODES,
  OAUTH_TOKEN_CACHE_SCHEMA,
  OAUTH_TOKEN_CACHE_SCHEMA_V1,
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
  effectiveCredentialFamily,
  hubSpotResponseCategory,
  hubSpotResponseClass,
  hostedBrokerUrl,
  maybeResolvePortalBearerProfile,
  oauthCacheAccessToken,
  oauthCacheBrokerCredential,
  oauthCacheClientIdFingerprint,
  oauthCacheExpiresAt,
  oauthCacheHasExpectedSchema,
  oauthCacheHubId,
  oauthCacheProfileMatch,
  oauthCacheRefreshToken,
  oauthCacheRefreshedAt,
  oauthCacheStatus,
  oauthCacheTokenType,
  oauthCacheUserId,
  oauthClientIdFingerprint,
  oauthEnvValues,
  oauthMetadataScopes,
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
  requestTokenAudience,
  requireOAuthCacheProfileMatch,
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
  tokenCachePathIsOutsidePackage,
  usableDeveloperClientCredentialsCacheToken,
  usableOAuthCacheToken,
  withOAuthTokenCacheMutationLock,
  writeDeveloperClientCredentialsTokenCache,
  writeOAuthTokenCache,
};
