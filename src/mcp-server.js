const { runCli } = require('./cli');
const packageJson = require('../package.json');

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2024-11-05', '2025-03-26', '2025-06-18']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const READ_RISKS = new Set(['read', 'sensitive-read']);
const DEFAULT_MCP_MAX_RESULTS = 50;
const DEFAULT_MCP_MAX_CHARS = 60000;
const MAX_MCP_MAX_RESULTS = 500;
const MAX_MCP_MAX_CHARS = 200000;
// Endpoints whose documented purpose is returning a client-facing token. The MCP
// redaction layer must not redact the very value the caller asked for; the catalog
// already marks these sensitive-read and the CLI gates still apply.
const INTENDED_CREDENTIAL_ENDPOINTS = new Set([
  'conversations.visitor_token'
]);
const FORBIDDEN_COMMAND_FLAGS = new Set([
  'portal',
  'yes',
  'show-request',
  'show-secrets',
  'raw-value',
  'compact',
  'agent',
  'max-results',
  'max-chars',
  'include-truncated',
  'select',
  'pick',
  'ids-only',
  'names-only',
  'id-name-map'
]);

const SERVER_INSTRUCTIONS = [
  'hsapi exposes HubSpot through a catalog-gated CLI core. Reads execute directly;',
  'mutations always return a blocked preview until you re-call with confirmMutation: true',
  '(danger flags like --danger-merge are still required inside argv where hsapi demands them).',
  'Prefer hsapi_command_execute (typed catalog commands - discover them with',
  'hsapi_catalog_commands) over hsapi_request_execute for writes: named commands read',
  'better in audit logs and avoid raw-body encoding mistakes. Use showRequest: true to',
  'inspect any call before running it. Output is budgeted (maxResults/maxChars defaults);',
  'use select/pick/discovery projections to keep responses small. Credentials resolve from',
  'environment variables named in the portals config; token values never appear in output.'
].join(' ');

const TOOLS = [
  {
    name: 'hsapi_profiles_list',
    description: 'List configured hsapi portal profiles with redacted credential presence metadata.',
    annotations: { title: 'List portal profiles', readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'hsapi_catalog_coverage',
    description: 'Return hsapi catalog coverage summary, including auth-family and risk counts.',
    annotations: { title: 'Catalog coverage summary', readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'hsapi_catalog_commands',
    description: 'List catalog-backed hsapi commands with optional filters and a bounded result limit.',
    annotations: { title: 'List catalog commands', readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        family: { type: 'string', description: 'Optional catalog family filter, for example crm.objects.' },
        authFamily: { type: 'string', description: 'Optional auth family filter: portal_bearer, oauth, or developer.' },
        commandContains: { type: 'string', description: 'Optional case-insensitive substring filter on command text.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum commands to return. Defaults to 50.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'hsapi_auth_doctor',
    description: 'Run offline hsapi auth doctor diagnostics with redacted credential-source metadata.',
    annotations: { title: 'Auth doctor (offline)', readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        portal: { type: 'string', description: 'Optional portal profile name.' },
        requireEnv: { type: 'boolean', description: 'Whether configured credential env vars must be present.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'hsapi_command_execute',
    description: 'Run a portal-aware catalog-backed hsapi command through shared CLI logic. Read commands execute; mutations return a blocked preview unless confirmMutation is true.',
    annotations: { title: 'Execute hsapi command', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        argv: {
          type: 'array',
          minItems: 1,
          maxItems: 80,
          items: { type: 'string' },
          description: 'hsapi arguments after the binary name, for example ["crm","list","contacts","--properties","email"]. Do not include hsapi itself.'
        },
        portal: { type: 'string', description: 'Optional portal profile name.' },
        showRequest: { type: 'boolean', description: 'Return the redacted request/auth preview without executing.' },
        confirmMutation: { type: 'boolean', description: 'Explicitly allow mutation execution by adding --yes. Existing danger flags are still required by hsapi.' },
        compact: { type: 'boolean', description: 'Use hsapi --agent compact output. Defaults to true.' },
        maxResults: { type: 'integer', minimum: 0, maximum: 500, description: 'Maximum obvious result rows to return. Defaults to 50.' },
        maxChars: { type: 'integer', minimum: 1000, maximum: 200000, description: 'Maximum serialized CLI payload chars before truncation summary. Defaults to 60000.' },
        includeTruncated: { type: 'boolean', description: 'Emit truncation summaries instead of failing when maxChars is exceeded. Defaults to true.' },
        select: { type: 'string', description: 'Optional hsapi --select dot path.' },
        pick: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string' },
          description: 'Optional hsapi --pick dot paths.'
        },
        discovery: {
          type: 'string',
          enum: ['ids-only', 'names-only', 'id-name-map'],
          description: 'Optional discovery projection helper.'
        }
      },
      required: ['argv'],
      additionalProperties: false
    }
  },
  {
    name: 'hsapi_request_execute',
    description: 'Run a portal-aware catalog-backed generic hsapi request. Safe methods execute; catalog read-only POST requires readOnly; mutations return a blocked preview unless confirmMutation is true.',
    annotations: { title: 'Execute generic HubSpot request', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'HTTP method, for example GET or POST.' },
        path: { type: 'string', description: 'HubSpot API path or URL on the selected portal baseUrl.' },
        portal: { type: 'string', description: 'Optional portal profile name.' },
        query: {
          type: 'object',
          description: 'Optional query parameters. Values may be strings, numbers, booleans, nulls, or arrays of those values.'
        },
        body: { description: 'Optional JSON request body.' },
        paginate: { type: 'boolean', description: 'Use hsapi --paginate for paged read requests.' },
        readOnly: { type: 'boolean', description: 'Allow catalog-marked read-only POST execution with hsapi --read-only.' },
        showRequest: { type: 'boolean', description: 'Return the redacted request/auth preview without executing.' },
        confirmMutation: { type: 'boolean', description: 'Explicitly allow mutation execution by adding --yes.' },
        requireCatalog: { type: 'boolean', description: 'Require the request to match a catalog endpoint. Defaults to true.' },
        compact: { type: 'boolean', description: 'Use hsapi --agent compact output. Defaults to true.' },
        maxResults: { type: 'integer', minimum: 0, maximum: 500, description: 'Maximum obvious result rows to return. Defaults to 50.' },
        maxChars: { type: 'integer', minimum: 1000, maximum: 200000, description: 'Maximum serialized CLI payload chars before truncation summary. Defaults to 60000.' },
        includeTruncated: { type: 'boolean', description: 'Emit truncation summaries instead of failing when maxChars is exceeded. Defaults to true.' },
        select: { type: 'string', description: 'Optional hsapi --select dot path.' },
        pick: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string' },
          description: 'Optional hsapi --pick dot paths.'
        },
        discovery: {
          type: 'string',
          enum: ['ids-only', 'names-only', 'id-name-map'],
          description: 'Optional discovery projection helper.'
        }
      },
      required: ['method', 'path'],
      additionalProperties: false
    }
  }
];

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      data
    }
  };
}

function jsonRpcResult(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result
  };
}

function frameMessage(message, mode = 'content-length') {
  const body = JSON.stringify(message);
  if (mode === 'line') return body + '\n';
  return 'Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\r\n\r\n' + body;
}

function writeMessage(stdout, message, mode) {
  stdout.write(frameMessage(message, mode));
}

function parseJsonLine(rawLine) {
  const line = rawLine.replace(/\r$/, '').trim();
  if (!line) return null;
  return JSON.parse(line);
}

function toolContent(result) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }
    ],
    structuredContent: result
  };
}

async function runHsapiJson(argv) {
  const result = await runCli(argv);
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || 'hsapi command failed with status ' + result.status;
    const error = new Error(message);
    error.status = result.status;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    const parseError = new Error('hsapi command did not return JSON: ' + error.message);
    parseError.stdout = result.stdout;
    throw parseError;
  }
}

function parseJsonMaybe(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { parsed: false, value: null, text: '' };
  try {
    return { parsed: true, value: JSON.parse(trimmed), text: trimmed };
  } catch (_error) {
    return { parsed: false, value: null, text: trimmed };
  }
}

function truncateText(text, limit = 5000) {
  const value = String(text || '');
  if (value.length <= limit) return value;
  return value.slice(0, limit) + '...<truncated>';
}

function redactMcpValue(value, parentKey = '') {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (/^Bearer\s+(\$|<)/i.test(value)) return value;
    if (/^Bearer\s+/i.test(value)) return 'Bearer REDACTED';
    if (/^(pat-|hapikey|secret-|token-)/i.test(value)) return 'REDACTED';
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactMcpValue(item, parentKey));
  if (typeof value !== 'object') return value;

  const redacted = {};
  for (const [key, child] of Object.entries(value)) {
    if (/authorization/i.test(key)) {
      redacted[key] = redactMcpValue(child, key);
    } else if (/(^|_)(access_token|refresh_token|id_token|client_secret|developer_api_key|personal_access_key|hapikey|password|secret|token)$/i.test(key)
      || (/token/i.test(key) && !/tokenEnv|tokenPresent|tokenCache|tokenUrlPath|tokenType/i.test(key))) {
      redacted[key] = 'REDACTED';
    } else {
      redacted[key] = redactMcpValue(child, key);
    }
  }
  return redacted;
}

async function runHsapiEnvelope(argv, options = {}) {
  const result = await runCli(argv);
  const stdout = parseJsonMaybe(result.stdout);
  const stderr = result.stderr.trim();
  const envelope = {
    ok: result.status === 0,
    status: result.status
  };
  if (stdout.parsed) {
    envelope.output = options.skipOutputRedaction === true ? stdout.value : redactMcpValue(stdout.value);
    if (stdout.value && typeof stdout.value === 'object' && stdout.value.ok === false) envelope.ok = false;
  } else if (stdout.text) {
    envelope.stdout = truncateText(stdout.text);
    envelope.parseError = 'stdout was not JSON';
    envelope.ok = false;
  }
  if (stderr) {
    envelope.stderr = truncateText(stderr);
    if (!envelope.error) {
      envelope.error = {
        code: 'hsapi_stderr',
        message: truncateText(stderr, 1000)
      };
    }
  }
  return envelope;
}

function stringArg(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(label + ' must be a non-empty string.');
  }
  return value;
}

function boolArg(args, name, defaultValue = false) {
  if (args[name] === undefined || args[name] === null) return defaultValue;
  if (typeof args[name] !== 'boolean') throw new Error(name + ' must be a boolean.');
  return args[name];
}

function integerArg(args, name, defaultValue, min, max) {
  if (args[name] === undefined || args[name] === null) return defaultValue;
  const value = Number(args[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(name + ' must be an integer between ' + min + ' and ' + max + '.');
  }
  return value;
}

function outputArgv(args = {}, options = {}) {
  const argv = [];
  if (boolArg(args, 'compact', true)) argv.push('--agent');
  argv.push('--max-results', String(integerArg(args, 'maxResults', DEFAULT_MCP_MAX_RESULTS, 0, MAX_MCP_MAX_RESULTS)));
  argv.push('--max-chars', String(integerArg(args, 'maxChars', DEFAULT_MCP_MAX_CHARS, 1000, MAX_MCP_MAX_CHARS)));
  if (boolArg(args, 'includeTruncated', true)) argv.push('--include-truncated');
  if (options.projection === false) return argv;
  if (args.select !== undefined && args.select !== null) argv.push('--select', stringArg(args.select, 'select'));
  if (args.pick !== undefined && args.pick !== null) {
    if (!Array.isArray(args.pick) || args.pick.length > 20) throw new Error('pick must be an array with at most 20 dot paths.');
    const paths = args.pick.map((item, index) => stringArg(item, 'pick[' + index + ']'));
    if (paths.length) argv.push('--pick', paths.join(','));
  }
  if (args.discovery !== undefined && args.discovery !== null) {
    const discovery = stringArg(args.discovery, 'discovery');
    if (!['ids-only', 'names-only', 'id-name-map'].includes(discovery)) {
      throw new Error('discovery must be ids-only, names-only, or id-name-map.');
    }
    argv.push('--' + discovery);
  }
  return argv;
}

function portalArgv(args = {}) {
  if (args.portal === undefined || args.portal === null) return [];
  return ['--portal', stringArg(args.portal, 'portal')];
}

function flagNameFromArg(arg) {
  if (!String(arg).startsWith('--')) return null;
  return String(arg).slice(2).split('=')[0];
}

function normalizedCommandArgv(args) {
  if (!Array.isArray(args.argv) || args.argv.length < 1 || args.argv.length > 80) {
    throw new Error('argv must be a non-empty array with at most 80 strings.');
  }
  const argv = args.argv.map((item, index) => stringArg(item, 'argv[' + index + ']'));
  if (argv[0] === 'hsapi' || argv[0] === 'hsapi-cli' || argv[0] === 'hubspot-agent-cli') {
    throw new Error('argv must not include the hsapi binary name.');
  }
  if (argv[0] === 'mcp') {
    throw new Error('MCP execution cannot run hsapi mcp commands.');
  }
  for (const arg of argv) {
    const flagName = flagNameFromArg(arg);
    if (flagName && FORBIDDEN_COMMAND_FLAGS.has(flagName)) {
      throw new Error('Use the MCP top-level argument for --' + flagName + '; it is not allowed inside argv.');
    }
  }
  return argv;
}

function queryArgv(query) {
  if (query === undefined || query === null) return [];
  if (typeof query !== 'object' || Array.isArray(query)) throw new Error('query must be an object.');
  const argv = [];
  for (const [key, rawValue] of Object.entries(query)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value === undefined) continue;
      argv.push('--query', key + '=' + (value === null ? '' : String(value)));
    }
  }
  return argv;
}

function bodyArgv(args) {
  if (!Object.prototype.hasOwnProperty.call(args, 'body')) return [];
  return ['--body', JSON.stringify(normalizedBodyArg(args.body))];
}

function normalizedBodyArg(body) {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch (_error) {
    throw new Error('body must be a JSON value. Pass MCP body as an object/array, or as a valid JSON-encoded string.');
  }
}

function requestArgv(args) {
  const method = stringArg(args.method, 'method').toUpperCase();
  const target = stringArg(args.path, 'path');
  if (!/^[A-Z]+$/.test(method)) throw new Error('method must be an HTTP method name.');
  const argv = ['request', method, target, ...queryArgv(args.query), ...bodyArgv(args)];
  if (boolArg(args, 'paginate', false)) argv.push('--paginate');
  if (boolArg(args, 'readOnly', false)) argv.push('--read-only');
  return argv;
}

function previewArgv(argv, args = {}) {
  return [...argv, ...portalArgv(args), '--show-request', ...outputArgv(args, { projection: false })];
}

function executionArgv(argv, args = {}) {
  const next = [...argv, ...portalArgv(args)];
  if (boolArg(args, 'confirmMutation', false)) next.push('--yes');
  next.push(...outputArgv(args));
  return next;
}

function outputEndpoint(preview) {
  return preview && preview.output && preview.output.endpoint ? preview.output.endpoint : null;
}

function outputRequest(preview) {
  return preview && preview.output && preview.output.request ? preview.output.request : null;
}

function riskFromPreview(preview) {
  const endpoint = outputEndpoint(preview);
  if (endpoint && endpoint.risk) return endpoint.risk;
  const request = outputRequest(preview);
  if (request && SAFE_METHODS.has(String(request.method || '').toUpperCase())) return 'read';
  return 'unknown';
}

function methodFromPreview(preview) {
  const request = outputRequest(preview);
  return request && request.method ? String(request.method).toUpperCase() : null;
}

function isReadExecutionAllowed(preview, options = {}) {
  const method = methodFromPreview(preview);
  if (method && SAFE_METHODS.has(method)) return true;
  const endpoint = outputEndpoint(preview);
  if (!endpoint || !READ_RISKS.has(endpoint.risk)) return false;
  if (endpoint.readOnlyPost === true) return options.readOnlyPostAllowed === true;
  return true;
}

function safetySummary(preview, options = {}) {
  const endpoint = outputEndpoint(preview);
  const request = outputRequest(preview);
  return {
    catalogBacked: Boolean(endpoint && endpoint.id),
    endpointId: endpoint && endpoint.id || null,
    risk: riskFromPreview(preview),
    method: request && request.method || null,
    readOnlyPost: Boolean(endpoint && endpoint.readOnlyPost),
    confirmMutation: Boolean(options.confirmMutation),
    readOnlyPostAllowed: Boolean(options.readOnlyPostAllowed)
  };
}

function notCatalogBackedEnvelope(preview, argv) {
  return {
    ok: false,
    executed: false,
    blocked: true,
    error: {
      code: 'not_catalog_backed',
      message: 'MCP execution requires a catalog-backed hsapi endpoint.'
    },
    command: { argv },
    safety: safetySummary(preview),
    preview: preview.output || preview
  };
}

async function executeWithPreview(argv, args = {}, options = {}) {
  const showRequest = boolArg(args, 'showRequest', false);
  const confirmMutation = boolArg(args, 'confirmMutation', false);
  const preview = await runHsapiEnvelope(previewArgv(argv, args));
  const command = { argv };
  const safety = safetySummary(preview, {
    confirmMutation,
    readOnlyPostAllowed: options.readOnlyPostAllowed === true
  });

  if (!preview.ok) {
    return {
      ok: false,
      executed: false,
      command,
      safety,
      error: {
        code: 'preview_failed',
        message: preview.error && preview.error.message || 'hsapi request preview failed.'
      },
      preview: preview.output || preview
    };
  }

  if (options.requireCatalog !== false && !safety.catalogBacked) {
    return notCatalogBackedEnvelope(preview, argv);
  }

  if (showRequest) {
    return {
      ok: true,
      executed: false,
      command,
      safety: { ...safety, showRequest: true },
      preview: preview.output
    };
  }

  if (!isReadExecutionAllowed(preview, { readOnlyPostAllowed: options.readOnlyPostAllowed === true }) && !confirmMutation) {
    return {
      ok: false,
      executed: false,
      blocked: true,
      command,
      safety,
      error: {
        code: 'mutation_blocked',
        message: 'Mutation/destructive execution is blocked. Re-run with confirmMutation true and any hsapi-required danger flags only after reviewing the preview.'
      },
      preview: preview.output
    };
  }

  const result = await runHsapiEnvelope(executionArgv(argv, args), {
    skipOutputRedaction: INTENDED_CREDENTIAL_ENDPOINTS.has(safety.endpointId)
  });
  return {
    ok: result.ok,
    executed: result.status === 0,
    status: result.status,
    command,
    safety,
    preview: preview.output,
    result: result.output || null,
    error: result.ok ? undefined : {
      code: 'execution_failed',
      message: result.error && result.error.message || result.stderr || 'hsapi execution failed.'
    },
    stderr: result.stderr
  };
}

function normalizeLimit(raw) {
  if (raw === undefined || raw === null) return 50;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error('limit must be an integer between 1 and 500.');
  }
  return value;
}

async function callTool(name, args = {}) {
  if (name === 'hsapi_profiles_list') {
    return runHsapiJson(['profiles', 'list']);
  }

  if (name === 'hsapi_catalog_coverage') {
    return runHsapiJson(['catalog', 'coverage']);
  }

  if (name === 'hsapi_catalog_commands') {
    const output = await runHsapiJson(['catalog', 'commands']);
    const limit = normalizeLimit(args.limit);
    const family = args.family ? String(args.family).toLowerCase() : null;
    const authFamily = args.authFamily ? String(args.authFamily).toLowerCase() : null;
    const commandContains = args.commandContains ? String(args.commandContains).toLowerCase() : null;
    let commands = Array.isArray(output.commands) ? output.commands : [];
    if (family) commands = commands.filter((entry) => String(entry.family || '').toLowerCase() === family);
    if (authFamily) commands = commands.filter((entry) => String(entry.auth && entry.auth.family || '').toLowerCase() === authFamily);
    if (commandContains) commands = commands.filter((entry) => String(entry.command || '').toLowerCase().includes(commandContains));
    return {
      ok: true,
      catalog: output.catalog,
      totalCommandCount: output.commandCount,
      filteredCommandCount: commands.length,
      returnedCommandCount: Math.min(commands.length, limit),
      truncated: commands.length > limit,
      commands: commands.slice(0, limit)
    };
  }

  if (name === 'hsapi_auth_doctor') {
    const argv = ['auth', 'doctor'];
    if (args.portal) argv.push('--portal', String(args.portal));
    if (args.requireEnv) argv.push('--require-env');
    return runHsapiJson(argv);
  }

  if (name === 'hsapi_command_execute') {
    return executeWithPreview(normalizedCommandArgv(args), args, {
      requireCatalog: true,
      readOnlyPostAllowed: true
    });
  }

  if (name === 'hsapi_request_execute') {
    return executeWithPreview(requestArgv(args), args, {
      requireCatalog: args.requireCatalog !== false,
      readOnlyPostAllowed: boolArg(args, 'readOnly', false)
    });
  }

  throw new Error('Unknown tool: ' + name);
}

async function handleRequest(message) {
  const id = message.id;
  const method = message.method;
  const params = message.params || {};

  if (method === 'initialize') {
    const requestedProtocolVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    return jsonRpcResult(id, {
      protocolVersion: requestedProtocolVersion && SUPPORTED_PROTOCOL_VERSIONS.includes(requestedProtocolVersion)
        ? requestedProtocolVersion
        : MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: 'hsapi-cli',
        version: packageJson.version
      },
      instructions: SERVER_INSTRUCTIONS
    });
  }

  if (method === 'ping') {
    return jsonRpcResult(id, {});
  }

  if (method === 'tools/list') {
    return jsonRpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    if (!params.name) return jsonRpcError(id, -32602, 'tools/call requires params.name.');
    try {
      const result = await callTool(params.name, params.arguments || {});
      return jsonRpcResult(id, toolContent(result));
    } catch (error) {
      const envelope = {
        ok: false,
        error: {
          code: 'tool_error',
          message: error.message
        }
      };
      return jsonRpcResult(id, {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(envelope, null, 2)
          }
        ],
        structuredContent: envelope
      });
    }
  }

  return jsonRpcError(id, -32601, 'Method not found: ' + method);
}

function parseMcpMessages(buffer) {
  const messages = [];
  let rest = buffer;
  while (rest.length) {
    const prefix = rest.slice(0, Math.min(rest.length, 32)).toString('utf8').trimStart();
    if (!/^content-length:/i.test(prefix)) {
      const lineEnd = rest.indexOf('\n');
      if (lineEnd === -1) break;
      const message = parseJsonLine(rest.slice(0, lineEnd).toString('utf8'));
      rest = rest.slice(lineEnd + 1);
      if (message) messages.push({ message, mode: 'line' });
      continue;
    }

    const headerEnd = rest.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const header = rest.slice(0, headerEnd).toString('utf8');
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) {
      throw new Error('MCP frame missing Content-Length header.');
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (rest.length < bodyEnd) break;
    const body = rest.slice(bodyStart, bodyEnd).toString('utf8');
    messages.push({ message: JSON.parse(body), mode: 'content-length' });
    rest = rest.slice(bodyEnd);
  }
  return { messages, rest };
}

function parseFrames(buffer) {
  const parsed = parseMcpMessages(buffer);
  return { messages: parsed.messages.map((entry) => entry.message), rest: parsed.rest };
}

function serveMcpStdio(options = {}) {
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  let buffer = Buffer.alloc(0);
  let queue = Promise.resolve();

  stdin.on('data', (chunk) => {
    try {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      const parsed = parseMcpMessages(buffer);
      buffer = parsed.rest;
      for (const entry of parsed.messages) {
        const { message, mode } = entry;
        // JSON-RPC: a message without an id is a notification (of any method name)
        // and must never receive a response. id 0 is a valid request id.
        if (message.id === undefined || message.id === null) continue;
        queue = queue.then(async () => {
          const response = await handleRequest(message);
          if (response) writeMessage(stdout, response, mode);
        }).catch((error) => {
          stderr.write((error.stack || error.message) + '\n');
          writeMessage(stdout, jsonRpcError(message.id, -32603, error.message), mode);
        });
      }
    } catch (error) {
      stderr.write((error.stack || error.message) + '\n');
    }
  });

  stdin.resume();
}

module.exports = {
  MCP_PROTOCOL_VERSION,
  TOOLS,
  callTool,
  frameMessage,
  parseFrames,
  parseMcpMessages,
  serveMcpStdio
};
