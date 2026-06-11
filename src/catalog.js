const fs = require('fs');
const path = require('path');
const { normalizeEndpointAuth } = require('./auth');

const DEFAULT_CATALOG_FILE = path.resolve(__dirname, '..', 'data', 'hubspot-api-catalog.json');
const VALID_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);
const VALID_STATUSES = new Set(['typed', 'catalog-only']);
const VALID_RISKS = new Set(['read', 'sensitive-read', 'mutation', 'destructive']);
const VALID_VERSION_MODES = new Set(['latest', 'legacy', 'v3', 'v4', 'beta']);
const VALID_SURFACE_TYPES = new Set(['javascript-sdk', 'docs-only']);
const VALID_ARG_KINDS = new Set(['positional', 'flag']);
const VALID_ARG_TYPES = new Set(['string', 'integer', 'boolean', 'json', 'list']);
const catalogCache = new Map();

function fail(message) {
  throw new Error(message);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveCatalogFile(filePath) {
  if (filePath) return path.resolve(filePath);
  if (process.env.HSAPI_CATALOG_FILE) return path.resolve(process.env.HSAPI_CATALOG_FILE);
  return DEFAULT_CATALOG_FILE;
}

function requireString(value, label, context) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(`${context} must include a non-empty string ${label}.`);
  }
  return value.trim();
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

function validateEndpointArgs(raw, context) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(`${context} must define args as an array when present.`);
  return raw.map((item, index) => {
    const argContext = `${context} args[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${argContext} must be an object.`);
    const name = requireString(item.name, 'name', argContext);
    const kind = requireString(item.kind, 'kind', argContext);
    if (!VALID_ARG_KINDS.has(kind)) fail(`${argContext} kind must be one of ${[...VALID_ARG_KINDS].join(', ')}.`);
    const type = requireString(item.type, 'type', argContext);
    if (!VALID_ARG_TYPES.has(type)) fail(`${argContext} type must be one of ${[...VALID_ARG_TYPES].join(', ')}.`);
    if (item.required !== undefined && typeof item.required !== 'boolean') fail(`${argContext} required must be a boolean.`);
    if (item.repeatable !== undefined && typeof item.repeatable !== 'boolean') fail(`${argContext} repeatable must be a boolean.`);
    return {
      name,
      kind,
      type,
      required: item.required === true,
      repeatable: item.repeatable === true,
      enum: optionalStringArray(item.enum, 'enum', argContext),
      aliases: optionalStringArray(item.aliases, 'aliases', argContext),
      description: optionalString(item.description)
    };
  });
}

function validateEndpointDefinition(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`Catalog endpoint[${index}] must be an object.`);
  }

  const context = `Catalog endpoint[${index}]${raw.name ? ` (${raw.name})` : ''}`;
  const id = requireString(raw.name, 'name', context);
  const family = requireString(raw.family, 'family', context);
  const method = requireString(raw.method, 'method', context).toUpperCase();
  if (!VALID_METHODS.has(method)) {
    fail(`${context} must use a supported HTTP method. Got ${method}.`);
  }

  const pathTemplate = requireString(raw.path, 'path', context);
  if (!pathTemplate.startsWith('/')) {
    fail(`${context} must use an absolute path that starts with /.`);
  }

  const status = requireString(raw.status, 'status', context);
  if (!VALID_STATUSES.has(status)) {
    fail(`${context} must use a supported status. Got ${status}.`);
  }

  const risk = requireString(raw.risk, 'risk', context);
  if (!VALID_RISKS.has(risk)) {
    fail(`${context} must use a supported risk. Got ${risk}.`);
  }

  const command = optionalString(raw.command);
  if (status === 'typed' && !command) {
    fail(`${context} is typed but missing command.`);
  }

  const versionMode = optionalString(raw.versionMode);
  if (versionMode && !VALID_VERSION_MODES.has(versionMode)) {
    fail(`${context} has unsupported versionMode ${versionMode}.`);
  }

  if (raw.readOnlyPost !== undefined && typeof raw.readOnlyPost !== 'boolean') {
    fail(`${context} must define readOnlyPost as a boolean when present.`);
  }

  const docsUrl = optionalString(raw.docsUrl);
  const contextUrl = optionalString(raw.contextUrl);
  const tierRequirement = optionalString(raw.tierRequirement);
  const scopeNotes = optionalString(raw.scopeNotes);
  const requiredScopes = optionalStringArray(raw.requiredScopes, 'requiredScopes', context);
  const auth = normalizeEndpointAuth(raw.auth, context);
  const args = validateEndpointArgs(raw.args, context);

  return {
    id,
    family,
    command,
    method,
    pathTemplate,
    versionMode: versionMode || null,
    risk,
    readOnlyPost: raw.readOnlyPost === true,
    status,
    docsUrl,
    contextUrl,
    tierRequirement,
    requiredScopes,
    scopeNotes,
    auth,
    args
  };
}

function validateSurfaceDefinition(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`Catalog surface[${index}] must be an object.`);
  }

  const context = `Catalog surface[${index}]${raw.name ? ` (${raw.name})` : ''}`;
  const id = requireString(raw.name, 'name', context);
  const family = requireString(raw.family, 'family', context);
  const surfaceType = requireString(raw.surfaceType, 'surfaceType', context);
  if (!VALID_SURFACE_TYPES.has(surfaceType)) {
    fail(`${context} has unsupported surfaceType ${surfaceType}.`);
  }

  const status = requireString(raw.status, 'status', context);
  if (!VALID_STATUSES.has(status)) {
    fail(`${context} must use a supported status. Got ${status}.`);
  }

  const risk = requireString(raw.risk, 'risk', context);
  if (!VALID_RISKS.has(risk)) {
    fail(`${context} must use a supported risk. Got ${risk}.`);
  }

  return {
    id,
    family,
    surfaceType,
    risk,
    status,
    docsUrl: optionalString(raw.docsUrl),
    contextUrl: optionalString(raw.contextUrl),
    tierRequirement: optionalString(raw.tierRequirement),
    requiredScopes: optionalStringArray(raw.requiredScopes, 'requiredScopes', context),
    scopeNotes: optionalString(raw.scopeNotes)
  };
}

function loadCatalogData(filePath) {
  const resolvedPath = resolveCatalogFile(filePath);
  const cached = catalogCache.get(resolvedPath);
  if (cached) return cached.catalog;

  const catalog = readJsonFile(resolvedPath);
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    fail(`Catalog file ${resolvedPath} must contain a JSON object.`);
  }

  if (!Array.isArray(catalog.endpoints)) {
    fail(`Catalog file ${resolvedPath} must contain an endpoints array.`);
  }

  if (catalog.surfaces !== undefined && !Array.isArray(catalog.surfaces)) {
    fail(`Catalog file ${resolvedPath} must define surfaces as an array when present.`);
  }
  const endpoints = catalog.endpoints.map(validateEndpointDefinition);
  const surfaces = catalog.surfaces === undefined ? [] : catalog.surfaces.map(validateSurfaceDefinition);
  const normalized = {
    ...catalog,
    endpoints,
    surfaces
  };
  catalogCache.set(resolvedPath, { catalog: normalized });
  return normalized;
}

function endpointDefinitions(filePath) {
  return loadCatalogData(filePath).endpoints.map((endpoint) => ({
    ...endpoint,
    requiredScopes: [...endpoint.requiredScopes],
    args: endpoint.args.map((arg) => ({ ...arg, enum: [...arg.enum], aliases: [...arg.aliases] })),
    auth: endpoint.auth ? {
      ...endpoint.auth,
      queryParams: [...endpoint.auth.queryParams],
      scopes: [...endpoint.auth.scopes]
    } : null
  }));
}

function pathTemplateToRegex(template) {
  const escaped = String(template)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{[^}]+\\\}/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

function findEndpointDefinition(method, pathname, filePath) {
  const upperMethod = String(method || '').toUpperCase();
  return endpointDefinitions(filePath).find((definition) => (
    definition.pathTemplate
    && definition.method === upperMethod
    && pathTemplateToRegex(definition.pathTemplate).test(pathname)
  )) || null;
}

function commandLiteralPrefix(command) {
  const tokens = String(command || '').split(/\s+/);
  const literal = [];
  for (const token of tokens) {
    if (token.startsWith('<') || token.startsWith('[')) break;
    literal.push(token);
  }
  return literal.join(' ');
}

// Resolve a typed command from argv-style tokens by longest literal prefix.
// Placeholder tokens like <objectType> in catalog command strings are ignored.
// Ambiguous prefixes resolve to null so callers can fall back safely.
function endpointForCommandTokens(tokens, filePath) {
  const positionals = [];
  for (const token of tokens || []) {
    if (String(token).startsWith('--')) break;
    positionals.push(String(token));
  }
  if (!positionals.length) return null;
  const byLiteral = new Map();
  for (const definition of endpointDefinitions(filePath)) {
    if (!definition.command) continue;
    const literal = commandLiteralPrefix(definition.command);
    if (!byLiteral.has(literal)) byLiteral.set(literal, []);
    byLiteral.get(literal).push(definition);
  }
  for (let length = positionals.length; length >= 1; length -= 1) {
    const matches = byLiteral.get(`hsapi ${positionals.slice(0, length).join(' ')}`) || [];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
  }
  return null;
}

function endpointDefinitionById(id, filePath) {
  return endpointDefinitions(filePath).find((definition) => definition.id === id) || null;
}

function surfaceDefinitions(filePath) {
  return loadCatalogData(filePath).surfaces.map((surface) => ({
    ...surface,
    requiredScopes: [...surface.requiredScopes]
  }));
}

function summarizeCatalogCoverage(catalog) {
  const endpoints = catalog.endpoints || [];
  const surfaces = catalog.surfaces || [];
  const byStatus = {};
  const byFamily = {};
  const byRisk = {};
  const byAuthFamily = {};
  const byTierRequirement = {};
  const scopeCounts = {};
  const surfacesByFamily = {};
  const surfacesByStatus = {};
  const surfacesByType = {};
  let unscopedCount = 0;
  let scopeNoteCount = 0;
  let noAuthRequiredCount = 0;

  for (const endpoint of endpoints) {
    const status = endpoint.status || 'unknown';
    const family = endpoint.family || 'unknown';
    const risk = endpoint.risk || 'unknown';
    const tier = endpoint.tierRequirement || 'none';
    const scopes = Array.isArray(endpoint.requiredScopes) ? endpoint.requiredScopes : [];
    const auth = endpoint.auth || {};

    byStatus[status] = (byStatus[status] || 0) + 1;
    byFamily[family] = (byFamily[family] || 0) + 1;
    byRisk[risk] = (byRisk[risk] || 0) + 1;
    byTierRequirement[tier] = (byTierRequirement[tier] || 0) + 1;
    if (auth.required === false) {
      noAuthRequiredCount += 1;
    } else {
      const authFamily = auth.family || 'unknown';
      byAuthFamily[authFamily] = (byAuthFamily[authFamily] || 0) + 1;
    }

    if (!scopes.length) {
      unscopedCount += 1;
    } else {
      for (const scope of scopes) {
        scopeCounts[scope] = (scopeCounts[scope] || 0) + 1;
      }
    }

    if (endpoint.scopeNotes) scopeNoteCount += 1;
  }

  for (const surface of surfaces) {
    const status = surface.status || 'unknown';
    const family = surface.family || 'unknown';
    const type = surface.surfaceType || 'unknown';

    surfacesByFamily[family] = (surfacesByFamily[family] || 0) + 1;
    surfacesByStatus[status] = (surfacesByStatus[status] || 0) + 1;
    surfacesByType[type] = (surfacesByType[type] || 0) + 1;
  }

  return {
    byStatus,
    byFamily,
    byRisk,
    byAuthFamily,
    byTierRequirement,
    scopeCounts,
    unscopedCount,
    scopeNoteCount,
    noAuthRequiredCount,
    endpointCount: endpoints.length,
    surfaceCount: surfaces.length,
    catalogItemCount: endpoints.length + surfaces.length,
    surfacesByFamily,
    surfacesByStatus,
    surfacesByType,
    typedCommandCount: endpoints.filter((endpoint) => endpoint.status === 'typed' && endpoint.command).length
  };
}

module.exports = {
  DEFAULT_CATALOG_FILE,
  commandLiteralPrefix,
  endpointDefinitionById,
  endpointForCommandTokens,
  endpointDefinitions,
  findEndpointDefinition,
  loadCatalogData,
  pathTemplateToRegex,
  surfaceDefinitions,
  summarizeCatalogCoverage
};
