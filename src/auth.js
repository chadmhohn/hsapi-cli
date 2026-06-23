const AUTH_FAMILIES = Object.freeze({
  PORTAL_BEARER: 'portal_bearer',
  OAUTH: 'oauth',
  DEVELOPER: 'developer'
});

const DEVELOPER_AUTH_SUBTYPES = Object.freeze({
  PERSONAL_ACCESS_KEY: 'personal_access_key',
  DEVELOPER_API_KEY: 'developer_api_key',
  CLIENT_CREDENTIALS: 'client_credentials'
});

// Token audience (issue #79): which identity class an endpoint should be
// satisfied with. 'user' endpoints prefer the per-user OAuth identity when the
// portal has one configured; 'admin' endpoints require the non-user
// (service-key/private-app) credential. The default is 'admin' so that any
// endpoint not explicitly flagged keeps using the non-user credential exactly
// as it did before this field existed.
const TOKEN_AUDIENCES = Object.freeze({
  USER: 'user',
  ADMIN: 'admin'
});
const DEFAULT_TOKEN_AUDIENCE = TOKEN_AUDIENCES.ADMIN;

const VALID_AUTH_FAMILIES = new Set(Object.values(AUTH_FAMILIES));
const VALID_DEVELOPER_AUTH_SUBTYPES = new Set(Object.values(DEVELOPER_AUTH_SUBTYPES));
const VALID_AUTH_FALLBACKS = new Set(['none']);
const VALID_TOKEN_AUDIENCES = new Set(Object.values(TOKEN_AUDIENCES));

function fail(message) {
  throw new Error(message);
}

function optionalString(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function optionalStringArray(value, label, context) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(`${context} must define ${label} as an array of strings.`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      fail(`${context} ${label}[${index}] must be a non-empty string.`);
    }
    return item.trim();
  });
}

function requireAuthFamily(value, context) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(`${context} auth.family must be one of ${Object.values(AUTH_FAMILIES).join(', ')}.`);
  }
  const family = value.trim();
  if (!VALID_AUTH_FAMILIES.has(family)) {
    fail(`${context} auth.family "${family}" is not supported. Use one of ${Object.values(AUTH_FAMILIES).join(', ')}.`);
  }
  return family;
}

function normalizeAuthSubtype(family, value, context) {
  const subtype = optionalString(value);
  if (family !== AUTH_FAMILIES.DEVELOPER) return subtype;
  if (!subtype) {
    fail(`${context} auth.subtype must be one of ${Object.values(DEVELOPER_AUTH_SUBTYPES).join(', ')} for developer auth.`);
  }
  if (!VALID_DEVELOPER_AUTH_SUBTYPES.has(subtype)) {
    fail(`${context} auth.subtype "${subtype}" is not supported for developer auth. Use one of ${Object.values(DEVELOPER_AUTH_SUBTYPES).join(', ')}.`);
  }
  return subtype;
}

function normalizeTokenAudience(value, context) {
  // Absent -> default to 'admin' (backward-compatible: unflagged endpoints keep
  // using the non-user credential exactly as before). Issue #79.
  const audience = optionalString(value);
  if (!audience) return DEFAULT_TOKEN_AUDIENCE;
  if (!VALID_TOKEN_AUDIENCES.has(audience)) {
    fail(`${context} auth.tokenAudience "${audience}" is not supported. Use one of ${Object.values(TOKEN_AUDIENCES).join(', ')}.`);
  }
  return audience;
}

function normalizeEndpointAuth(rawAuth, context) {
  if (!rawAuth || typeof rawAuth !== 'object' || Array.isArray(rawAuth)) {
    fail(`${context} must include auth metadata.`);
  }

  const fallback = optionalString(rawAuth.fallback) || 'none';
  if (!VALID_AUTH_FALLBACKS.has(fallback)) {
    fail(`${context} auth.fallback must be "none".`);
  }

  const queryParams = optionalStringArray(rawAuth.queryParams, 'auth.queryParams', context);
  const scopes = optionalStringArray(rawAuth.scopes, 'auth.scopes', context);
  const tokenAudience = normalizeTokenAudience(rawAuth.tokenAudience, context);

  if (rawAuth.required === false) {
    return {
      required: false,
      family: null,
      subtype: optionalString(rawAuth.subtype),
      fallback,
      queryParams,
      scopes,
      tokenAudience,
      reason: optionalString(rawAuth.reason)
    };
  }

  const family = requireAuthFamily(rawAuth.family, context);
  return {
    required: true,
    family,
    subtype: normalizeAuthSubtype(family, rawAuth.subtype, context),
    fallback,
    queryParams,
    scopes,
    tokenAudience
  };
}

function endpointAuthRequirement(endpoint, options = {}) {
  if (endpoint && endpoint.auth) {
    return {
      ...endpoint.auth,
      endpointId: endpoint.id || null,
      provenance: 'catalog',
      scopes: endpoint.auth.scopes && endpoint.auth.scopes.length
        ? [...endpoint.auth.scopes]
        : (Array.isArray(endpoint.requiredScopes) ? [...endpoint.requiredScopes] : []),
      queryParams: Array.isArray(endpoint.auth.queryParams) ? [...endpoint.auth.queryParams] : [],
      // tokenAudience rides along via the spread for normalized catalog auth,
      // but a synthesized endpoint.auth (e.g. CRM CRUD passing a raw object)
      // may omit it, so default it here. Issue #79.
      tokenAudience: endpoint.auth.tokenAudience || DEFAULT_TOKEN_AUDIENCE
    };
  }

  return {
    required: true,
    family: options.defaultFamily || AUTH_FAMILIES.PORTAL_BEARER,
    subtype: options.defaultSubtype || 'private_app_or_static_app',
    fallback: 'none',
    queryParams: [],
    scopes: [],
    tokenAudience: options.defaultTokenAudience || DEFAULT_TOKEN_AUDIENCE,
    endpointId: null,
    provenance: options.defaultProvenance || 'generic_request_default'
  };
}

module.exports = {
  AUTH_FAMILIES,
  DEVELOPER_AUTH_SUBTYPES,
  DEFAULT_TOKEN_AUDIENCE,
  TOKEN_AUDIENCES,
  VALID_AUTH_FAMILIES,
  VALID_DEVELOPER_AUTH_SUBTYPES,
  VALID_TOKEN_AUDIENCES,
  endpointAuthRequirement,
  normalizeEndpointAuth,
  normalizeTokenAudience,
  optionalStringArray,
  requireAuthFamily
};
