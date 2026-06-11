// Request core: URL building + origin allowlist, retry policy, the
// hubspotFetch/guardedFetch family with preview-first mutation gating,
// external (non-portal-origin) fetch wrappers, and cursor pagination.
const {
  exitCli,
  fail,
  writeStderr,
  writeStdout,
} = require('./runtime');
const {
  SAFE_METHODS,
  boolFlag,
  pathPart,
  values,
} = require('./flags');
const {
  JSONL_STREAMED,
  jsonlStreamFromFlags,
  parseNonNegativeIntegerFlag,
  printJson,
  redactTokenUrl,
} = require('./output');
const {
  recordMutationHistory,
} = require('./history');
const {
  endpointDefinitions,
  findEndpointDefinition,
  pathTemplateToRegex,
} = require('./catalog');
const {
  AUTH_FAMILIES,
  DEVELOPER_AUTH_SUBTYPES,
} = require('./auth');
const {
  requestAuthMetadata,
  resolveRequestCredential,
} = require('./auth-resolvers');
const {
  accessNoteForError,
} = require('./tiers');
const {
  CATALOG_FILE,
} = require('./config-paths');

const RATE_LIMIT_HEADERS = [
  'x-hubspot-ratelimit-daily',
  'x-hubspot-ratelimit-daily-remaining',
  'x-hubspot-ratelimit-interval-milliseconds',
  'x-hubspot-ratelimit-max',
  'x-hubspot-ratelimit-remaining',
  'retry-after'
];

const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'hapikey',
  'refresh_token',
  'token'
]);

const SENSITIVE_BODY_KEYS = new Set([
  'access_token',
  'client_secret',
  'code',
  'developerApiKey',
  'developer_api_key',
  'hapikey',
  'personalAccessKey',
  'personal_access_key',
  'refresh_token',
  'signed_access_token',
  'token'
]);

const MAX_RETRY_AFTER_MS = 15000;

const DEFAULT_PAGINATE_MAX_RESULTS = 1000;

const CRM_SEARCH_WINDOW_LIMIT = 10000;

function appendQuery(url, flags) {
  for (const item of values(flags.query)) {
    const [key, ...rest] = String(item).split('=');
    if (!key || rest.length === 0) fail(`Invalid --query value "${item}". Expected k=v.`);
    url.searchParams.append(key, rest.join('='));
  }
}

function buildUrl(portal, inputPath, flags) {
  const raw = String(inputPath || '');
  const url = raw.startsWith('http://') || raw.startsWith('https://')
    ? new URL(raw)
    : new URL(raw.startsWith('/') ? raw : `/${raw}`, portal.baseUrl);
  assertAllowedHubSpotUrl(portal, url);
  appendQuery(url, flags);
  return url;
}

function assertAllowedHubSpotUrl(portal, url) {
  const allowedOrigin = new URL(portal.baseUrl).origin;
  if (url.origin !== allowedOrigin) {
    fail(`Refusing to send HubSpot token to non-HubSpot/API origin: ${url.origin}. Expected ${allowedOrigin}.`);
  }
}

function responseMeta(response) {
  const headers = {};
  for (const header of RATE_LIMIT_HEADERS) {
    const value = response.headers.get(header);
    if (value !== null) headers[header] = value;
  }
  return {
    rateLimit: Object.keys(headers).length ? headers : undefined,
    requestId: response.headers.get('x-hubspot-correlation-id') || undefined
  };
}

function safeRetryLimit() {
  const raw = process.env.HSAPI_SAFE_RETRIES;
  if (raw === undefined || raw === '') return 1;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return 1;
  return Math.min(value, 3);
}

function retryDelayMs(response, attempt = 0) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null && retryAfter !== '') {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      if (seconds <= 0) return 0;
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) + Math.floor(Math.random() * 100);
    }
  }
  return Math.min(200 * (attempt + 1), 1000) + Math.floor(Math.random() * 100);
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyCredentialToRequest(url, headers, credential) {
  if (!credential) return;
  if (credential.placement === 'query') {
    for (const [key, value] of Object.entries(credential.query || {})) {
      url.searchParams.set(key, value);
    }
    return;
  }
  headers.Authorization = `Bearer ${credential.token}`;
}

function shouldRetryResponse(method, response, attempt, limit, options = {}) {
  if (attempt >= limit) return false;
  if (response.status !== 429 && response.status < 500) return false;
  // Safe HTTP methods are always retryable. Catalog-marked read-only POSTs
  // (CRM search and friends - HubSpot's tightest rate limit) are read
  // semantics over POST and are equally safe to retry.
  return SAFE_METHODS.has(method) || options.readOnlyPostRetry === true;
}

function readOnlyPostRetryOption(endpoint) {
  return {
    readOnlyPostRetry: Boolean(endpoint && endpoint.readOnlyPost === true && endpoint.risk === 'read')
  };
}

async function hubspotFetchResponse(url, options, method, retryOptions = {}) {
  const limit = safeRetryLimit();
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, options);
    if (!shouldRetryResponse(method, response, attempt, limit, retryOptions)) return response;
    await sleep(retryDelayMs(response, attempt));
  }
}

async function hubspotFetchAllowError(portal, method, inputPath, flags, body, endpointOverride = null) {
  const url = buildUrl(portal, inputPath, flags);
  const endpoint = endpointOverride || findEndpointDefinition(method, url.pathname);
  const auth = requestAuthMetadata(portal, endpoint);
  if (boolFlag(flags, 'show-request')) {
    showRequestPreview(portal, method, url, body, endpoint, { auth });
  }

  const credential = await resolveRequestCredential(portal, auth);
  const headers = {
    Accept: 'application/json'
  };
  applyCredentialToRequest(url, headers, credential);

  const options = {
    method,
    headers
  };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await hubspotFetchResponse(url, options, method, readOnlyPostRetryOption(endpoint));
  recordMutationHistory(portal, method, url, endpoint, response);
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = text;
    }
  }

  const output = {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    ...responseMeta(response),
    portal: portal.name,
    method,
    url: redactTokenUrl(url.toString())
  };
  if (response.ok) {
    output.data = payload;
  } else {
    output.response = redactSensitiveValue(payload);
    const accessNote = accessNoteForError(output.url, response.status);
    if (accessNote) output.note = accessNote;
  }
  return output;
}

async function hubspotFetch(portal, method, inputPath, flags, body, endpointOverride = null) {
  const url = buildUrl(portal, inputPath, flags);
  const endpoint = endpointOverride || findEndpointDefinition(method, url.pathname);
  const auth = requestAuthMetadata(portal, endpoint);
  if (boolFlag(flags, 'show-request')) {
    showRequestPreview(portal, method, url, body, endpoint, { auth });
  }

  const credential = await resolveRequestCredential(portal, auth);

  const headers = {
    Accept: 'application/json'
  };
  applyCredentialToRequest(url, headers, credential);

  const options = {
    method,
    headers
  };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await hubspotFetchResponse(url, options, method, readOnlyPostRetryOption(endpoint));
  recordMutationHistory(portal, method, url, endpoint, response);
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
    const urlString = redactTokenUrl(url.toString());
    const error = {
      ok: false,
      status: response.status,
      statusText: response.statusText,
      ...responseMeta(response),
      portal: portal.name,
      method,
      url: urlString,
      response: redactSensitiveValue(payload)
    };
    const accessNote = accessNoteForError(urlString, response.status);
    if (accessNote) error.note = accessNote;
    printJson(error);
    exitCli(1);
  }

  return {
    ok: true,
    status: response.status,
    ...responseMeta(response),
    portal: portal.name,
    method,
    url: redactTokenUrl(url.toString()),
    data: payload
  };
}

async function hubspotMultipartFetch(portal, method, inputPath, flags, formBody, previewBody, endpointOverride = null) {
  const url = buildUrl(portal, inputPath, flags);
  const endpoint = endpointOverride || findEndpointDefinition(method, url.pathname);
  const auth = requestAuthMetadata(portal, endpoint);
  if (boolFlag(flags, 'show-request')) {
    showRequestPreview(portal, method, url, previewBody, endpoint, {
      auth,
      contentType: 'multipart/form-data'
    });
  }

  const credential = await resolveRequestCredential(portal, auth);
  const headers = {
    Accept: 'application/json'
  };
  applyCredentialToRequest(url, headers, credential);

  const response = await fetch(url, {
    method,
    headers,
    body: formBody
  });
  recordMutationHistory(portal, method, url, endpoint, response);
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
    const urlString = redactTokenUrl(url.toString());
    const error = {
      ok: false,
      status: response.status,
      statusText: response.statusText,
      ...responseMeta(response),
      portal: portal.name,
      method,
      url: urlString,
      response: redactSensitiveValue(payload)
    };
    const accessNote = accessNoteForError(urlString, response.status);
    if (accessNote) error.note = accessNote;
    printJson(error);
    exitCli(1);
  }

  return {
    ok: true,
    status: response.status,
    ...responseMeta(response),
    portal: portal.name,
    method,
    url: redactTokenUrl(url.toString()),
    data: payload
  };
}

function previewUrlForAuth(url, auth) {
  const previewUrl = new URL(url.toString());
  if (auth.family !== AUTH_FAMILIES.DEVELOPER || auth.subtype !== DEVELOPER_AUTH_SUBTYPES.DEVELOPER_API_KEY) {
    return previewUrl;
  }
  const queryParams = auth.credentialSource && auth.credentialSource.queryParams
    ? auth.credentialSource.queryParams
    : {};
  if (queryParams.hapikey) previewUrl.searchParams.set('hapikey', `$${queryParams.hapikey.name}`);
  if (queryParams.appId) previewUrl.searchParams.set('appId', `$${queryParams.appId.name}`);
  return previewUrl;
}

function queryObjectForDisplay(url) {
  const output = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (SENSITIVE_QUERY_KEYS.has(key) && !String(value).startsWith('$')) {
      output[key] = 'REDACTED';
    } else {
      output[key] = value;
    }
  }
  return output;
}

function showRequestPreview(portal, method, url, body, endpoint, options = {}) {
  const auth = options.auth || requestAuthMetadata(portal, endpoint);
  const previewUrl = previewUrlForAuth(url, auth);
  const headers = {
    Accept: 'application/json'
  };
  if (auth.family === AUTH_FAMILIES.PORTAL_BEARER) headers.Authorization = `Bearer $${portal.tokenEnv}`;
  if (auth.family === AUTH_FAMILIES.OAUTH) headers.Authorization = 'Bearer <oauth-access-token>';
  if (auth.family === AUTH_FAMILIES.DEVELOPER && auth.subtype === DEVELOPER_AUTH_SUBTYPES.PERSONAL_ACCESS_KEY) {
    headers.Authorization = `Bearer $${auth.credentialSource.name}`;
  }
  if (auth.family === AUTH_FAMILIES.DEVELOPER && auth.subtype === DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS) {
    headers.Authorization = 'Bearer <developer-client-credentials-access-token>';
  }
  if (body !== undefined) headers['Content-Type'] = options.contentType || 'application/json';
  printJson({
    ok: true,
    dryRun: true,
    showRequest: true,
    authFamily: auth.family,
    authSubtype: auth.subtype,
    auth,
    portal: {
      name: portal.name,
      label: portal.label,
      portalId: portal.portalId,
      tokenEnv: portal.tokenEnv
    },
    endpoint,
    request: {
      method,
      url: redactTokenUrl(previewUrl.toString()),
      pathname: previewUrl.pathname,
      query: queryObjectForDisplay(previewUrl),
      headers,
      body: options.previewBody !== undefined ? options.previewBody : (body === undefined ? null : redactSensitiveValue(body))
    }
  });
  exitCli(0);
}

function isCatalogReadOnlyPost(portal, method, target, flags) {
  if (method !== 'POST') return false;
  const url = buildUrl(portal, target, flags);
  return endpointDefinitions(CATALOG_FILE).some((endpoint) => (
    endpoint.readOnlyPost === true &&
    endpoint.risk === 'read' &&
    endpoint.method === method &&
    endpoint.pathTemplate &&
    pathTemplateToRegex(endpoint.pathTemplate).test(url.pathname)
  ));
}

function requireCatalogReadOnlyPost(portal, method, target, flags) {
  if (!isCatalogReadOnlyPost(portal, method, target, flags)) {
    fail(`--read-only is only allowed for catalog-marked read-only POST endpoints. Refusing ${method} ${target}.`);
  }
}

function previewMutation(portal, method, target, body) {
  printJson({
    ok: false,
    dryRun: true,
    message: 'Mutation blocked. Re-run with --yes to execute.',
    portal: portal.name,
    method,
    target,
    body: body || null
  });
  exitCli(2);
}

async function guardedFetch(portal, method, target, flags, body, options = {}) {
  const isReadOnlyPost = options.readOnly === true;
  const requiresConfirmation = !SAFE_METHODS.has(method) && !isReadOnlyPost;
  if (requiresConfirmation && !boolFlag(flags, 'yes') && !boolFlag(flags, 'show-request')) {
    previewMutation(portal, method, target, body);
  }
  return hubspotFetch(portal, method, target, flags, body, options.endpoint || null);
}

async function guardedMultipartFetch(portal, method, target, flags, formBody, previewBody, options = {}) {
  const requiresConfirmation = !SAFE_METHODS.has(method);
  if (requiresConfirmation && !boolFlag(flags, 'yes') && !boolFlag(flags, 'show-request')) {
    previewMutation(portal, method, target, previewBody);
  }
  return hubspotMultipartFetch(portal, method, target, flags, formBody, previewBody, options.endpoint || null);
}

function redactSensitiveValue(value) {
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (value && typeof value === 'object') {
    const redacted = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      redacted[key] = SENSITIVE_BODY_KEYS.has(key) ? 'REDACTED' : redactSensitiveValue(nestedValue);
    }
    return redacted;
  }
  return value;
}

function maybeRedactSensitivePayload(payload, flags) {
  return boolFlag(flags, 'show-secrets') ? payload : redactSensitiveValue(payload);
}

function showNoAuthRequestPreview(portal, method, url, body, endpoint, options = {}) {
  const auth = options.auth || requestAuthMetadata(portal, endpoint);
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = options.contentType || 'application/json';
  printJson({
    ok: true,
    dryRun: true,
    showRequest: true,
    authFamily: auth.family,
    authSubtype: auth.subtype,
    auth,
    portal: {
      name: portal.name,
      label: portal.label,
      portalId: portal.portalId,
      tokenEnv: portal.tokenEnv
    },
    endpoint,
    request: {
      method,
      url: redactTokenUrl(url.toString()),
      pathname: url.pathname,
      query: queryObjectForDisplay(url),
      headers,
      body: options.previewBody !== undefined ? options.previewBody : (body === undefined ? null : body)
    }
  });
  exitCli(0);
}

async function externalNoAuthJsonFetch(portal, method, url, flags, body, endpointOverride = null) {
  const endpoint = endpointOverride || findEndpointDefinition(method, url.pathname);
  const auth = requestAuthMetadata(portal, endpoint);
  if (boolFlag(flags, 'show-request')) {
    showNoAuthRequestPreview(portal, method, url, body, endpoint, { auth });
  }

  const options = {
    method,
    headers: {
      Accept: 'application/json'
    }
  };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
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
    printJson({
      ok: false,
      status: response.status,
      statusText: response.statusText,
      ...responseMeta(response),
      portal: portal.name,
      method,
      url: redactTokenUrl(url.toString()),
      response: payload
    });
    exitCli(1);
  }

  return {
    ok: true,
    status: response.status,
    ...responseMeta(response),
    portal: portal.name,
    method,
    url: redactTokenUrl(url.toString()),
    data: payload
  };
}

async function guardedExternalNoAuthJsonFetch(portal, method, url, flags, body, options = {}) {
  const requiresConfirmation = !SAFE_METHODS.has(method);
  if (requiresConfirmation && !boolFlag(flags, 'yes') && !boolFlag(flags, 'show-request')) {
    previewMutation(portal, method, redactTokenUrl(url.toString()), body);
  }
  return externalNoAuthJsonFetch(portal, method, url, flags, body, options.endpoint || null);
}

async function externalNoAuthFormFetch(portal, method, url, flags, body, endpointOverride = null, options = {}) {
  const endpoint = endpointOverride || findEndpointDefinition(method, url.pathname);
  const auth = requestAuthMetadata(portal, endpoint);
  if (boolFlag(flags, 'show-request')) {
    showNoAuthRequestPreview(portal, method, url, body, endpoint, {
      auth,
      contentType: 'application/x-www-form-urlencoded',
      previewBody: redactSensitiveValue(body)
    });
  }

  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(body)
  });
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
    printJson({
      ok: false,
      status: response.status,
      statusText: response.statusText,
      ...responseMeta(response),
      portal: portal.name,
      method,
      url: redactTokenUrl(url.toString()),
      response: maybeRedactSensitivePayload(payload, flags)
    });
    exitCli(1);
  }

  return {
    ok: true,
    status: response.status,
    ...responseMeta(response),
    portal: portal.name,
    method,
    url: redactTokenUrl(url.toString()),
    data: maybeRedactSensitivePayload(payload, flags),
    redacted: !boolFlag(flags, 'show-secrets')
  };
}

async function guardedExternalNoAuthFormFetch(portal, method, url, flags, body, options = {}) {
  const requiresConfirmation = !SAFE_METHODS.has(method) && options.readOnly !== true;
  if (requiresConfirmation && !boolFlag(flags, 'yes') && !boolFlag(flags, 'show-request')) {
    previewMutation(portal, method, redactTokenUrl(url.toString()), redactSensitiveValue(body));
  }
  return externalNoAuthFormFetch(portal, method, url, flags, body, options.endpoint || null, options);
}

async function externalBearerJsonFetch(portal, method, url, flags, body, endpointOverride = null) {
  const endpoint = endpointOverride || findEndpointDefinition(method, url.pathname);
  const auth = requestAuthMetadata(portal, endpoint);
  if (boolFlag(flags, 'show-request')) {
    showRequestPreview(portal, method, url, body, endpoint, { auth });
  }

  const credential = await resolveRequestCredential(portal, auth);
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
  applyCredentialToRequest(url, headers, credential);

  const response = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(body)
  });
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
    printJson({
      ok: false,
      status: response.status,
      statusText: response.statusText,
      ...responseMeta(response),
      portal: portal.name,
      method,
      url: redactTokenUrl(url.toString()),
      response: payload
    });
    exitCli(1);
  }

  return {
    ok: true,
    status: response.status,
    ...responseMeta(response),
    portal: portal.name,
    method,
    url: redactTokenUrl(url.toString()),
    data: payload
  };
}

async function guardedExternalBearerJsonFetch(portal, method, url, flags, body, options = {}) {
  const requiresConfirmation = !SAFE_METHODS.has(method);
  if (requiresConfirmation && !boolFlag(flags, 'yes') && !boolFlag(flags, 'show-request')) {
    previewMutation(portal, method, redactTokenUrl(url.toString()), body);
  }
  return externalBearerJsonFetch(portal, method, url, flags, body, options.endpoint || null);
}

function paginationBudgetFromFlags(flags) {
  const raw = parseNonNegativeIntegerFlag(flags['max-results'], 'max-results');
  if (raw === 0) return { maxResults: undefined, defaultCap: false };
  if (raw === undefined) return { maxResults: DEFAULT_PAGINATE_MAX_RESULTS, defaultCap: true };
  return { maxResults: raw, defaultCap: false };
}

async function collectPages(portal, method, inputPath, flags, body) {
  const stream = jsonlStreamFromFlags(flags);
  const { maxResults, defaultCap } = paginationBudgetFromFlags(flags);
  const firstUrl = buildUrl(portal, inputPath, flags);
  let after = firstUrl.searchParams.get('after');
  const results = [];
  let collected = 0;
  let pageCount = 0;
  let last = null;
  let truncated = false;
  let truncation = null;

  while (true) {
    const pageFlags = { ...flags, query: [] };
    const url = new URL(firstUrl.toString());
    if (after) url.searchParams.set('after', after);
    last = await hubspotFetch(portal, method, url.toString(), pageFlags, body);
    pageCount += 1;

    const data = last.data;
    if (data && Array.isArray(data.results)) {
      const remaining = maxResults === undefined ? Infinity : Math.max(maxResults - collected, 0);
      const accepted = data.results.length > remaining ? data.results.slice(0, remaining) : data.results;
      if (stream) {
        for (const record of accepted) writeStdout(JSON.stringify(record));
        stream.streamed += accepted.length;
      } else {
        results.push(...accepted);
      }
      collected += accepted.length;
      if (maxResults !== undefined) {
        const nextAfter = data && data.paging && data.paging.next && data.paging.next.after;
        if (data.results.length > remaining || (collected >= maxResults && nextAfter)) {
          truncated = true;
          truncation = {
            reason: 'max-results',
            path: 'results',
            maxResults,
            defaultCap: defaultCap || undefined,
            note: defaultCap ? 'Default pagination cap. Pass an explicit --max-results, or --max-results 0 for unlimited.' : undefined,
            returnedResultCount: collected,
            fetchedPageResultCount: data.results.length,
            pageCount,
            nextAfter: nextAfter || null
          };
          if (data.results.length > remaining) {
            truncation.limitedWithinPage = true;
          }
          break;
        }
      }
    }

    after = data && data.paging && data.paging.next && data.paging.next.after;
    if (!after) break;
  }

  if (stream) {
    writeStderr(jsonlStreamSummary(collected, pageCount, truncated, truncation));
    return JSONL_STREAMED;
  }

  const output = {
    ok: true,
    status: last.status,
    portal: portal.name,
    method,
    url: redactTokenUrl(firstUrl.toString()),
    pageCount,
    resultCount: results.length,
    results
  };
  if (truncated) {
    output.truncated = true;
    output.truncation = truncation;
  }
  return output;
}

function jsonlStreamSummary(collected, pageCount, truncated, truncation) {
  const base = `jsonl: streamed ${collected} record(s) over ${pageCount} page(s)`;
  if (!truncated || !truncation) return base;
  if (truncation.reason === 'search-window') {
    return `${base} (stopped at HubSpot's ${CRM_SEARCH_WINDOW_LIMIT}-result search window; narrow the filters to fetch the rest)`;
  }
  return `${base} (stopped at --max-results ${truncation.maxResults}${truncation.defaultCap ? ' default cap; pass --max-results 0 for unlimited' : ''}; nextAfter ${truncation.nextAfter || 'n/a'})`;
}

async function collectSearchPages(portal, objectType, flags, baseBody) {
  const stream = jsonlStreamFromFlags(flags);
  const { maxResults, defaultCap } = paginationBudgetFromFlags(flags);
  const target = `/crm/objects/2026-03/${pathPart(objectType)}/search`;
  const results = [];
  let collected = 0;
  let after = baseBody.after;
  let pageCount = 0;
  let last = null;
  let truncated = false;
  let truncation = null;

  while (true) {
    const body = { ...baseBody };
    if (after === undefined || after === null) {
      delete body.after;
    } else {
      body.after = String(after);
    }
    last = await hubspotFetch(portal, 'POST', target, flags, body);
    pageCount += 1;

    const data = last.data;
    const pageResults = data && Array.isArray(data.results) ? data.results : [];
    const nextAfter = data && data.paging && data.paging.next && data.paging.next.after;

    const remaining = maxResults === undefined ? Infinity : Math.max(maxResults - collected, 0);
    const accepted = pageResults.length > remaining ? pageResults.slice(0, remaining) : pageResults;
    if (stream) {
      for (const record of accepted) writeStdout(JSON.stringify(record));
      stream.streamed += accepted.length;
    } else {
      results.push(...accepted);
    }
    collected += accepted.length;
    if (maxResults !== undefined && (pageResults.length > remaining || (collected >= maxResults && nextAfter))) {
      truncated = true;
      truncation = {
        reason: 'max-results',
        path: 'results',
        maxResults,
        defaultCap: defaultCap || undefined,
        note: defaultCap ? 'Default pagination cap. Pass an explicit --max-results, or --max-results 0 for unlimited.' : undefined,
        returnedResultCount: collected,
        fetchedPageResultCount: pageResults.length,
        pageCount,
        nextAfter: nextAfter || null
      };
      break;
    }

    if (!nextAfter) break;
    if (Number.isFinite(Number(nextAfter)) && Number(nextAfter) >= CRM_SEARCH_WINDOW_LIMIT) {
      truncated = true;
      truncation = {
        reason: 'search-window',
        message: `HubSpot CRM search only pages through the first ${CRM_SEARCH_WINDOW_LIMIT} results. Narrow the filters to fetch the rest.`,
        returnedResultCount: collected,
        pageCount,
        nextAfter: String(nextAfter)
      };
      break;
    }
    after = nextAfter;
  }

  if (stream) {
    writeStderr(jsonlStreamSummary(collected, pageCount, truncated, truncation));
    return JSONL_STREAMED;
  }

  const output = {
    ok: true,
    status: last.status,
    portal: portal.name,
    objectType,
    method: 'POST',
    url: redactTokenUrl(buildUrl(portal, target, { query: [] }).toString()),
    pageCount,
    resultCount: results.length,
    total: last.data && typeof last.data.total === 'number' ? last.data.total : undefined,
    results
  };
  if (truncated) {
    output.truncated = true;
    output.truncation = truncation;
  }
  return output;
}

module.exports = {
  CRM_SEARCH_WINDOW_LIMIT,
  DEFAULT_PAGINATE_MAX_RESULTS,
  MAX_RETRY_AFTER_MS,
  RATE_LIMIT_HEADERS,
  SENSITIVE_BODY_KEYS,
  SENSITIVE_QUERY_KEYS,
  appendQuery,
  applyCredentialToRequest,
  assertAllowedHubSpotUrl,
  buildUrl,
  collectPages,
  collectSearchPages,
  externalBearerJsonFetch,
  externalNoAuthFormFetch,
  externalNoAuthJsonFetch,
  guardedExternalBearerJsonFetch,
  guardedExternalNoAuthFormFetch,
  guardedExternalNoAuthJsonFetch,
  guardedFetch,
  guardedMultipartFetch,
  hubspotFetch,
  hubspotFetchAllowError,
  hubspotFetchResponse,
  hubspotMultipartFetch,
  isCatalogReadOnlyPost,
  jsonlStreamSummary,
  maybeRedactSensitivePayload,
  paginationBudgetFromFlags,
  previewMutation,
  previewUrlForAuth,
  queryObjectForDisplay,
  readOnlyPostRetryOption,
  redactSensitiveValue,
  requireCatalogReadOnlyPost,
  responseMeta,
  retryDelayMs,
  safeRetryLimit,
  shouldRetryResponse,
  showNoAuthRequestPreview,
  showRequestPreview,
  sleep,
};
