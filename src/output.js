// Output layer: every command's JSON flows through processOutput so generic
// requests and typed helpers share projection (--select/--pick), discovery
// helpers (--ids-only/--names-only/--id-name-map), compact mode, result/char
// budgets, and the JSONL streaming sentinel.
const { fail, writeStdout } = require('./runtime');
const { boolFlag, values } = require('./flags');

let currentOutputFlags = {};

function setCurrentOutputFlags(flags) {
  currentOutputFlags = flags || {};
}

const JSONL_STREAMED = Symbol('jsonl-streamed');
const JSONL_INCOMPATIBLE_FLAGS = ['select', 'pick', 'ids-only', 'names-only', 'id-name-map', 'max-chars', 'include-truncated', 'count-only', 'raw-value'];

const DISCOVERY_ID_PATHS = [
  ['id'],
  ['objectId'],
  ['recordId'],
  ['listId'],
  ['pipelineId'],
  ['folderId'],
  ['fileId'],
  ['contentId'],
  ['pageId'],
  ['postId'],
  ['domainId'],
  ['redirectId'],
  ['properties', 'hs_object_id']
];

const DISCOVERY_NAME_PATHS = [
  ['name'],
  ['label'],
  ['title'],
  ['displayName'],
  ['path'],
  ['url'],
  ['email'],
  ['properties', 'name'],
  ['properties', 'hs_name'],
  ['properties', 'dealname'],
  ['properties', 'email']
];

function printJson(value) {
  if (value === JSONL_STREAMED) return;
  const output = processOutput(value, currentOutputFlags);
  if (output.raw) {
    writeStdout(output.text);
    return;
  }
  writeStdout(output.text);
}

function processOutput(value, flags = {}) {
  const options = outputOptionsFromFlags(flags);
  let output = applyMaxResultsBudget(value, options.maxResults);
  if (options.discoveryHelper) output = discoveryHelperOutput(output, options.discoveryHelper);
  if (options.compact) output = compactOutput(output);
  if (options.selectPath) {
    output = selectOutputPath(output, options.selectPath);
  } else if (options.pickPaths.length) {
    const picked = {};
    for (const pickPath of options.pickPaths) {
      picked[pickPath] = selectOutputPath(output, pickPath);
    }
    output = picked;
  }

  if (options.rawValue) {
    if (!isRawScalar(output)) {
      fail('--raw-value requires --select <path> to resolve to a string, number, boolean, or null.');
    }
    const rawText = output === null ? 'null' : String(output);
    const maybeTruncated = enforceMaxChars(rawText, options, output, { raw: true });
    if (maybeTruncated) return { raw: false, text: JSON.stringify(maybeTruncated, null, 2) };
    return { raw: true, text: rawText };
  }

  const serialized = JSON.stringify(output, null, 2);
  const text = serialized === undefined ? 'undefined' : serialized;
  const maybeTruncated = enforceMaxChars(text, options, output);
  if (maybeTruncated) return { raw: false, text: JSON.stringify(maybeTruncated, null, 2) };
  return { raw: false, text };
}

function normalizeMaxResultsFlag(raw, flagName) {
  const value = parseNonNegativeIntegerFlag(raw, flagName);
  // Explicit 0 means unlimited (issue #21); undefined means "not set".
  if (value === 0) return undefined;
  return value;
}

function outputOptionsFromFlags(flags = {}) {
  const selectValues = values(flags.select).map((item) => parseOutputPathValue(item, 'select'));
  if (selectValues.length > 1) fail('--select accepts one path.');

  const pickPaths = [];
  for (const rawPick of values(flags.pick)) {
    const pickText = parseOutputPathValue(rawPick, 'pick');
    for (const item of pickText.split(',')) {
      const trimmed = item.trim();
      if (trimmed) pickPaths.push(trimmed);
    }
  }
  if (values(flags.pick).length && pickPaths.length === 0) fail('--pick requires at least one path.');
  if (selectValues.length && pickPaths.length) fail('--select and --pick cannot be used together.');

  const rawValue = boolFlag(flags, 'raw-value');
  if (rawValue && !selectValues.length) {
    fail('--raw-value requires --select <path> that resolves to a scalar value.');
  }

  const discoveryHelpers = ['ids-only', 'names-only', 'id-name-map'].filter((name) => boolFlag(flags, name));
  if (discoveryHelpers.length > 1) fail('--ids-only, --names-only, and --id-name-map cannot be used together.');
  if (discoveryHelpers.length && (selectValues.length || pickPaths.length || rawValue)) {
    fail('--ids-only, --names-only, and --id-name-map cannot be used with --select, --pick, or --raw-value.');
  }

  return {
    selectPath: selectValues[0] || null,
    pickPaths,
    rawValue,
    discoveryHelper: discoveryHelpers[0] || null,
    compact: boolFlag(flags, 'compact') || boolFlag(flags, 'agent'),
    maxResults: normalizeMaxResultsFlag(flags['max-results'], 'max-results'),
    maxChars: parseNonNegativeIntegerFlag(flags['max-chars'], 'max-chars'),
    includeTruncated: boolFlag(flags, 'include-truncated')
  };
}

function parseOutputPathValue(raw, flagName) {
  if (raw === undefined || raw === true || String(raw).trim() === '') {
    fail(`--${flagName} requires a dot path.`);
  }
  const value = String(raw).trim();
  if (value.split('.').some((segment) => segment === '')) {
    fail(`Invalid --${flagName} path "${value}".`);
  }
  return value;
}

function parseNonNegativeIntegerFlag(raw, flagName) {
  if (raw === undefined) return undefined;
  if (raw === true || raw === '') fail(`--${flagName} requires a non-negative integer.`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    fail(`--${flagName} requires a non-negative integer, got "${raw}".`);
  }
  return value;
}

function selectOutputPath(value, pathExpression) {
  const segments = pathExpression.split('.');
  return selectPathSegments(value, segments, pathExpression, []);
}

function selectPathSegments(value, segments, pathExpression, trail) {
  if (segments.length === 0) return value;

  const [segment, ...rest] = segments;
  const mapsArray = segment.endsWith('[]');
  const key = mapsArray ? segment.slice(0, -2) : segment;
  const current = key ? selectPathProperty(value, key, pathExpression, trail) : value;

  if (!mapsArray) {
    return selectPathSegments(current, rest, pathExpression, trail.concat(key));
  }
  if (!Array.isArray(current)) {
    const location = trail.concat(key || '[]').filter(Boolean).join('.') || '<root>';
    fail(`Projection path "${pathExpression}" expected an array at "${location}".`);
  }
  return current.map((item, index) => (
    selectPathSegments(item, rest, pathExpression, trail.concat(`${key || ''}[${index}]`))
  ));
}

function selectPathProperty(value, key, pathExpression, trail) {
  const location = trail.concat(key).join('.');
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`Projection path "${pathExpression}" not found at "${location}".`);
  }
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    fail(`Projection path "${pathExpression}" not found at "${location}".`);
  }
  return value[key];
}

function isRawScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function discoveryHelperOutput(value, helperName) {
  if (value && typeof value === 'object' && !Array.isArray(value) && (value.showRequest || value.dryRun)) return value;
  if (helperName === 'names-only' && isExistingNamesOnlyOutput(value)) return value;

  const records = discoveryRecords(value);
  const output = { ok: discoveryOk(value) };
  const portal = discoveryPortal(value);
  if (portal !== undefined) output.portal = portal;
  copyDiscoveryTruncation(value, output);

  if (helperName === 'ids-only') {
    const ids = records.map(discoveryId).filter((item) => item !== null);
    output.count = ids.length;
    output.ids = ids;
    return output;
  }

  if (helperName === 'names-only') {
    const names = records.map(discoveryName).filter((item) => item !== null);
    output.count = names.length;
    output.names = names;
    return output;
  }

  const items = [];
  for (const record of records) {
    const item = {};
    const id = discoveryId(record);
    const name = discoveryName(record);
    if (id !== null) item.id = id;
    if (name !== null) item.name = name;
    if (Object.keys(item).length) items.push(item);
  }
  output.count = items.length;
  output.items = items;
  return output;
}

function isExistingNamesOnlyOutput(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Array.isArray(value.names)
    && Object.prototype.hasOwnProperty.call(value, 'count')
    && !Object.prototype.hasOwnProperty.call(value, 'data')
    && !Object.prototype.hasOwnProperty.call(value, 'results');
}

function discoveryRecords(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value.results)) return value.results;
  if (value.data && typeof value.data === 'object') {
    if (Array.isArray(value.data)) return value.data;
    if (Array.isArray(value.data.results)) return value.data.results;
    if (Array.isArray(value.data.objects)) return value.data.objects;
    if (Array.isArray(value.data.items)) return value.data.items;
    if (Array.isArray(value.data.lists)) return value.data.lists;
  }
  return [];
}

function discoveryOk(value) {
  return value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'ok') ? Boolean(value.ok) : true;
}

function discoveryPortal(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.portal !== undefined ? value.portal : undefined;
}

function copyDiscoveryTruncation(input, output) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  if (input.truncated !== undefined) output.truncated = Boolean(input.truncated);
  if (input.truncation && typeof input.truncation === 'object') output.truncation = input.truncation;
  if (input.totalResultCount !== undefined) output.totalResultCount = input.totalResultCount;
}

function discoveryId(record) {
  return discoveryScalar(record, DISCOVERY_ID_PATHS);
}

function discoveryName(record) {
  const name = discoveryScalar(record, DISCOVERY_NAME_PATHS);
  if (name !== null) return name;

  if (record && typeof record === 'object' && record.properties && typeof record.properties === 'object') {
    const first = record.properties.firstname;
    const last = record.properties.lastname;
    const fullName = [first, last].filter((item) => item !== undefined && item !== null && String(item).trim() !== '').join(' ').trim();
    if (fullName) return fullName;
  }
  return null;
}

function discoveryScalar(record, paths) {
  for (const pathParts of paths) {
    const value = nestedRecordValue(record, pathParts);
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return null;
}

function nestedRecordValue(record, pathParts) {
  let current = record;
  for (const part of pathParts) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function compactOutput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (value.showRequest || value.dryRun) return value;

  const compacted = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === 'rateLimit' || key === 'requestId' || key === 'method' || key === 'url') continue;
    if (key === 'status' && value.ok === true) continue;
    compacted[key] = nestedValue;
  }
  return compacted;
}

function applyMaxResultsBudget(value, maxResults) {
  if (maxResults === undefined || !value || typeof value !== 'object' || Array.isArray(value)) return value;

  // Most HubSpot API responses use results/data.results. The first-party Agent
  // CLI instead emits {data:[...]} and HSAPI wraps that parsed payload at
  // result.data. Keep the budget centralized so CLI and MCP callers get the
  // same bounded behavior without capability-specific response rewriting.
  const candidates = [
    ['results'],
    ['data', 'results'],
    ['data'],
    ['result', 'data', 'results'],
    ['result', 'data', 'data'],
  ];
  for (const pathParts of candidates) {
    const results = nestedRecordValue(value, pathParts);
    if (!Array.isArray(results) || results.length <= maxResults) continue;
    const target = cloneJsonValue(value);
    trimResultsAtPath(target, pathParts, maxResults);
    return target;
  }

  return value;
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function trimResultsAtPath(target, pathParts, maxResults) {
  let container = target;
  for (const part of pathParts.slice(0, -1)) container = container[part];
  const key = pathParts[pathParts.length - 1];
  const originalResultCount = container[key].length;
  container[key] = container[key].slice(0, maxResults);
  const nextAfter = container.paging && container.paging.next
    ? container.paging.next.after || null
    : null;
  markResultTruncated(target, {
    path: pathParts.join('.'),
    maxResults,
    originalResultCount,
    returnedResultCount: container[key].length,
    ...(pathParts.join('.') === 'data.results' || nextAfter ? { nextAfter } : {})
  });
}

function markResultTruncated(target, detail) {
  target.truncated = true;
  target.truncation = {
    ...(target.truncation || {}),
    reason: 'max-results',
    ...detail
  };
  if (Object.prototype.hasOwnProperty.call(target, 'resultCount')) {
    const original = Number(target.resultCount);
    target.totalResultCount = Number.isFinite(original) ? original : detail.originalResultCount;
    target.resultCount = detail.returnedResultCount;
  }
}

function enforceMaxChars(text, options, output, extra = {}) {
  if (options.maxChars === undefined || text.length <= options.maxChars) return null;
  if (!options.includeTruncated) {
    fail(`Output is ${text.length} chars, exceeding --max-chars ${options.maxChars}. Add --include-truncated for a compact truncation summary, or reduce output with --select, --pick, --max-results, or --compact.`);
  }
  return truncationSummary(output, text.length, options.maxChars, extra);
}

function truncationSummary(output, serializedChars, maxChars, extra = {}) {
  const summary = {
    ok: output && typeof output === 'object' && Object.prototype.hasOwnProperty.call(output, 'ok') ? output.ok : true,
    truncated: true,
    truncation: {
      reason: 'max-chars',
      maxChars,
      serializedChars,
      message: 'Full output omitted because it exceeded --max-chars.'
    }
  };
  if (extra.raw) summary.truncation.rawValue = true;
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    for (const key of ['portal', 'status', 'pageCount', 'resultCount', 'totalResultCount']) {
      if (Object.prototype.hasOwnProperty.call(output, key)) summary[key] = output[key];
    }
    if (output.truncated && output.truncation) summary.sourceTruncation = output.truncation;
  }
  return summary;
}

function jsonlStreamingRequested(flags) {
  return String(flags.format || '').toLowerCase() === 'jsonl';
}

function jsonlStreamFromFlags(flags) {
  if (!jsonlStreamingRequested(flags)) return null;
  for (const name of JSONL_INCOMPATIBLE_FLAGS) {
    if (flags[name] !== undefined) {
      fail(`--format jsonl streams raw records to stdout and cannot be combined with --${name}.`);
    }
  }
  return { streamed: 0 };
}

function redactTokenUrl(url) {
  return url
    .replace(/([?&]hapikey=)[^&]+/g, '$1REDACTED')
    .replace(/([?&]access_token=)[^&]+/g, '$1REDACTED')
    .replace(/([?&]token=)[^&]+/g, '$1REDACTED');
}

module.exports = {
  redactTokenUrl,
  JSONL_STREAMED,
  jsonlStreamFromFlags,
  jsonlStreamingRequested,
  outputOptionsFromFlags,
  parseNonNegativeIntegerFlag,
  printJson,
  processOutput,
  setCurrentOutputFlags
};
