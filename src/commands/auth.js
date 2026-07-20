// hsapi auth: doctor (profile/cache diagnostics), the OAuth token commands, and
// the interactive `auth login`/`auth logout` per-user loopback flow (issue #77).
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const {
  exitCli,
  fail,
  writeStderr,
} = require('../runtime');
const {
  boolFlag,
  optionalNumber,
} = require('../flags');
const {
  printJson,
} = require('../output');
const {
  authBasePortal,
  authIntrospectBodyFromFlags,
  authRefreshBodyFromFlags,
  authRevokeBodyFromFlags,
  authTokenExchangeBodyFromFlags,
  authUrlFromFlags,
  buildAuthorizeUrl,
  parseOAuthCallback,
} = require('../command-inputs');
const {
  endpointDefinitionById,
} = require('../catalog');
const { loadConfig } = require('../auth-resolvers');
const {
  AUTH_FAMILIES,
  DEVELOPER_AUTH_SUBTYPES,
} = require('../auth');
const {
  OAUTH_MODES,
  assertTokenCacheOutsidePackage,
  hubSpotResponseCategory,
  hubSpotResponseClass,
  hostedBrokerStartKeyIsValid,
  maybeResolvePortalBearerProfile,
  oauthCacheBrokerCredential,
  oauthCacheProfileMatch,
  oauthCacheRefreshToken,
  oauthTokenCacheFromRefreshPayload,
  readOAuthTokenCache,
  redactedOAuthTokenCacheContract,
  resolveDeveloperProfile,
  resolveOAuthProfile,
  resolvePortal,
  resolveProfileDefaultFamily,
  tokenCachePathIsOutsidePackage,
  withOAuthTokenCacheMutationLock,
  writeOAuthTokenCache,
} = require('../auth-resolvers');
const {
  exchangeHostedBrokerLogin,
  revokeHostedBrokerTokens,
  startHostedBrokerLogin,
} = require('../oauth-broker');
const {
  guardedExternalNoAuthFormFetch,
} = require('../request');
const {
  PACKAGE_ROOT,
} = require('../config-paths');

const DEFAULT_LOGIN_TIMEOUT_MS = 300000;
const OAUTH_TOKEN_REQUEST_TIMEOUT_MS = 30000;
const LOGIN_SUCCESS_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>hsapi login</title></head>'
  + '<body style="font-family:system-ui,sans-serif;padding:2rem"><h1>Login complete</h1>'
  + '<p>You can close this tab and return to your terminal.</p></body></html>';

function isInsidePath(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function doctorCheck(checks, status, id, message, extra = {}) {
  checks.push({
    id,
    status,
    message,
    ...extra
  });
}

function doctorEnvCheck(checks, envName, label, options, extra = {}) {
  const present = Boolean(envName && process.env[envName]);
  const status = present ? 'pass' : (options.requireEnv ? 'fail' : 'warn');
  doctorCheck(
    checks,
    status,
    extra.id || `${label}.env`,
    present
      ? `${label} environment variable ${envName} is set.`
      : `${label} environment variable ${envName} is not set.`,
    {
      env: envName,
      present,
      ...extra
    }
  );
}

function doctorBrokerStartKeyEnvCheck(checks, envName, options) {
  const value = envName ? process.env[envName] : null;
  const present = Boolean(value);
  const valid = present && hostedBrokerStartKeyIsValid(value);
  const status = valid ? 'pass' : (present || options.requireEnv ? 'fail' : 'warn');
  doctorCheck(
    checks,
    status,
    'oauth.broker_start_key_env',
    valid
      ? `oauth broker session-start credential environment variable ${envName} is set and valid.`
      : present
        ? `oauth broker session-start credential environment variable ${envName} is set but must contain a 43-character base64url credential.`
        : `oauth broker session-start credential environment variable ${envName} is not set.`,
    {
      env: envName,
      present,
      valid,
      family: AUTH_FAMILIES.OAUTH,
      profileField: 'auth.oauth.brokerStartKeyEnv'
    }
  );
}

function doctorCachePathCheck(checks, cachePath, label, field) {
  if (!cachePath) return false;
  const insidePackage = !tokenCachePathIsOutsidePackage(cachePath);
  doctorCheck(
    checks,
    insidePackage ? 'fail' : 'pass',
    `${field}.outside_package`,
    insidePackage
      ? `${field} points inside the package. Token caches must live outside the package.`
      : `${field} points outside the package.`,
    {
      field,
      path: label || cachePath
    }
  );
  return !insidePackage;
}

function profileDoctor(name, rawPortal, options) {
  const checks = [];
  const portalBearer = maybeResolvePortalBearerProfile(rawPortal, name);
  const resolvedOAuth = resolveOAuthProfile(rawPortal, name);
  const oauth = resolvedOAuth
    ? {
      ...resolvedOAuth,
      portalId: rawPortal.portalId ? String(rawPortal.portalId) : null
    }
    : null;
  const developer = resolveDeveloperProfile(rawPortal, name);
  const authDefaultFamily = resolveProfileDefaultFamily(rawPortal, name);
  const authFamilies = [];

  if (portalBearer) authFamilies.push(AUTH_FAMILIES.PORTAL_BEARER);
  if (oauth) authFamilies.push(AUTH_FAMILIES.OAUTH);
  if (developer) authFamilies.push(AUTH_FAMILIES.DEVELOPER);

  doctorCheck(
    checks,
    authFamilies.length ? 'pass' : 'fail',
    'profile.auth_family.configured',
    authFamilies.length
      ? `Profile "${name}" declares auth families: ${authFamilies.join(', ')}.`
      : `Profile "${name}" does not declare auth.portalBearer, auth.oauth, auth.developer, or legacy tokenEnv.`
  );

  if (authDefaultFamily) {
    doctorCheck(
      checks,
      authFamilies.includes(authDefaultFamily) ? 'pass' : 'fail',
      'profile.default_family.configured',
      authFamilies.includes(authDefaultFamily)
        ? `auth.defaultFamily ${authDefaultFamily} is configured on this profile.`
        : `auth.defaultFamily ${authDefaultFamily} is not backed by a configured auth family on this profile.`,
      {
        authDefaultFamily
      }
    );
  }

  if (portalBearer) {
    doctorCheck(checks, 'pass', 'portal_bearer.profile', 'portal_bearer profile metadata is configured.', {
      profileField: portalBearer.profileField,
      provenance: portalBearer.provenance,
      kind: portalBearer.kind || null
    });
    doctorEnvCheck(checks, portalBearer.tokenEnv, 'portal_bearer token', options, {
      id: 'portal_bearer.env',
      family: AUTH_FAMILIES.PORTAL_BEARER,
      profileField: portalBearer.profileField
    });
  }

  if (oauth) {
    doctorCheck(checks, 'pass', 'oauth.profile', 'oauth profile metadata is configured.', {
      profileField: oauth.profileField,
      mode: oauth.mode,
      tokenUrlPath: oauth.tokenUrlPath,
      brokerUrl: oauth.brokerUrl
    });
    if (oauth.mode === OAUTH_MODES.HOSTED_BROKER) {
      doctorCheck(
        checks,
        'pass',
        'oauth.hosted_broker',
        'Hosted OAuth broker is configured; HubSpot client credentials and redirect handling stay server-side.',
        {
          family: AUTH_FAMILIES.OAUTH,
          mode: oauth.mode,
          profileField: 'auth.oauth.brokerUrl',
          brokerUrl: oauth.brokerUrl
        }
      );
      doctorBrokerStartKeyEnvCheck(checks, oauth.brokerStartKeyEnv, options);
      doctorCheck(
        checks,
        'pass',
        'oauth.refresh_token_env',
        'Hosted-broker OAuth uses broker-bound credentials from the token cache; no local refresh-token environment variable is read.',
        {
          family: AUTH_FAMILIES.OAUTH,
          profileField: 'auth.oauth.tokenCachePath',
          present: false,
          refreshTokenSource: 'cache'
        }
      );
    } else {
      doctorEnvCheck(checks, oauth.clientIdEnv, 'oauth client ID', options, {
        id: 'oauth.client_id_env',
        family: AUTH_FAMILIES.OAUTH,
        profileField: 'auth.oauth.clientIdEnv'
      });
      doctorEnvCheck(checks, oauth.clientSecretEnv, 'oauth client secret', options, {
        id: 'oauth.client_secret_env',
        family: AUTH_FAMILIES.OAUTH,
        profileField: 'auth.oauth.clientSecretEnv'
      });
      // refreshTokenEnv is optional (issue #78): login-based profiles persist
      // the refresh token to the per-user token cache, so a missing env var is
      // a pass, not a fail. When configured, the usual env check applies.
      if (oauth.refreshTokenEnv) {
        doctorEnvCheck(checks, oauth.refreshTokenEnv, 'oauth refresh token', options, {
          id: 'oauth.refresh_token_env',
          family: AUTH_FAMILIES.OAUTH,
          profileField: 'auth.oauth.refreshTokenEnv',
        });
      } else {
        doctorCheck(
          checks,
          'pass',
          'oauth.refresh_token_env',
          'auth.oauth.refreshTokenEnv is not set; this profile gets its refresh token from the token cache. Run: hsapi auth login --portal ' + name,
          {
            family: AUTH_FAMILIES.OAUTH,
            profileField: 'auth.oauth.refreshTokenEnv',
            present: false,
            refreshTokenSource: 'cache'
          }
        );
      }
    }
    const oauthCacheOutsidePackage = doctorCachePathCheck(
      checks,
      oauth.tokenCachePath,
      oauth.tokenCachePathDisplay,
      'auth.oauth.tokenCachePath'
    );
    const oauthCacheRead = oauthCacheOutsidePackage
      ? readOAuthTokenCache(oauth.tokenCachePath)
      : {
        status: 'invalid',
        cache: null,
        error: 'Token cache path resolves inside the package; credentials were not read.'
      };
    const oauthCacheContract = redactedOAuthTokenCacheContract(oauth, oauthCacheRead);
    const cacheStatus = oauthCacheContract.status;
    doctorCheck(
      checks,
      cacheStatus === 'usable' ? 'pass' : (cacheStatus === 'invalid' ? 'fail' : (cacheStatus === 'expired' ? 'warn' : 'pass')),
      'oauth.token_cache.status',
      cacheStatus === 'usable'
        ? `OAuth token cache is present and usable (expires ${oauthCacheContract.expiresAt}).`
        : cacheStatus === 'missing'
          ? `OAuth token cache is not yet present. Run: hsapi auth login --portal ${name} to authenticate.`
          : cacheStatus === 'expired'
            ? `OAuth access token expired; will auto-refresh on next use if the required ${oauth.mode === OAUTH_MODES.HOSTED_BROKER ? 'broker-bound credentials are' : 'refresh token is'} cached. Run: hsapi auth login --portal ${name} to re-authenticate.`
            : oauthCacheContract.profileMismatchReason === 'client_id_unavailable'
              ? `OAuth token cache cannot be app-identity checked because ${oauth.clientIdEnv} is not set. Set it, then run: hsapi auth login --portal ${name}`
              : oauthCacheContract.profileMismatchReason === 'client_id_fingerprint_missing'
                ? `OAuth token cache is a legacy cache without an OAuth app binding. Re-authenticate with: hsapi auth login --portal ${name}`
                : oauthCacheContract.profileMismatchReason === 'client_id_mismatch'
                  ? `OAuth token cache belongs to a different OAuth client app. Re-authenticate with: hsapi auth login --portal ${name}`
                  : `OAuth token cache is invalid. Run: hsapi auth login --portal ${name}`,
      {
        family: AUTH_FAMILIES.OAUTH,
        tokenCache: oauthCacheContract
      }
    );
  }

  if (developer) {
    const developerSubtypes = [];
    doctorCheck(checks, 'pass', 'developer.profile', 'developer profile metadata is configured.', {
      profileField: developer.profileField,
      tokenUrlPath: developer.tokenUrlPath
    });

    if (developer.personalAccessKeyEnv) {
      developerSubtypes.push(DEVELOPER_AUTH_SUBTYPES.PERSONAL_ACCESS_KEY);
      doctorEnvCheck(checks, developer.personalAccessKeyEnv, 'developer personal access key', options, {
        id: 'developer.personal_access_key_env',
        family: AUTH_FAMILIES.DEVELOPER,
        subtype: DEVELOPER_AUTH_SUBTYPES.PERSONAL_ACCESS_KEY,
        profileField: 'auth.developer.personalAccessKeyEnv'
      });
    }

    if (developer.developerApiKeyEnv) {
      developerSubtypes.push(DEVELOPER_AUTH_SUBTYPES.DEVELOPER_API_KEY);
      doctorEnvCheck(checks, developer.developerApiKeyEnv, 'developer API key', options, {
        id: 'developer.developer_api_key_env',
        family: AUTH_FAMILIES.DEVELOPER,
        subtype: DEVELOPER_AUTH_SUBTYPES.DEVELOPER_API_KEY,
        profileField: 'auth.developer.developerApiKeyEnv'
      });
    }

    if (developer.appIdEnv) {
      doctorEnvCheck(checks, developer.appIdEnv, 'developer app ID', options, {
        id: 'developer.app_id_env',
        family: AUTH_FAMILIES.DEVELOPER,
        subtype: DEVELOPER_AUTH_SUBTYPES.DEVELOPER_API_KEY,
        profileField: 'auth.developer.appIdEnv'
      });
    }

    const hasClientCredentialsField = Boolean(developer.clientIdEnv || developer.clientSecretEnv || developer.tokenCachePath);
    if (hasClientCredentialsField) {
      developerSubtypes.push(DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS);
      for (const [field, value] of [
        ['auth.developer.clientIdEnv', developer.clientIdEnv],
        ['auth.developer.clientSecretEnv', developer.clientSecretEnv],
        ['auth.developer.tokenCachePath', developer.tokenCachePathDisplay]
      ]) {
        doctorCheck(
          checks,
          value ? 'pass' : 'fail',
          `${field}.configured`,
          value
            ? `${field} is configured for developer/client_credentials.`
            : `${field} is required when any developer client-credentials field is configured.`,
          { field }
        );
      }
      if (developer.clientIdEnv) {
        doctorEnvCheck(checks, developer.clientIdEnv, 'developer client-credentials client ID', options, {
          id: 'developer.client_credentials.client_id_env',
          family: AUTH_FAMILIES.DEVELOPER,
          subtype: DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS,
          profileField: 'auth.developer.clientIdEnv'
        });
      }
      if (developer.clientSecretEnv) {
        doctorEnvCheck(checks, developer.clientSecretEnv, 'developer client-credentials client secret', options, {
          id: 'developer.client_credentials.client_secret_env',
          family: AUTH_FAMILIES.DEVELOPER,
          subtype: DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS,
          profileField: 'auth.developer.clientSecretEnv'
        });
      }
      doctorCachePathCheck(checks, developer.tokenCachePath, developer.tokenCachePathDisplay, 'auth.developer.tokenCachePath');
    }

    doctorCheck(
      checks,
      developerSubtypes.length ? 'pass' : 'fail',
      'developer.subtype.configured',
      developerSubtypes.length
        ? `Developer auth subtypes configured: ${developerSubtypes.join(', ')}.`
        : 'auth.developer is present but no developer credential subtype fields are configured.',
      {
        subtypes: developerSubtypes
      }
    );
  }

  if (oauth && developer && oauth.tokenCachePath && developer.tokenCachePath) {
    doctorCheck(
      checks,
      oauth.tokenCachePath === developer.tokenCachePath ? 'fail' : 'pass',
      'token_cache.paths.separate',
      oauth.tokenCachePath === developer.tokenCachePath
        ? 'auth.oauth.tokenCachePath and auth.developer.tokenCachePath must be separate.'
        : 'OAuth and developer client-credentials token caches are separate.',
      {
        oauthTokenCachePath: oauth.tokenCachePathDisplay || oauth.tokenCachePath,
        developerTokenCachePath: developer.tokenCachePathDisplay || developer.tokenCachePath
      }
    );
  }

  const summary = checks.reduce((counts, check) => {
    counts[check.status] = (counts[check.status] || 0) + 1;
    return counts;
  }, {});

  return {
    name,
    label: rawPortal.label || name,
    portalId: rawPortal.portalId || null,
    baseUrl: rawPortal.baseUrl || 'https://api.hubapi.com',
    authFamilies,
    authDefaultFamily,
    ready: !summary.fail && !summary.warn,
    checks,
    summary
  };
}

function runAuthDoctor(flags) {
  const { configPath, config } = loadConfig();
  const requireEnv = boolFlag(flags, 'require-env');
  const selectedPortal = flags.portal || null;
  const names = selectedPortal ? [selectedPortal] : Object.keys(config.portals);
  if (selectedPortal && !config.portals[selectedPortal]) {
    fail(`Unknown portal "${selectedPortal}". Run: hsapi profiles list`);
  }

  const profiles = names.map((name) => profileDoctor(name, config.portals[name], { requireEnv }));
  const summary = profiles.reduce((counts, profile) => {
    for (const [status, count] of Object.entries(profile.summary)) {
      counts[status] = (counts[status] || 0) + count;
    }
    return counts;
  }, {});
  const ok = !summary.fail;
  const output = {
    ok,
    ready: ok && !summary.warn,
    configPath,
    requireEnv,
    profileCount: profiles.length,
    summary,
    authFamilies: Object.values(AUTH_FAMILIES),
    developerAuthSubtypes: Object.values(DEVELOPER_AUTH_SUBTYPES),
    profiles,
    commandAuthDiscovery: {
      catalogCommands: 'hsapi catalog commands',
      preview: 'Add --show-request to a command to see authFamily, authSubtype, and redacted credential sources before any request is sent.'
    }
  };
  printJson(output);
  if (!ok) exitCli(1);
}

// ---------------------------------------------------------------------------
// Interactive per-user OAuth login (issue #77).
//
// SECURITY: the loopback server binds 127.0.0.1 only, validates the `state`
// nonce, ignores non-callback paths, enforces a timeout, and always closes the
// socket in a finally. Secrets (client_secret), the authorization code, and the
// access/refresh tokens are never logged or printed.
// ---------------------------------------------------------------------------

// Parse + validate the loopback redirect URL. Host must be localhost/127.0.0.1.
function parseLoopbackRedirect(redirectUrl, portalName) {
  let parsed;
  try {
    parsed = new URL(String(redirectUrl));
  } catch (error) {
    fail(`auth login: portal "${portalName}" auth.oauth.redirectUrl is not a valid URL: ${error.message}`);
  }
  const host = parsed.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    fail(`auth login: portal "${portalName}" auth.oauth.redirectUrl host must be localhost or 127.0.0.1 (got "${host}"). Loopback redirect required.`);
  }
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fail(`auth login: portal "${portalName}" auth.oauth.redirectUrl must include a valid port.`);
  }
  return { port, path: parsed.pathname || '/' };
}

// Best-effort: open the system browser. On failure, the caller still prints the
// URL so the user can open it manually.
function openBrowser(url) {
  try {
    const target = url.toString();
    let command;
    let args;
    if (process.platform === 'win32') {
      // Open via PowerShell Start-Process rather than `cmd /c start "" <url>`:
      // cmd treats `&` in the URL as a command separator (even when the URL is
      // quoted), which truncates the OAuth authorize URL at the first query
      // parameter — dropping redirect_uri, scope, and state. PowerShell receives
      // the URL as a single-quoted literal, so `&` is preserved.
      command = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${target.replace(/'/g, "''")}'`];
    } else if (process.platform === 'darwin') {
      command = 'open';
      args = [target];
    } else {
      command = 'xdg-open';
      args = [target];
    }
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (_error) {
    return false;
  }
}

// Bind the loopback server and resolve with the captured authorization code, or
// reject on state mismatch / OAuth error / timeout. Always closes the server.
function awaitOAuthCallback({ port, path: callbackPath, expectedState, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const server = http.createServer((req, res) => {
      const result = parseOAuthCallback(req.url, expectedState, callbackPath);
      if (!result.ok && result.ignore) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      if (!result.ok) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Login failed. Return to your terminal.');
        finish(() => reject(new Error(`auth login failed: ${result.error}`)));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(LOGIN_SUCCESS_HTML);
      finish(() => resolve(result.code));
    });

    function finish(action) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Close in a finally-equivalent: always tear the socket down.
      try {
        server.close();
      } finally {
        action();
      }
    }

    server.on('error', (error) => {
      finish(() => reject(new Error(`auth login: could not bind loopback server on 127.0.0.1:${port}: ${error.message}`)));
    });

    timer = setTimeout(() => {
      finish(() => reject(new Error(`auth login: timed out after ${timeoutMs}ms waiting for the OAuth callback.`)));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    server.listen(port, '127.0.0.1');
  });
}

// Exchange the authorization code for tokens. Mirrors refreshOAuthCredential's
// fetch + HubSpot error handling style. Secrets are never surfaced.
async function exchangeAuthorizationCode(portal, oauth, env, redirectUrl, code, codeVerifier) {
  const tokenUrl = new URL(oauth.tokenUrlPath, portal.baseUrl);
  // PKCE: send the code_verifier matching the authorize request's S256 challenge.
  // client_secret is included only when configured — HubSpot user-level apps may
  // accept a confidential client + PKCE; if the exchange is later found to reject
  // a secret on this public-client flow, drop client_secret here.
  const exchangeBody = {
    grant_type: 'authorization_code',
    client_id: env.clientId,
    redirect_uri: redirectUrl,
    code
  };
  if (codeVerifier) exchangeBody.code_verifier = codeVerifier;
  if (env.clientSecret) exchangeBody.client_secret = env.clientSecret;
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
      body: new URLSearchParams(exchangeBody)
    });
    text = await response.text();
  } catch (_error) {
    fail(`auth login token exchange failed for portal "${portal.name}": network_error contacting HubSpot OAuth.`);
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
    fail(`auth login token exchange failed for portal "${portal.name}": HubSpot ${responseClass} response${categoryText} (${response.status} ${response.statusText || 'HTTP error'}).`);
  }
  return payload;
}

function requireLoginPrerequisites(portal, oauth) {
  if (!oauth) {
    fail(`auth login: portal "${portal.name}" has no auth.oauth profile.`);
  }
  if (oauth.mode === OAUTH_MODES.HOSTED_BROKER) {
    if (!portal.portalId || !/^[1-9][0-9]*$/.test(String(portal.portalId))) {
      fail(`auth login: portal "${portal.name}" must define a numeric portalId for hosted-broker account binding.`);
    }
    if (!oauth.brokerUrl) {
      fail(`auth login: portal "${portal.name}" is missing required hosted-broker configuration: auth.oauth.brokerUrl.`);
    }
    const brokerStartKey = process.env[oauth.brokerStartKeyEnv];
    if (!brokerStartKey) {
      fail(`auth login: portal "${portal.name}" is missing ${oauth.brokerStartKeyEnv} (auth.oauth.brokerStartKeyEnv).`);
    }
    if (!hostedBrokerStartKeyIsValid(brokerStartKey)) {
      fail(`auth login: ${oauth.brokerStartKeyEnv} must contain the 43-character base64url broker session-start credential.`);
    }
    return { brokerStartKey };
  }
  const missing = [];
  const clientId = process.env[oauth.clientIdEnv];
  const clientSecret = process.env[oauth.clientSecretEnv];
  if (!clientId) missing.push(`${oauth.clientIdEnv} (auth.oauth.clientIdEnv)`);
  if (!clientSecret) missing.push(`${oauth.clientSecretEnv} (auth.oauth.clientSecretEnv)`);
  if (!oauth.redirectUrl) missing.push('auth.oauth.redirectUrl');
  if (!Array.isArray(oauth.scopes) || !oauth.scopes.length) missing.push('auth.oauth.scopes');
  if (missing.length) {
    fail(`auth login: portal "${portal.name}" is missing required login configuration: ${missing.join(', ')}.`);
  }
  return { clientId, clientSecret };
}

function loginTimeoutFromFlags(flags) {
  return flags.timeout !== undefined
    ? (optionalNumber(flags.timeout) || DEFAULT_LOGIN_TIMEOUT_MS)
    : DEFAULT_LOGIN_TIMEOUT_MS;
}

function oauthPkceMaterial() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  return {
    codeVerifier,
    codeChallenge: crypto.createHash('sha256').update(codeVerifier).digest('base64url')
  };
}

function waitForBrokerPoll(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runHostedBrokerAuthLogin(portal, oauth, flags) {
  assertTokenCacheOutsidePackage(oauth.tokenCachePath, 'OAuth token cache');
  const { brokerStartKey } = requireLoginPrerequisites(portal, oauth);
  const timeoutMs = loginTimeoutFromFlags(flags);
  const { codeVerifier, codeChallenge } = oauthPkceMaterial();
  const consumeSecret = crypto.randomBytes(32).toString('base64url');
  const consumeSecretHash = crypto.createHash('sha256').update(consumeSecret).digest('base64url');
  let session;
  try {
    session = await startHostedBrokerLogin(oauth, {
      codeChallenge,
      consumeSecretHash,
      accountId: portal.portalId,
      brokerStartKey
    });
  } catch (error) {
    fail(error.message);
  }

  const sessionTimeoutMs = session.expiresIn
    ? Math.min(timeoutMs, session.expiresIn * 1000)
    : timeoutMs;
  const deadline = Date.now() + sessionTimeoutMs;
  let pollIntervalMs = Math.min(Math.max((session.intervalSeconds || 1) * 1000, 500), 5000);

  // The URL contains the broker-created OAuth state but never the consume
  // secret, verifier, HubSpot client secret, or resulting tokens.
  writeStderr(`Opening browser for HubSpot login (portal "${portal.name}", hosted broker).\nIf it does not open, visit:\n${session.authorizationUrl.toString()}\n`);
  openBrowser(session.authorizationUrl);

  while (Date.now() < deadline) {
    let exchange;
    try {
      exchange = await exchangeHostedBrokerLogin(oauth, {
        sessionId: session.sessionId,
        consumeSecret,
        codeVerifier
      });
    } catch (error) {
      fail(error.message);
    }
    if (exchange.status === 'complete') {
      if (!exchange.token.refreshToken || !exchange.token.brokerCredential) {
        fail(`auth login broker token exchange failed for portal "${portal.name}": response did not include broker-bound refresh credentials.`);
      }
      const cache = await withOAuthTokenCacheMutationLock(
        oauth.tokenCachePath,
        portal.name,
        async () => {
          const candidate = oauthTokenCacheFromRefreshPayload(exchange.token, oauth);
          const profileMatch = oauthCacheProfileMatch(candidate, oauth);
          if (!profileMatch.ok) {
            fail(`auth login broker token exchange failed for portal "${portal.name}": broker response did not match the configured OAuth profile (${profileMatch.reason}).`);
          }
          writeOAuthTokenCache(oauth.tokenCachePath, candidate);
          return candidate;
        }
      );
      printJson({
        ok: true,
        portal: portal.name,
        action: 'login',
        oauthMode: oauth.mode,
        tokenCache: redactedOAuthTokenCacheContract(oauth, { status: 'read', cache, error: null }),
        scopeSource: 'hosted_broker'
      });
      return;
    }
    if (exchange.intervalSeconds) {
      pollIntervalMs = Math.min(Math.max(exchange.intervalSeconds * 1000, 500), 5000);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await waitForBrokerPoll(Math.min(pollIntervalMs, remainingMs));
  }
  fail(`auth login: timed out after ${sessionTimeoutMs}ms waiting for hosted OAuth broker completion.`);
}

async function runLocalAuthLogin(portal, oauth, flags) {
  assertTokenCacheOutsidePackage(oauth.tokenCachePath, 'OAuth token cache');
  const env = requireLoginPrerequisites(portal, oauth);
  const { port, path: callbackPath } = parseLoopbackRedirect(oauth.redirectUrl, portal.name);

  const timeoutMs = loginTimeoutFromFlags(flags);

  const state = crypto.randomBytes(16).toString('hex');
  // PKCE (RFC 7636, S256): HubSpot user-level apps require a code challenge on the
  // authorize request; the matching verifier is sent at token exchange.
  const { codeVerifier, codeChallenge } = oauthPkceMaterial();
  const authorizeUrl = buildAuthorizeUrl({
    authorizeUrlBase: oauth.authorizeUrlBase,
    clientId: env.clientId,
    redirectUrl: oauth.redirectUrl,
    scopes: oauth.scopes,
    optionalScopes: oauth.optionalScopes,
    state,
    codeChallenge
  });

  // Always print the URL so the user can open it manually if the browser does
  // not launch. stderr keeps stdout reserved for the JSON result.
  writeStderr(`Opening browser for HubSpot login (portal "${portal.name}").\nIf it does not open, visit:\n${authorizeUrl.toString()}\n`);
  openBrowser(authorizeUrl);

  const code = await awaitOAuthCallback({ port, path: callbackPath, expectedState: state, timeoutMs });
  const payload = await exchangeAuthorizationCode(portal, oauth, env, oauth.redirectUrl, code, codeVerifier);
  const cache = await withOAuthTokenCacheMutationLock(
    oauth.tokenCachePath,
    portal.name,
    async () => {
      const candidate = oauthTokenCacheFromRefreshPayload(
        payload,
        oauth,
        Date.now(),
        null,
        null,
        env.clientId
      );
      const profileMatch = oauthCacheProfileMatch(candidate, oauth);
      if (!profileMatch.ok) {
        fail(`auth login token exchange failed for portal "${portal.name}": response did not match the configured OAuth profile (${profileMatch.reason}).`);
      }
      writeOAuthTokenCache(oauth.tokenCachePath, candidate);
      return candidate;
    }
  );

  printJson({
    ok: true,
    portal: portal.name,
    action: 'login',
    tokenCache: redactedOAuthTokenCacheContract(oauth, { status: 'read', cache, error: null }),
    scopesRequested: [...oauth.scopes],
    optionalScopesRequested: oauth.optionalScopes && oauth.optionalScopes.length ? [...oauth.optionalScopes] : undefined
  });
}

async function runAuthLogin(flags) {
  const { config } = loadConfig();
  const portal = resolvePortal(config, flags);
  const oauth = portal.oauth;
  if (!oauth) requireLoginPrerequisites(portal, oauth);
  if (oauth.mode === OAUTH_MODES.HOSTED_BROKER) {
    await runHostedBrokerAuthLogin(portal, oauth, flags);
    return;
  }
  await runLocalAuthLogin(portal, oauth, flags);
}

async function runAuthLogout(flags) {
  const { config } = loadConfig();
  const portal = resolvePortal(config, flags);
  const oauth = portal.oauth;
  if (!oauth) {
    fail(`auth logout: portal "${portal.name}" has no auth.oauth profile with a tokenCachePath.`);
  }
  const cachePath = oauth.tokenCachePath;
  assertTokenCacheOutsidePackage(cachePath, 'OAuth token cache');
  let removed = false;
  let remoteRevocation = oauth.mode === OAUTH_MODES.HOSTED_BROKER
    ? {
      attempted: false,
      status: 'not_attempted',
      error: null
    }
    : null;
  await withOAuthTokenCacheMutationLock(cachePath, portal.name, async () => {
    // Re-read only after acquiring the cache lock. A refresh or login may have
    // replaced both the access and refresh credentials while logout waited.
    if (fs.existsSync(cachePath)) {
      if (oauth.mode === OAUTH_MODES.HOSTED_BROKER) {
        const cacheRead = readOAuthTokenCache(cachePath);
        const refreshToken = oauthCacheRefreshToken(cacheRead.cache);
        const brokerCredential = oauthCacheBrokerCredential(cacheRead.cache);
        const profileMatch = oauthCacheProfileMatch(cacheRead.cache, oauth);
        if (!profileMatch.ok) {
          remoteRevocation = {
            attempted: false,
            status: 'not_attempted',
            error: `cache_profile_mismatch:${profileMatch.reason}`
          };
        } else if (!refreshToken || !brokerCredential) {
          remoteRevocation = {
            attempted: false,
            status: 'not_attempted',
            error: 'broker_bound_credentials_missing'
          };
        } else {
          remoteRevocation.attempted = true;
          try {
            await revokeHostedBrokerTokens(oauth, {
              refreshToken,
              brokerCredential
            });
            remoteRevocation.status = 'revoked';
          } catch (error) {
            remoteRevocation.status = 'failed';
            remoteRevocation.error = error.message;
          }
        }
      }
      // Logout always removes the local bearer and refresh credentials. Remote
      // revocation is best-effort and reported separately; a network outage must
      // not leave a usable local session behind.
      fs.rmSync(cachePath);
      removed = true;
    }
  });
  printJson({
    ok: true,
    portal: portal.name,
    action: 'logout',
    removed,
    revoked: remoteRevocation ? remoteRevocation.status === 'revoked' : false,
    remoteRevocation,
    oauthMode: oauth.mode,
    path: oauth.tokenCachePathDisplay || cachePath
  });
}

// All command JSON flows through this small output layer so generic requests
// and typed helpers share projection, compact mode, and agent-safe budgets.

// Static set of operations HubSpot blocks for user-level OAuth tokens.
// Used by whoami so callers know what still requires an admin credential.
const ADMIN_ONLY_OPERATIONS = [
  'crm archive / batch-archive (DELETE) — blocked by HubSpot for user tokens',
  'crm list/get owners',
  'crm list/get pipelines and pipeline stages',
  'crm schemas (custom object definitions)',
  'any custom object read/write',
  'auth introspect, revoke',
];

function runAuthWhoami(flags) {
  const { configPath, config } = loadConfig();
  const portal = resolvePortal(config, flags);

  const authFamilies = [
    portal.portalBearer && AUTH_FAMILIES.PORTAL_BEARER,
    portal.oauth && AUTH_FAMILIES.OAUTH,
    portal.developer && AUTH_FAMILIES.DEVELOPER,
  ].filter(Boolean);

  const result = {
    ok: true,
    portal: portal.name,
    portalId: portal.portalId,
    label: portal.label,
    baseUrl: portal.baseUrl,
    authFamilies,
    authDefaultFamily: portal.authDefaultFamily || null,
    configPath,
  };

  if (portal.oauth) {
    const oauthCacheRead = tokenCachePathIsOutsidePackage(portal.oauth.tokenCachePath)
      ? readOAuthTokenCache(portal.oauth.tokenCachePath)
      : {
        status: 'invalid',
        cache: null,
        error: 'Token cache path resolves inside the package; credentials were not read.'
      };
    const oauthCacheContract = redactedOAuthTokenCacheContract(portal.oauth, oauthCacheRead);
    result.oauth = oauthCacheContract;
    if (oauthCacheContract.status !== 'usable') {
      result.oauth.hint = oauthCacheContract.profileMismatchReason === 'client_id_unavailable'
        ? `Set ${portal.oauth.clientIdEnv}, then run: hsapi auth login --portal ${portal.name}`
        : oauthCacheContract.profileMismatchReason === 'client_id_fingerprint_missing'
          ? `Legacy cache is not bound to an OAuth client app. Re-authenticate with: hsapi auth login --portal ${portal.name}`
          : oauthCacheContract.profileMismatchReason === 'client_id_mismatch'
            ? `Cache belongs to a different OAuth client app. Re-authenticate with: hsapi auth login --portal ${portal.name}`
            : `Run: hsapi auth login --portal ${portal.name}`;
    }
  }

  if (portal.portalBearer) {
    result.portalBearer = {
      tokenEnv: portal.portalBearer.tokenEnv,
      kind: portal.portalBearer.kind || null,
      envSet: Boolean(process.env[portal.portalBearer.tokenEnv]),
    };
  }

  result.adminOnlyOperations = ADMIN_ONLY_OPERATIONS;
  printJson(result);
}

async function runAuth(action, rest, flags) {
  if (action === 'whoami') {
    runAuthWhoami(flags);
    return;
  }

  if (action === 'doctor' || action === 'validate') {
    runAuthDoctor(flags);
    return;
  }

  // Per-user local-loopback or hosted-broker flows. These resolve a real
  // configured portal (not the synthetic auth base portal) and never call a
  // HubSpot endpoint through the catalog, so they have no catalog entry.
  if (action === 'login') {
    await runAuthLogin(flags);
    return;
  }

  if (action === 'logout') {
    await runAuthLogout(flags);
    return;
  }

  const portal = authBasePortal(flags);
  const tokenUrl = new URL('/oauth/2026-03/token', portal.baseUrl);

  if (action === 'authorize-url' || action === 'authorization-url') {
    const url = authUrlFromFlags(flags);
    printJson({
      ok: true,
      authorizationUrl: url.toString(),
      params: {
        clientId: url.searchParams.get('client_id'),
        redirectUri: url.searchParams.get('redirect_uri'),
        scope: url.searchParams.get('scope'),
        optionalScopes: url.searchParams.get('optional_scopes') || null,
        state: url.searchParams.get('state') || null
      }
    });
    return;
  }

  if (action === 'token' || action === 'exchange') {
    printJson(await guardedExternalNoAuthFormFetch(portal, 'POST', tokenUrl, flags, authTokenExchangeBodyFromFlags(flags), {
      endpoint: endpointDefinitionById('auth.oauth.token')
    }));
    return;
  }

  if (action === 'refresh') {
    printJson(await guardedExternalNoAuthFormFetch(portal, 'POST', tokenUrl, flags, authRefreshBodyFromFlags(flags), {
      endpoint: endpointDefinitionById('auth.oauth.refresh')
    }));
    return;
  }

  if (action === 'introspect') {
    printJson(await guardedExternalNoAuthFormFetch(portal, 'POST', new URL('/oauth/2026-03/token/introspect', portal.baseUrl), flags, authIntrospectBodyFromFlags(flags), {
      endpoint: endpointDefinitionById('auth.oauth.introspect'),
      readOnly: true
    }));
    return;
  }

  if (action === 'revoke') {
    if (!boolFlag(flags, 'danger-revoke-token')) fail('auth revoke requires --danger-revoke-token.');
    printJson(await guardedExternalNoAuthFormFetch(portal, 'POST', new URL('/oauth/2026-03/token/revoke', portal.baseUrl), flags, authRevokeBodyFromFlags(flags), {
      endpoint: endpointDefinitionById('auth.oauth.revoke')
    }));
    return;
  }

  fail(`Unknown auth action: ${action}`);
}

module.exports = {
  ADMIN_ONLY_OPERATIONS,
  doctorCachePathCheck,
  doctorCheck,
  doctorEnvCheck,
  isInsidePath,
  profileDoctor,
  runAuth,
  runAuthDoctor,
  runAuthWhoami,
};
