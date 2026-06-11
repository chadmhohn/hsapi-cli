#!/usr/bin/env node

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  endpointDefinitions,
  loadCatalogData,
  pathTemplateToRegex,
  summarizeCatalogCoverage
} = require('../src/catalog');
const {
  AUTH_FAMILIES,
  DEVELOPER_AUTH_SUBTYPES,
  VALID_AUTH_FAMILIES,
  VALID_DEVELOPER_AUTH_SUBTYPES
} = require('../src/auth');
const { runCli } = require('../src/cli');

const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(WORKSPACE_ROOT, 'bin', 'hsapi.js');
const MCP_CLI = path.join(WORKSPACE_ROOT, 'bin', 'hsapi-mcp.js');
const CATALOG_UPDATER = path.join(WORKSPACE_ROOT, 'scripts', 'update-hubspot-api-catalog.js');
const LIVE_READ_SMOKE = path.join(WORKSPACE_ROOT, 'scripts', 'live-read-smoke.js');
const DISPOSABLE_WRITE_SMOKE = path.join(WORKSPACE_ROOT, 'scripts', 'disposable-write-smoke.js');
const COVERAGE_DASHBOARD = path.join(WORKSPACE_ROOT, 'scripts', 'write-hubspot-api-coverage-dashboard.js');
const CATALOG_FILE = path.join(WORKSPACE_ROOT, 'data', 'hubspot-api-catalog.json');
const TEST_MATRIX_SAMPLE = path.join(WORKSPACE_ROOT, 'examples', 'portals.test-matrix.sample.json');
const DEVELOPER_CLIENT_CREDENTIALS_TOKEN_CACHE_SCHEMA = 'hsapi.developerClientCredentialsTokenCache.v1';
const { frameMessage, parseFrames } = require('../src/mcp-server');

function writeTempConfig(baseUrl, portalOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsapi-test-'));
  const configPath = path.join(dir, 'hubspot-portals.json');
  const portal = {
    label: 'Test Portal',
    portalId: '999',
    tokenEnv: 'HSAPI_TEST_TOKEN',
    baseUrl,
    ...portalOverrides
  };
  if (portal.tokenEnv === null) delete portal.tokenEnv;
  fs.writeFileSync(configPath, JSON.stringify({
    default: 'test',
    portals: {
      test: portal
    }
  }, null, 2));
  return configPath;
}

function writeTempCatalog(transform) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsapi-catalog-'));
  const catalogPath = path.join(dir, 'hubspot-api-catalog.json');
  const catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  transform(catalog);
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  return catalogPath;
}

function writeDeveloperClientCredentialsCache(cachePath, accessToken, expiresAt, baseUrl, scopes, overrides = {}) {
  fs.writeFileSync(cachePath, JSON.stringify({
    schema: DEVELOPER_CLIENT_CREDENTIALS_TOKEN_CACHE_SCHEMA,
    family: AUTH_FAMILIES.DEVELOPER,
    subtype: DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS,
    grantType: 'client_credentials',
    tokenType: 'bearer',
    accessToken,
    expiresIn: 1800,
    expiresAt,
    refreshedAt: '2026-05-15T00:00:00.000Z',
    portal: {
      name: 'test',
      portalId: '999',
      baseUrl
    },
    source: {
      clientIdEnv: 'HSAPI_DEVELOPER_CLIENT_ID',
      clientSecretEnv: 'HSAPI_DEVELOPER_CLIENT_SECRET',
      tokenUrlPath: '/oauth/2026-03/token',
      scopes
    },
    ...overrides
  }, null, 2));
}

function startServer() {
  const requests = [];
  const routeCounts = {};
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const url = new URL(req.url, 'http://127.0.0.1');
      const routeKey = `${req.method} ${url.pathname}`;
      routeCounts[routeKey] = (routeCounts[routeKey] || 0) + 1;
      const headers = {
        'content-type': 'application/json',
        'x-hubspot-correlation-id': 'test-correlation',
        'x-hubspot-ratelimit-remaining': '99'
      };
      if (url.pathname === '/crm/v3/owners') {
        res.writeHead(200, headers);
        res.end(JSON.stringify({
          total: 2,
          results: [
            { id: 'owner-1', email: 'ada@example.com', properties: { name: 'Ada Lovelace' } },
            { id: 'owner-2', email: 'grace@example.com', properties: { name: 'Grace Hopper' } }
          ],
          paging: { next: { after: 'owners-page-2' } }
        }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/crm/objects/2026-03/paged_targets/search') {
        const parsedBody = body ? JSON.parse(body) : {};
        res.writeHead(200, headers);
        if (parsedBody.after === '2') {
          res.end(JSON.stringify({ total: 3, results: [{ id: '3' }] }));
        } else {
          res.end(JSON.stringify({ total: 3, results: [{ id: '1' }, { id: '2' }], paging: { next: { after: '2' } } }));
        }
        return;
      }
      if (url.pathname === '/crm/v3/bigpage') {
        res.writeHead(200, headers);
        res.end(JSON.stringify({
          results: Array.from({ length: 600 }, (_, index) => ({ id: String(index) })),
          paging: { next: { after: 'more' } }
        }));
        return;
      }
      if (url.pathname === '/automation/v4/flows') {
        res.writeHead(200, headers);
        if (url.searchParams.get('after') === 'flow-page-2') {
          res.end(JSON.stringify({ results: [{ id: 'flow-2', name: 'Nurture B', revisionId: '4' }] }));
        } else {
          res.end(JSON.stringify({
            results: [{ id: 'flow-1', name: 'Nurture A', revisionId: '9' }],
            paging: { next: { after: 'flow-page-2' } }
          }));
        }
        return;
      }
      if (url.pathname === '/crm/v3/paged') {
        res.writeHead(200, headers);
        if (url.searchParams.get('after') === 'page-2') {
          res.end(JSON.stringify({ results: [{ id: '2' }] }));
        } else {
          res.end(JSON.stringify({ results: [{ id: '1' }], paging: { next: { after: 'page-2' } } }));
        }
        return;
      }
      if (url.pathname === '/crm/v3/retry-once' && routeCounts[routeKey] === 1) {
        res.writeHead(429, { ...headers, 'retry-after': '0' });
        res.end(JSON.stringify({ message: 'rate limited once' }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/crm/objects/2026-03/retry_targets/search') {
        if (routeCounts[routeKey] === 1) {
          res.writeHead(429, { ...headers, 'retry-after': '0' });
          res.end(JSON.stringify({ message: 'search rate limited once' }));
          return;
        }
        res.writeHead(200, headers);
        res.end(JSON.stringify({ total: 0, results: [] }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/crm/objects/2026-03/retry_targets') {
        res.writeHead(429, { ...headers, 'retry-after': '0' });
        res.end(JSON.stringify({ message: 'always rate limited' }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/oauth/2026-03/token') {
        const params = new URLSearchParams(body);
        if (params.get('grant_type') === 'client_credentials') {
          if (params.get('client_secret') === 'bad-developer-client-secret') {
            res.writeHead(401, headers);
            res.end(JSON.stringify({
              category: 'INVALID_CLIENT',
              message: `bad developer client secret ${params.get('client_secret')}`,
              access_token: 'developer-token-error-secret'
            }));
            return;
          }
          res.writeHead(200, headers);
          res.end(JSON.stringify({
            access_token: `developer-client-access-token-${routeCounts[routeKey]}`,
            token_type: 'bearer',
            expires_in: 1800
          }));
          return;
        }
        if (params.get('grant_type') !== 'refresh_token') {
          res.writeHead(400, headers);
          res.end(JSON.stringify({ category: 'BAD_REQUEST', message: 'unsupported grant type' }));
          return;
        }
        if (params.get('refresh_token') === 'bad-refresh-token') {
          res.writeHead(401, headers);
          res.end(JSON.stringify({
            category: 'INVALID_AUTHENTICATION',
            message: 'refresh failed',
            refresh_token: 'server-refresh-token-should-redact'
          }));
          return;
        }
        res.writeHead(200, headers);
        res.end(JSON.stringify({
          access_token: 'refreshed-access-token',
          refresh_token: 'server-refresh-token-should-not-cache',
          token_type: 'bearer',
          expires_in: 1800
        }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/crm/objects/2026-03/contacts') {
        res.writeHead(200, headers);
        res.end(JSON.stringify({
          results: [{ id: '101', properties: { email: 'ada@example.com' } }],
          paging: { next: { after: 'contact-page-2' } }
        }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/crm/objects/2026-03/companies/search') {
        res.writeHead(200, headers);
        res.end(JSON.stringify({
          total: 42,
          results: [{ id: 'company-1', properties: { name: 'Example Company' } }]
        }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/crm/objects/2026-03/contacts/search') {
        const parsedBody = body ? JSON.parse(body) : {};
        const filters = parsedBody.filterGroups && parsedBody.filterGroups[0] ? parsedBody.filterGroups[0].filters || [] : [];
        const missing = filters.some((filter) => filter.value === 'nobody@example.com');
        res.writeHead(200, headers);
        res.end(JSON.stringify(missing
          ? { total: 0, results: [] }
          : {
              total: 1,
              results: [{
                id: '101',
                properties: {
                  email: 'ada@example.com',
                  firstname: 'Ada'
                }
              }]
            }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/crm/properties/2026-03/contacts') {
        res.writeHead(200, headers);
        res.end(JSON.stringify({
          results: [
            { name: 'firstname', label: 'First name' },
            { name: 'email', label: 'Email' },
            { name: 'createdate', label: 'Create date' }
          ]
        }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/files/2026-03/files/search') {
        res.writeHead(200, headers);
        res.end(JSON.stringify({
          results: [
            { id: 'file-1', name: 'logo.png', path: '/library/brand/logo.png' },
            { fileId: 'file-2', title: 'brand-guide.pdf', path: '/library/brand/brand-guide.pdf' }
          ]
        }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/crm/properties/2026-03/deals/groups') {
        res.writeHead(201, headers);
        res.end(JSON.stringify({ name: 'hsapi_test_group_mock' }));
        return;
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/crm/properties/2026-03/deals/groups/')) {
        res.writeHead(204, headers);
        res.end('');
        return;
      }
      if (req.method === 'POST' && url.pathname === '/crm/properties/2026-03/deals') {
        res.writeHead(403, headers);
        res.end(JSON.stringify({ message: 'requires deals-write' }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/crm/pipelines/2026-03/deals/default/stages') {
        res.writeHead(403, headers);
        res.end(JSON.stringify({ message: 'User level OAuth token is not allowed for this endpoint.' }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/crm/lists/2026-03') {
        res.writeHead(403, headers);
        res.end(JSON.stringify({ message: 'missing list write scope' }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/crm/objects/2026-03/contacts') {
        res.writeHead(403, headers);
        res.end(JSON.stringify({ message: 'missing contacts-write' }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/crm/imports/2026-03') {
        res.writeHead(200, headers);
        res.end(JSON.stringify({ id: 'import-1' }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/crm/imports/2026-03/import-1/cancel') {
        res.writeHead(200, headers);
        res.end(JSON.stringify({ id: 'import-1', state: 'CANCELED' }));
        return;
      }
      if (url.pathname === '/crm-object-schemas/2026-03/schemas') {
        res.writeHead(403, headers);
        res.end(JSON.stringify({ message: 'missing scope or tier' }));
        return;
      }
      if (url.pathname === '/crm/pipelines/2026-03/deals') {
        res.writeHead(403, headers);
        res.end(JSON.stringify({ message: 'User level OAuth token is not allowed for this endpoint.' }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/visitor-identification/2026-03/tokens/create') {
        res.writeHead(200, headers);
        res.end(JSON.stringify({ token: 'visitor-token-fixture-value' }));
        return;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify({ results: [], paging: null }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, requests, routeCounts, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function startCmsDoctorFixtureServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const url = new URL(req.url, 'http://127.0.0.1');
      const headers = {
        'content-type': 'application/json',
        'x-hubspot-correlation-id': 'cms-doctor-correlation'
      };
      handler(req, res, url, headers);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, requests, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: WORKSPACE_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function runWithInput(args, env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: WORKSPACE_ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function runProgrammatic(args, env) {
  const result = await runCli(args, { env });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function runNodeScript(scriptPath, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: WORKSPACE_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function writeMockHsCli() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsapi-mock-hs-'));
  const scriptPath = process.platform === 'win32' ? path.join(dir, 'hs-mock.js') : path.join(dir, 'hs');
  const binPath = process.platform === 'win32' ? path.join(dir, 'hs.cmd') : scriptPath;
  const logPath = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HSAPI_MOCK_HS_LOG, JSON.stringify(args) + '\\n');
if (args[0] === '--version') {
  console.log('8.4.0');
  process.exit(0);
}
if (args[0] === 'accounts' && args[1] === 'info') {
  const account = args[2] || 'missing-account';
  if (account === 'bad-account') {
    console.error('Account not found: bad-account');
    process.exit(1);
  }
  console.log('Account name: ' + account);
  console.log('Account ID: 123456');
  console.log('Scopes available:');
  console.log('  developer.projects.write');
  process.exit(0);
}
if (args[0] === 'project' && args[1] === 'list') {
  const account = args[args.indexOf('--account') + 1] || 'unknown';
  if (account === 'empty') {
    console.error('✖ ERROR No projects found for account empty [standard] (123456)');
    process.exit(1);
  }
  console.log('No projects found for ' + account);
  process.exit(0);
}
if (args[0] === 'project' && args[1] === 'deploy') {
  console.log('Deploy delegated for ' + (args[args.indexOf('--project') + 1] || 'unknown-project'));
  process.exit(0);
}
if (args[0] === 'project' && args[1] === 'info') {
  console.log('Project info');
  process.exit(0);
}
console.log('mock hs called: ' + args.join(' '));
process.exit(0);
`, 'utf8');
  fs.chmodSync(scriptPath, 0o755);
  if (process.platform === 'win32') {
    fs.writeFileSync(binPath, `@echo off\r\n"${process.execPath}" "%~dp0hs-mock.js" %*\r\n`, 'utf8');
  }
  return { dir, binPath, logPath };
}

function readMockHsCalls(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runMcpConversation(messages, env, expectedResponses, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_CLI], {
      cwd: WORKSPACE_ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdoutBuffer = Buffer.alloc(0);
    let stderr = '';
    const responses = [];
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out waiting for MCP responses. stderr: ' + stderr));
    }, 5000);

    child.stdout.on('data', (chunk) => {
      try {
        stdoutBuffer = Buffer.concat([stdoutBuffer, Buffer.from(chunk)]);
        const parsed = parseFrames(stdoutBuffer);
        stdoutBuffer = parsed.rest;
        responses.push(...parsed.messages);
        if (responses.length >= expectedResponses) {
          clearTimeout(timeout);
          child.kill();
          resolve({ responses, stderr });
        }
      } catch (error) {
        clearTimeout(timeout);
        child.kill();
        reject(error);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    const frameMode = options.frameMode || 'content-length';
    for (const message of messages) child.stdin.write(frameMessage(message, frameMode));
  });
}

function parseJsonOutput(result) {
  assert.strictEqual(result.stderr, '', result.stderr);
  return JSON.parse(result.stdout);
}

function mcpStructuredContent(response) {
  assert(response.result, JSON.stringify(response));
  if (response.result.structuredContent) return response.result.structuredContent;
  assert(response.result.content && response.result.content[0] && response.result.content[0].text);
  return JSON.parse(response.result.content[0].text);
}

function samplePathForTemplate(template) {
  return template.replace(/\{[^}]+\}/g, 'sample');
}

function requestCount(requests, method, pathname) {
  return requests.filter((request) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    return request.method === method && url.pathname === pathname;
  }).length;
}

function assertNoTokenLikeValues(value, context = 'fixture') {
  if (typeof value === 'string') {
    assert(!/(pat-|hapikey|Bearer\s+|[A-Za-z0-9_-]{40,})/.test(value), `${context} must not include token-like values`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoTokenLikeValues(item, `${context}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) assertNoTokenLikeValues(child, `${context}.${key}`);
  }
}

async function expectShowRequest(args, env, expected) {
  const before = expected.requests.length;
  const output = parseJsonOutput(await run([...args, '--show-request'], env));
  assert.strictEqual(output.showRequest, true);
  assert.strictEqual(output.request.method, expected.method);
  assert.strictEqual(output.request.pathname, expected.pathname);
  if (expected.endpointId) assert.strictEqual(output.endpoint && output.endpoint.id, expected.endpointId);
  if (expected.body !== undefined) assert.deepStrictEqual(output.request.body, expected.body);
  assert.strictEqual(expected.requests.length, before, `${args.join(' ')} --show-request must not make a network request`);
  return output;
}

const { test, before, after } = require('node:test');

let server;
let requests;
let routeCounts;
let baseUrl;
let configPath;
let baseEnv;
let importDir;
let importCsv;
let uploadFile;
let importRequestPath;
let explicitPortalBearerConfig;
let developerOnlyConfig;

before(async () => {
  ({ server, requests, routeCounts, baseUrl } = await startServer());
  configPath = writeTempConfig(baseUrl);
  baseEnv = {
    HSAPI_PORTALS_CONFIG: configPath,
    HUBSPOT_ACCESS_TOKEN: 'generic-token',
    HSAPI_TEST_TOKEN: '',
    // Keep test-run mutations out of any real local history file.
    HSAPI_HISTORY: '0'
  };
  importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsapi-import-'));
  importCsv = path.join(importDir, 'contacts.csv');
  uploadFile = path.join(importDir, 'logo.txt');
  importRequestPath = path.join(importDir, 'import-request.json');
  fs.writeFileSync(importCsv, 'email,firstname\nada@example.com,Ada\n');
  fs.writeFileSync(uploadFile, 'test file content\n');
  fs.writeFileSync(importRequestPath, JSON.stringify({
    name: 'Test import',
    importOperations: { '0-1': 'CREATE' },
    files: [{
      fileName: 'contacts.csv',
      fileFormat: 'CSV',
      fileImportPage: {
        hasHeader: true,
        columnMappings: [{
          columnObjectTypeId: '0-1',
          columnName: 'email',
          propertyName: 'email',
          idColumnType: 'HUBSPOT_OBJECT_ID'
        }]
      }
    }]
  }, null, 2));
  explicitPortalBearerConfig = writeTempConfig(baseUrl, {
    tokenEnv: null,
    auth: {
      defaultFamily: AUTH_FAMILIES.PORTAL_BEARER,
      portalBearer: {
        tokenEnv: 'HSAPI_TEST_EXPLICIT_TOKEN',
        kind: 'private_app'
      }
    }
  });
  developerOnlyConfig = writeTempConfig(baseUrl, {
    tokenEnv: null,
    auth: {
      defaultFamily: AUTH_FAMILIES.DEVELOPER,
      developer: {
        developerApiKeyEnv: 'HSAPI_DEVELOPER_API_KEY',
        appIdEnv: 'HSAPI_DEVELOPER_APP_ID',
        personalAccessKeyEnv: 'HSAPI_PERSONAL_ACCESS_KEY'
      }
    }
  });
});

after(() => {
  server.close();
  console.log('hsapi tests passed');
});

test('01 block', async () => {
    const noConfigEnv = {
      HSAPI_PORTALS_CONFIG: path.join(os.tmpdir(), 'hsapi-missing-config.json')
    };
    const catalog = await run(['catalog', 'coverage'], noConfigEnv);
    assert.strictEqual(catalog.status, 0, catalog.stderr || catalog.stdout);
    assert.strictEqual(JSON.parse(catalog.stdout).ok, true);

    const tiers = await run(['tiers', 'products'], noConfigEnv);
    assert.strictEqual(tiers.status, 0, tiers.stderr || tiers.stdout);
    assert.strictEqual(JSON.parse(tiers.stdout).ok, true);

    const commerceTypes = await run(['crm', 'object-types', '--family', 'commerce'], noConfigEnv);
    assert.strictEqual(commerceTypes.status, 0, commerceTypes.stderr || commerceTypes.stdout);
    const commerceOutput = JSON.parse(commerceTypes.stdout);
    assert.strictEqual(commerceOutput.ok, true);
    assert.strictEqual(commerceOutput.family, 'commerce');
    assert.strictEqual(commerceOutput.count, 13);
    assert(commerceOutput.objectTypes.some((entry) => entry.objectType === 'line_items'));
    assert(commerceOutput.objectTypes.some((entry) => entry.objectType === 'commerce_payments'));
    assert(commerceOutput.objectTypes.some((entry) => entry.objectType === 'subscriptions'));

    const commerceCount = await run(['crm', 'object-types', '--family', 'commerce', '--select', 'count', '--raw-value'], noConfigEnv);
    assert.strictEqual(commerceCount.status, 0, commerceCount.stderr || commerceCount.stdout);
    assert.strictEqual(commerceCount.stdout, '13\n');

    const commerceNames = await run(['crm', 'object-types', '--family', 'commerce', '--names-only'], noConfigEnv);
    assert.strictEqual(commerceNames.status, 0, commerceNames.stderr || commerceNames.stdout);
    assert.deepStrictEqual(JSON.parse(commerceNames.stdout).names, [
      'products',
      'line_items',
      'quotes',
      'invoices',
      'commerce_payments',
      'subscriptions',
      'orders',
      'carts',
      'fees',
      'discounts',
      'taxes',
      'listings',
      'services'
    ]);

    const activityNames = await run(['crm', 'object-types', '--family', 'activity', '--names-only'], noConfigEnv);
    assert.strictEqual(activityNames.status, 0, activityNames.stderr || activityNames.stdout);
    assert.deepStrictEqual(JSON.parse(activityNames.stdout).names, [
      'calls',
      'meetings',
      'notes',
      'emails',
      'tasks',
      'communications',
      'postal_mail',
      'projects'
    ]);

});

test('02 block (2)', async () => {
    const mockHs = writeMockHsCli();
    const projectEnv = {
      HSAPI_PORTALS_CONFIG: path.join(os.tmpdir(), 'hsapi-project-bridge-no-config.json'),
      HSAPI_MOCK_HS_LOG: mockHs.logPath
    };
    const doctor = await run(['project', 'doctor', '--account', 'sandbox', '--hs-bin', mockHs.binPath], projectEnv);
    assert.strictEqual(doctor.status, 0, doctor.stderr || doctor.stdout);
    const doctorOutput = parseJsonOutput(doctor);
    assert.strictEqual(doctorOutput.ready, true);
    assert.strictEqual(doctorOutput.delegatedTo, 'official_hubspot_cli');
    assert.strictEqual(doctorOutput.account.selector, 'sandbox');
    assert.match(doctorOutput.account.note, /does not treat ~\/\.hscli\/config\.yml as portal bearer auth/);
    assert(!doctor.stdout.includes('developer-projects-secret'), 'project doctor must not print token-like values');
    assert.deepStrictEqual(readMockHsCalls(mockHs.logPath), [
      ['--version'],
      ['accounts', 'info', 'sandbox'],
      ['project', 'list', '--account', 'sandbox']
    ]);

    fs.writeFileSync(mockHs.logPath, '');
    const preview = await run(['project', 'list', '--account', 'sandbox', '--hs-bin', mockHs.binPath, '--compact', '--show-request'], projectEnv);
    assert.strictEqual(preview.status, 0, preview.stderr || preview.stdout);
    const previewOutput = parseJsonOutput(preview);
    assert.strictEqual(previewOutput.ok, true);
    assert.strictEqual(previewOutput.dryRun, true);
    assert.strictEqual(previewOutput.command.display, 'hs project list --account sandbox');
    assert.deepStrictEqual(readMockHsCalls(mockHs.logPath), [], 'project --show-request must not call hs');

    const list = await run(['project', 'list', '--account', 'sandbox', '--hs-bin', mockHs.binPath], projectEnv);
    assert.strictEqual(list.status, 0, list.stderr || list.stdout);
    const listOutput = parseJsonOutput(list);
    assert.strictEqual(listOutput.ok, true);
    assert.strictEqual(listOutput.result.stdout, 'No projects found for sandbox');
    assert.deepStrictEqual(readMockHsCalls(mockHs.logPath), [
      ['project', 'list', '--account', 'sandbox']
    ]);

    fs.writeFileSync(mockHs.logPath, '');
    const emptyList = await run(['project', 'list', '--account', 'empty', '--hs-bin', mockHs.binPath], projectEnv);
    assert.strictEqual(emptyList.status, 0, emptyList.stderr || emptyList.stdout);
    const emptyListOutput = parseJsonOutput(emptyList);
    assert.strictEqual(emptyListOutput.ok, true);
    assert.strictEqual(emptyListOutput.result.normalizedReason, 'no_projects_found');
    assert.strictEqual(emptyListOutput.result.empty, true);
    assert.deepStrictEqual(readMockHsCalls(mockHs.logPath), [
      ['project', 'list', '--account', 'empty']
    ]);

    fs.writeFileSync(mockHs.logPath, '');
    const blockedDeploy = await run(['project', 'deploy', '--account', 'sandbox', '--project', 'demo', '--build', '5', '--hs-bin', mockHs.binPath], projectEnv);
    assert.strictEqual(blockedDeploy.status, 2, blockedDeploy.stderr || blockedDeploy.stdout);
    const blockedOutput = parseJsonOutput(blockedDeploy);
    assert.strictEqual(blockedOutput.ok, false);
    assert.strictEqual(blockedOutput.dryRun, true);
    assert.match(blockedOutput.message, /blocked/);
    assert.strictEqual(blockedOutput.safety.requiresConfirmation, true);
    assert.deepStrictEqual(readMockHsCalls(mockHs.logPath), [], 'project deploy without --yes must not call hs');

    const confirmedDeploy = await run(['project', 'deploy', '--account', 'sandbox', '--project', 'demo', '--build', '5', '--hs-bin', mockHs.binPath, '--yes'], projectEnv);
    assert.strictEqual(confirmedDeploy.status, 0, confirmedDeploy.stderr || confirmedDeploy.stdout);
    const confirmedOutput = parseJsonOutput(confirmedDeploy);
    assert.strictEqual(confirmedOutput.mutationConfirmed, true);
    assert.strictEqual(confirmedOutput.command.display, 'hs project deploy --project demo --build 5 --account sandbox');
    assert.strictEqual(confirmedOutput.result.stdout, 'Deploy delegated for demo');
    assert.deepStrictEqual(readMockHsCalls(mockHs.logPath), [
      ['project', 'deploy', '--project', 'demo', '--build', '5', '--account', 'sandbox']
    ]);

    const missingAccount = await run(['project', 'list', '--hs-bin', mockHs.binPath], projectEnv);
    assert.notStrictEqual(missingAccount.status, 0);
    assert.match(missingAccount.stderr, /requires --account/);

});

test('03 block (3)', async () => {
    const result = await run(['request', 'GET', '/crm/v3/owners'], baseEnv);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /Missing HubSpot token\. Set HSAPI_TEST_TOKEN/);
    assert.strictEqual(requests.length, 0, 'generic HUBSPOT_ACCESS_TOKEN must not satisfy profile-specific token');

});

test('04 block (4)', async () => {
    const before = requests.length;
    const output = parseJsonOutput(await run(['account', 'details', '--show-request'], baseEnv));
    assert.strictEqual(output.showRequest, true);
    assert.strictEqual(output.portal.tokenEnv, 'HSAPI_TEST_TOKEN');
    assert.strictEqual(output.request.method, 'GET');
    assert.strictEqual(output.request.url, `${baseUrl}/account-info/2026-03/details`);
    assert.strictEqual(output.request.headers.Authorization, 'Bearer $HSAPI_TEST_TOKEN');
    assert.strictEqual(output.endpoint.id, 'account.details');
    assert.strictEqual(output.authFamily, AUTH_FAMILIES.PORTAL_BEARER);
    assert.strictEqual(output.auth.family, AUTH_FAMILIES.PORTAL_BEARER);
    assert.strictEqual(output.auth.provenance, 'catalog');
    assert.strictEqual(output.auth.endpointId, 'account.details');
    assert.strictEqual(output.auth.credentialSource.name, 'HSAPI_TEST_TOKEN');
    assert.strictEqual(output.auth.credentialSource.profileField, 'tokenEnv');
    assert.strictEqual(requests.length, before, '--show-request must not make a network request');

});

test('05 block (5)', async () => {
    const before = requests.length;
    const previousToken = process.env.HSAPI_TEST_TOKEN;
    const result = await runProgrammatic(['account', 'details', '--show-request'], baseEnv);
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.strictEqual(result.stderr, '');
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.showRequest, true);
    assert.strictEqual(output.request.headers.Authorization, 'Bearer $HSAPI_TEST_TOKEN');
    assert.strictEqual(output.auth.credentialSource.name, 'HSAPI_TEST_TOKEN');
    assert.strictEqual(requests.length, before, 'programmatic --show-request must not make a network request');
    assert.strictEqual(process.env.HSAPI_TEST_TOKEN, previousToken, 'programmatic env overrides must be restored');

});

test('06 block (6)', async () => {
    const result = await runProgrammatic(['request', 'GET', '/crm/v3/owners'], baseEnv);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /Missing HubSpot token\. Set HSAPI_TEST_TOKEN/);
    assert.strictEqual(result.stdout, '');

});

test('07 block (7)', async () => {
    const mcp = await runMcpConversation([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'hsapi-test', version: '0.0.0' }
        }
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hsapi_profiles_list', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hsapi_catalog_commands', arguments: { authFamily: AUTH_FAMILIES.PORTAL_BEARER, limit: 2 } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'hsapi_auth_doctor', arguments: { portal: 'test' } } }
    ], baseEnv, 5);
    assert.strictEqual(mcp.stderr, '');
    assert.strictEqual(mcp.responses[0].result.serverInfo.name, 'hsapi-cli');
    const toolNames = mcp.responses[1].result.tools.map((tool) => tool.name);
    assert(toolNames.includes('hsapi_profiles_list'));
    assert(toolNames.includes('hsapi_catalog_coverage'));
    assert(toolNames.includes('hsapi_catalog_commands'));
    assert(toolNames.includes('hsapi_auth_doctor'));
    assert(toolNames.includes('hsapi_command_execute'));
    assert(toolNames.includes('hsapi_request_execute'));
    const profiles = mcpStructuredContent(mcp.responses[2]);
    assert.strictEqual(profiles.ok, true);
    assert.strictEqual(profiles.profiles[0].name, 'test');
    assert.strictEqual(profiles.profiles[0].tokenPresent, false);
    const commands = mcpStructuredContent(mcp.responses[3]);
    assert.strictEqual(commands.ok, true);
    assert.strictEqual(commands.returnedCommandCount, 2);
    assert(commands.commands.every((command) => command.auth.family === AUTH_FAMILIES.PORTAL_BEARER));
    const doctor = mcpStructuredContent(mcp.responses[4]);
    assert.strictEqual(doctor.ok, true);
    assert.strictEqual(doctor.profileCount, 1);
    assert.strictEqual(doctor.profiles[0].name, 'test');

});

test('08 block (8)', async () => {
    const mcp = await runMcpConversation([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'hsapi-test-line', version: '0.0.0' }
        }
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' }
    ], baseEnv, 2, { frameMode: 'line' });
    assert.strictEqual(mcp.stderr, '');
    assert.strictEqual(mcp.responses[0].result.serverInfo.name, 'hsapi-cli');
    const toolNames = mcp.responses[1].result.tools.map((tool) => tool.name);
    assert(toolNames.includes('hsapi_auth_doctor'));
    assert(toolNames.includes('hsapi_request_execute'));

});

test('09 Issue #16: id-less notifications of any method name must be ignored (no', async () => {
    // Issue #16: id-less notifications of any method name must be ignored (no
    // id-less responses written), and initialize must clamp unknown protocol versions.
    const mcp = await runMcpConversation([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 'draft-9999-test',
          capabilities: {},
          clientInfo: { name: 'hsapi-test-hygiene', version: '0.0.0' }
        }
      },
      { jsonrpc: '2.0', method: 'initialized' },
      { jsonrpc: '2.0', method: 'cancelled', params: { reason: 'test' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' }
    ], baseEnv, 2);
    assert.strictEqual(mcp.stderr, '');
    assert.strictEqual(mcp.responses.length, 2);
    assert.strictEqual(mcp.responses[0].result.protocolVersion, '2024-11-05');
    assert(mcp.responses.every((response) => response.id !== undefined && response.id !== null));
    assert.strictEqual(mcp.responses[1].id, 2);
    assert(Array.isArray(mcp.responses[1].result.tools));

    const supported = await runMcpConversation([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'hsapi-test-hygiene-2', version: '0.0.0' }
        }
      },
      { jsonrpc: '2.0', id: 2, method: 'ping' }
    ], baseEnv, 2);
    assert.strictEqual(supported.stderr, '');
    assert.strictEqual(supported.responses[0].result.protocolVersion, '2025-06-18');
    assert.strictEqual(supported.responses[1].id, 2);

});

test('10 Issue #20: safe reads run once and omit the preview from the envelope', async () => {
    const before = requests.length;
    const mcp = await runMcpConversation([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'hsapi-test', version: '0.0.0' }
        }
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'hsapi_command_execute',
          arguments: {
            portal: 'test',
            argv: ['properties', 'list', 'contacts'],
            maxResults: 1
          }
        }
      },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'hsapi_request_execute',
          arguments: {
            portal: 'test',
            method: 'GET',
            path: '/crm/properties/2026-03/contacts',
            maxResults: 1
          }
        }
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'hsapi_command_execute',
          arguments: {
            portal: 'test',
            argv: ['crm', 'create', 'contacts', '--properties', '{"email":"ada@example.com"}']
          }
        }
      },
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'hsapi_request_execute',
          arguments: {
            portal: 'test',
            method: 'GET',
            path: '/uncataloged/test'
          }
        }
      },
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'hsapi_request_execute',
          arguments: {
            portal: 'test',
            method: 'POST',
            path: '/crm/objects/2026-03/contacts',
            body: { properties: { email: 'ada@example.com' } },
            showRequest: true
          }
        }
      },
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'hsapi_request_execute',
          arguments: {
            portal: 'test',
            method: 'POST',
            path: '/crm/objects/2026-03/contacts',
            body: '{"properties":{"email":"ada@example.com"}}',
            showRequest: true
          }
        }
      }
    ], { ...baseEnv, HSAPI_TEST_TOKEN: 'mcp-token' }, 7);
    assert.strictEqual(mcp.stderr, '');
    const commandRead = mcpStructuredContent(mcp.responses[1]);
    assert.strictEqual(commandRead.ok, true);
    assert.strictEqual(commandRead.executed, true);
    assert.strictEqual(commandRead.safety.catalogBacked, true);
    assert.strictEqual(commandRead.safety.risk, 'read');
    // Issue #20: safe reads run once and omit the preview from the envelope.
    assert.strictEqual(commandRead.preview, undefined, 'safe command reads must not carry a preview');
    assert.strictEqual(commandRead.result.portal, 'test');
    assert.strictEqual(commandRead.result.data.results.length, 1);
    assert(!JSON.stringify(commandRead).includes('mcp-token'), 'MCP command read result must not expose raw token values');

    const read = mcpStructuredContent(mcp.responses[2]);
    assert.strictEqual(read.ok, true);
    assert.strictEqual(read.executed, true);
    assert.strictEqual(read.safety.catalogBacked, true);
    assert.strictEqual(read.safety.risk, 'read');
    assert.strictEqual(read.preview, undefined, 'safe request reads must not carry a preview');
    assert.strictEqual(read.result.portal, 'test');
    assert.strictEqual(read.result.data.results.length, 1);
    assert(!JSON.stringify(read).includes('mcp-token'), 'MCP request read result must not expose raw token values');

    const blocked = mcpStructuredContent(mcp.responses[3]);
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.executed, false);
    assert.strictEqual(blocked.blocked, true);
    assert.strictEqual(blocked.error.code, 'mutation_blocked');
    assert.strictEqual(blocked.safety.catalogBacked, true);
    assert.strictEqual(blocked.safety.risk, 'mutation');
    assert.strictEqual(blocked.preview.showRequest, true);
    assert.strictEqual(blocked.preview.auth.provenance, 'catalog');
    assert(!JSON.stringify(blocked).includes('mcp-token'), 'MCP mutation preview must not expose raw token values');

    const uncataloged = mcpStructuredContent(mcp.responses[4]);
    assert.strictEqual(uncataloged.ok, false);
    assert.strictEqual(uncataloged.executed, false);
    assert.strictEqual(uncataloged.blocked, true);
    assert.strictEqual(uncataloged.error.code, 'not_catalog_backed');
    assert.strictEqual(uncataloged.safety.catalogBacked, false);
    assert.strictEqual(uncataloged.preview.auth.provenance, 'generic_request_default');
    const objectBodyPreview = mcpStructuredContent(mcp.responses[5]);
    assert.strictEqual(objectBodyPreview.ok, true);
    assert.deepStrictEqual(objectBodyPreview.preview.request.body, { properties: { email: 'ada@example.com' } });

    const stringBodyPreview = mcpStructuredContent(mcp.responses[6]);
    assert.strictEqual(stringBodyPreview.ok, true);
    assert.deepStrictEqual(stringBodyPreview.preview.request.body, { properties: { email: 'ada@example.com' } });
    assert.strictEqual(requests.length, before + 2, 'MCP smoke should execute only the read operations');

});

test('11 Issue #17 (slice 1): catalog argspecs + hsapi help + per-command --help', async () => {
    // Issue #17 (slice 1): catalog argspecs + hsapi help + per-command --help.
    const ownersHelp = parseJsonOutput(await run(['help', 'owners', 'list'], baseEnv));
    assert.strictEqual(ownersHelp.ok, true);
    assert.strictEqual(ownersHelp.endpointId, 'owners.list');
    assert.strictEqual(ownersHelp.argsDocumented, true);
    assert(ownersHelp.args.some((arg) => arg.name === 'email' && arg.kind === 'flag'));
    assert(ownersHelp.args.some((arg) => arg.name === 'paginate' && arg.type === 'boolean'));

    const searchHelpViaFlag = parseJsonOutput(await run(['crm', 'search', '--help'], baseEnv));
    assert.strictEqual(searchHelpViaFlag.endpointId, 'objects.search');
    const filterArg = searchHelpViaFlag.args.find((arg) => arg.name === 'filter');
    assert.strictEqual(filterArg.repeatable, true);
    assert(searchHelpViaFlag.args.some((arg) => arg.name === 'objectType' && arg.kind === 'positional' && arg.required === true));

    const argslessCatalog = writeTempCatalog((catalog) => {
      const indexedData = catalog.endpoints.find((endpoint) => endpoint.name === 'cms.site_search.indexed_data');
      delete indexedData.args;
    });
    const undocumented = parseJsonOutput(await run(['help', 'cms', 'indexed-data'], {
      ...baseEnv,
      HSAPI_CATALOG_FILE: argslessCatalog
    }));
    assert.strictEqual(undocumented.argsDocumented, false);
    assert.match(undocumented.note, /No argspec documented/);

    {
      // Issue #17 completeness gate: every typed command documents args.
      const catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
      const missingArgs = catalog.endpoints
        .filter((endpoint) => endpoint.status === 'typed' && endpoint.command && !Array.isArray(endpoint.args))
        .map((endpoint) => endpoint.name);
      assert.deepStrictEqual(missingArgs, [], 'every typed command must document args in the catalog');
    }

    {
      // Issue #17 (slice 2): usage is generated from the endpoint catalog.
      const fullUsage = await run(['help'], baseEnv);
      assert.strictEqual(fullUsage.status, 0);
      assert.match(fullUsage.stdout, /Typed commands \(generated from the endpoint catalog/);
      assert.match(fullUsage.stdout, /hsapi lists create\|search\|get\|get-by-name\|update-name\|delete\|restore\|memberships\|membership-update\|memberships-clear\|record-memberships \.\.\. \[--portal <name>\] \[--yes\]/);
      assert.match(fullUsage.stdout, /hsapi account details\|usage\|subscription \.\.\. \[--portal <name>\]\n/);

      const usageCatalog = writeTempCatalog((catalog) => {
        catalog.endpoints.push({
          family: 'zz.fake',
          name: 'zz.fake.ping',
          method: 'GET',
          path: '/zz-fake/2026-03/ping',
          risk: 'read',
          status: 'typed',
          command: 'hsapi zz-fake ping',
          auth: { family: 'portal_bearer', subtype: 'private_app_or_static_app', fallback: 'none' }
        });
      });
      const customUsage = await run(['help'], { ...baseEnv, HSAPI_CATALOG_FILE: usageCatalog });
      assert.strictEqual(customUsage.status, 0);
      assert.match(customUsage.stdout, /hsapi zz-fake ping \.\.\. \[--portal <name>\]/);
    }

    {
      // Issue #17 (slice 3): unknown/mistyped flags are rejected from the argspecs.
      const unknownFlag = await run(['owners', 'list', '--emial', 'ada@example.com'], baseEnv);
      assert.notStrictEqual(unknownFlag.status, 0);
      assert.match(unknownFlag.stderr, /Unknown flag --emial for "hsapi owners list"/);
      assert.match(unknownFlag.stderr, /hsapi help owners list/);

      const badInteger = await run(['owners', 'list', '--limit', 'abc'], baseEnv);
      assert.notStrictEqual(badInteger.status, 0);
      assert.match(badInteger.stderr, /--limit expects an integer for "hsapi owners list"/);

      const missingValue = await run(['owners', 'list', '--email'], baseEnv);
      assert.notStrictEqual(missingValue.status, 0);
      assert.match(missingValue.stderr, /--email requires a value/);

      const badBoolean = await run(['crm', 'list', 'contacts', '--count-only', 'sometimes'], baseEnv);
      assert.notStrictEqual(badBoolean.status, 0);
      assert.match(badBoolean.stderr, /--count-only is a boolean flag/);

      // Catalog aliases pass validation (campaign-id aliases campaignGuid).
      const aliasOk = parseJsonOutput(await run(['marketing', 'campaigns', 'get', '--campaign-id', 'a1b2', '--show-request'], baseEnv));
      assert.strictEqual(aliasOk.ok, true);
      assert.strictEqual(aliasOk.showRequest, true);

      // Global output/budget flags are always allowed.
      const globalsOk = parseJsonOutput(await run(['owners', 'list', '--paginate', '--max-results', '5', '--show-request'], baseEnv));
      assert.strictEqual(globalsOk.showRequest, true);

      // HSAPI_FLAG_VALIDATION=0 bypasses validation.
      const bypass = parseJsonOutput(await run(['owners', 'list', '--emial', 'x', '--show-request'], {
        ...baseEnv,
        HSAPI_FLAG_VALIDATION: '0'
      }));
      assert.strictEqual(bypass.showRequest, true);
    }

    {
      // Issue #27 (phase 1): extracted modules load standalone without require cycles.
      for (const moduleName of ['runtime', 'flags', 'output', 'history', 'command-inputs', 'usage', 'catalog', 'auth']) {
        const exported = require(path.join(WORKSPACE_ROOT, 'src', `${moduleName}.js`));
        assert(exported && typeof exported === 'object' && Object.keys(exported).length > 0,
          `src/${moduleName}.js must export a non-empty object`);
      }
    }

    const visitorTokenHelp = parseJsonOutput(await run(['help', 'conversations', 'visitor-token'], baseEnv));
    assert.strictEqual(visitorTokenHelp.argsDocumented, true);
    assert(visitorTokenHelp.args.some((arg) => arg.name === 'yes' && arg.type === 'boolean'));

    const unknown = await run(['help', 'definitely', 'not-a-command'], baseEnv);
    assert.notStrictEqual(unknown.status, 0);
    assert.match(unknown.stderr, /No catalog command matches/);

    const fullUsageFallback = await run(['not-an-area', '--help'], baseEnv);
    assert.strictEqual(fullUsageFallback.status, 0);
    assert.match(fullUsageFallback.stdout, /^hsapi - portal-aware HubSpot API CLI/);

    const bareHelp = await run(['help'], baseEnv);
    assert.strictEqual(bareHelp.status, 0);
    assert.match(bareHelp.stdout, /^hsapi - portal-aware HubSpot API CLI/);

});

test('12 Issue #17 (slice 1): hsapi_command_help MCP tool', async () => {
    // Issue #17 (slice 1): hsapi_command_help MCP tool.
    const mcp = await runMcpConversation([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'hsapi-test-command-help', version: '0.0.0' }
        }
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hsapi_command_help', arguments: { command: 'crm search' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hsapi_command_help', arguments: { command: 'totally bogus' } } }
    ], baseEnv, 4);
    assert.strictEqual(mcp.stderr, '');
    const toolNames = mcp.responses[1].result.tools.map((tool) => tool.name);
    assert(toolNames.includes('hsapi_command_help'));

    const searchHelp = mcpStructuredContent(mcp.responses[2]);
    assert.strictEqual(searchHelp.endpointId, 'objects.search');
    assert.strictEqual(searchHelp.argsDocumented, true);
    assert(searchHelp.args.some((arg) => arg.name === 'search-body' && arg.type === 'json'));

    assert.strictEqual(mcp.responses[3].result.isError, true);
    const bogus = mcpStructuredContent(mcp.responses[3]);
    assert.strictEqual(bogus.ok, false);
    assert.match(bogus.error.message, /No catalog command matches/);

});

test('13 hsapi upgrade: git-checkout installs fast-forward to origin/main; tarball', async () => {
    // hsapi upgrade: git-checkout installs fast-forward to origin/main; tarball
    // installs get the release-download flow. Uses a local fixture origin.
    const { spawnSync } = require('child_process');
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir() };
    const git = (cwd, ...gitArgs) => {
      const result = spawnSync('git', ['-C', cwd, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...gitArgs], { encoding: 'utf8', env: gitEnv });
      assert.strictEqual(result.status, 0, `git ${gitArgs.join(' ')}: ${result.stderr}`);
      return String(result.stdout || '').trim();
    };
    const upgradeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsapi-upgrade-'));
    const originDir = path.join(upgradeDir, 'origin.git');
    const seedDir = path.join(upgradeDir, 'seed');
    const installDir = path.join(upgradeDir, 'install');
    fs.mkdirSync(originDir);
    fs.mkdirSync(seedDir);
    spawnSync('git', ['init', '--bare', '-b', 'main', originDir], { env: gitEnv });
    spawnSync('git', ['init', '-b', 'main', seedDir], { env: gitEnv });
    fs.writeFileSync(path.join(seedDir, 'package.json'), JSON.stringify({ name: 'hsapi-cli', version: '0.0.0-local' }));
    git(seedDir, 'add', '-A');
    git(seedDir, 'commit', '-m', 'v1');
    git(seedDir, 'remote', 'add', 'origin', originDir);
    git(seedDir, 'push', 'origin', 'main');
    spawnSync('git', ['clone', originDir, installDir], { env: gitEnv });

    // Advance origin by one commit.
    fs.writeFileSync(path.join(seedDir, 'CHANGES.md'), 'newer');
    git(seedDir, 'add', '-A');
    git(seedDir, 'commit', '-m', 'v2');
    git(seedDir, 'push', 'origin', 'main');

    const env = { ...baseEnv, HSAPI_UPGRADE_ROOT: installDir };
    const check = parseJsonOutput(await run(['upgrade', '--check'], env));
    assert.strictEqual(check.mode, 'git-checkout');
    assert.strictEqual(check.behind, 1);
    assert.strictEqual(check.upToDate, false);
    assert.match(check.action, /fast-forward/i);

    const upgraded = parseJsonOutput(await run(['upgrade'], env));
    assert.strictEqual(upgraded.mode, 'git-checkout');
    assert.strictEqual(upgraded.updatedCommitCount, 1);
    assert.match(upgraded.note, /Restart any running hsapi-mcp consumers/);

    const recheck = parseJsonOutput(await run(['upgrade', '--check'], env));
    assert.strictEqual(recheck.upToDate, true);
    assert.strictEqual(recheck.behind, 0);

    // Dirty checkout refuses to upgrade.
    fs.writeFileSync(path.join(seedDir, 'CHANGES.md'), 'even newer');
    git(seedDir, 'add', '-A');
    git(seedDir, 'commit', '-m', 'v3');
    git(seedDir, 'push', 'origin', 'main');
    fs.writeFileSync(path.join(installDir, 'package.json'), JSON.stringify({ name: 'hsapi-cli', version: 'dirty' }));
    const dirty = await run(['upgrade'], env);
    assert.notStrictEqual(dirty.status, 0);
    assert.match(dirty.stderr, /uncommitted changes/);

    // Non-checkout install: instructions instead of self-update.
    const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsapi-pkg-'));
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
      name: 'hsapi-cli',
      version: '0.1.0',
      repository: { type: 'git', url: 'git+https://github.com/chadmhohn/hsapi-cli.git' }
    }));
    const packageMode = parseJsonOutput(await run(['upgrade'], { ...baseEnv, HSAPI_UPGRADE_ROOT: packageDir }));
    assert.strictEqual(packageMode.mode, 'installed-package');
    assert.strictEqual(packageMode.repo, 'chadmhohn/hsapi-cli');
    assert(packageMode.commands[0].includes('gh release download --repo chadmhohn/hsapi-cli'));

});

test('14 Issue #25: executed mutations append to the local history log; reads and', async () => {
    // Issue #25: executed mutations append to the local history log; reads and
    // read-only POST search do not; hsapi history reads it back.
    const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsapi-history-'));
    const historyFile = path.join(historyDir, 'history.jsonl');
    const env = {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token',
      HSAPI_HISTORY: '1',
      HSAPI_HISTORY_FILE: historyFile
    };

    const update = await run(['crm', 'update', 'contacts', '101', '--properties', '{"firstname":"Ada"}', '--yes'], env);
    assert.strictEqual(update.status, 0, update.stderr || update.stdout);
    await run(['request', 'GET', '/crm/v3/owners'], env);
    await run(['crm', 'search', 'contacts', '--filter', 'email:HAS_PROPERTY'], env);

    const lines = fs.readFileSync(historyFile, 'utf8').split(/\r?\n/).filter(Boolean);
    assert.strictEqual(lines.length, 1, 'only the mutation should be recorded');
    const entry = JSON.parse(lines[0]);
    assert.strictEqual(entry.method, 'PATCH');
    assert.strictEqual(entry.portal, 'test');
    assert.strictEqual(entry.ok, true);
    assert(entry.url.includes('/crm/objects/2026-03/contacts/101'));
    const payloadIndex = entry.argv.indexOf('--properties') + 1;
    assert.match(entry.argv[payloadIndex], /^\[payload:\d+ chars\]$/, 'payload values must be redacted to lengths');

    const historyOutput = parseJsonOutput(await run(['history', '--since', '24h', '--limit', '10'], env));
    assert.strictEqual(historyOutput.ok, true);
    assert.strictEqual(historyOutput.returnedCount, 1);
    assert.strictEqual(historyOutput.entries[0].method, 'PATCH');

    const filtered = parseJsonOutput(await run(['history', '--portal', 'other'], env));
    assert.strictEqual(filtered.returnedCount, 0);

    const disabled = await run(['crm', 'update', 'contacts', '102', '--properties', '{"firstname":"Grace"}', '--yes'], { ...env, HSAPI_HISTORY: '0' });
    assert.strictEqual(disabled.status, 0, disabled.stderr || disabled.stdout);
    assert.strictEqual(fs.readFileSync(historyFile, 'utf8').split(/\r?\n/).filter(Boolean).length, 1, 'HSAPI_HISTORY=0 must disable recording');

});

test('15 Issue #21: crm search pagination via body.after, default 1000-result cap', async () => {
    // Issue #21: crm search pagination via body.after, default 1000-result cap
    // on --paginate, and --max-results 0 as explicit unlimited.
    const env = { ...baseEnv, HSAPI_TEST_TOKEN: 'profile-token' };

    const searchPaged = parseJsonOutput(await run(['crm', 'search', 'paged_targets', '--filter', 'email:HAS_PROPERTY', '--paginate'], env));
    assert.strictEqual(searchPaged.ok, true);
    assert.strictEqual(searchPaged.pageCount, 2);
    assert.strictEqual(searchPaged.resultCount, 3);
    assert.deepStrictEqual(searchPaged.results.map((record) => record.id), ['1', '2', '3']);
    assert.strictEqual(searchPaged.truncated, undefined);

    const searchCapped = parseJsonOutput(await run(['crm', 'search', 'paged_targets', '--filter', 'email:HAS_PROPERTY', '--paginate', '--max-results', '2'], env));
    assert.strictEqual(searchCapped.resultCount, 2);
    assert.strictEqual(searchCapped.truncated, true);
    assert.strictEqual(searchCapped.truncation.nextAfter, '2');

    const defaultCapped = parseJsonOutput(await run(['request', 'GET', '/crm/v3/bigpage', '--paginate'], env));
    assert.strictEqual(defaultCapped.resultCount, 1000);
    assert.strictEqual(defaultCapped.truncated, true);
    assert.strictEqual(defaultCapped.truncation.maxResults, 1000);
    assert.strictEqual(defaultCapped.truncation.defaultCap, true);
    assert.match(defaultCapped.truncation.note, /--max-results 0 for unlimited/);

    const unlimited = parseJsonOutput(await run(['request', 'GET', '/crm/v3/paged', '--paginate', '--max-results', '0'], env));
    assert.strictEqual(unlimited.resultCount, 2);
    assert.strictEqual(unlimited.pageCount, 2);
    assert.strictEqual(unlimited.truncated, undefined);

    {
      // Issue #21 (final slice): --paginate --format jsonl streams one record
      // per line page-by-page; stdout is pure JSONL, summary goes to stderr.
      const streamed = await run(['request', 'GET', '/crm/v3/paged', '--paginate', '--max-results', '0', '--format', 'jsonl'], env);
      assert.strictEqual(streamed.status, 0);
      const lines = streamed.stdout.split(/\r?\n/).filter(Boolean);
      assert.deepStrictEqual(lines.map((line) => JSON.parse(line).id), ['1', '2']);
      assert.match(streamed.stderr, /jsonl: streamed 2 record\(s\) over 2 page\(s\)/);

      const searchStreamed = await run(['crm', 'search', 'paged_targets', '--filter', 'email:HAS_PROPERTY', '--paginate', '--format', 'jsonl'], env);
      assert.strictEqual(searchStreamed.status, 0);
      const searchLines = searchStreamed.stdout.split(/\r?\n/).filter(Boolean);
      assert.deepStrictEqual(searchLines.map((line) => JSON.parse(line).id), ['1', '2', '3']);
      assert.match(searchStreamed.stderr, /jsonl: streamed 3 record\(s\) over 2 page\(s\)/);

      const cappedStream = await run(['crm', 'search', 'paged_targets', '--filter', 'email:HAS_PROPERTY', '--paginate', '--max-results', '2', '--format', 'jsonl'], env);
      assert.strictEqual(cappedStream.status, 0);
      const cappedLines = cappedStream.stdout.split(/\r?\n/).filter(Boolean);
      assert.deepStrictEqual(cappedLines.map((line) => JSON.parse(line).id), ['1', '2']);
      assert.match(cappedStream.stderr, /stopped at --max-results 2/);

      const withoutPaginate = await run(['request', 'GET', '/crm/v3/paged', '--format', 'jsonl'], env);
      assert.notStrictEqual(withoutPaginate.status, 0);
      assert.match(withoutPaginate.stderr, /--format jsonl is a streaming mode for --paginate/);

      const withSelect = await run(['request', 'GET', '/crm/v3/paged', '--paginate', '--format', 'jsonl', '--select', 'data.results[].id'], env);
      assert.notStrictEqual(withSelect.status, 0);
      assert.match(withSelect.stderr, /cannot be combined with --select/);
    }

});

test('16 Issue #23: @- reads stdin; batch --inputs accepts JSONL', async () => {
    // Issue #23: @- reads stdin; batch --inputs accepts JSONL.
    const env = { ...baseEnv, HSAPI_TEST_TOKEN: 'profile-token' };

    const jsonlStdin = await runWithInput(
      ['crm', 'batch-update', 'contacts', '--inputs', '@-', '--show-request'],
      env,
      '{"id":"101","properties":{"firstname":"Ada"}}\n{"id":"102","properties":{"firstname":"Grace"}}\n'
    );
    assert.strictEqual(jsonlStdin.status, 0, jsonlStdin.stderr || jsonlStdin.stdout);
    const jsonlPreview = JSON.parse(jsonlStdin.stdout);
    assert.strictEqual(jsonlPreview.showRequest, true);
    assert.strictEqual(jsonlPreview.request.body.inputs.length, 2);
    assert.strictEqual(jsonlPreview.request.body.inputs[1].id, '102');

    const arrayStdin = await runWithInput(
      ['crm', 'create', 'contacts', '--properties', '@-', '--show-request'],
      env,
      '{"email":"stdin@example.com"}'
    );
    assert.strictEqual(arrayStdin.status, 0, arrayStdin.stderr || arrayStdin.stdout);
    assert.strictEqual(JSON.parse(arrayStdin.stdout).request.body.properties.email, 'stdin@example.com');

    const jsonlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsapi-jsonl-'));
    const jsonlFile = path.join(jsonlDir, 'inputs.jsonl');
    fs.writeFileSync(jsonlFile, '{"id":"201","properties":{"city":"Denver"}}\n{"id":"202","properties":{"city":"Boise"}}\n');
    const jsonlFromFile = parseJsonOutput(await run(['crm', 'batch-update', 'contacts', '--inputs', `@${jsonlFile}`, '--show-request'], env));
    assert.strictEqual(jsonlFromFile.request.body.inputs.length, 2);
    assert.strictEqual(jsonlFromFile.request.body.inputs[0].id, '201');

    fs.writeFileSync(path.join(jsonlDir, 'bad.jsonl'), '{"id":"301"}\nnot json\n');
    const badJsonl = await run(['crm', 'batch-update', 'contacts', '--inputs', '@' + path.join(jsonlDir, 'bad.jsonl'), '--show-request'], env);
    assert.notStrictEqual(badJsonl.status, 0);
    assert.match(badJsonl.stderr, /line 2 is not valid JSON/);

});

test('17 Issue #18: packaged context docs are reachable through MCP', async () => {
    // Issue #18: packaged context docs are reachable through MCP.
    const mcp = await runMcpConversation([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'hsapi-test-context-docs', version: '0.0.0' }
        }
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hsapi_context_doc', arguments: {} } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hsapi_context_doc', arguments: { name: 'crm-records' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hsapi_context_doc', arguments: { name: 'docs/hubspot-api-context/associations.md', maxChars: 1000 } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'hsapi_context_doc', arguments: { name: '../../package.json' } } }
    ], baseEnv, 5);
    assert.strictEqual(mcp.stderr, '');

    const listing = mcpStructuredContent(mcp.responses[1]);
    assert.strictEqual(listing.ok, true);
    assert(listing.docs.some((doc) => doc.name === 'crm-records'));
    assert(listing.docs.every((doc) => doc.path.startsWith('docs/hubspot-api-context/')));

    const crmRecords = mcpStructuredContent(mcp.responses[2]);
    assert.strictEqual(crmRecords.ok, true);
    assert.strictEqual(crmRecords.name, 'crm-records');
    assert(crmRecords.markdown.length > 100);

    const associations = mcpStructuredContent(mcp.responses[3]);
    assert.strictEqual(associations.ok, true);
    assert.strictEqual(associations.name, 'associations');
    assert(associations.markdown.length <= 1000 + 20);

    const traversal = mcpStructuredContent(mcp.responses[4]);
    assert.strictEqual(traversal.ok, false);
    assert.strictEqual(traversal.error.code, 'unknown_context_doc');

});

test('18 Issue #20: mutations and showRequest keep the preview-first flow; safe', async () => {
    // Issue #20: mutations and showRequest keep the preview-first flow; safe
    // reads (typed command or generic request) run once with no preview.
    const mcp = await runMcpConversation([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'hsapi-test-single-run', version: '0.0.0' }
        }
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'hsapi_request_execute',
          arguments: { portal: 'test', method: 'GET', path: '/crm/v3/owners', maxResults: 2 }
        }
      },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'hsapi_request_execute',
          arguments: { portal: 'test', method: 'GET', path: '/crm/v3/owners', showRequest: true }
        }
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'hsapi_command_execute',
          arguments: { portal: 'test', argv: ['crm', 'create', 'contacts', '--properties', '{"email":"x@example.com"}'] }
        }
      }
    ], { ...baseEnv, HSAPI_TEST_TOKEN: 'mcp-token' }, 4);
    assert.strictEqual(mcp.stderr, '');

    const ownersRead = mcpStructuredContent(mcp.responses[1]);
    assert.strictEqual(ownersRead.ok, true);
    assert.strictEqual(ownersRead.executed, true);
    assert.strictEqual(ownersRead.preview, undefined);
    assert.strictEqual(ownersRead.safety.endpointId, 'owners.list');
    assert.strictEqual(ownersRead.safety.catalogBacked, true);

    const ownersPreview = mcpStructuredContent(mcp.responses[2]);
    assert.strictEqual(ownersPreview.executed, false);
    assert.strictEqual(ownersPreview.safety.showRequest, true);
    assert(ownersPreview.preview, 'showRequest must still return the full preview');

    const blockedMutation = mcpStructuredContent(mcp.responses[3]);
    assert.strictEqual(blockedMutation.blocked, true);
    assert.strictEqual(blockedMutation.error.code, 'mutation_blocked');
    assert(blockedMutation.preview, 'blocked mutations must still include the preview');

});

test('19 Issue #19: tool annotations + initialize instructions for modern MCP clients', async () => {
    // Issue #19: tool annotations + initialize instructions for modern MCP clients.
    const mcp = await runMcpConversation([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'hsapi-test-annotations', version: '0.0.0' }
        }
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' }
    ], baseEnv, 2);
    assert.strictEqual(mcp.stderr, '');
    assert.strictEqual(typeof mcp.responses[0].result.instructions, 'string');
    assert(mcp.responses[0].result.instructions.includes('confirmMutation'));

    const tools = mcp.responses[1].result.tools;
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    for (const readTool of ['hsapi_profiles_list', 'hsapi_catalog_coverage', 'hsapi_catalog_commands', 'hsapi_auth_doctor']) {
      assert.strictEqual(byName[readTool].annotations.readOnlyHint, true, readTool);
      assert.strictEqual(byName[readTool].annotations.openWorldHint, false, readTool);
    }
    for (const executeTool of ['hsapi_command_execute', 'hsapi_request_execute']) {
      assert.strictEqual(byName[executeTool].annotations.readOnlyHint, false, executeTool);
      assert.strictEqual(byName[executeTool].annotations.destructiveHint, true, executeTool);
      assert.strictEqual(byName[executeTool].annotations.openWorldHint, true, executeTool);
    }

});

test('20 Issue #22: catalog read-only POSTs (CRM search) retry transient 429s like', async () => {
    // Issue #22: catalog read-only POSTs (CRM search) retry transient 429s like
    // safe GETs do; mutating POSTs never retry.
    const env = { ...baseEnv, HSAPI_TEST_TOKEN: 'profile-token' };
    const searchKey = 'POST /crm/objects/2026-03/retry_targets/search';
    const searchBefore = routeCounts[searchKey] || 0;
    const searchResult = parseJsonOutput(await run(['crm', 'search', 'retry_targets', '--filter', 'email:HAS_PROPERTY'], env));
    assert.strictEqual(searchResult.ok, true);
    assert.strictEqual((routeCounts[searchKey] || 0) - searchBefore, 2, 'read-only POST search should retry one transient 429');

    const createKey = 'POST /crm/objects/2026-03/retry_targets';
    const createBefore = routeCounts[createKey] || 0;
    const createResult = await run(['crm', 'create', 'retry_targets', '--properties', '{"email":"x@example.com"}', '--yes'], env);
    assert.notStrictEqual(createResult.status, 0);
    assert.strictEqual((routeCounts[createKey] || 0) - createBefore, 1, 'mutating POST must never retry');

});

test('21 Issue #13: filter mini-language - IN/NOT_IN (values array), BETWEEN', async () => {
    // Issue #13: filter mini-language - IN/NOT_IN (values array), BETWEEN
    // (value+highValue), HAS_PROPERTY/NOT_HAS_PROPERTY (no value), OR groups
    // via --filter-group, and --search-body as the full-JSON escape hatch.
    const env = { ...baseEnv, HSAPI_TEST_TOKEN: 'profile-token' };

    const inPreview = await expectShowRequest(['crm', 'search', 'deals', '--filter', 'dealstage:IN:closedwon,closedlost'], env, {
      requests,
      method: 'POST',
      pathname: '/crm/objects/2026-03/deals/search'
    });
    assert.deepStrictEqual(inPreview.request.body.filterGroups, [{
      filters: [{ propertyName: 'dealstage', operator: 'IN', values: ['closedwon', 'closedlost'] }]
    }]);

    const betweenPreview = await expectShowRequest(['crm', 'search', 'deals', '--filter', 'amount:BETWEEN:100:5000'], env, {
      requests,
      method: 'POST',
      pathname: '/crm/objects/2026-03/deals/search'
    });
    assert.deepStrictEqual(betweenPreview.request.body.filterGroups, [{
      filters: [{ propertyName: 'amount', operator: 'BETWEEN', value: '100', highValue: '5000' }]
    }]);

    const hasPropertyPreview = await expectShowRequest(['crm', 'search', 'contacts', '--filter', 'email:HAS_PROPERTY'], env, {
      requests,
      method: 'POST',
      pathname: '/crm/objects/2026-03/contacts/search'
    });
    assert.deepStrictEqual(hasPropertyPreview.request.body.filterGroups, [{
      filters: [{ propertyName: 'email', operator: 'HAS_PROPERTY' }]
    }]);

    const orGroupsPreview = await expectShowRequest([
      'crm', 'search', 'contacts',
      '--filter-group', 'lifecyclestage:EQ:customer;hs_lead_status:EQ:OPEN',
      '--filter-group', 'email:NOT_HAS_PROPERTY'
    ], env, {
      requests,
      method: 'POST',
      pathname: '/crm/objects/2026-03/contacts/search'
    });
    assert.deepStrictEqual(orGroupsPreview.request.body.filterGroups, [
      {
        filters: [
          { propertyName: 'lifecyclestage', operator: 'EQ', value: 'customer' },
          { propertyName: 'hs_lead_status', operator: 'EQ', value: 'OPEN' }
        ]
      },
      { filters: [{ propertyName: 'email', operator: 'NOT_HAS_PROPERTY' }] }
    ]);

    const searchBodyPreview = await expectShowRequest([
      'crm', 'search', 'contacts',
      '--search-body', '{"filterGroups":[{"filters":[{"propertyName":"email","operator":"EQ","value":"ada@example.com"}]}],"properties":["email"]}',
      '--limit', '3'
    ], env, {
      requests,
      method: 'POST',
      pathname: '/crm/objects/2026-03/contacts/search'
    });
    assert.deepStrictEqual(searchBodyPreview.request.body.properties, ['email']);
    assert.strictEqual(searchBodyPreview.request.body.limit, 3);

    // Executed path: IN filter against the mock search route still round-trips.
    const inExecuted = parseJsonOutput(await run(['crm', 'search', 'contacts', '--filter', 'email:IN:ada@example.com,grace@example.com', '--limit', '1'], env));
    assert.strictEqual(inExecuted.ok, true);
    const inRequestBody = JSON.parse(requests.at(-1).body);
    assert.deepStrictEqual(inRequestBody.filterGroups[0].filters[0].values, ['ada@example.com', 'grace@example.com']);

    // Operator case is normalized.
    const lowercasePreview = await expectShowRequest(['crm', 'search', 'contacts', '--filter', 'email:eq:ada@example.com'], env, {
      requests,
      method: 'POST',
      pathname: '/crm/objects/2026-03/contacts/search'
    });
    assert.strictEqual(lowercasePreview.request.body.filterGroups[0].filters[0].operator, 'EQ');

    // Failure modes.
    const hasPropertyWithValue = await run(['crm', 'search', 'contacts', '--filter', 'email:HAS_PROPERTY:x'], env);
    assert.notStrictEqual(hasPropertyWithValue.status, 0);
    assert.match(hasPropertyWithValue.stderr, /takes no value/);

    const betweenWrongArity = await run(['crm', 'search', 'deals', '--filter', 'amount:BETWEEN:100'], env);
    assert.notStrictEqual(betweenWrongArity.status, 0);
    assert.match(betweenWrongArity.stderr, /BETWEEN requires exactly two values/);

    const mixedFilterForms = await run(['crm', 'search', 'contacts', '--filter', 'email:HAS_PROPERTY', '--filter-group', 'email:HAS_PROPERTY'], env);
    assert.notStrictEqual(mixedFilterForms.status, 0);
    assert.match(mixedFilterForms.stderr, /--filter or --filter-group, not both/);

    const emptyIn = await run(['crm', 'search', 'contacts', '--filter', 'email:IN:'], env);
    assert.notStrictEqual(emptyIn.status, 0);
    assert.match(emptyIn.stderr, /requires a value|at least one comma-separated value/);

    // count/exists keep working with the new parser (single-group summary stays flat).
    const countOutput = parseJsonOutput(await run(['crm', 'count', 'contacts', '--filter', 'email:HAS_PROPERTY'], env));
    assert.strictEqual(countOutput.ok, true);
    assert.deepStrictEqual(countOutput.filters, ['email:HAS_PROPERTY']);

});

test('22 Issue #12: typed owners commands, catalog-backed (so MCP generic requests', async () => {
    // Issue #12: typed owners commands, catalog-backed (so MCP generic requests
    // against /crm/v3/owners stop being blocked as not_catalog_backed).
    const ownersList = parseJsonOutput(await run(['owners', 'list', '--limit', '2'], { ...baseEnv, HSAPI_TEST_TOKEN: 'profile-token' }));
    assert.strictEqual(ownersList.ok, true);
    assert.strictEqual(ownersList.data.results.length, 2);
    const ownersListRequest = requests.at(-1);
    assert(ownersListRequest.url.startsWith('/crm/v3/owners?'), ownersListRequest.url);
    assert(ownersListRequest.url.includes('limit=2'), ownersListRequest.url);

    await expectShowRequest(['owners', 'list', '--email', 'ada@example.com', '--archived'], { ...baseEnv, HSAPI_TEST_TOKEN: 'profile-token' }, {
      requests,
      method: 'GET',
      pathname: '/crm/v3/owners',
      endpointId: 'owners.list'
    });

    await expectShowRequest(['owners', 'get', 'owner-1'], { ...baseEnv, HSAPI_TEST_TOKEN: 'profile-token' }, {
      requests,
      method: 'GET',
      pathname: '/crm/v3/owners/owner-1',
      endpointId: 'owners.get'
    });

    const ownerByUserId = await expectShowRequest(['owners', 'get', '42', '--id-property', 'userId'], { ...baseEnv, HSAPI_TEST_TOKEN: 'profile-token' }, {
      requests,
      method: 'GET',
      pathname: '/crm/v3/owners/42',
      endpointId: 'owners.get'
    });
    assert.strictEqual(ownerByUserId.request.query.idProperty, 'userId');

    // The generic request path now resolves the catalog endpoint too.
    const genericOwners = await expectShowRequest(['request', 'GET', '/crm/v3/owners'], { ...baseEnv, HSAPI_TEST_TOKEN: 'profile-token' }, {
      requests,
      method: 'GET',
      pathname: '/crm/v3/owners',
      endpointId: 'owners.list'
    });
    assert.strictEqual(genericOwners.endpoint.risk, 'read');

});

test('23 Issue #14: endpoints whose purpose is returning a client-facing token', async () => {
    // Issue #14: endpoints whose purpose is returning a client-facing token
    // (visitor identification) must not have that token redacted by the MCP layer.
    const mcp = await runMcpConversation([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'hsapi-test-visitor-token', version: '0.0.0' }
        }
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'hsapi_command_execute',
          arguments: {
            portal: 'test',
            argv: ['conversations', 'visitor-token', '--email', 'ada@example.com', '--first-name', 'Ada'],
            confirmMutation: true
          }
        }
      },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'hsapi_command_execute',
          arguments: {
            portal: 'test',
            argv: ['crm', 'list', 'contacts'],
            maxResults: 1
          }
        }
      }
    ], { ...baseEnv, HSAPI_TEST_TOKEN: 'mcp-token' }, 3);
    assert.strictEqual(mcp.stderr, '');

    const visitorToken = mcpStructuredContent(mcp.responses[1]);
    assert.strictEqual(visitorToken.ok, true, JSON.stringify(visitorToken));
    assert.strictEqual(visitorToken.executed, true);
    assert.strictEqual(visitorToken.safety.endpointId, 'conversations.visitor_token');
    assert.strictEqual(visitorToken.result.data.token, 'visitor-token-fixture-value',
      'intended-credential endpoint output must not be redacted');
    assert(!JSON.stringify(visitorToken).includes('mcp-token'),
      'portal bearer token must still never appear');

    const normalRead = mcpStructuredContent(mcp.responses[2]);
    assert.strictEqual(normalRead.ok, true);
    assert.strictEqual(normalRead.executed, true);
    assert(!JSON.stringify(normalRead).includes('mcp-token'),
      'non-exempt responses keep full redaction');

});

test('24 Issue #15: regression coverage for the MCP request-body double-encoding fix', async () => {
    // Issue #15: regression coverage for the MCP request-body double-encoding fix
    // (2ac3582). The HTTP body HubSpot receives must be the JSON object form whether
    // the MCP client passes body as an object or as a JSON-encoded string, and an
    // unparseable string body must error without sending any request.
    const before = requests.length;
    const searchBody = { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: 'ada@example.com' }] }], limit: 1 };
    const mcp = await runMcpConversation([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'hsapi-test-body-encoding', version: '0.0.0' }
        }
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'hsapi_request_execute',
          arguments: {
            portal: 'test',
            method: 'POST',
            path: '/crm/objects/2026-03/contacts/search',
            body: searchBody,
            readOnly: true
          }
        }
      },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'hsapi_request_execute',
          arguments: {
            portal: 'test',
            method: 'POST',
            path: '/crm/objects/2026-03/contacts/search',
            body: JSON.stringify(searchBody),
            readOnly: true
          }
        }
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'hsapi_request_execute',
          arguments: {
            portal: 'test',
            method: 'POST',
            path: '/crm/objects/2026-03/contacts/search',
            body: 'not json {',
            readOnly: true
          }
        }
      }
    ], { ...baseEnv, HSAPI_TEST_TOKEN: 'mcp-token' }, 4);
    assert.strictEqual(mcp.stderr, '');

    const objectBodyExecuted = mcpStructuredContent(mcp.responses[1]);
    assert.strictEqual(objectBodyExecuted.ok, true, JSON.stringify(objectBodyExecuted));
    assert.strictEqual(objectBodyExecuted.executed, true);

    const stringBodyExecuted = mcpStructuredContent(mcp.responses[2]);
    assert.strictEqual(stringBodyExecuted.ok, true, JSON.stringify(stringBodyExecuted));
    assert.strictEqual(stringBodyExecuted.executed, true);

    const invalidBody = mcpStructuredContent(mcp.responses[3]);
    assert.strictEqual(invalidBody.ok, false);
    assert(/body must be a JSON value/i.test(invalidBody.error.message), invalidBody.error.message);

    const searchRequests = requests.slice(before).filter((request) => request.url.startsWith('/crm/objects/2026-03/contacts/search'));
    assert.strictEqual(searchRequests.length, 2, 'invalid string body must not reach HubSpot');
    for (const request of searchRequests) {
      const received = JSON.parse(request.body);
      assert.deepStrictEqual(received, searchBody, 'HTTP body must be the JSON object form, not a double-encoded string');
    }

});

test('25 block (9)', async () => {
    const before = requests.length;
    const output = parseJsonOutput(await run(['account', 'details', '--show-request'], {
      ...baseEnv,
      HSAPI_PORTALS_CONFIG: explicitPortalBearerConfig,
      HSAPI_TEST_EXPLICIT_TOKEN: 'explicit-token'
    }));
    assert.strictEqual(output.showRequest, true);
    assert.strictEqual(output.portal.tokenEnv, 'HSAPI_TEST_EXPLICIT_TOKEN');
    assert.strictEqual(output.request.headers.Authorization, 'Bearer $HSAPI_TEST_EXPLICIT_TOKEN');
    assert.strictEqual(output.authFamily, AUTH_FAMILIES.PORTAL_BEARER);
    assert.strictEqual(output.auth.credentialSource.name, 'HSAPI_TEST_EXPLICIT_TOKEN');
    assert.strictEqual(output.auth.credentialSource.profileField, 'auth.portalBearer.tokenEnv');
    assert.strictEqual(output.auth.credentialSource.provenance, 'explicit_profile');
    assert.strictEqual(output.auth.credentialSource.kind, 'private_app');
    assert(!JSON.stringify(output).includes('explicit-token'), '--show-request must not print token values');
    assert.strictEqual(requests.length, before, 'explicit portal bearer --show-request must not make a network request');

});

test('26 block (10)', async () => {
    const before = requests.length;
    const result = await run(['account', 'details'], {
      ...baseEnv,
      HSAPI_PORTALS_CONFIG: explicitPortalBearerConfig
    });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /Missing HubSpot token\. Set HSAPI_TEST_EXPLICIT_TOKEN/);
    assert.strictEqual(requests.length, before, 'missing explicit portal bearer env must fail before request execution');

});

test('27 block (11)', async () => {
    const result = await run(['request', 'GET', '/crm/v3/owners'], {
      ...baseEnv,
      HSAPI_PORTALS_CONFIG: explicitPortalBearerConfig,
      HSAPI_TEST_EXPLICIT_TOKEN: 'explicit-token'
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.strictEqual(requests.at(-1).headers.authorization, 'Bearer explicit-token');

});

test('28 api.hubapi.com/crm/v3/owners\'], {', async () => {
    const before = requests.length;
    const result = await run(['request', 'GET', 'https://api.hubapi.com/crm/v3/owners'], {
      ...baseEnv,
      HSAPI_PORTALS_CONFIG: explicitPortalBearerConfig,
      HSAPI_TEST_EXPLICIT_TOKEN: 'explicit-token'
    });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to send HubSpot token to non-HubSpot\/API origin/);
    assert.strictEqual(requests.length, before, 'mismatched absolute URL must not make a network request');

});

test('29 block (12)', async () => {
    const doctorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsapi-doctor-'));
    const doctorConfig = writeTempConfig(baseUrl, {
      tokenEnv: null,
      auth: {
        defaultFamily: AUTH_FAMILIES.PORTAL_BEARER,
        portalBearer: {
          tokenEnv: 'HSAPI_DOCTOR_PORTAL_TOKEN',
          kind: 'private_app'
        },
        oauth: {
          clientIdEnv: 'HSAPI_DOCTOR_OAUTH_CLIENT_ID',
          clientSecretEnv: 'HSAPI_DOCTOR_OAUTH_CLIENT_SECRET',
          refreshTokenEnv: 'HSAPI_DOCTOR_OAUTH_REFRESH_TOKEN',
          tokenCachePath: path.join(doctorDir, 'oauth-cache.json')
        },
        developer: {
          personalAccessKeyEnv: 'HSAPI_DOCTOR_PERSONAL_ACCESS_KEY',
          developerApiKeyEnv: 'HSAPI_DOCTOR_DEVELOPER_API_KEY',
          appIdEnv: 'HSAPI_DOCTOR_APP_ID',
          clientIdEnv: 'HSAPI_DOCTOR_DEVELOPER_CLIENT_ID',
          clientSecretEnv: 'HSAPI_DOCTOR_DEVELOPER_CLIENT_SECRET',
          tokenCachePath: path.join(doctorDir, 'developer-cache.json')
        }
      }
    });
    const doctorEnv = {
      ...baseEnv,
      HSAPI_PORTALS_CONFIG: doctorConfig,
      HSAPI_DOCTOR_PORTAL_TOKEN: 'doctor-portal-token',
      HSAPI_DOCTOR_OAUTH_CLIENT_ID: 'doctor-oauth-client-id',
      HSAPI_DOCTOR_OAUTH_CLIENT_SECRET: 'doctor-oauth-client-secret',
      HSAPI_DOCTOR_OAUTH_REFRESH_TOKEN: 'doctor-oauth-refresh-token',
      HSAPI_DOCTOR_PERSONAL_ACCESS_KEY: 'doctor-personal-access-key',
      HSAPI_DOCTOR_DEVELOPER_API_KEY: 'doctor-developer-api-key',
      HSAPI_DOCTOR_APP_ID: 'doctor-app-id',
      HSAPI_DOCTOR_DEVELOPER_CLIENT_ID: 'doctor-developer-client-id',
      HSAPI_DOCTOR_DEVELOPER_CLIENT_SECRET: 'doctor-developer-client-secret'
    };
    const before = requests.length;
    const output = parseJsonOutput(await run(['auth', 'doctor', '--portal', 'test', '--require-env'], doctorEnv));
    assert.strictEqual(output.ok, true);
    assert.strictEqual(output.ready, true);
    assert.deepStrictEqual(output.profiles[0].authFamilies, [
      AUTH_FAMILIES.PORTAL_BEARER,
      AUTH_FAMILIES.OAUTH,
      AUTH_FAMILIES.DEVELOPER
    ]);
    assert(output.profiles[0].checks.some((check) => check.id === 'token_cache.paths.separate' && check.status === 'pass'));
    assert.strictEqual(requests.length, before, 'auth doctor must not make a network request');
    const serialized = JSON.stringify(output);
    assert(!serialized.includes('doctor-portal-token'), 'auth doctor must not print portal token values');
    assert(!serialized.includes('doctor-oauth-client-secret'), 'auth doctor must not print OAuth client secret values');
    assert(!serialized.includes('doctor-personal-access-key'), 'auth doctor must not print developer credential values');

    const missingDoctorEnv = {
      ...baseEnv,
      HSAPI_PORTALS_CONFIG: doctorConfig,
      HSAPI_DOCTOR_PORTAL_TOKEN: '',
      HSAPI_DOCTOR_OAUTH_CLIENT_ID: '',
      HSAPI_DOCTOR_OAUTH_CLIENT_SECRET: '',
      HSAPI_DOCTOR_OAUTH_REFRESH_TOKEN: '',
      HSAPI_DOCTOR_PERSONAL_ACCESS_KEY: '',
      HSAPI_DOCTOR_DEVELOPER_API_KEY: '',
      HSAPI_DOCTOR_APP_ID: '',
      HSAPI_DOCTOR_DEVELOPER_CLIENT_ID: '',
      HSAPI_DOCTOR_DEVELOPER_CLIENT_SECRET: ''
    };
    const warningOutput = parseJsonOutput(await run(['auth', 'doctor', '--portal', 'test'], missingDoctorEnv));
    assert.strictEqual(warningOutput.ok, true);
    assert.strictEqual(warningOutput.ready, false);
    assert(warningOutput.summary.warn > 0, 'auth doctor should warn on missing env vars by default');

    const requiredEnvResult = await run(['auth', 'doctor', '--portal', 'test', '--require-env'], missingDoctorEnv);
    assert.notStrictEqual(requiredEnvResult.status, 0);
    const requiredEnvOutput = parseJsonOutput(requiredEnvResult);
    assert.strictEqual(requiredEnvOutput.ok, false);
    assert(requiredEnvOutput.summary.fail > 0, 'auth doctor --require-env should fail on missing env vars');

});

test('30 block (13)', async () => {
    const before = requests.length;
    const output = parseJsonOutput(await run(['webhooks', 'settings', '12345', '--show-request'], {
      ...baseEnv,
      HSAPI_PORTALS_CONFIG: developerOnlyConfig,
      HSAPI_DEVELOPER_API_KEY: ''
    }));
    assert.strictEqual(output.showRequest, true);
    assert.strictEqual(output.authFamily, AUTH_FAMILIES.DEVELOPER);
    assert.strictEqual(output.authSubtype, DEVELOPER_AUTH_SUBTYPES.DEVELOPER_API_KEY);
    assert.strictEqual(output.auth.subtype, DEVELOPER_AUTH_SUBTYPES.DEVELOPER_API_KEY);
    assert.strictEqual(output.auth.credentialSource.type, DEVELOPER_AUTH_SUBTYPES.DEVELOPER_API_KEY);
    assert.strictEqual(output.auth.credentialSource.name, 'HSAPI_DEVELOPER_API_KEY');
    assert.strictEqual(output.auth.credentialSource.queryParams.hapikey.name, 'HSAPI_DEVELOPER_API_KEY');
    assert.strictEqual(output.request.query.hapikey, '$HSAPI_DEVELOPER_API_KEY');
    assert.strictEqual(output.request.url, `${baseUrl}/webhooks/2026-03/12345/settings?hapikey=REDACTED`);
    assert(!Object.prototype.hasOwnProperty.call(output.request.headers, 'Authorization'), 'developer API key preview must not use a bearer header');
    assert.strictEqual(requests.length, before, 'developer API key --show-request must not call network');

});

test('31 block (14)', async () => {
    const before = requests.length;
    const result = await run(['webhooks', 'settings', '12345'], {
      ...baseEnv,
      HSAPI_PORTALS_CONFIG: developerOnlyConfig,
      HSAPI_DEVELOPER_API_KEY: ''
    });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /Missing HubSpot developer API key\. Set HSAPI_DEVELOPER_API_KEY/);
    assert.strictEqual(requests.length, before, 'missing developer API key env must fail before request execution');

});

test('32 block (15)', async () => {
    const before = requests.length;
    const result = await run(['webhooks', 'settings', '12345'], {
      ...baseEnv,
      HSAPI_PORTALS_CONFIG: developerOnlyConfig,
      HSAPI_DEVELOPER_API_KEY: 'developer-key'
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.strictEqual(requests.length, before + 1);
    const request = requests.at(-1);
    const url = new URL(request.url, baseUrl);
    assert.strictEqual(url.pathname, '/webhooks/2026-03/12345/settings');
    assert.strictEqual(url.searchParams.get('hapikey'), 'developer-key');
    assert(!Object.prototype.hasOwnProperty.call(request.headers, 'authorization'), 'developer API key endpoints must not send portal bearer headers');
    assert(!result.stdout.includes('developer-key'), 'developer API key must not appear in command output');

});

test('33 block (16)', async () => {
    const before = requests.length;
    const result = await run(['webhooks', 'settings'], {
      ...baseEnv,
      HSAPI_PORTALS_CONFIG: developerOnlyConfig,
      HSAPI_DEVELOPER_API_KEY: 'developer-key'
    });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /webhooks requires <appId> or --app-id/);
    assert.strictEqual(requests.length, before, 'missing appId must fail before request execution');

});

test('34 block (17)', async () => {
    const developerAppIdCatalog = writeTempCatalog((catalog) => {
      catalog.endpoints.find((endpoint) => endpoint.name === 'account.details').auth = {
        family: AUTH_FAMILIES.DEVELOPER,
        subtype: DEVELOPER_AUTH_SUBTYPES.DEVELOPER_API_KEY,
        fallback: 'none',
        queryParams: ['hapikey', 'appId']
      };
    });
    const missingAppIdConfig = writeTempConfig(baseUrl, {
      tokenEnv: null,
      auth: {
        developer: {
          developerApiKeyEnv: 'HSAPI_DEVELOPER_API_KEY'
        }
      }
    });
    const before = requests.length;
    const result = await run(['account', 'details'], {
      ...baseEnv,
      HSAPI_PORTALS_CONFIG: missingAppIdConfig,
      HSAPI_CATALOG_FILE: developerAppIdCatalog,
      HSAPI_DEVELOPER_API_KEY: 'developer-key'
    });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /auth\.developer\.appIdEnv/);
    assert.strictEqual(requests.length, before, 'missing appId env metadata must fail before request execution');

});

test('35 block (18)', async () => {
    const personalAccessCatalog = writeTempCatalog((catalog) => {
      catalog.endpoints.find((endpoint) => endpoint.name === 'account.details').auth = {
        family: AUTH_FAMILIES.DEVELOPER,
        subtype: DEVELOPER_AUTH_SUBTYPES.PERSONAL_ACCESS_KEY,
        fallback: 'none'
      };
    });
    const before = requests.length;
    const output = parseJsonOutput(await run(['account', 'details', '--show-request'], {
      ...baseEnv,
      HSAPI_PORTALS_CONFIG: developerOnlyConfig,
      HSAPI_CATALOG_FILE: personalAccessCatalog
    }));
    assert.strictEqual(output.authFamily, AUTH_FAMILIES.DEVELOPER);
    assert.strictEqual(output.authSubtype, DEVELOPER_AUTH_SUBTYPES.PERSONAL_ACCESS_KEY);
    assert.strictEqual(output.request.headers.Authorization, 'Bearer $HSAPI_PERSONAL_ACCESS_KEY');
    assert.strictEqual(output.auth.credentialSource.name, 'HSAPI_PERSONAL_ACCESS_KEY');
    assert.strictEqual(requests.length, before, 'personal access key --show-request must not call network');

    const missing = await run(['account', 'details'], {
      ...baseEnv,
      HSAPI_PORTALS_CONFIG: developerOnlyConfig,
      HSAPI_CATALOG_FILE: personalAccessCatalog,
      HSAPI_PERSONAL_ACCESS_KEY: ''
    });
    assert.notStrictEqual(missing.status, 0);
    assert.match(missing.stderr, /Missing HubSpot personal access key\. Set HSAPI_PERSONAL_ACCESS_KEY/);
    assert.strictEqual(requests.length, before, 'missing personal access key env must fail before request execution');

    const result = await run(['account', 'details'], {
      ...baseEnv,
      HSAPI_PORTALS_CONFIG: developerOnlyConfig,
      HSAPI_CATALOG_FILE: personalAccessCatalog,
      HSAPI_PERSONAL_ACCESS_KEY: 'personal-access-key'
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.strictEqual(requests.at(-1).headers.authorization, 'Bearer personal-access-key');
    assert(!result.stdout.includes('personal-access-key'), 'personal access key must not appear in command output');

});

test('36 block (19)', async () => {
    const before = requests.length;
    const result = await run(['account', 'details'], {
      ...baseEnv,
      HSAPI_PORTALS_CONFIG: developerOnlyConfig,
      HSAPI_DEVELOPER_API_KEY: 'developer-key',
      HSAPI_PERSONAL_ACCESS_KEY: 'personal-access-key'
    });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /missing auth\.portalBearer\.tokenEnv or legacy tokenEnv/);
    assert.strictEqual(requests.length, before, 'developer credentials must never satisfy portal-bearer endpoints');

});

test('37 block (20)', async () => {
    const mixedAuthConfig = writeTempConfig(baseUrl, {
      tokenEnv: null,
      auth: {
        portalBearer: {
          tokenEnv: 'HSAPI_TEST_MIXED_PORTAL_TOKEN'
        },
        developer: {
          developerApiKeyEnv: 'HSAPI_DEVELOPER_API_KEY',
          personalAccessKeyEnv: 'HSAPI_PERSONAL_ACCESS_KEY'
        }
      }
    });
    const result = await run(['account', 'details'], {
      ...baseEnv,
      HSAPI_PORTALS_CONFIG: mixedAuthConfig,
      HSAPI_TEST_MIXED_PORTAL_TOKEN: 'portal-token',
      HSAPI_DEVELOPER_API_KEY: 'developer-key',
      HSAPI_PERSONAL_ACCESS_KEY: 'personal-access-key'
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const request = requests.at(-1);
    const url = new URL(request.url, baseUrl);
    assert.strictEqual(url.searchParams.get('hapikey'), null);
    assert.strictEqual(request.headers.authorization, 'Bearer portal-token');

});

test('38 block (21)', async () => {
    const clientCredentialsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsapi-dev-client-'));
    const developerConfigForCache = (tokenCachePath) => writeTempConfig(baseUrl, {
      tokenEnv: null,
      auth: {
        defaultFamily: AUTH_FAMILIES.DEVELOPER,
        developer: {
          clientIdEnv: 'HSAPI_DEVELOPER_CLIENT_ID',
          clientSecretEnv: 'HSAPI_DEVELOPER_CLIENT_SECRET',
          tokenCachePath
        }
      }
    });
    const clientCredentialsEnv = (configPath, extra = {}) => ({
      ...baseEnv,
      HSAPI_PORTALS_CONFIG: configPath,
      HSAPI_DEVELOPER_CLIENT_ID: 'developer-client-id',
      HSAPI_DEVELOPER_CLIENT_SECRET: 'developer-client-secret',
      ...extra
    });
    const readScopes = ['developer.webhooks_journal.read'];

    {
      const cachePath = path.join(clientCredentialsDir, 'preview-cache.json');
      const cachedToken = 'cached-developer-client-token-preview';
      writeDeveloperClientCredentialsCache(cachePath, cachedToken, '2999-01-01T00:00:00.000Z', baseUrl, readScopes);
      const config = developerConfigForCache(cachePath);
      const before = requests.length;
      const beforeToken = requestCount(requests, 'POST', '/oauth/2026-03/token');
      const output = parseJsonOutput(await run(['webhook-journal', 'journal-batch-read', '--offsets', '101,102', '--show-request'], clientCredentialsEnv(config, {
        HSAPI_DEVELOPER_CLIENT_SECRET: 'developer-client-secret-preview'
      })));
      const serialized = JSON.stringify(output);
      assert.strictEqual(output.authFamily, AUTH_FAMILIES.DEVELOPER);
      assert.strictEqual(output.authSubtype, DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS);
      assert.strictEqual(output.auth.credentialSource.type, DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS);
      assert.strictEqual(output.auth.credentialSource.grantType, 'client_credentials');
      assert.strictEqual(output.auth.credentialSource.clientIdEnv, 'HSAPI_DEVELOPER_CLIENT_ID');
      assert.strictEqual(output.auth.credentialSource.clientSecretEnv, 'HSAPI_DEVELOPER_CLIENT_SECRET');
      assert.deepStrictEqual(output.auth.scopes, readScopes);
      assert.deepStrictEqual(output.auth.credentialSource.scopes, readScopes);
      assert.strictEqual(output.auth.credentialSource.tokenCache.schema, DEVELOPER_CLIENT_CREDENTIALS_TOKEN_CACHE_SCHEMA);
      assert.strictEqual(output.auth.credentialSource.tokenCache.status, 'usable');
      assert.strictEqual(output.auth.credentialSource.tokenCache.accessToken, 'REDACTED');
      assert.strictEqual(output.request.headers.Authorization, 'Bearer <developer-client-credentials-access-token>');
      assert(!serialized.includes('developer-client-secret-preview'), 'developer client-credentials preview must not leak client secret values');
      assert(!serialized.includes(cachedToken), 'developer client-credentials preview must not leak cached token values');
      assert.strictEqual(requests.length, before, 'developer client-credentials --show-request must not call network');
      assert.strictEqual(requestCount(requests, 'POST', '/oauth/2026-03/token'), beforeToken, 'developer client-credentials --show-request must not refresh');
    }

    {
      const cachePath = path.join(clientCredentialsDir, 'refresh-cache.json');
      const config = developerConfigForCache(cachePath);
      const beforeToken = requestCount(requests, 'POST', '/oauth/2026-03/token');
      const beforeJournal = requestCount(requests, 'GET', '/webhooks-journal/journal/2026-03/earliest');
      const result = await run(['webhook-journal', 'journal-earliest'], clientCredentialsEnv(config));
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.strictEqual(requestCount(requests, 'POST', '/oauth/2026-03/token'), beforeToken + 1, 'missing developer client-credentials cache must refresh once');
      assert.strictEqual(requestCount(requests, 'GET', '/webhooks-journal/journal/2026-03/earliest'), beforeJournal + 1);
      const tokenRequest = requests.at(-2);
      const tokenBody = new URLSearchParams(tokenRequest.body);
      assert.strictEqual(tokenBody.get('grant_type'), 'client_credentials');
      assert.strictEqual(tokenBody.get('client_id'), 'developer-client-id');
      assert.strictEqual(tokenBody.get('client_secret'), 'developer-client-secret');
      assert.strictEqual(tokenBody.get('scope'), readScopes.join(' '));
      const accessToken = requests.at(-1).headers.authorization.replace(/^Bearer /, '');
      assert.match(accessToken, /^developer-client-access-token-/);
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      assert.strictEqual(cache.schema, DEVELOPER_CLIENT_CREDENTIALS_TOKEN_CACHE_SCHEMA);
      assert.strictEqual(cache.family, AUTH_FAMILIES.DEVELOPER);
      assert.strictEqual(cache.subtype, DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS);
      assert.strictEqual(cache.grantType, 'client_credentials');
      assert.deepStrictEqual(cache.source.scopes, readScopes);
      assert(!result.stdout.includes(accessToken), 'developer client-credentials access token must not appear in command output');
      assert(!result.stdout.includes('developer-client-secret'), 'developer client-credentials client secret must not appear in command output');
    }

    {
      const cachePath = path.join(clientCredentialsDir, 'missing-env-cache.json');
      const config = developerConfigForCache(cachePath);
      const before = requests.length;
      const result = await run(['webhook-journal', 'journal-earliest'], clientCredentialsEnv(config, {
        HSAPI_DEVELOPER_CLIENT_ID: 'developer-client-id',
        HSAPI_DEVELOPER_CLIENT_SECRET: ''
      }));
      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /HSAPI_DEVELOPER_CLIENT_SECRET/);
      assert.strictEqual(requests.length, before, 'missing developer client-credentials env vars must fail before refresh or endpoint execution');
    }

    {
      const missingScopesCatalog = writeTempCatalog((catalog) => {
        const endpoint = catalog.endpoints.find((item) => item.name === 'webhook_journal.journal_earliest');
        endpoint.requiredScopes = [];
        endpoint.auth.scopes = [];
      });
      const cachePath = path.join(clientCredentialsDir, 'missing-scopes-cache.json');
      const config = developerConfigForCache(cachePath);
      const before = requests.length;
      const result = await run(['webhook-journal', 'journal-earliest', '--show-request'], {
        ...clientCredentialsEnv(config),
        HSAPI_CATALOG_FILE: missingScopesCatalog
      });
      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /auth\.scopes or requiredScopes/);
      assert.strictEqual(requests.length, before, 'missing client-credentials scopes must fail before request execution');
    }

    {
      const cachePath = path.join(clientCredentialsDir, 'fresh-cache.json');
      const cachedToken = 'cached-developer-client-access-token';
      writeDeveloperClientCredentialsCache(cachePath, cachedToken, '2999-01-01T00:00:00.000Z', baseUrl, readScopes);
      const config = developerConfigForCache(cachePath);
      const beforeToken = requestCount(requests, 'POST', '/oauth/2026-03/token');
      const result = await run(['webhook-journal', 'journal-earliest'], clientCredentialsEnv(config));
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.strictEqual(requestCount(requests, 'POST', '/oauth/2026-03/token'), beforeToken, 'fresh developer client-credentials cache must be reused');
      assert.strictEqual(requests.at(-1).headers.authorization, `Bearer ${cachedToken}`);
      assert(!result.stdout.includes(cachedToken), 'developer client-credentials cached token must be redacted from output');
    }

    {
      const cachePath = path.join(clientCredentialsDir, 'expired-cache.json');
      const expiredToken = 'expired-developer-client-access-token';
      writeDeveloperClientCredentialsCache(cachePath, expiredToken, '2000-01-01T00:00:00.000Z', baseUrl, readScopes);
      const config = developerConfigForCache(cachePath);
      const beforeToken = requestCount(requests, 'POST', '/oauth/2026-03/token');
      const result = await run(['webhook-journal', 'journal-earliest'], clientCredentialsEnv(config, {
        HSAPI_DEVELOPER_CLIENT_SECRET: 'developer-client-secret-expired'
      }));
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.strictEqual(requestCount(requests, 'POST', '/oauth/2026-03/token'), beforeToken + 1, 'expired developer client-credentials cache must refresh');
      assert.notStrictEqual(requests.at(-1).headers.authorization, `Bearer ${expiredToken}`);
      assert(!result.stdout.includes(expiredToken), 'expired developer client-credentials token must not leak');
      assert(!result.stdout.includes('developer-client-secret-expired'), 'developer client-credentials refresh output must not leak client secret');
    }

    {
      const cachePath = path.join(clientCredentialsDir, 'token-error-cache.json');
      const config = developerConfigForCache(cachePath);
      const beforeJournal = requestCount(requests, 'GET', '/webhooks-journal/journal/2026-03/earliest');
      const result = await run(['webhook-journal', 'journal-earliest'], clientCredentialsEnv(config, {
        HSAPI_DEVELOPER_CLIENT_ID: 'developer-client-id-error',
        HSAPI_DEVELOPER_CLIENT_SECRET: 'bad-developer-client-secret'
      }));
      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /developer\.webhooks_journal\.read/);
      assert.match(result.stderr, /HubSpot 4xx response category INVALID_CLIENT/);
      assert(!result.stderr.includes('bad-developer-client-secret'), 'developer client-credentials token errors must not leak client secret values');
      assert(!result.stderr.includes('developer-client-id-error'), 'developer client-credentials token errors must not leak client id values');
      assert(!result.stderr.includes('developer-token-error-secret'), 'developer client-credentials token errors must not leak response token values');
      assert.strictEqual(requestCount(requests, 'GET', '/webhooks-journal/journal/2026-03/earliest'), beforeJournal, 'failed developer client-credentials refresh must not call target endpoint');
    }

    {
      const oauthCachePath = path.join(clientCredentialsDir, 'separation-oauth-cache.json');
      const developerCachePath = path.join(clientCredentialsDir, 'separation-developer-cache.json');
      fs.writeFileSync(oauthCachePath, JSON.stringify({
        schema: 'hsapi.oauthTokenCache.v1',
        family: AUTH_FAMILIES.OAUTH,
        tokenType: 'bearer',
        accessToken: 'oauth-cache-should-not-satisfy-developer',
        expiresIn: 1800,
        expiresAt: '2999-01-01T00:00:00.000Z',
        refreshedAt: '2026-05-15T00:00:00.000Z'
      }, null, 2));
      const combinedConfig = writeTempConfig(baseUrl, {
        tokenEnv: null,
        auth: {
          oauth: {
            clientIdEnv: 'HSAPI_OAUTH_CLIENT_ID',
            clientSecretEnv: 'HSAPI_OAUTH_CLIENT_SECRET',
            refreshTokenEnv: 'HSAPI_OAUTH_REFRESH_TOKEN',
            tokenCachePath: oauthCachePath
          },
          developer: {
            clientIdEnv: 'HSAPI_DEVELOPER_CLIENT_ID',
            clientSecretEnv: 'HSAPI_DEVELOPER_CLIENT_SECRET',
            tokenCachePath: developerCachePath
          }
        }
      });
      const beforeToken = requestCount(requests, 'POST', '/oauth/2026-03/token');
      const result = await run(['webhook-journal', 'journal-earliest'], clientCredentialsEnv(combinedConfig, {
        HSAPI_OAUTH_CLIENT_ID: '',
        HSAPI_OAUTH_CLIENT_SECRET: '',
        HSAPI_OAUTH_REFRESH_TOKEN: ''
      }));
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.strictEqual(requestCount(requests, 'POST', '/oauth/2026-03/token'), beforeToken + 1, 'OAuth cache must not satisfy developer client-credentials endpoints');
      assert.notStrictEqual(requests.at(-1).headers.authorization, 'Bearer oauth-cache-should-not-satisfy-developer');
      assert.strictEqual(JSON.parse(fs.readFileSync(oauthCachePath, 'utf8')).accessToken, 'oauth-cache-should-not-satisfy-developer');
      assert.strictEqual(JSON.parse(fs.readFileSync(developerCachePath, 'utf8')).schema, DEVELOPER_CLIENT_CREDENTIALS_TOKEN_CACHE_SCHEMA);
    }

    {
      const oauthCatalog = writeTempCatalog((catalog) => {
        catalog.endpoints.find((endpoint) => endpoint.name === 'account.details').auth = {
          family: AUTH_FAMILIES.OAUTH,
          subtype: 'installed_app',
          fallback: 'none'
        };
      });
      const oauthCachePath = path.join(clientCredentialsDir, 'oauth-separate-cache.json');
      const developerCachePath = path.join(clientCredentialsDir, 'developer-separate-cache.json');
      writeDeveloperClientCredentialsCache(developerCachePath, 'developer-cache-should-not-satisfy-oauth', '2999-01-01T00:00:00.000Z', baseUrl, readScopes);
      const combinedConfig = writeTempConfig(baseUrl, {
        tokenEnv: null,
        auth: {
          oauth: {
            clientIdEnv: 'HSAPI_OAUTH_CLIENT_ID',
            clientSecretEnv: 'HSAPI_OAUTH_CLIENT_SECRET',
            refreshTokenEnv: 'HSAPI_OAUTH_REFRESH_TOKEN',
            tokenCachePath: oauthCachePath
          },
          developer: {
            clientIdEnv: 'HSAPI_DEVELOPER_CLIENT_ID',
            clientSecretEnv: 'HSAPI_DEVELOPER_CLIENT_SECRET',
            tokenCachePath: developerCachePath
          }
        }
      });
      const beforeToken = requestCount(requests, 'POST', '/oauth/2026-03/token');
      const result = await run(['account', 'details'], {
        ...baseEnv,
        HSAPI_PORTALS_CONFIG: combinedConfig,
        HSAPI_CATALOG_FILE: oauthCatalog,
        HSAPI_OAUTH_CLIENT_ID: 'oauth-client-id',
        HSAPI_OAUTH_CLIENT_SECRET: 'oauth-client-secret',
        HSAPI_OAUTH_REFRESH_TOKEN: 'oauth-refresh-token',
        HSAPI_DEVELOPER_CLIENT_ID: '',
        HSAPI_DEVELOPER_CLIENT_SECRET: ''
      });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.strictEqual(requestCount(requests, 'POST', '/oauth/2026-03/token'), beforeToken + 1, 'developer client-credentials cache must not satisfy OAuth endpoints');
      assert.strictEqual(requests.at(-1).headers.authorization, 'Bearer refreshed-access-token');
      assert.strictEqual(JSON.parse(fs.readFileSync(oauthCachePath, 'utf8')).schema, 'hsapi.oauthTokenCache.v1');
      assert.strictEqual(JSON.parse(fs.readFileSync(developerCachePath, 'utf8')).schema, DEVELOPER_CLIENT_CREDENTIALS_TOKEN_CACHE_SCHEMA);
      assert(!result.stdout.includes('developer-cache-should-not-satisfy-oauth'), 'OAuth output must not leak or reuse developer cache tokens');
    }

});

test('39 block (22)', async () => {
    const missingAuthCatalog = writeTempCatalog((catalog) => {
      delete catalog.endpoints.find((endpoint) => endpoint.name === 'account.details').auth;
    });
    const before = requests.length;
    const result = await run(['account', 'details'], {
      ...baseEnv,
      HSAPI_CATALOG_FILE: missingAuthCatalog,
      HSAPI_TEST_TOKEN: 'profile-token'
    });
    assert.notStrictEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.ok, false);
    assert.match(output.error, /account\.details\) must include auth metadata/);
    assert.strictEqual(requests.length, before, 'missing endpoint auth metadata must fail before request execution');

});

test('40 block (23)', async () => {
    const unknownAuthCatalog = writeTempCatalog((catalog) => {
      catalog.endpoints.find((endpoint) => endpoint.name === 'account.details').auth.family = 'session_cookie';
    });
    const before = requests.length;
    const result = await run(['account', 'details'], {
      ...baseEnv,
      HSAPI_CATALOG_FILE: unknownAuthCatalog,
      HSAPI_TEST_TOKEN: 'profile-token'
    });
    assert.notStrictEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.ok, false);
    assert.match(output.error, /auth\.family "session_cookie" is not supported/);
    assert.strictEqual(requests.length, before, 'unknown endpoint auth family must fail before request execution');

});

test('41 block (24)', async () => {
    const before = requests.length;
    const output = parseJsonOutput(await run([
      'request',
      'PATCH',
      '/crm/objects/2026-03/contacts/123',
      '--show-request',
      '--body',
      '{"properties":{"firstname":"Ada"}}'
    ], baseEnv));
    assert.strictEqual(output.showRequest, true);
    assert.strictEqual(output.request.method, 'PATCH');
    assert.deepStrictEqual(output.request.body, { properties: { firstname: 'Ada' } });
    assert.strictEqual(output.endpoint.id, 'objects.update');
    assert.strictEqual(requests.length, before, '--show-request must bypass mutation preview without network');

});

test('42 127.0.0.1:1/steal\'], {', async () => {
    const before = requests.length;
    const result = await run(['request', 'GET', 'http://127.0.0.1:1/steal'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to send HubSpot token to non-HubSpot\/API origin/);
    assert.strictEqual(requests.length, before, 'blocked absolute URL must not make a network request');

});

test('43 block (25)', async () => {
    const result = await run(['request', 'GET', '/crm/v3/owners'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const output = parseJsonOutput(result);
    assert.strictEqual(output.requestId, 'test-correlation');
    assert.strictEqual(output.rateLimit['x-hubspot-ratelimit-remaining'], '99');
    assert.strictEqual(requests.at(-1).headers.authorization, 'Bearer profile-token');

});

test('44 block (26)', async () => {
    const output = parseJsonOutput(await run(['request', 'GET', '/crm/v3/owners', '--select', 'data.total'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    }));
    assert.strictEqual(output, 2);

});

test('45 block (27)', async () => {
    const output = parseJsonOutput(await run(['request', 'GET', '/crm/v3/owners', '--select', 'data.results[].id'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    }));
    assert.deepStrictEqual(output, ['owner-1', 'owner-2']);

});

test('46 block (28)', async () => {
    const output = parseJsonOutput(await run(['request', 'GET', '/crm/v3/owners', '--pick', 'data.total,data.results[].properties.name'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    }));
    assert.deepStrictEqual(output, {
      'data.total': 2,
      'data.results[].properties.name': ['Ada Lovelace', 'Grace Hopper']
    });

});

test('47 block (29)', async () => {
    const result = await run(['request', 'GET', '/crm/v3/owners', '--select', 'data.total', '--raw-value'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.strictEqual(result.stderr, '');
    assert.strictEqual(result.stdout, '2\n');

});

test('48 block (30)', async () => {
    const result = await run(['request', 'GET', '/crm/v3/owners', '--select', 'data.results', '--raw-value'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /--raw-value requires --select <path> to resolve to a string, number, boolean, or null/);

});

test('49 block (31)', async () => {
    const output = parseJsonOutput(await run(['request', 'GET', '/crm/v3/owners', '--compact'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    }));
    assert.strictEqual(output.ok, true);
    assert.strictEqual(output.portal, 'test');
    assert.strictEqual(output.data.total, 2);
    assert(!Object.prototype.hasOwnProperty.call(output, 'rateLimit'), 'compact output should omit rateLimit');
    assert(!Object.prototype.hasOwnProperty.call(output, 'requestId'), 'compact output should omit requestId');
    assert(!Object.prototype.hasOwnProperty.call(output, 'method'), 'compact output should omit method');
    assert(!Object.prototype.hasOwnProperty.call(output, 'url'), 'compact output should omit url');
    assert(!Object.prototype.hasOwnProperty.call(output, 'status'), 'compact output should omit success status');

});

test('50 owners.list is catalog-backed since issue #12, so provenance resolves from the c', async () => {
    const before = requests.length;
    const output = parseJsonOutput(await run(['request', 'GET', '/crm/v3/owners', '--show-request', '--agent'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    }));
    assert.strictEqual(output.showRequest, true);
    assert.strictEqual(output.request.method, 'GET');
    assert.strictEqual(output.request.url, `${baseUrl}/crm/v3/owners`);
    assert.strictEqual(output.request.headers.Authorization, 'Bearer $HSAPI_TEST_TOKEN');
    assert.strictEqual(output.authFamily, AUTH_FAMILIES.PORTAL_BEARER);
    // owners.list is catalog-backed since issue #12, so provenance resolves from the catalog.
    assert.strictEqual(output.auth.provenance, 'catalog');
    assert.strictEqual(output.endpoint.id, 'owners.list');
    assert.strictEqual(output.auth.credentialSource.name, 'HSAPI_TEST_TOKEN');
    assert.strictEqual(requests.length, before, '--show-request --agent must not make a network request');

});

test('51 block (32)', async () => {
    const output = parseJsonOutput(await run(['request', 'GET', '/crm/v3/owners', '--max-results', '1'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    }));
    assert.strictEqual(output.truncated, true);
    assert.strictEqual(output.truncation.reason, 'max-results');
    assert.strictEqual(output.truncation.path, 'data.results');
    assert.strictEqual(output.truncation.originalResultCount, 2);
    assert.strictEqual(output.truncation.returnedResultCount, 1);
    assert.strictEqual(output.truncation.nextAfter, 'owners-page-2');
    assert.deepStrictEqual(output.data.results.map((item) => item.id), ['owner-1']);

});

test('52 block (33)', async () => {
    const result = await run(['request', 'GET', '/crm/v3/owners', '--max-chars', '120'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /Output is \d+ chars, exceeding --max-chars 120/);

});

test('53 block (34)', async () => {
    const output = parseJsonOutput(await run(['request', 'GET', '/crm/v3/owners', '--max-chars', '120', '--include-truncated'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    }));
    assert.strictEqual(output.truncated, true);
    assert.strictEqual(output.truncation.reason, 'max-chars');
    assert.strictEqual(output.truncation.maxChars, 120);
    assert.strictEqual(output.portal, 'test');
    assert(!Object.prototype.hasOwnProperty.call(output, 'data'), 'max-chars truncation summary must not include full payload');

});

test('54 block (35)', async () => {
    const output = parseJsonOutput(await run(['request', 'GET', '/crm/v3/paged', '--paginate'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    }));
    assert.strictEqual(output.pageCount, 2);
    assert.strictEqual(output.resultCount, 2);
    assert.deepStrictEqual(output.results.map((item) => item.id), ['1', '2']);
    assert(requests.some((request) => request.url === '/crm/v3/paged?after=page-2'), 'pagination should request the next page cursor');

});

test('55 block (36)', async () => {
    const before = routeCounts['GET /crm/v3/paged'] || 0;
    const output = parseJsonOutput(await run(['request', 'GET', '/crm/v3/paged', '--paginate', '--max-results', '1'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    }));
    assert.strictEqual(output.truncated, true);
    assert.strictEqual(output.truncation.reason, 'max-results');
    assert.strictEqual(output.truncation.nextAfter, 'page-2');
    assert.strictEqual(output.pageCount, 1);
    assert.strictEqual(output.resultCount, 1);
    assert.deepStrictEqual(output.results.map((item) => item.id), ['1']);
    assert.strictEqual((routeCounts['GET /crm/v3/paged'] || 0) - before, 1, 'max-results should stop pagination after enough rows');

});

test('56 block (37)', async () => {
    const before = routeCounts['GET /crm/v3/retry-once'] || 0;
    const output = parseJsonOutput(await run(['request', 'GET', '/crm/v3/retry-once'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    }));
    assert.strictEqual(output.status, 200);
    assert.strictEqual((routeCounts['GET /crm/v3/retry-once'] || 0) - before, 2, 'safe GETs should retry one transient 429');

});

test('57 block (38)', async () => {
    const before = requests.length;
    const result = await run(['schemas', 'list'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    });
    assert.strictEqual(result.status, 1);
    const output = parseJsonOutput(result);
    assert.strictEqual(output.status, 403);
    assert.match(output.note, /portal subscription/);
    assert.strictEqual(requests.length, before + 1);

});

test('58 block (39)', async () => {
    const before = requests.length;
    const result = await run(['request', 'POST', '/crm/objects/2026-03/deals', '--read-only', '--body', '{"x":1}'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /--read-only is only allowed/);
    assert.strictEqual(requests.length, before, 'unknown read-only POST must not execute');

});

test('59 block (40)', async () => {
    const result = await run(['request', 'POST', '/crm/objects/2026-03/deals/search', '--read-only', '--body', '{"limit":1}'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    parseJsonOutput(result);
    assert.strictEqual(requests.at(-1).method, 'POST');
    assert.strictEqual(requests.at(-1).url, '/crm/objects/2026-03/deals/search');

});

test('60 block (41)', async () => {
    const output = parseJsonOutput(await run(['tiers', 'apis', '--tier', 'starter'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    }));
    const names = output.products.flatMap((product) => product.features.map((feature) => feature.name));
    assert(!names.includes('Custom Objects'), 'starter product-tier output must not inherit global Custom Objects row');
    assert(output.globalApiSurface, 'global API surface summary should be present separately');

});

test('61 api.hubapi.com\');', async () => {
    const matrix = JSON.parse(fs.readFileSync(TEST_MATRIX_SAMPLE, 'utf8'));
    const requiredFixtures = [
      'free_like',
      'starter_like',
      'professional_like',
      'enterprise_like',
      'no_custom_objects',
      'disposable_write'
    ];
    assert.strictEqual(matrix.default, 'free_like');
    assert.deepStrictEqual(Object.keys(matrix.portals).sort(), requiredFixtures.sort());
    assertNoTokenLikeValues(matrix, 'examples/portals.test-matrix.sample.json');
    assert.deepStrictEqual(matrix.commandExpectations['pipelines.deals'].acceptHttpStatuses, [403]);
    assert.deepStrictEqual(matrix.disposableWriteExpectations['list.create'].acceptHttpStatuses, [403]);
    for (const fixtureName of requiredFixtures) {
      const fixture = matrix.portals[fixtureName];
      assert.strictEqual(fixture.fixtureRole, fixtureName);
      assert.match(fixture.tokenEnv, /^HSAPI_TEST_[A-Z_]+_TOKEN$/);
      assert.strictEqual(fixture.auth.defaultFamily, AUTH_FAMILIES.PORTAL_BEARER);
      assert.strictEqual(fixture.auth.portalBearer.tokenEnv, fixture.tokenEnv);
      assert.strictEqual(fixture.auth.portalBearer.kind, 'private_app');
      assert.strictEqual(fixture.baseUrl, 'https://api.hubapi.com');
      assert(Array.isArray(fixture.expectedCapabilities), `${fixtureName} must list expected capabilities`);
      assert(Array.isArray(fixture.blockedCapabilities), `${fixtureName} must list blocked capabilities`);
    }
    assert.strictEqual(matrix.portals.disposable_write.fixtureSafety, 'write-disposable-only');
    assert.strictEqual(matrix.portals.disposable_write.writeGateEnv, 'HSAPI_RUN_DISPOSABLE_WRITES');
    assert.deepStrictEqual(matrix.portals.no_custom_objects.commandExpectations['schemas.list'].expectedHttpStatuses, [200]);
    assert.strictEqual(matrix.portals.no_custom_objects.commandExpectations['schemas.list'].expectedResultCount, 0);

    const smoke = parseJsonOutput(await runNodeScript(LIVE_READ_SMOKE, [
      '--config',
      TEST_MATRIX_SAMPLE,
      '--json'
    ], {
      HSAPI_TEST_FREE_TOKEN: '',
      HSAPI_TEST_STARTER_TOKEN: '',
      HSAPI_TEST_PRO_TOKEN: '',
      HSAPI_TEST_ENTERPRISE_TOKEN: '',
      HSAPI_TEST_NO_CUSTOM_OBJECTS_TOKEN: '',
      HSAPI_TEST_DISPOSABLE_WRITE_TOKEN: ''
    }));
    assert.strictEqual(smoke.ok, true);
    assert.strictEqual(smoke.status, 'skipped');
    assert.strictEqual(smoke.portals.length, requiredFixtures.length);
    assert(smoke.portals.every((portal) => portal.status === 'skipped'));

    const matrixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsapi-matrix-'));
    const matrixPath = path.join(matrixDir, 'matrix.json');
    fs.writeFileSync(matrixPath, JSON.stringify({
      default: 'test',
      commandExpectations: {
        'pipelines.deals': {
          acceptHttpStatuses: [403],
          reason: 'PAK auth-mode limitation'
        }
      },
      portals: {
        test: {
          label: 'Test fixture',
          portalId: '999',
          tokenEnv: 'HSAPI_TEST_TOKEN',
          baseUrl,
          fixtureRole: 'free_like',
          fixtureSafety: 'read-only'
        }
      }
    }, null, 2));
    const acceptedSmoke = parseJsonOutput(await runNodeScript(LIVE_READ_SMOKE, [
      '--config',
      matrixPath,
      '--portal',
      'test',
      '--json'
    ], {
      HSAPI_TEST_TOKEN: 'profile-token'
    }));
    assert.strictEqual(acceptedSmoke.ok, true);
    assert.strictEqual(acceptedSmoke.status, 'completed');
    const pipelineCheck = acceptedSmoke.portals[0].commands.find((command) => command.id === 'pipelines.deals');
    assert.strictEqual(pipelineCheck.status, 'passed');
    assert.strictEqual(pipelineCheck.exitCode, 1);
    assert.strictEqual(pipelineCheck.httpStatus, 403);
    assert.strictEqual(pipelineCheck.acceptedReason, 'PAK auth-mode limitation');

    const writePlan = parseJsonOutput(await runNodeScript(DISPOSABLE_WRITE_SMOKE, [
      '--config',
      TEST_MATRIX_SAMPLE,
      '--plan-only',
      '--json'
    ], {
      HSAPI_DISPOSABLE_RUN_ID: 'sample'
    }));
    assert.strictEqual(writePlan.status, 'planned');
    assert.strictEqual(writePlan.portal, 'disposable_write');
    assert.strictEqual(writePlan.plannedSteps.length, 6);
    assert(writePlan.plannedSteps.every((step) => step.args.includes('--yes')));
    assert(writePlan.plannedSteps.some((step) => step.id === 'property.create'));
    assert(writePlan.plannedSteps.some((step) => step.id === 'pipeline_stage.create'));
    assert(writePlan.plannedSteps.some((step) => step.id === 'crm_record.create'));
    assert(writePlan.plannedSteps.some((step) => step.id === 'import.start'));
    assert(writePlan.plannedSteps.flatMap((step) => step.args).some((arg) => String(arg).includes('hsapi_test_')));

    const writeSkip = parseJsonOutput(await runNodeScript(DISPOSABLE_WRITE_SMOKE, [
      '--config',
      TEST_MATRIX_SAMPLE,
      '--json'
    ], {}));
    assert.strictEqual(writeSkip.ok, true);
    assert.strictEqual(writeSkip.status, 'skipped');
    assert.match(writeSkip.reason, /HSAPI_RUN_DISPOSABLE_WRITES/);

    const writeMatrixPath = path.join(matrixDir, 'write-matrix.json');
    fs.writeFileSync(writeMatrixPath, JSON.stringify({
      default: 'disposable_write',
      disposableWriteExpectations: {
        'property.create': { acceptHttpStatuses: [403], reason: 'missing deals-write' },
        'pipeline_stage.create': { acceptHttpStatuses: [403], reason: 'pipeline auth mode' },
        'list.create': { acceptHttpStatuses: [403], reason: 'missing list write' },
        'crm_record.create': { acceptHttpStatuses: [403], reason: 'missing contacts-write' }
      },
      portals: {
        disposable_write: {
          label: 'Mock disposable write fixture',
          portalId: '999',
          tokenEnv: 'HSAPI_TEST_TOKEN',
          baseUrl,
          fixtureRole: 'disposable_write',
          fixtureSafety: 'write-disposable-only',
          testAssetPrefix: 'hsapi_test_'
        }
      }
    }, null, 2));
    const writeSmoke = parseJsonOutput(await runNodeScript(DISPOSABLE_WRITE_SMOKE, [
      '--config',
      writeMatrixPath,
      '--json'
    ], {
      HSAPI_RUN_DISPOSABLE_WRITES: 'true',
      HSAPI_TEST_TOKEN: 'profile-token',
      HSAPI_DISPOSABLE_RUN_ID: 'mock'
    }));
    assert.strictEqual(writeSmoke.ok, true);
    assert.strictEqual(writeSmoke.status, 'completed_with_expected_blocks');
    assert.strictEqual(writeSmoke.summary.failed, 0);
    assert.strictEqual(writeSmoke.summary.blocked, 4);
    assert(writeSmoke.steps.some((step) => step.id === 'property_group.archive' && step.cleanup === true));
    assert(writeSmoke.steps.some((step) => step.id === 'import.cancel' && step.cleanup === true));

});

test('62 block (42)', async () => {
    const definitions = endpointDefinitions(CATALOG_FILE);
    const typedDefinitions = definitions.filter((definition) => definition.status === 'typed');
    const catalog = loadCatalogData(CATALOG_FILE);
    const ids = new Set();
    const commands = new Set();

    for (const definition of typedDefinitions) {
      assert(definition.id, 'typed endpoint definitions must include ids');
      assert(definition.command, `${definition.id} must include a command mapping`);
      assert(definition.auth, `${definition.id} must include auth metadata`);
      assert.strictEqual(definition.auth.fallback, 'none', `${definition.id} must not declare auth fallback`);
      if (definition.auth.required === false) {
        assert.strictEqual(definition.auth.family, null, `${definition.id} unauthenticated metadata must not use an auth family`);
      } else {
        assert(VALID_AUTH_FAMILIES.has(definition.auth.family), `${definition.id} must use a supported auth family`);
        if (definition.auth.family === AUTH_FAMILIES.DEVELOPER) {
          assert(VALID_DEVELOPER_AUTH_SUBTYPES.has(definition.auth.subtype), `${definition.id} must use a supported developer auth subtype`);
          if (definition.auth.subtype === DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS) {
            assert(definition.auth.scopes.length, `${definition.id} client-credentials auth must declare auth.scopes`);
            assert.deepStrictEqual(definition.auth.scopes, definition.requiredScopes, `${definition.id} client-credentials auth.scopes must match requiredScopes`);
          }
        }
      }
      assert(!ids.has(definition.id), `${definition.id} must be unique`);
      assert(!commands.has(definition.command), `${definition.command} must map to only one typed endpoint`);
      assert(pathTemplateToRegex(definition.pathTemplate).test(samplePathForTemplate(definition.pathTemplate)), `${definition.id} path template must compile`);
      ids.add(definition.id);
      commands.add(definition.command);
    }
    assert.strictEqual(catalog.endpoints.find((endpoint) => endpoint.id === 'forms.submit').auth.required, false);
    assert.strictEqual(catalog.endpoints.find((endpoint) => endpoint.id === 'auth.oauth.refresh').auth.family, AUTH_FAMILIES.OAUTH);
    assert.strictEqual(catalog.endpoints.find((endpoint) => endpoint.id === 'webhook_journal.journal_batch_read').auth.family, AUTH_FAMILIES.DEVELOPER);
    assert.strictEqual(catalog.endpoints.find((endpoint) => endpoint.id === 'objects.list').auth.family, AUTH_FAMILIES.PORTAL_BEARER);

    const marketingContext = path.join(WORKSPACE_ROOT, 'docs', 'hubspot-api-context', 'marketing-surfaces.md');
    const cmsHubdbContext = path.join(WORKSPACE_ROOT, 'docs', 'hubspot-api-context', 'hubdb.md');
    const cmsSourceCodeContext = path.join(WORKSPACE_ROOT, 'docs', 'hubspot-api-context', 'source-code.md');
    const automationContext = path.join(WORKSPACE_ROOT, 'docs', 'hubspot-api-context', 'automation-surfaces.md');
    const marketingTypedChecks = [
      ['marketing.emails.create', 'hsapi marketing emails create'],
      ['marketing.emails.update', 'hsapi marketing emails update'],
      ['marketing.emails.delete', 'hsapi marketing emails delete'],
      ['marketing.campaigns.create', 'hsapi marketing campaigns create'],
      ['marketing.campaigns.get', 'hsapi marketing campaigns get'],
      ['marketing.campaigns.delete', 'hsapi marketing campaigns delete'],
      ['marketing.events.list', 'hsapi marketing events list'],
      ['marketing.events.create', 'hsapi marketing events create'],
      ['marketing.events.upsert', 'hsapi marketing events upsert'],
      ['marketing.transactional.send', 'hsapi marketing transactional send']
    ];

    const surfacesById = new Map(catalog.surfaces.map((surface) => [surface.id, surface]));
    assert(fs.existsSync(marketingContext), 'marketing surface context file should exist');
    assert(fs.existsSync(automationContext), 'automation surface context file should exist');
    const expectedSurfaces = [
      ['marketing.ctas.javascript_sdk', 'javascript-sdk', 'docs/hubspot-api-context/marketing-surfaces.md'],
      ['automation.workflows.docs', 'docs-only', 'docs/hubspot-api-context/automation-surfaces.md'],
      ['automation.sequences.docs', 'docs-only', 'docs/hubspot-api-context/automation-surfaces.md']
    ];
    for (const [id, surfaceType, contextUrl] of expectedSurfaces) {
      const surface = surfacesById.get(id);
      assert(surface, `${id} surface should be cataloged`);
      assert.strictEqual(surface.surfaceType, surfaceType);
      assert.strictEqual(surface.status, 'catalog-only');
      assert.strictEqual(surface.contextUrl, contextUrl);
    }
    const ctaSurface = surfacesById.get('marketing.ctas.javascript_sdk');
    assert.match(ctaSurface.scopeNotes, /browser JavaScript SDK surface/);
    assert.match(ctaSurface.scopeNotes, /window\.HubSpotCallsToActions/);
    assert.match(ctaSurface.scopeNotes, /not as a bearer-token REST endpoint/);
    assert(!catalog.endpoints.some((endpoint) => endpoint.id.startsWith('marketing.ctas.')), 'CTA JavaScript SDK must not be cataloged as an HTTP endpoint');
    assert(!typedDefinitions.some((definition) => definition.command && definition.command.startsWith('hsapi marketing ctas')), 'CTA JavaScript SDK must not expose an hsapi marketing ctas command');
    assert(fs.existsSync(cmsHubdbContext), 'hubdb context file should exist');
    assert(fs.existsSync(cmsSourceCodeContext), 'source code context file should exist');

    const marketingEndpoints = new Map(catalog.endpoints.map((endpoint) => [endpoint.id, endpoint]));
    for (const [id, command] of marketingTypedChecks) {
      const endpoint = marketingEndpoints.get(id);
      assert(endpoint, `${id} must be cataloged`);
      assert.strictEqual(endpoint.status, 'typed', `${id} should have a typed command`);
      assert.strictEqual(endpoint.command, command, `${id} should point at the typed command`);
      assert.strictEqual(endpoint.contextUrl, 'docs/hubspot-api-context/marketing-surfaces.md', `${id} should point at the marketing surface context`);
    }

    const cmsGapEndpoints = new Map(catalog.endpoints.map((endpoint) => [endpoint.id, endpoint]));
    const cmsGapChecks = [
      ['cms.hubdb.tables.list', 'docs/hubspot-api-context/hubdb.md', 'hsapi cms hubdb tables list'],
      ['cms.hubdb.tables.get', 'docs/hubspot-api-context/hubdb.md', 'hsapi cms hubdb tables get'],
      ['cms.hubdb.tables.create', 'docs/hubspot-api-context/hubdb.md', 'hsapi cms hubdb tables create'],
      ['cms.hubdb.rows.list', 'docs/hubspot-api-context/hubdb.md', 'hsapi cms hubdb rows list'],
      ['cms.hubdb.rows.create', 'docs/hubspot-api-context/hubdb.md', 'hsapi cms hubdb rows create'],
      ['cms.source_code.upload', 'docs/hubspot-api-context/source-code.md', 'hsapi cms source-code upload'],
      ['cms.source_code.validate', 'docs/hubspot-api-context/source-code.md', 'hsapi cms source-code validate'],
      ['cms.source_code.delete', 'docs/hubspot-api-context/source-code.md', 'hsapi cms source-code delete']
    ];

    for (const [id, contextUrl, command] of cmsGapChecks) {
      const endpoint = cmsGapEndpoints.get(id);
      assert(endpoint, `${id} must be cataloged`);
      assert.strictEqual(endpoint.status, 'typed', `${id} should have a typed command`);
      assert.strictEqual(endpoint.command, command, `${id} should point at the typed command`);
      assert.strictEqual(endpoint.contextUrl, contextUrl, `${id} should point at the correct CMS gap context`);
    }

    const automationEndpoints = new Map(catalog.endpoints.map((endpoint) => [endpoint.id, endpoint]));
    const automationTypedChecks = [
      ['automation.workflows.list', 'hsapi automation workflows list'],
      ['automation.workflows.get', 'hsapi automation workflows get'],
      ['automation.workflows.current_enrollment', 'hsapi automation workflows current-enrollment'],
      ['automation.workflows.enroll_contact', 'hsapi automation workflows enroll'],
      ['automation.sequences.list', 'hsapi automation sequences list'],
      ['automation.sequences.get', 'hsapi automation sequences get'],
      ['automation.sequences.enroll_contact', 'hsapi automation sequences enroll'],
      ['automation.sequences.enrollment_status', 'hsapi automation sequences status'],
      ['crm.extensions.calling.settings.get', 'hsapi extensions calling settings get'],
      ['crm.extensions.calling.settings.delete', 'hsapi extensions calling settings delete'],
      ['crm.extensions.calling.recording_settings.get', 'hsapi extensions calling recording-settings get'],
      ['crm.extensions.calling.recording_settings.create', 'hsapi extensions calling recording-settings create'],
      ['crm.extensions.calling.recording_settings.update', 'hsapi extensions calling recording-settings update'],
      ['crm.extensions.calling.channel_connection.delete', 'hsapi extensions calling channel-connection delete'],
      ['crm.extensions.calling.recordings.ready', 'hsapi extensions calling recordings ready'],
      ['crm.extensions.calling.transcripts.create', 'hsapi extensions calling transcripts create'],
      ['crm.extensions.calling.transcripts.get', 'hsapi extensions calling transcripts get'],
      ['crm.extensions.videoconferencing.settings.get', 'hsapi extensions videoconferencing settings get'],
      ['crm.extensions.videoconferencing.settings.delete', 'hsapi extensions videoconferencing settings delete']
    ];
    for (const [id, command] of automationTypedChecks) {
      const endpoint = automationEndpoints.get(id);
      assert(endpoint, `${id} must be cataloged`);
      assert.strictEqual(endpoint.status, 'typed', `${id} should have a typed command`);
      assert.strictEqual(endpoint.command, command, `${id} should point at the typed command`);
      assert.strictEqual(endpoint.contextUrl, 'docs/hubspot-api-context/automation-surfaces.md', `${id} should point at the automation surface context`);
    }

    const videoSettingsGet = automationEndpoints.get('crm.extensions.videoconferencing.settings.get');
    assert.strictEqual(videoSettingsGet.risk, 'read');
    assert.match(videoSettingsGet.scopeNotes, /app-level video conferencing extension settings/);
    const videoSettingsDelete = automationEndpoints.get('crm.extensions.videoconferencing.settings.delete');
    assert.strictEqual(videoSettingsDelete.risk, 'destructive');
    assert.match(videoSettingsDelete.scopeNotes, /CLI requires --yes/);

    const output = parseJsonOutput(await run(['catalog', 'commands'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    }));
    assert.strictEqual(output.commandCount, typedDefinitions.length, 'catalog commands should expose every typed endpoint definition');
    assert(output.commands.some((command) => command.command === 'hsapi account details'));
    assert(output.commands.every((command) => command.method && command.pathTemplate));

    const outputById = new Map(output.commands.map((command) => [command.id, command]));
    for (const definition of typedDefinitions) {
      const command = outputById.get(definition.id);
      assert(command, `${definition.id} must be exposed by catalog commands`);
      assert.strictEqual(command.command, definition.command);
      assert.strictEqual(command.method, definition.method);
      assert.strictEqual(command.pathTemplate, definition.pathTemplate);
      assert.strictEqual(command.risk, definition.risk);
      assert.strictEqual(command.status, definition.status);
    }

});

test('63 block (43)', async () => {
    const expectedCoverage = summarizeCatalogCoverage(loadCatalogData(CATALOG_FILE));
    const output = parseJsonOutput(await run(['catalog', 'coverage'], {
      ...baseEnv,
      HSAPI_TEST_TOKEN: 'profile-token'
    }));
    assert(output.byRisk.read > 0, 'coverage should include risk summary');
    assert(output.byAuthFamily[AUTH_FAMILIES.PORTAL_BEARER] > 0, 'coverage should include auth-family summary');
    assert(output.byAuthFamily[AUTH_FAMILIES.OAUTH] > 0, 'coverage should include OAuth endpoint inventory');
    assert(output.byAuthFamily[AUTH_FAMILIES.DEVELOPER] > 0, 'coverage should include developer endpoint inventory');
    assert(output.typedCommandCount > 0, 'coverage should count typed command definitions');
    assert.deepStrictEqual(output.byStatus, expectedCoverage.byStatus);
    assert.deepStrictEqual(output.byRisk, expectedCoverage.byRisk);
    assert.deepStrictEqual(output.byAuthFamily, expectedCoverage.byAuthFamily);
    assert.deepStrictEqual(output.byTierRequirement, expectedCoverage.byTierRequirement);
    assert.deepStrictEqual(output.scopeCounts, expectedCoverage.scopeCounts);
    assert.strictEqual(output.unscopedCount, expectedCoverage.unscopedCount);
    assert.strictEqual(output.scopeNoteCount, expectedCoverage.scopeNoteCount);
    assert.strictEqual(output.noAuthRequiredCount, expectedCoverage.noAuthRequiredCount);
    assert.strictEqual(output.surfaceCount, expectedCoverage.surfaceCount);
    assert.deepStrictEqual(output.surfacesByFamily, expectedCoverage.surfacesByFamily);
    assert.deepStrictEqual(output.surfacesByStatus, expectedCoverage.surfacesByStatus);
    assert.deepStrictEqual(output.surfacesByType, expectedCoverage.surfacesByType);

});

test('64 block (44)', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsapi-dashboard-'));
    const dashboardPath = path.join(outputDir, 'coverage-dashboard.md');
    const output = parseJsonOutput(await runNodeScript(COVERAGE_DASHBOARD, [
      '--output',
      dashboardPath,
      '--json'
    ], baseEnv));
    assert.strictEqual(output.ok, true);
    assert.strictEqual(path.resolve(output.output), path.resolve(dashboardPath));
    assert(fs.existsSync(dashboardPath), 'coverage dashboard markdown should be written');
    const dashboard = fs.readFileSync(dashboardPath, 'utf8');
    assert.match(dashboard, /# HubSpot API Coverage Dashboard/);
    assert.match(dashboard, /## Snapshot/);
    assert.match(dashboard, /- Typed commands:/);
    assert.match(dashboard, /## Non-HTTP Surfaces/);
    assert.match(dashboard, /marketing\.ctas\.javascript_sdk \(javascript-sdk, marketing\.ctas\)/);
    assert.match(dashboard, /Disposition: HubSpot documents CTAs as a catalog-only browser JavaScript SDK surface under window\.HubSpotCallsToActions, not as a bearer-token REST endpoint\./);

});

test('65 block (45)', async () => {
    const proposalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsapi-catalog-proposal-'));
    const candidateFile = path.join(proposalDir, 'candidate.html');
    fs.writeFileSync(candidateFile, [
      '<html><body>',
      '<code>GET /crm/v3/timeline/events/{eventTemplateId}</code>',
      '<code>POST /crm/v3/timeline/events</code>',
      '<code>POST /crm/objects/2026-03/contacts/search</code>',
      '</body></html>'
    ].join('\n'));
    const output = parseJsonOutput(await runNodeScript(CATALOG_UPDATER, [
      '--offline',
      '--propose-diff',
      '--candidate-file',
      candidateFile,
      '--json'
    ], baseEnv));
    assert.strictEqual(output.proposals.candidateFileCount, 1);
    assert(output.proposals.catalogAdditions.some((proposal) => (
      proposal.method === 'GET'
      && proposal.path === '/crm/v3/timeline/events/{eventTemplateId}'
      && proposal.risk === 'read'
    )));
    assert(output.proposals.catalogAdditions.some((proposal) => (
      proposal.method === 'POST'
      && proposal.path === '/crm/v3/timeline/events'
      && proposal.risk === 'mutation'
    )));
    assert(!output.proposals.catalogAdditions.some((proposal) => (
      proposal.method === 'POST'
      && proposal.path === '/crm/objects/2026-03/contacts/search'
    )), 'existing catalog endpoints must not be proposed again');

});

test('66 block (46)', async () => {
    const reportDate = '2099-12-31';
    const reportPath = path.join(WORKSPACE_ROOT, 'docs', 'hubspot-api-updates', `${reportDate}.md`);
    if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
    try {
      const output = parseJsonOutput(await runNodeScript(CATALOG_UPDATER, [
        '--offline',
        '--write-report',
        '--date',
        reportDate,
        '--json'
      ], baseEnv));
      assert.strictEqual(output.report, `docs/hubspot-api-updates/${reportDate}.md`);
      const report = fs.readFileSync(reportPath, 'utf8');
      assert.match(report, /## Coverage By Implementation Status/);
      assert.match(report, /## Coverage By Risk/);
      assert.match(report, /## Coverage By Tier Requirement/);
      assert.match(report, /## Coverage By Scope/);
      assert.match(report, /## Coverage By Family/);
    } finally {
      if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
    }

});

test('67 example.com/oauth/callback\',', async () => {
    const output = parseJsonOutput(await run([
      'auth',
      'authorize-url',
      '--client-id',
      'client-123',
      '--redirect-uri',
      'https://example.com/oauth/callback',
      '--scopes',
      'oauth,crm.objects.contacts.read',
      '--optional-scopes',
      'files',
      '--state',
      'csrf-123'
    ], {
      HSAPI_PORTALS_CONFIG: path.join(os.tmpdir(), 'hsapi-missing-config.json')
    }));
    const url = new URL(output.authorizationUrl);
    assert.strictEqual(url.origin, 'https://app.hubspot.com');
    assert.strictEqual(url.pathname, '/oauth/authorize');
    assert.strictEqual(url.searchParams.get('client_id'), 'client-123');
    assert.strictEqual(url.searchParams.get('redirect_uri'), 'https://example.com/oauth/callback');
    assert.strictEqual(url.searchParams.get('scope'), 'oauth crm.objects.contacts.read');
    assert.strictEqual(url.searchParams.get('optional_scopes'), 'files');
    assert.strictEqual(url.searchParams.get('state'), 'csrf-123');

});

test('68 example.com/oauth/callback\'], baseEnv, {', async () => {
    const output = await expectShowRequest(['auth', 'token', '--client-id', 'client-123', '--client-secret', 'secret-456', '--code', 'code-789', '--redirect-uri', 'https://example.com/oauth/callback'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/oauth/2026-03/token',
      endpointId: 'auth.oauth.token',
      body: {
        grant_type: 'authorization_code',
        client_id: 'client-123',
        client_secret: 'REDACTED',
        code: 'REDACTED',
        redirect_uri: 'https://example.com/oauth/callback'
      }
    });
    assert.strictEqual(output.request.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert(!Object.prototype.hasOwnProperty.call(output.request.headers, 'Authorization'), 'auth token preview must not include Authorization');
    assert.strictEqual(output.authFamily, AUTH_FAMILIES.OAUTH);
    assert.strictEqual(output.auth.family, AUTH_FAMILIES.OAUTH);
    assert.strictEqual(output.auth.provenance, 'catalog');
    assert.strictEqual(output.auth.endpointId, 'auth.oauth.token');
    assert.strictEqual(output.auth.credentialSource.name, 'oauth_command_credentials');

});

test('69 block (47)', async () => {
    const output = await expectShowRequest(['auth', 'refresh', '--client-id', 'client-123', '--client-secret', 'secret-456', '--refresh-token', 'refresh-789'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/oauth/2026-03/token',
      endpointId: 'auth.oauth.refresh',
      body: {
        grant_type: 'refresh_token',
        client_id: 'client-123',
        client_secret: 'REDACTED',
        refresh_token: 'REDACTED'
      }
    });
    assert.strictEqual(output.request.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.strictEqual(output.authFamily, AUTH_FAMILIES.OAUTH);

});

test('70 block (48)', async () => {
    const output = await expectShowRequest(['auth', 'introspect', '--client-id', 'client-123', '--client-secret', 'secret-456', '--refresh-token', 'refresh-789'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/oauth/2026-03/token/introspect',
      endpointId: 'auth.oauth.introspect',
      body: {
        client_id: 'client-123',
        client_secret: 'REDACTED',
        token_type_hint: 'refresh_token',
        token: 'REDACTED'
      }
    });
    assert.strictEqual(output.request.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.strictEqual(output.authFamily, AUTH_FAMILIES.OAUTH);

});

test('71 example.com/oauth/callback\'], baseEnv);', async () => {
    const before = requests.length;
    const result = await run(['auth', 'token', '--client-id', 'client-123', '--client-secret', 'secret-456', '--code', 'code-789', '--redirect-uri', 'https://example.com/oauth/callback'], baseEnv);
    assert.strictEqual(result.status, 2);
    const output = parseJsonOutput(result);
    assert.strictEqual(output.dryRun, true);
    assert.strictEqual(output.body.client_secret, 'REDACTED');
    assert.strictEqual(output.body.code, 'REDACTED');
    assert.strictEqual(requests.length, before, 'auth token without --yes must not call network');

});

test('72 block (49)', async () => {
    const before = requests.length;
    const result = await run(['auth', 'revoke', '--client-id', 'client-123', '--client-secret', 'secret-456', '--refresh-token', 'refresh-789', '--danger-revoke-token'], baseEnv);
    assert.strictEqual(result.status, 2);
    const output = parseJsonOutput(result);
    assert.strictEqual(output.dryRun, true);
    assert.strictEqual(output.body.client_secret, 'REDACTED');
    assert.strictEqual(output.body.token, 'REDACTED');
    assert.strictEqual(requests.length, before, 'auth revoke without --yes must not call network');

});

test('73 127.0.0.1\');', async () => {
    const oauthCatalog = writeTempCatalog((catalog) => {
      for (const name of ['account.details', 'objects.search']) {
        catalog.endpoints.find((endpoint) => endpoint.name === name).auth = {
          family: AUTH_FAMILIES.OAUTH,
          subtype: 'installed_app',
          fallback: 'none'
        };
      }
    });
    const oauthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsapi-oauth-'));
    const oauthConfigForCache = (tokenCachePath) => writeTempConfig(baseUrl, {
      tokenEnv: null,
      auth: {
        defaultFamily: AUTH_FAMILIES.OAUTH,
        oauth: {
          clientIdEnv: 'HSAPI_OAUTH_CLIENT_ID',
          clientSecretEnv: 'HSAPI_OAUTH_CLIENT_SECRET',
          refreshTokenEnv: 'HSAPI_OAUTH_REFRESH_TOKEN',
          tokenCachePath
        }
      }
    });

    const freshCachePath = path.join(oauthDir, 'fresh-cache.json');
    const freshExpiresAt = '2999-01-01T00:00:00.000Z';
    fs.writeFileSync(freshCachePath, JSON.stringify({
      schema: 'hsapi.oauthTokenCache.v1',
      family: AUTH_FAMILIES.OAUTH,
      tokenType: 'bearer',
      accessToken: 'cached-access-token',
      expiresIn: 1800,
      expiresAt: freshExpiresAt,
      refreshedAt: '2026-05-15T00:00:00.000Z'
    }, null, 2));
    const freshOauthConfig = oauthConfigForCache(freshCachePath);

    {
      const before = requests.length;
      const output = parseJsonOutput(await run(['account', 'details', '--show-request'], {
        ...baseEnv,
        HSAPI_PORTALS_CONFIG: freshOauthConfig,
        HSAPI_CATALOG_FILE: oauthCatalog,
        HSAPI_OAUTH_CLIENT_ID: '',
        HSAPI_OAUTH_CLIENT_SECRET: '',
        HSAPI_OAUTH_REFRESH_TOKEN: ''
      }));
      assert.strictEqual(output.showRequest, true);
      assert.strictEqual(output.authFamily, AUTH_FAMILIES.OAUTH);
      assert.strictEqual(output.request.headers.Authorization, 'Bearer <oauth-access-token>');
      assert.strictEqual(output.auth.credentialSource.type, 'oauth_refresh_token');
      assert.strictEqual(output.auth.credentialSource.clientIdEnv, 'HSAPI_OAUTH_CLIENT_ID');
      assert.strictEqual(output.auth.credentialSource.clientSecretEnv, 'HSAPI_OAUTH_CLIENT_SECRET');
      assert.strictEqual(output.auth.credentialSource.refreshTokenEnv, 'HSAPI_OAUTH_REFRESH_TOKEN');
      assert.strictEqual(output.auth.credentialSource.tokenCache.status, 'usable');
      assert.strictEqual(output.auth.credentialSource.tokenCache.accessToken, 'REDACTED');
      assert.strictEqual(output.auth.credentialSource.tokenCache.expiresAt, freshExpiresAt);
      assert(!JSON.stringify(output).includes('cached-access-token'), 'OAuth show-request must not print cached token values');
      assert.strictEqual(requests.length, before, 'OAuth --show-request must not refresh or call the endpoint');
    }

    {
      const before = requests.length;
      const output = parseJsonOutput(await run([
        'request',
        'POST',
        '/crm/objects/2026-03/contacts/search',
        '--show-request',
        '--body',
        '{"access_token":"body-token","filterGroups":[]}'
      ], {
        ...baseEnv,
        HSAPI_PORTALS_CONFIG: freshOauthConfig,
        HSAPI_CATALOG_FILE: oauthCatalog,
        HSAPI_OAUTH_CLIENT_ID: '',
        HSAPI_OAUTH_CLIENT_SECRET: '',
        HSAPI_OAUTH_REFRESH_TOKEN: ''
      }));
      assert.strictEqual(output.authFamily, AUTH_FAMILIES.OAUTH);
      assert.strictEqual(output.request.body.access_token, 'REDACTED');
      assert(!JSON.stringify(output).includes('body-token'), 'OAuth show-request must redact token-like body fields');
      assert.strictEqual(requests.length, before, 'OAuth POST --show-request must not refresh or call the endpoint');
    }

    {
      const beforeToken = requestCount(requests, 'POST', '/oauth/2026-03/token');
      const beforeAccount = requestCount(requests, 'GET', '/account-info/2026-03/details');
      const result = await run(['account', 'details'], {
        ...baseEnv,
        HSAPI_PORTALS_CONFIG: freshOauthConfig,
        HSAPI_CATALOG_FILE: oauthCatalog,
        HSAPI_OAUTH_CLIENT_ID: '',
        HSAPI_OAUTH_CLIENT_SECRET: '',
        HSAPI_OAUTH_REFRESH_TOKEN: ''
      });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.strictEqual(requestCount(requests, 'POST', '/oauth/2026-03/token'), beforeToken, 'fresh OAuth cache must not refresh');
      assert.strictEqual(requestCount(requests, 'GET', '/account-info/2026-03/details'), beforeAccount + 1);
      assert.strictEqual(requests.at(-1).headers.authorization, 'Bearer cached-access-token');
    }

    {
      const refreshCachePath = path.join(oauthDir, 'refresh-cache.json');
      fs.writeFileSync(refreshCachePath, JSON.stringify({
        schema: 'hsapi.oauthTokenCache.v1',
        family: AUTH_FAMILIES.OAUTH,
        tokenType: 'bearer',
        accessToken: 'expired-access-token',
        expiresIn: 1800,
        expiresAt: '2000-01-01T00:00:00.000Z',
        refreshedAt: '1999-12-31T23:30:00.000Z'
      }, null, 2));
      const beforeToken = requestCount(requests, 'POST', '/oauth/2026-03/token');
      const beforeAccount = requestCount(requests, 'GET', '/account-info/2026-03/details');
      const result = await run(['account', 'details'], {
        ...baseEnv,
        HSAPI_PORTALS_CONFIG: oauthConfigForCache(refreshCachePath),
        HSAPI_CATALOG_FILE: oauthCatalog,
        HSAPI_OAUTH_CLIENT_ID: 'client-id',
        HSAPI_OAUTH_CLIENT_SECRET: 'client-secret',
        HSAPI_OAUTH_REFRESH_TOKEN: 'refresh-token'
      });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.strictEqual(requestCount(requests, 'POST', '/oauth/2026-03/token'), beforeToken + 1, 'expired OAuth cache must refresh once');
      assert.strictEqual(requestCount(requests, 'GET', '/account-info/2026-03/details'), beforeAccount + 1);
      assert.strictEqual(requests.at(-1).headers.authorization, 'Bearer refreshed-access-token');
      const tokenRequest = requests.filter((request) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        return request.method === 'POST' && url.pathname === '/oauth/2026-03/token';
      }).at(-1);
      const tokenBody = new URLSearchParams(tokenRequest.body);
      assert.strictEqual(tokenBody.get('grant_type'), 'refresh_token');
      assert.strictEqual(tokenBody.get('refresh_token'), 'refresh-token');
      const cache = JSON.parse(fs.readFileSync(refreshCachePath, 'utf8'));
      assert.strictEqual(cache.schema, 'hsapi.oauthTokenCache.v1');
      assert.strictEqual(cache.accessToken, 'refreshed-access-token');
      assert.strictEqual(cache.source.refreshTokenEnv, 'HSAPI_OAUTH_REFRESH_TOKEN');
      assert(!JSON.stringify(cache).includes('server-refresh-token-should-not-cache'), 'refresh token responses must not be stored in the access-token cache');
      assert(!result.stdout.includes('refreshed-access-token'), 'OAuth access token must not appear in command output');
      assert(!result.stdout.includes('refresh-token'), 'OAuth refresh token must not appear in command output');
    }

    {
      const missingEnvCachePath = path.join(oauthDir, 'missing-env-cache.json');
      const before = requests.length;
      const result = await run(['account', 'details'], {
        ...baseEnv,
        HSAPI_PORTALS_CONFIG: oauthConfigForCache(missingEnvCachePath),
        HSAPI_CATALOG_FILE: oauthCatalog,
        HSAPI_OAUTH_CLIENT_ID: 'client-id',
        HSAPI_OAUTH_CLIENT_SECRET: '',
        HSAPI_OAUTH_REFRESH_TOKEN: ''
      });
      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /HSAPI_OAUTH_CLIENT_SECRET/);
      assert.match(result.stderr, /HSAPI_OAUTH_REFRESH_TOKEN/);
      assert.strictEqual(requests.length, before, 'missing OAuth env vars must fail before refresh or endpoint execution');
    }

    {
      const failedRefreshCachePath = path.join(oauthDir, 'failed-refresh-cache.json');
      const beforeToken = requestCount(requests, 'POST', '/oauth/2026-03/token');
      const beforeAccount = requestCount(requests, 'GET', '/account-info/2026-03/details');
      const result = await run(['account', 'details'], {
        ...baseEnv,
        HSAPI_PORTALS_CONFIG: oauthConfigForCache(failedRefreshCachePath),
        HSAPI_CATALOG_FILE: oauthCatalog,
        HSAPI_OAUTH_CLIENT_ID: 'client-id',
        HSAPI_OAUTH_CLIENT_SECRET: 'client-secret',
        HSAPI_OAUTH_REFRESH_TOKEN: 'bad-refresh-token'
      });
      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /HubSpot 4xx response category INVALID_AUTHENTICATION/);
      assert(!result.stderr.includes('bad-refresh-token'), 'failed refresh error must not print refresh token values');
      assert(!result.stderr.includes('server-refresh-token-should-redact'), 'failed refresh error must not print response token fields');
      assert.strictEqual(requestCount(requests, 'POST', '/oauth/2026-03/token'), beforeToken + 1);
      assert.strictEqual(requestCount(requests, 'GET', '/account-info/2026-03/details'), beforeAccount, 'failed refresh must not call the target endpoint');
    }

});

test('74 example.com/logo.png\', \'--folder-path\', \'/library/imports\', \'--access\', \'PRIVATE', async () => {
    await expectShowRequest(['crm', 'list', 'deals', '--limit', '5'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/crm/objects/2026-03/deals',
      endpointId: 'objects.list'
    });
    await expectShowRequest(['crm', 'get', 'contacts', '101', '--properties', 'email,firstname', '--id-property', 'email'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/crm/objects/2026-03/contacts/101',
      endpointId: 'objects.get'
    });
    {
      const output = await expectShowRequest(['crm', 'get', 'contacts', '101', '--properties', 'email', '--properties-with-history', 'lifecyclestage,hs_lead_status'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/crm/objects/2026-03/contacts/101',
        endpointId: 'objects.get'
      });
      const url = new URL(output.request.url);
      assert.deepStrictEqual(url.searchParams.getAll('properties'), ['email']);
      assert.deepStrictEqual(url.searchParams.getAll('propertiesWithHistory'), ['lifecyclestage', 'hs_lead_status']);
    }
    await expectShowRequest(['crm', 'search', 'deals', '--filter', 'dealstage:EQ:closedwon', '--properties', 'dealname,amount', '--search', 'renewal', '--sort', 'createdate:DESC', '--after', 'paging-token', '--limit', '10'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/objects/2026-03/deals/search',
      endpointId: 'objects.search',
      body: {
        filterGroups: [{ filters: [{ propertyName: 'dealstage', operator: 'EQ', value: 'closedwon' }] }],
        limit: 10,
        properties: ['dealname', 'amount'],
        sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
        query: 'renewal',
        after: 'paging-token'
      }
    });
    await expectShowRequest(['crm', 'search', 'contacts', '--filter', 'email:EQ:ada@example.com', '--properties', 'email', '--properties-with-history', 'lifecyclestage'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/objects/2026-03/contacts/search',
      endpointId: 'objects.search',
      body: {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: 'ada@example.com' }] }],
        limit: 10,
        properties: ['email'],
        propertiesWithHistory: ['lifecyclestage']
      }
    });
    await expectShowRequest(['crm', 'create', 'contacts', '--properties', '{"email":"ada@example.com","firstname":"Ada"}'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/objects/2026-03/contacts',
      endpointId: 'objects.create',
      body: { properties: { email: 'ada@example.com', firstname: 'Ada' } }
    });
    await expectShowRequest(['crm', 'create', 'deals', '--body', '{"properties":{"dealname":"Test deal"},"associations":[]}'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/objects/2026-03/deals',
      endpointId: 'objects.create',
      body: { properties: { dealname: 'Test deal' }, associations: [] }
    });
    await expectShowRequest(['crm', 'update', 'tickets', '101', '--properties', '{"subject":"Updated"}'], baseEnv, {
      requests,
      method: 'PATCH',
      pathname: '/crm/objects/2026-03/tickets/101',
      endpointId: 'objects.update',
      body: { properties: { subject: 'Updated' } }
    });
    await expectShowRequest(['crm', 'archive', 'companies', '101'], baseEnv, {
      requests,
      method: 'DELETE',
      pathname: '/crm/objects/2026-03/companies/101',
      endpointId: 'objects.archive'
    });
    await expectShowRequest(['crm', 'merge', 'contacts', '101', '202', '--danger-merge'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/objects/2026-03/contacts/merge',
      endpointId: 'objects.merge',
      body: { primaryObjectId: '101', objectIdToMerge: '202' }
    });
    await expectShowRequest(['crm', 'gdpr-delete', 'contacts', 'ada@example.com', '--id-property', 'email', '--danger-gdpr-delete'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/objects/2025-09/contacts/gdpr-delete',
      endpointId: 'objects.gdpr_delete',
      body: { objectId: 'ada@example.com', idProperty: 'email' }
    });
    await expectShowRequest(['crm', 'batch-read', 'contacts', '--ids', '101,102', '--properties', 'email,firstname', '--properties-with-history', 'lifecyclestage'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/objects/2026-03/contacts/batch/read',
      endpointId: 'objects.batch_read',
      body: {
        inputs: [{ id: '101' }, { id: '102' }],
        properties: ['email', 'firstname'],
        propertiesWithHistory: ['lifecyclestage']
      }
    });
    await expectShowRequest(['crm', 'batch-create', 'contacts', '--inputs', '[{"properties":{"email":"ada@example.com","firstname":"Ada"}}]'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/objects/2026-03/contacts/batch/create',
      endpointId: 'objects.batch_create',
      body: { inputs: [{ properties: { email: 'ada@example.com', firstname: 'Ada' } }] }
    });
    await expectShowRequest(['crm', 'batch-update', 'contacts', '--id-property', 'email', '--inputs', '[{"id":"ada@example.com","properties":{"firstname":"Ada"}}]'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/objects/2026-03/contacts/batch/update',
      endpointId: 'objects.batch_update',
      body: { inputs: [{ id: 'ada@example.com', properties: { firstname: 'Ada' }, idProperty: 'email' }] }
    });
    await expectShowRequest(['crm', 'batch-upsert', 'contacts', '--id-property', 'email', '--inputs', '[{"id":"ada@example.com","properties":{"firstname":"Ada"}}]'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/objects/2026-03/contacts/batch/upsert',
      endpointId: 'objects.batch_upsert',
      body: { inputs: [{ id: 'ada@example.com', properties: { firstname: 'Ada' }, idProperty: 'email' }] }
    });
    await expectShowRequest(['crm', 'batch-archive', 'contacts', '--ids', '101,102'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/objects/2026-03/contacts/batch/archive',
      endpointId: 'objects.batch_archive',
      body: { inputs: [{ id: '101' }, { id: '102' }] }
    });
    {
      const output = parseJsonOutput(await run(['crm', 'object-types', '--family', 'optional'], baseEnv));
      assert.strictEqual(output.ok, true);
      assert(output.names === undefined, 'full object-type output should include object metadata');
      assert(output.objectTypes.some((entry) => entry.objectType === 'appointments' && entry.objectTypeId === '0-421'));
      assert(output.objectTypes.some((entry) => entry.objectType === 'leads' && entry.objectTypeId === '0-136'));
    }
    {
      const output = parseJsonOutput(await run(['crm', 'resolve-object', 'project'], baseEnv));
      assert.strictEqual(output.resolved, true);
      assert.strictEqual(output.source, 'standard-catalog');
      assert.strictEqual(output.objectType, 'projects');
      assert.strictEqual(output.objectTypeId, '0-970');
      assert.strictEqual(output.customLookup, undefined);
    }
    {
      const before = requests.length;
      const output = parseJsonOutput(await run(['crm', 'resolve-object', 'project', '--custom-fallback'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      }));
      assert.strictEqual(output.resolved, true);
      assert.strictEqual(output.source, 'standard-catalog');
      assert.strictEqual(output.objectTypeId, '0-970');
      assert.strictEqual(requests.length, before, 'standard objects should resolve before any custom-schema lookup');
    }
    {
      const before = requests.length;
      const result = await run(['crm', 'resolve-object', 'widget', '--custom-fallback'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.resolved, false);
      assert.strictEqual(output.source, 'unresolved');
      assert.deepStrictEqual(output.customLookup, {
        attempted: true,
        available: false,
        status: 403,
        statusText: 'Forbidden',
        note: 'A 403 on custom-object/schema endpoints can mean either the app token is missing the needed API scope, or the portal subscription does not include custom objects/schemas. Check both the token scopes and the HubSpot tier matrix before assuming the API is broken.'
      });
      assert.strictEqual(requests.length, before + 1, 'custom fallback should make one schema lookup for unresolved objects');
      assert.strictEqual(requests.at(-1).url, '/crm-object-schemas/2026-03/schemas');
    }
    await expectShowRequest(['crm', 'get', 'project object', '101'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/crm/objects/2026-03/projects/101',
      endpointId: 'objects.get'
    });
    await expectShowRequest(['object-library', 'status', 'project'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/crm/object-library/2026-03/enablement/0-970',
      endpointId: 'object_library.enablement_for_type'
    });
    {
      const result = await run(['crm', 'search', 'companies', '--filter', 'hs_object_id:GT:0', '--count-only'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const output = parseJsonOutput(result);
      assert.deepStrictEqual(output, {
        ok: true,
        portal: 'test',
        objectType: 'companies',
        source: 'crm.search',
        filters: ['hs_object_id:GT:0'],
        count: 42,
        countType: 'exact',
        countSource: 'response.total'
      });
      assert(!Object.prototype.hasOwnProperty.call(output, 'data'), 'count-only output must not include data');
      assert(!Object.prototype.hasOwnProperty.call(output, 'results'), 'count-only output must not include results');
      assert(!Object.prototype.hasOwnProperty.call(output, 'rateLimit'), 'count-only output must not include rate limit metadata');
      const requestBody = JSON.parse(requests.at(-1).body);
      assert.strictEqual(requests.at(-1).url, '/crm/objects/2026-03/companies/search');
      assert.strictEqual(requestBody.limit, 1);
      assert.deepStrictEqual(requestBody.filterGroups[0].filters, [
        { propertyName: 'hs_object_id', operator: 'GT', value: '0' }
      ]);
      assert(!Object.prototype.hasOwnProperty.call(requestBody, 'properties'), 'count-only search should not request record properties');
    }
    {
      const result = await run(['crm', 'search', 'companies', '--filter', 'hs_object_id:GT:0', '--properties-with-history', 'lifecyclestage', '--count-only'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.count, 42);
      const requestBody = JSON.parse(requests.at(-1).body);
      assert.strictEqual(requestBody.limit, 1);
      assert(!Object.prototype.hasOwnProperty.call(requestBody, 'properties'), 'count-only search should not request record properties');
      assert(!Object.prototype.hasOwnProperty.call(requestBody, 'propertiesWithHistory'), 'count-only search should not request property history');
    }
    {
      const output = parseJsonOutput(await run(['crm', 'search', 'contacts', '--filter', 'email:EQ:ada@example.com', '--properties', 'email', '--properties-with-history', 'lifecyclestage', '--show-request', '--compact', '--pick', 'request.body.properties,request.body.propertiesWithHistory'], baseEnv));
      assert.deepStrictEqual(output, {
        'request.body.properties': ['email'],
        'request.body.propertiesWithHistory': ['lifecyclestage']
      });
    }
    {
      const result = await run(['crm', 'list', 'contacts', '--properties', 'email,firstname', '--count-only'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.ok, true);
      assert.strictEqual(output.portal, 'test');
      assert.strictEqual(output.objectType, 'contacts');
      assert.strictEqual(output.source, 'crm.list');
      assert.strictEqual(output.count, 1);
      assert.strictEqual(output.countType, 'page-limited');
      assert.strictEqual(output.countSource, 'first-page');
      assert.strictEqual(output.pageLimit, 1);
      assert.strictEqual(output.returnedCount, 1);
      assert.strictEqual(output.hasMore, true);
      assert.strictEqual(output.nextAfter, 'contact-page-2');
      assert(!Object.prototype.hasOwnProperty.call(output, 'data'), 'list count-only output must not include data');
      assert(!requests.at(-1).url.includes('properties='), 'list count-only should not request record properties');
      assert(requests.at(-1).url.includes('limit=1'), 'list count-only should request a one-row page');
    }
    {
      const result = await run(['crm', 'list', 'contacts', '--properties', 'email', '--ids-only'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.deepStrictEqual(parseJsonOutput(result), {
        ok: true,
        portal: 'test',
        count: 1,
        ids: ['101']
      });
    }
    {
      const result = await run(['crm', 'search', 'contacts', '--filter', 'email:EQ:ada@example.com', '--properties', 'email,firstname', '--id-name-map'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.deepStrictEqual(parseJsonOutput(result), {
        ok: true,
        portal: 'test',
        count: 1,
        items: [{ id: '101', name: 'ada@example.com' }]
      });
    }
    {
      const result = await run(['crm', 'search', 'companies', '--filter', 'hs_object_id:GT:0', '--id-name-map', '--compact', '--max-results', '1'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.deepStrictEqual(parseJsonOutput(result), {
        ok: true,
        portal: 'test',
        count: 1,
        items: [{ id: 'company-1', name: 'Example Company' }]
      });
    }
    {
      const result = await run(['crm', 'count', 'companies'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.ok, true);
      assert.strictEqual(output.portal, 'test');
      assert.strictEqual(output.objectType, 'companies');
      assert.strictEqual(output.count, 42);
      assert.strictEqual(output.countType, 'exact');
      assert.deepStrictEqual(output.filters, ['hs_object_id:GT:0']);
      assert.strictEqual(output.defaultFilter, true);
    }
    {
      const result = await run(['crm', 'exists', 'contacts', '--filter', 'email:EQ:ada@example.com'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const output = parseJsonOutput(result);
      assert.deepStrictEqual(output, {
        ok: true,
        portal: 'test',
        objectType: 'contacts',
        source: 'crm.search',
        filters: ['email:EQ:ada@example.com'],
        exists: true,
        count: 1,
        countType: 'exact',
        countSource: 'response.total'
      });
    }
    {
      const result = await run(['crm', 'find-one', 'contacts', '--filter', 'email:EQ:ada@example.com', '--properties', 'email,firstname'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.ok, true);
      assert.strictEqual(output.portal, 'test');
      assert.strictEqual(output.objectType, 'contacts');
      assert.strictEqual(output.found, true);
      assert.strictEqual(output.count, 1);
      assert.strictEqual(output.countType, 'exact');
      assert.deepStrictEqual(output.properties, ['email', 'firstname']);
      assert.strictEqual(output.record.id, '101');
      assert.deepStrictEqual(output.record.properties, { email: 'ada@example.com', firstname: 'Ada' });
      const requestBody = JSON.parse(requests.at(-1).body);
      assert.strictEqual(requestBody.limit, 1);
      assert.deepStrictEqual(requestBody.properties, ['email', 'firstname']);
    }
    {
      const result = await run(['properties', 'names', 'contacts'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const output = parseJsonOutput(result);
      assert.deepStrictEqual(output, {
        ok: true,
        portal: 'test',
        objectType: 'contacts',
        count: 3,
        names: ['createdate', 'email', 'firstname']
      });
    }
    {
      const result = await run(['properties', 'list', 'contacts', '--names-only'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.deepStrictEqual(parseJsonOutput(result), {
        ok: true,
        portal: 'test',
        objectType: 'contacts',
        count: 3,
        names: ['createdate', 'email', 'firstname']
      });
    }
    {
      const result = await run(['files', 'search', '--name', 'brand', '--id-name-map'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.deepStrictEqual(parseJsonOutput(result), {
        ok: true,
        portal: 'test',
        count: 2,
        items: [
          { id: 'file-1', name: 'logo.png' },
          { id: 'file-2', name: 'brand-guide.pdf' }
        ]
      });
    }
    {
      const result = await run(['files', 'search', '--name', 'brand', '--id-name-map', '--max-results', '1'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.deepStrictEqual(parseJsonOutput(result), {
        ok: true,
        portal: 'test',
        truncated: true,
        truncation: {
          reason: 'max-results',
          path: 'data.results',
          maxResults: 1,
          originalResultCount: 2,
          returnedResultCount: 1,
          nextAfter: null
        },
        count: 1,
        items: [{ id: 'file-1', name: 'logo.png' }]
      });
    }
    {
      const result = await run(['crm', 'list', 'contacts', '--ids-only', '--select', 'data.results[].id'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /cannot be used with --select/);
    }
    {
      const before = requests.length;
      const result = await run(['crm', 'batch-update', 'contacts', '--inputs', '[{"id":"101","properties":{"firstname":"Blocked"}}]'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'crm batch-update without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['crm', 'create', 'contacts', '--properties', '{"email":"blocked@example.com"}'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'crm create without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['crm', 'archive', 'companies', '101'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'crm archive without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['crm', 'merge', 'contacts', '101', '202', '--yes'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /--danger-merge/);
      assert.strictEqual(requests.length, before, 'crm merge without danger flag must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['crm', 'gdpr-delete', 'contacts', '101', '--yes'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /--danger-gdpr-delete/);
      assert.strictEqual(requests.length, before, 'crm gdpr-delete without danger flag must not call network');
    }
    await expectShowRequest(['properties', 'get', 'deals', 'dealname'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/crm/properties/2026-03/deals/dealname',
      endpointId: 'properties.get'
    });
    await expectShowRequest([
      'properties',
      'create',
      'deals',
      '--name',
      'test_agent_property',
      '--label',
      'Test Agent Property',
      '--type',
      'string',
      '--field-type',
      'text',
      '--group',
      'dealinformation',
      '--hidden',
      'false'
    ], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/properties/2026-03/deals',
      endpointId: 'properties.create',
      body: {
        name: 'test_agent_property',
        label: 'Test Agent Property',
        type: 'string',
        fieldType: 'text',
        groupName: 'dealinformation',
        hidden: false
      }
    });
    await expectShowRequest(['properties', 'update', 'deals', 'test_agent_property', '--label', 'Updated Label'], baseEnv, {
      requests,
      method: 'PATCH',
      pathname: '/crm/properties/2026-03/deals/test_agent_property',
      endpointId: 'properties.update',
      body: { label: 'Updated Label' }
    });
    await expectShowRequest(['properties', 'archive', 'deals', 'test_agent_property'], baseEnv, {
      requests,
      method: 'DELETE',
      pathname: '/crm/properties/2026-03/deals/test_agent_property',
      endpointId: 'properties.archive'
    });
    await expectShowRequest(['associations', 'types', 'contacts', 'companies'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/crm/associations/2026-03/contacts/companies/labels',
      endpointId: 'associations.labels'
    });
    await expectShowRequest(['associations', 'list', 'contacts', '101', 'companies'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/crm/objects/2026-03/contacts/101/associations/companies',
      endpointId: 'associations.records.list'
    });
    await expectShowRequest(['associations', 'create-default', 'contacts', '101', 'companies', '9001'], baseEnv, {
      requests,
      method: 'PUT',
      pathname: '/crm/objects/2026-03/contacts/101/associations/default/companies/9001',
      endpointId: 'associations.records.create_default'
    });
    await expectShowRequest(['associations', 'create', 'contacts', '101', 'companies', '9001', '--category', 'HUBSPOT_DEFINED', '--type-id', '279'], baseEnv, {
      requests,
      method: 'PUT',
      pathname: '/crm/objects/2026-03/contacts/101/associations/companies/9001',
      endpointId: 'associations.records.create_labeled',
      body: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 279 }]
    });
    await expectShowRequest(['associations', 'delete', 'contacts', '101', 'companies', '9001'], baseEnv, {
      requests,
      method: 'DELETE',
      pathname: '/crm/objects/2026-03/contacts/101/associations/companies/9001',
      endpointId: 'associations.records.delete'
    });
    await expectShowRequest(['associations', 'batch-read', 'contacts', 'companies', '--ids', '101,102'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/associations/2026-03/contacts/companies/batch/read',
      endpointId: 'associations.records.batch_read',
      body: { inputs: [{ id: '101' }, { id: '102' }] }
    });
    await expectShowRequest(['associations', 'batch-create-default', 'contacts', 'companies', '--inputs', '[{"from":{"id":"101"},"to":{"id":"9001"}}]'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/associations/2026-03/contacts/companies/batch/associate/default',
      endpointId: 'associations.records.batch_create_default',
      body: { inputs: [{ from: { id: '101' }, to: { id: '9001' } }] }
    });
    await expectShowRequest(['associations', 'batch-create', 'contacts', 'companies', '--inputs', '[{"from":{"id":"101"},"to":{"id":"9001"},"types":[{"associationCategory":"HUBSPOT_DEFINED","associationTypeId":279}]}]'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/associations/2026-03/contacts/companies/batch/create',
      endpointId: 'associations.records.batch_create_labeled',
      body: { inputs: [{ from: { id: '101' }, to: { id: '9001' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 279 }] }] }
    });
    await expectShowRequest(['associations', 'batch-archive', 'contacts', 'companies', '--inputs', '[{"from":{"id":"101"},"to":[{"id":"9001"}]}]'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/associations/2026-03/contacts/companies/batch/archive',
      endpointId: 'associations.records.batch_archive',
      body: { inputs: [{ from: { id: '101' }, to: [{ id: '9001' }] }] }
    });
    await expectShowRequest(['associations', 'batch-labels-archive', 'contacts', 'companies', '--inputs', '[{"from":{"id":"101"},"to":{"id":"9001"},"types":[{"associationCategory":"USER_DEFINED","associationTypeId":42}]}]'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/associations/2026-03/contacts/companies/batch/labels/archive',
      endpointId: 'associations.records.batch_labels_archive',
      body: { inputs: [{ from: { id: '101' }, to: { id: '9001' }, types: [{ associationCategory: 'USER_DEFINED', associationTypeId: 42 }] }] }
    });
    await expectShowRequest(['lists', 'search', '--search', 'Renewals', '--count', '10'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/lists/2026-03/search',
      endpointId: 'lists.search',
      body: { count: 10, query: 'Renewals' }
    });
    await expectShowRequest(['lists', 'create', '--name', 'Test List', '--object-type-id', '0-1', '--processing-type', 'MANUAL'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/lists/2026-03',
      endpointId: 'lists.create',
      body: { name: 'Test List', objectTypeId: '0-1', processingType: 'MANUAL' }
    });
    await expectShowRequest(['lists', 'membership-update', '123', '--add', '101,102', '--remove', '103'], baseEnv, {
      requests,
      method: 'PUT',
      pathname: '/crm/lists/2026-03/123/memberships/add-and-remove',
      endpointId: 'lists.membership_update',
      body: { recordIdsToAdd: ['101', '102'], recordIdsToRemove: ['103'] }
    });
    await expectShowRequest(['lists', 'memberships-clear', '123'], baseEnv, {
      requests,
      method: 'DELETE',
      pathname: '/crm/lists/2026-03/123/memberships',
      endpointId: 'lists.memberships_clear'
    });
    await expectShowRequest(['lists', 'record-memberships', '0-1', '101'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/crm/lists/2026-03/records/0-1/101/memberships',
      endpointId: 'lists.record_memberships'
    });
    await expectShowRequest(['exports', 'start', '--export-name', 'Contact export', '--object-type', 'contacts', '--properties', 'email,firstname', '--format', 'CSV'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/exports/2026-03/export/async',
      endpointId: 'exports.start',
      body: {
        exportType: 'VIEW',
        format: 'CSV',
        exportName: 'Contact export',
        objectType: 'contacts',
        objectProperties: ['email', 'firstname'],
        associatedObjectType: [],
        includeLabeledAssociations: false,
        includePrimaryDisplayPropertyForAssociatedObjects: false,
        language: 'EN',
        exportInternalValuesOptions: ['NAMES'],
        overrideAssociatedObjectsPerDefinitionPerRowLimit: false
      }
    });
    await expectShowRequest(['exports', 'status', 'task-123'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/crm/exports/2026-03/export/async/tasks/task-123/status',
      endpointId: 'exports.status'
    });
    await expectShowRequest(['imports', 'start', '--import-request', `@${importRequestPath}`, '--file', importCsv], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/imports/2026-03',
      endpointId: 'imports.start',
      body: {
        importRequest: JSON.parse(fs.readFileSync(importRequestPath, 'utf8')),
        files: [{ field: 'files', path: importCsv, filename: 'contacts.csv', size: fs.statSync(importCsv).size }]
      }
    });
    await expectShowRequest(['imports', 'errors', '456', '--include-row-data', 'true'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/crm/imports/2026-03/456/errors',
      endpointId: 'imports.errors'
    });
    {
      const output = await expectShowRequest(['subscriptions', 'definitions', '--include-translations', 'true'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/communication-preferences/2026-03/definitions',
        endpointId: 'subscriptions.definitions'
      });
      assert.strictEqual(output.request.query.includeTranslations, 'true');
    }
    {
      const output = await expectShowRequest(['subscriptions', 'status', 'ada@example.com', '--business-unit-id', '0'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/communication-preferences/2026-03/statuses/ada%40example.com',
        endpointId: 'subscriptions.status'
      });
      assert.strictEqual(output.request.query.channel, 'EMAIL');
      assert.strictEqual(output.request.query.businessUnitId, '0');
    }
    await expectShowRequest([
      'subscriptions',
      'set-status',
      'ada@example.com',
      '--subscription-id',
      '123',
      '--status',
      'SUBSCRIBED',
      '--legal-basis',
      'LEGITIMATE_INTEREST_OTHER',
      '--legal-basis-explanation',
      'Requested resubscribe'
    ], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/communication-preferences/2026-03/statuses/ada%40example.com',
      endpointId: 'subscriptions.set_status',
      body: {
        subscriptionId: 123,
        statusState: 'SUBSCRIBED',
        channel: 'EMAIL',
        legalBasis: 'LEGITIMATE_INTEREST_OTHER',
        legalBasisExplanation: 'Requested resubscribe'
      }
    });
    {
      const output = await expectShowRequest(['subscriptions', 'unsubscribe-all-status', 'ada@example.com', '--verbose', 'true'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/communication-preferences/2026-03/statuses/ada%40example.com/unsubscribe-all',
        endpointId: 'subscriptions.unsubscribe_all_status'
      });
      assert.strictEqual(output.request.query.verbose, 'true');
    }
    {
      const output = await expectShowRequest(['subscriptions', 'unsubscribe-all', 'ada@example.com', '--verbose', 'true'], baseEnv, {
        requests,
        method: 'POST',
        pathname: '/communication-preferences/2026-03/statuses/ada%40example.com/unsubscribe-all',
        endpointId: 'subscriptions.unsubscribe_all',
        body: null
      });
      assert.strictEqual(output.request.query.verbose, 'true');
    }
    await expectShowRequest(['subscriptions', 'batch-read', '--emails', 'ada@example.com,grace@example.com'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/communication-preferences/2026-03/statuses/batch/read',
      endpointId: 'subscriptions.batch_read',
      body: { inputs: ['ada@example.com', 'grace@example.com'] }
    });
    await expectShowRequest(['subscriptions', 'batch-unsubscribe-all-read', '--emails', 'ada@example.com,grace@example.com'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/communication-preferences/2026-03/statuses/batch/unsubscribe-all/read',
      endpointId: 'subscriptions.batch_unsubscribe_all_read',
      body: { inputs: ['ada@example.com', 'grace@example.com'] }
    });
    await expectShowRequest(['subscriptions', 'batch-write', '--inputs', '[{"subscriberIdString":"ada@example.com","subscriptionId":123,"statusState":"UNSUBSCRIBED","channel":"EMAIL"}]'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/communication-preferences/2026-03/statuses/batch/write',
      endpointId: 'subscriptions.batch_write',
      body: {
        inputs: [{
          subscriberIdString: 'ada@example.com',
          subscriptionId: 123,
          statusState: 'UNSUBSCRIBED',
          channel: 'EMAIL'
        }]
      }
    });
    await expectShowRequest(['subscriptions', 'generate-links', 'ada@example.com', '--subscription-id', '123', '--language', 'en'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/communication-preferences/v4/links/generate',
      endpointId: 'subscriptions.generate_links',
      body: {
        subscriberIdString: 'ada@example.com',
        language: 'en',
        subscriptionId: 123
      }
    });
    {
      const output = await expectShowRequest(['files', 'search', '--name', 'logo', '--limit', '5', '--properties', 'name'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/files/2026-03/files/search',
        endpointId: 'files.search'
      });
      assert.strictEqual(output.request.query.name, 'logo');
      assert.strictEqual(output.request.query.limit, '5');
      assert.strictEqual(output.request.query.properties, 'name');
    }
    {
      const output = await expectShowRequest(['files', 'get', '123', '--properties', 'name'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/files/2026-03/files/123',
        endpointId: 'files.get'
      });
      assert.strictEqual(output.request.query.properties, 'name');
    }
    {
      const output = await expectShowRequest(['files', 'signed-url', '123', '--properties', 'url'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/files/2026-03/files/123/signed-url',
        endpointId: 'files.signed_url'
      });
      assert.strictEqual(output.request.query.property, 'url');
    }
    await expectShowRequest(['files', 'upload', '--file', uploadFile, '--folder-path', '/library/brand', '--access', 'PRIVATE'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/files/2026-03/files',
      endpointId: 'files.upload',
      body: {
        file: { field: 'file', path: uploadFile, filename: 'logo.txt', size: fs.statSync(uploadFile).size },
        options: { access: 'PRIVATE' },
        folderPath: '/library/brand'
      }
    });
    await expectShowRequest(['files', 'replace', '123', '--file', uploadFile, '--access', 'PRIVATE'], baseEnv, {
      requests,
      method: 'PUT',
      pathname: '/files/2026-03/files/123',
      endpointId: 'files.replace',
      body: {
        file: { field: 'file', path: uploadFile, filename: 'logo.txt', size: fs.statSync(uploadFile).size },
        options: { access: 'PRIVATE' }
      }
    });
    await expectShowRequest(['files', 'update', '123', '--name', 'logo-updated', '--access', 'PUBLIC_NOT_INDEXABLE', '--clear-expires', 'true'], baseEnv, {
      requests,
      method: 'PATCH',
      pathname: '/files/2026-03/files/123',
      endpointId: 'files.update',
      body: {
        name: 'logo-updated',
        access: 'PUBLIC_NOT_INDEXABLE',
        clearExpires: true
      }
    });
    await expectShowRequest(['files', 'import-url', '--url', 'https://example.com/logo.png', '--folder-path', '/library/imports', '--access', 'PRIVATE'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/files/2026-03/files/import-from-url/async',
      endpointId: 'files.import_url',
      body: {
        access: 'PRIVATE',
        duplicateValidationScope: 'ENTIRE_PORTAL',
        duplicateValidationStrategy: 'NONE',
        overwrite: false,
        url: 'https://example.com/logo.png',
        folderPath: '/library/imports'
      }
    });
    await expectShowRequest(['files', 'import-status', 'task-123'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/files/2026-03/files/import-from-url/async/tasks/task-123/status',
      endpointId: 'files.import_status'
    });
    {
      const output = await expectShowRequest(['files', 'folder-search', '--path', '/library', '--limit', '10'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/files/2026-03/folders/search',
        endpointId: 'files.folders.search'
      });
      assert.strictEqual(output.request.query.path, '/library');
      assert.strictEqual(output.request.query.limit, '10');
    }
    await expectShowRequest(['files', 'folder-get', '456', '--properties', 'name'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/files/2026-03/folders/456',
      endpointId: 'files.folders.get'
    });
    await expectShowRequest(['files', 'folder-create', '--name', 'brand', '--parent-folder-path', '/library'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/files/2026-03/folders',
      endpointId: 'files.folders.create',
      body: { name: 'brand', parentFolderPath: '/library' }
    });
    await expectShowRequest(['files', 'folder-update', '456', '--name', 'brand-assets'], baseEnv, {
      requests,
      method: 'PATCH',
      pathname: '/files/2026-03/folders/456',
      endpointId: 'files.folders.update',
      body: { name: 'brand-assets' }
    });
    await expectShowRequest(['files', 'folder-update-async', '456', '--parent-folder-id', '789'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/files/2026-03/folders/update/async',
      endpointId: 'files.folders.update_async',
      body: { id: '456', parentFolderId: '789' }
    });
    await expectShowRequest(['files', 'folder-update-status', 'folder-task-123'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/files/2026-03/folders/update/async/tasks/folder-task-123/status',
      endpointId: 'files.folders.update_status'
    });
    await expectShowRequest(['files', 'delete', '123'], baseEnv, {
      requests,
      method: 'DELETE',
      pathname: '/files/2026-03/files/123',
      endpointId: 'files.delete'
    });
    await expectShowRequest(['files', 'gdpr-delete', '123', '--danger-gdpr-delete'], baseEnv, {
      requests,
      method: 'DELETE',
      pathname: '/files/2026-03/files/123/gdpr-delete',
      endpointId: 'files.gdpr_delete'
    });
    {
      const output = await expectShowRequest(['events', 'occurrences', '--event-type', 'e_visited_page', '--object-type', 'contact', '--object-id', '224834'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/events/event-occurrences/2026-03',
        endpointId: 'events.occurrences'
      });
      assert.strictEqual(output.request.query.eventType, 'e_visited_page');
      assert.strictEqual(output.request.query.objectType, 'contact');
      assert.strictEqual(output.request.query.objectId, '224834');
    }
    await expectShowRequest(['events', 'definition-create', '--name', 'pe_test_event', '--label', 'Test Event', '--object-type', 'contact'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/events/2026-03/event-definitions',
      endpointId: 'events.definitions.create',
      body: { name: 'pe_test_event', label: 'Test Event', objectType: 'contact' }
    });
    await expectShowRequest(['events', 'send', '--event-name', 'pe_test_event', '--email', 'ada@example.com', '--properties', '{"source":"test"}'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/events/2026-03/send',
      endpointId: 'events.send',
      body: { eventName: 'pe_test_event', email: 'ada@example.com', properties: { source: 'test' } }
    });
    await expectShowRequest(['webhooks', 'settings', '12345'], {
      ...baseEnv,
      HSAPI_PORTALS_CONFIG: developerOnlyConfig
    }, {
      requests,
      method: 'GET',
      pathname: '/webhooks/2026-03/12345/settings',
      endpointId: 'webhooks.settings'
    });
    await expectShowRequest(['webhooks', 'subscription-create', '12345', '--subscription-type', 'contact.propertyChange', '--property-name', 'email', '--active', 'true'], {
      ...baseEnv,
      HSAPI_PORTALS_CONFIG: developerOnlyConfig
    }, {
      requests,
      method: 'POST',
      pathname: '/webhooks/2026-03/12345/subscriptions',
      endpointId: 'webhooks.subscription_create',
      body: { subscriptionType: 'contact.propertyChange', propertyName: 'email', active: true }
    });
    const webhookJournalConfig = writeTempConfig(baseUrl, {
      tokenEnv: null,
      auth: {
        developer: {
          clientIdEnv: 'HSAPI_DEVELOPER_CLIENT_ID',
          clientSecretEnv: 'HSAPI_DEVELOPER_CLIENT_SECRET',
          tokenCachePath: path.join(os.tmpdir(), `hsapi-webhook-journal-${Date.now()}-${process.pid}.json`)
        }
      }
    });
    const webhookJournalEnv = {
      ...baseEnv,
      HSAPI_PORTALS_CONFIG: webhookJournalConfig,
      HSAPI_DEVELOPER_CLIENT_ID: 'webhook-journal-client-id',
      HSAPI_DEVELOPER_CLIENT_SECRET: 'webhook-journal-client-secret'
    };
    const journalBatchPreview = await expectShowRequest(['webhook-journal', 'journal-batch-read', '--offsets', '101,102'], webhookJournalEnv, {
      requests,
      method: 'POST',
      pathname: '/webhooks-journal/journal/2026-03/batch/read',
      endpointId: 'webhook_journal.journal_batch_read',
      body: { offsets: [101, 102] }
    });
    assert.strictEqual(journalBatchPreview.authSubtype, DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS);
    assert.strictEqual(journalBatchPreview.request.headers.Authorization, 'Bearer <developer-client-credentials-access-token>');
    await expectShowRequest(['webhook-journal', 'subscription-create', '--portal-id', '999', '--callback-url', 'https://example.com/hooks'], webhookJournalEnv, {
      requests,
      method: 'POST',
      pathname: '/webhooks-journal/subscriptions/2026-03',
      endpointId: 'webhook_journal.subscriptions.create',
      body: { portalId: '999', callbackUrl: 'https://example.com/hooks' }
    });
    {
      const output = await expectShowRequest(['conversations', 'threads', '--inbox-id', 'inbox-1', '--limit', '10'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/conversations/conversations/2026-09-beta/threads',
        endpointId: 'conversations.threads.list'
      });
      assert.strictEqual(output.request.query.inboxId, 'inbox-1');
      assert.strictEqual(output.request.query.limit, '10');
    }
    await expectShowRequest(['conversations', 'message-create', 'thread-1', '--text', 'Hello from hsapi', '--actor-id', 'A-1'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/conversations/conversations/2026-09-beta/threads/thread-1/messages',
      endpointId: 'conversations.messages.create',
      body: { text: 'Hello from hsapi', actorId: 'A-1' }
    });
    await expectShowRequest(['conversations', 'actors-batch-read', '--ids', 'A-1,A-2'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/conversations/conversations/2026-09-beta/actors/batch/read',
      endpointId: 'conversations.actors.batch_read',
      body: { inputs: [{ id: 'A-1' }, { id: 'A-2' }] }
    });
    await expectShowRequest(['conversations', 'custom-message-create', 'channel-1', '--text', 'Custom hello', '--channel-account-id', 'acct-1'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/conversations/custom-channels/2026-03/channel-1/messages',
      endpointId: 'conversations.custom_messages.create',
      body: { text: 'Custom hello', channelAccountId: 'acct-1' }
    });
    await expectShowRequest(['conversations', 'visitor-token', '--email', 'ada@example.com', '--first-name', 'Ada'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/visitor-identification/2026-03/tokens/create',
      endpointId: 'conversations.visitor_token',
      body: { email: 'ada@example.com', firstName: 'Ada' }
    });
    {
      const output = await expectShowRequest(['forms', 'list', '--form-types', 'hubspot', '--limit', '10'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/marketing/v3/forms',
        endpointId: 'forms.list'
      });
      assert.strictEqual(output.request.query.formTypes, 'hubspot');
      assert.strictEqual(output.request.query.limit, '10');
    }
    await expectShowRequest(['forms', 'get', 'form-123'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/marketing/v3/forms/form-123',
      endpointId: 'forms.get'
    });
    await expectShowRequest(['forms', 'create', '--name', 'Lead Capture', '--field-groups', '[{"fields":[{"name":"email"}]}]', '--configuration', '{"language":"en"}'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/marketing/v3/forms',
      endpointId: 'forms.create',
      body: {
        name: 'Lead Capture',
        fieldGroups: [{ fields: [{ name: 'email' }] }],
        configuration: { language: 'en' },
        formType: 'hubspot'
      }
    });
    {
      const output = await expectShowRequest(['forms', 'submissions', 'form-guid-123', '--limit', '20'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/form-integrations/v1/submissions/forms/form-guid-123',
        endpointId: 'forms.submissions'
      });
      assert.strictEqual(output.request.query.limit, '20');
    }
    {
      const output = await expectShowRequest(['forms', 'submit', '999', 'form-guid-123', '--fields', '[{"name":"email","value":"ada@example.com"}]', '--context', '{"pageUri":"https://example.com"}'], baseEnv, {
        requests,
        method: 'POST',
        pathname: '/submissions/v3/integration/submit/999/form-guid-123',
        endpointId: 'forms.submit',
        body: {
          fields: [{ name: 'email', value: 'ada@example.com' }],
          context: { pageUri: 'https://example.com' }
        }
      });
      assert.strictEqual(output.request.url, 'https://api.hsforms.com/submissions/v3/integration/submit/999/form-guid-123');
      assert(!Object.prototype.hasOwnProperty.call(output.request.headers, 'Authorization'), 'forms submit preview must not include Authorization');
      assert.strictEqual(output.authFamily, null);
      assert.strictEqual(output.auth.required, false);
      assert.strictEqual(output.auth.provenance, 'catalog');
      assert.strictEqual(output.auth.reason, 'unauthenticated_form_submission');
    }
    {
      const output = await expectShowRequest(['forms', 'secure-submit', '999', 'form-guid-123', '--fields', '[{"name":"email","value":"ada@example.com"}]'], baseEnv, {
        requests,
        method: 'POST',
        pathname: '/submissions/v3/integration/secure/submit/999/form-guid-123',
        endpointId: 'forms.secure_submit',
        body: {
          fields: [{ name: 'email', value: 'ada@example.com' }]
        }
      });
      assert.strictEqual(output.request.url, 'https://api.hsforms.com/submissions/v3/integration/secure/submit/999/form-guid-123');
      assert.strictEqual(output.request.headers.Authorization, 'Bearer $HSAPI_TEST_TOKEN');
      assert.strictEqual(output.authFamily, AUTH_FAMILIES.PORTAL_BEARER);
    }
    {
      const output = await expectShowRequest([
        'cms',
        'site-pages',
        'list',
        '--state',
        'PUBLISHED_OR_SCHEDULED',
        '--publish-date-lt',
        '2026-06-01T00:00:00Z',
        '--limit',
        '10'
      ], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/cms/pages/2026-03/site-pages',
        endpointId: 'cms.pages.site.list'
      });
      assert.strictEqual(output.request.query.state__in, 'PUBLISHED_OR_SCHEDULED');
      assert.strictEqual(output.request.query.publishDate__lt, '2026-06-01T00:00:00Z');
      assert.strictEqual(output.request.query.limit, '10');
    }
    await expectShowRequest([
      'cms',
      'site-pages',
      'create',
      '--name',
      'Home Draft',
      '--template-path',
      '/@hubspot/basic/templates/layouts/blank.html',
      '--slug',
      'home-draft',
      '--state',
      'DRAFT',
      '--featured-image',
      'https://example.com/hero.jpg',
      '--layout-sections',
      '{}'
    ], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/cms/pages/2026-03/site-pages',
      endpointId: 'cms.pages.site.create',
      body: {
        name: 'Home Draft',
        templatePath: '@hubspot/basic/templates/layouts/blank.html',
        slug: 'home-draft',
        state: 'DRAFT',
        featuredImage: 'https://example.com/hero.jpg',
        useFeaturedImage: true,
        layoutSections: {}
      }
    });
    await expectShowRequest(['cms', 'site-pages', 'draft-update', '123', '--html-title', 'Updated title', '--widgets', '{}'], baseEnv, {
      requests,
      method: 'PATCH',
      pathname: '/cms/pages/2026-03/site-pages/123/draft',
      endpointId: 'cms.pages.site.draft_update',
      body: {
        htmlTitle: 'Updated title',
        widgets: {}
      }
    });
    await expectShowRequest(['cms', 'site-pages', 'schedule', '123', '--publish-date', '2026-06-01T15:00:00Z'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/cms/pages/2026-03/site-pages/schedule',
      endpointId: 'cms.pages.site.schedule',
      body: {
        id: '123',
        publishDate: '2026-06-01T15:00:00Z'
      }
    });
    await expectShowRequest(['cms', 'landing-pages', 'draft-get', '456'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/cms/pages/2026-03/landing-pages/456/draft',
      endpointId: 'cms.pages.landing.draft_get'
    });
    await expectShowRequest(['cms', 'landing-pages', 'push-live', '456'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/cms/pages/2026-03/landing-pages/456/draft/push-live',
      endpointId: 'cms.pages.landing.push_live'
    });
    {
      const output = await expectShowRequest(['cms', 'blog-posts', 'list', '--content-group-id', '456', '--state', 'PUBLISHED', '--limit', '10'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/cms/blogs/2026-03/posts',
        endpointId: 'cms.blogs.posts.list'
      });
      assert.strictEqual(output.request.query.contentGroupId__eq, '456');
      assert.strictEqual(output.request.query.state, 'PUBLISHED');
      assert.strictEqual(output.request.query.limit, '10');
    }
    await expectShowRequest([
      'cms',
      'blog-posts',
      'create',
      '--name',
      'Draft post',
      '--content-group-id',
      '456',
      '--slug',
      'draft-post',
      '--post-body',
      '<p>Hello</p>',
      '--html-title',
      'Draft post',
      '--tag-ids',
      '11,12',
      '--featured-image',
      'https://example.com/post.jpg',
      '--meta-description',
      'A post'
    ], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/cms/blogs/2026-03/posts',
      endpointId: 'cms.blogs.posts.create',
      body: {
        name: 'Draft post',
        contentGroupId: '456',
        slug: 'draft-post',
        metaDescription: 'A post',
        featuredImage: 'https://example.com/post.jpg',
        useFeaturedImage: true,
        postBody: '<p>Hello</p>',
        htmlTitle: 'Draft post',
        tagIds: ['11', '12']
      }
    });
    await expectShowRequest(['cms', 'blog-posts', 'draft-reset', '789'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/cms/blogs/2026-03/posts/789/draft/reset',
      endpointId: 'cms.blogs.posts.draft_reset'
    });
    await expectShowRequest(['cms', 'blog-posts', 'schedule', '789', '--publish-date', '2026-06-01T15:00:00Z'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/cms/blogs/2026-03/posts/schedule',
      endpointId: 'cms.blogs.posts.schedule',
      body: {
        id: '789',
        publishDate: '2026-06-01T15:00:00Z'
      }
    });
    await expectShowRequest(['cms', 'redirects', 'create', '--route-prefix', '/old', '--destination', '/new', '--redirect-style', '301', '--is-pattern', 'true', '--is-protocol-agnostic', 'true'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/cms/url-redirects/2026-03',
      endpointId: 'cms.url_redirects.create',
      body: {
        routePrefix: '/old',
        destination: '/new',
        redirectStyle: 301,
        isPattern: true,
        isProtocolAgnostic: true
      }
    });
    await expectShowRequest(['cms', 'redirects', 'update', '321', '--destination', '/updated'], baseEnv, {
      requests,
      method: 'PATCH',
      pathname: '/cms/url-redirects/2026-03/321',
      endpointId: 'cms.url_redirects.update',
      body: {
        destination: '/updated'
      }
    });
    {
      const output = await expectShowRequest(['cms', 'domains', 'list', '--limit', '5'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/cms/domains/2026-03',
        endpointId: 'cms.domains.list'
      });
      assert.strictEqual(output.request.query.limit, '5');
    }
    await expectShowRequest(['cms', 'domains', 'get', '55'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/cms/domains/2026-03/55',
      endpointId: 'cms.domains.get'
    });
    {
      const output = await expectShowRequest(['cms', 'search', '--q', 'marketing', '--type', 'BLOG_POST', '--domain', 'blog.example.com', '--path-prefix', '/blog', '--limit', '10'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/cms/site-search/2026-03/search',
        endpointId: 'cms.site_search.search'
      });
      assert.strictEqual(output.request.query.q, 'marketing');
      assert.strictEqual(output.request.query.type, 'BLOG_POST');
      assert.strictEqual(output.request.query.domain, 'blog.example.com');
      assert.strictEqual(output.request.query.pathPrefix, '/blog');
      assert.strictEqual(output.request.query.limit, '10');
    }
    await expectShowRequest(['cms', 'indexed-data', '123', '--type', 'SITE_PAGE'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/cms/site-search/2026-03/indexed-data/123',
      endpointId: 'cms.site_search.indexed_data'
    });
    {
      const output = await expectShowRequest(['cms', 'hubdb', 'tables', 'list', '--limit', '5'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/cms/hubdb/2026-03/tables',
        endpointId: 'cms.hubdb.tables.list'
      });
      assert.strictEqual(output.request.query.limit, '5');
    }
    await expectShowRequest(['cms', 'hubdb', 'tables', 'get', 'agent_table'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/cms/hubdb/2026-03/tables/agent_table',
      endpointId: 'cms.hubdb.tables.get'
    });
    await expectShowRequest(['cms', 'hubdb', 'tables', 'create', '--name', 'agent_table', '--label', 'Agent Table', '--columns', '[{"name":"title","label":"Title","type":"TEXT"}]', '--allow-public-api-access', 'true'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/cms/hubdb/2026-03/tables',
      endpointId: 'cms.hubdb.tables.create',
      body: {
        name: 'agent_table',
        label: 'Agent Table',
        columns: [{ name: 'title', label: 'Title', type: 'TEXT' }],
        allowPublicApiAccess: true
      }
    });
    {
      const output = await expectShowRequest(['cms', 'hubdb', 'rows', 'list', 'agent_table', '--limit', '10', '--offset', '20'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/cms/hubdb/2026-03/tables/agent_table/rows',
        endpointId: 'cms.hubdb.rows.list'
      });
      assert.strictEqual(output.request.query.limit, '10');
      assert.strictEqual(output.request.query.offset, '20');
    }
    await expectShowRequest(['cms', 'hubdb', 'rows', 'create', 'agent_table', '--values', '{"title":"Hello"}', '--name', 'hello', '--path', 'hello'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/cms/hubdb/2026-03/tables/agent_table/rows',
      endpointId: 'cms.hubdb.rows.create',
      body: {
        values: { title: 'Hello' },
        name: 'hello',
        path: 'hello'
      }
    });
    await expectShowRequest(['cms', 'source-code', 'upload', 'draft', '/theme/main.css', '--file', uploadFile], baseEnv, {
      requests,
      method: 'PUT',
      pathname: '/cms/source-code/2026-03/draft/content/theme/main.css',
      endpointId: 'cms.source_code.upload',
      body: {
        file: { field: 'file', path: uploadFile, filename: 'logo.txt', size: fs.statSync(uploadFile).size }
      }
    });
    await expectShowRequest(['cms', 'source-code', 'validate', 'draft', '/theme/main.css', '--file', uploadFile], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/cms/source-code/2026-03/draft/validate/theme/main.css',
      endpointId: 'cms.source_code.validate',
      body: {
        file: { field: 'file', path: uploadFile, filename: 'logo.txt', size: fs.statSync(uploadFile).size }
      }
    });
    await expectShowRequest(['cms', 'source-code', 'delete', 'draft', '/theme/main.css'], baseEnv, {
      requests,
      method: 'DELETE',
      pathname: '/cms/source-code/2026-03/draft/content/theme/main.css',
      endpointId: 'cms.source_code.delete'
    });
    {
      const before = requests.length;
      const result = await run(['cms', 'doctor', '--content-id', '123', '--type', 'SITE_PAGE'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.ok, true);
      assert.strictEqual(output.ready, true);
      assert.strictEqual(output.portal.name, 'test');
      assert.strictEqual(output.auth.authFamily, AUTH_FAMILIES.PORTAL_BEARER);
      assert.strictEqual(output.auth.credentialSource.name, 'HSAPI_TEST_TOKEN');
      assert.strictEqual(output.summary.success, 7);
      assert.strictEqual(output.summary.pass, 7);
      assert(!result.stdout.includes('profile-token'), 'cms doctor must not print token values');
      assert(output.checks.every((check) => check.request.method === 'GET'), 'cms doctor must only run GET checks');
      assert.deepStrictEqual(requests.slice(before).map((request) => `${request.method} ${new URL(request.url, baseUrl).pathname}`), [
        'GET /cms/domains/2026-03',
        'GET /cms/pages/2026-03/site-pages',
        'GET /cms/pages/2026-03/landing-pages',
        'GET /cms/blogs/2026-03/posts',
        'GET /cms/url-redirects/2026-03',
        'GET /cms/site-search/2026-03/search',
        'GET /cms/site-search/2026-03/indexed-data/123'
      ]);
    }
    {
      const before = requests.length;
      const output = parseJsonOutput(await run(['cms', 'doctor', '--show-request'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      }));
      assert.strictEqual(output.showRequest, true);
      assert.strictEqual(output.dryRun, true);
      assert.strictEqual(output.checks.find((check) => check.id === 'indexed_data').skipped, true);
      assert.strictEqual(requests.length, before, 'cms doctor --show-request must not call network');
    }
    {
      const partial = await startCmsDoctorFixtureServer((req, res, url, headers) => {
        if (url.pathname === '/cms/pages/2026-03/site-pages') {
          res.writeHead(403, headers);
          res.end(JSON.stringify({ category: 'MISSING_SCOPES', message: 'missing content scope' }));
          return;
        }
        if (url.pathname === '/cms/pages/2026-03/landing-pages') {
          res.writeHead(403, headers);
          res.end(JSON.stringify({ category: 'FEATURE_NOT_AVAILABLE', message: 'Account does not have access to landing pages feature' }));
          return;
        }
        if (url.pathname === '/cms/blogs/2026-03/posts') {
          res.writeHead(500, headers);
          res.end(JSON.stringify({ message: 'upstream failed' }));
          return;
        }
        res.writeHead(200, headers);
        res.end(JSON.stringify({ total: 1, results: [{ id: 'cms-1', name: 'CMS fixture' }] }));
      });
      try {
        const partialConfig = writeTempConfig(partial.baseUrl);
        const result = await run(['cms', 'doctor', '--content-id', 'abc'], {
          HSAPI_PORTALS_CONFIG: partialConfig,
          HSAPI_TEST_TOKEN: 'partial-token'
        });
        assert.strictEqual(result.status, 0, result.stderr || result.stdout);
        const output = parseJsonOutput(result);
        assert.strictEqual(output.ok, true);
        assert.strictEqual(output.ready, false);
        const byId = Object.fromEntries(output.checks.map((check) => [check.id, check]));
        assert.strictEqual(byId.site_pages.capability, 'missing_scopes_or_permissions');
        assert.strictEqual(byId.site_pages.status, 'warn');
        assert.strictEqual(byId.landing_pages.capability, 'unavailable_feature_or_tier');
        assert.strictEqual(byId.landing_pages.status, 'warn');
        assert.strictEqual(byId.blog_posts.capability, 'unexpected_api_failure');
        assert.strictEqual(byId.blog_posts.status, 'fail');
        assert.strictEqual(byId.indexed_data.capability, 'success');
        assert(!result.stdout.includes('partial-token'), 'cms doctor partial output must not print token values');
        assert(partial.requests.every((request) => request.method === 'GET'), 'cms doctor partial fixture must only receive GET checks');
      } finally {
        partial.server.close();
      }
    }
    await expectShowRequest(['marketing', 'emails', 'create', '--name', 'Launch Email', '--subject', 'Launch', '--content', '{"templatePath":"@hubspot/email/dnd/welcome.html"}'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/marketing/emails/2026-03',
      endpointId: 'marketing.emails.create',
      body: {
        name: 'Launch Email',
        subject: 'Launch',
        content: { templatePath: '@hubspot/email/dnd/welcome.html' }
      }
    });
    await expectShowRequest(['marketing', 'emails', 'update', 'email-123', '--subject', 'Updated Launch'], baseEnv, {
      requests,
      method: 'PATCH',
      pathname: '/marketing/emails/2026-03/email-123',
      endpointId: 'marketing.emails.update',
      body: { subject: 'Updated Launch' }
    });
    await expectShowRequest(['marketing', 'emails', 'delete', 'email-123'], baseEnv, {
      requests,
      method: 'DELETE',
      pathname: '/marketing/emails/2026-03/email-123',
      endpointId: 'marketing.emails.delete'
    });
    await expectShowRequest(['marketing', 'campaigns', 'create', '--properties', '{"hs_name":"Launch","hs_notes":"Agent-created"}'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/marketing/campaigns/2026-03',
      endpointId: 'marketing.campaigns.create',
      body: {
        properties: {
          hs_name: 'Launch',
          hs_notes: 'Agent-created'
        }
      }
    });
    {
      const output = await expectShowRequest(['marketing', 'campaigns', 'get', 'campaign-guid-123', '--properties', 'hs_name'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/marketing/campaigns/2026-03/campaign-guid-123',
        endpointId: 'marketing.campaigns.get'
      });
      assert.strictEqual(output.request.query.properties, 'hs_name');
    }
    await expectShowRequest(['marketing', 'campaigns', 'delete', 'campaign-guid-123'], baseEnv, {
      requests,
      method: 'DELETE',
      pathname: '/marketing/campaigns/2026-03/campaign-guid-123',
      endpointId: 'marketing.campaigns.delete'
    });
    {
      const output = await expectShowRequest(['marketing', 'events', 'list', '--limit', '5'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/marketing/marketing-events/2026-03',
        endpointId: 'marketing.events.list'
      });
      assert.strictEqual(output.request.query.limit, '5');
    }
    await expectShowRequest(['marketing', 'events', 'create', '--external-account-id', 'acct-1', '--external-event-id', 'event-1', '--event-name', 'Winter webinar', '--event-organizer', 'Portal Alpha', '--event-url', 'https://example.com/webinar', '--event-cancelled', 'false'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/marketing/marketing-events/2026-03/events',
      endpointId: 'marketing.events.create',
      body: {
        externalAccountId: 'acct-1',
        externalEventId: 'event-1',
        eventName: 'Winter webinar',
        eventOrganizer: 'Portal Alpha',
        eventUrl: 'https://example.com/webinar',
        eventCancelled: false
      }
    });
    await expectShowRequest(['marketing', 'events', 'upsert', '--inputs', '[{"externalAccountId":"acct-1","externalEventId":"event-1","eventName":"Winter webinar","eventOrganizer":"Portal Alpha"}]'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/marketing/marketing-events/2026-03/events/upsert',
      endpointId: 'marketing.events.upsert',
      body: {
        inputs: [{
          externalAccountId: 'acct-1',
          externalEventId: 'event-1',
          eventName: 'Winter webinar',
          eventOrganizer: 'Portal Alpha'
        }]
      }
    });
    await expectShowRequest(['marketing', 'transactional', 'send', '--email-id', '4126643121', '--to', 'ada@example.com', '--send-id', 'agent-send-1', '--custom-properties', '{"purchaseUrl":"https://example.com/receipt"}'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/marketing/transactional/2026-03/single-email/send',
      endpointId: 'marketing.transactional.send',
      body: {
        emailId: 4126643121,
        message: {
          to: 'ada@example.com',
          sendId: 'agent-send-1'
        },
        customProperties: {
          purchaseUrl: 'https://example.com/receipt'
        }
      }
    });
    await expectShowRequest(['automation', 'workflows', 'list'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/automation/v3/workflows',
      endpointId: 'automation.workflows.list'
    });
    {
      const output = await expectShowRequest(['automation', 'workflows', 'get', '10900', '--errors', 'true', '--stats', 'false'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/automation/v3/workflows/10900',
        endpointId: 'automation.workflows.get'
      });
      assert.strictEqual(output.request.query.errors, 'true');
      assert.strictEqual(output.request.query.stats, 'false');
    }
    await expectShowRequest(['automation', 'workflows', 'current-enrollment', '12345'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/automation/v2/workflows/enrollments/contacts/12345',
      endpointId: 'automation.workflows.current_enrollment'
    });
    await expectShowRequest(['automation', 'workflows', 'enroll', '10900', 'ada@example.com'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/automation/v2/workflows/10900/enrollments/contacts/ada%40example.com',
      endpointId: 'automation.workflows.enroll_contact',
      body: null
    });
    {
      const output = await expectShowRequest(['automation', 'sequences', 'list', '--user-id', '2222222', '--limit', '4', '--name', 'Follow-up'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/automation/sequences/2026-03',
        endpointId: 'automation.sequences.list'
      });
      assert.strictEqual(output.request.query.userId, '2222222');
      assert.strictEqual(output.request.query.limit, '4');
      assert.strictEqual(output.request.query.name, 'Follow-up');
    }
    {
      const output = await expectShowRequest(['automation', 'sequences', 'get', 'seq-123', '--user-id', '2222222'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/automation/sequences/2026-03/seq-123',
        endpointId: 'automation.sequences.get'
      });
      assert.strictEqual(output.request.query.userId, '2222222');
    }
    {
      const output = await expectShowRequest(['automation', 'sequences', 'enroll', '--user-id', '2222222', '--sequence-id', 'seq-123', '--contact-id', '33333', '--sender-email', 'seller@example.com', '--sender-alias-address', 'alias@example.com'], baseEnv, {
        requests,
        method: 'POST',
        pathname: '/automation/sequences/2026-03/enrollments',
        endpointId: 'automation.sequences.enroll_contact',
        body: {
          contactId: '33333',
          sequenceId: 'seq-123',
          senderEmail: 'seller@example.com',
          senderAliasAddress: 'alias@example.com'
        }
      });
      assert.strictEqual(output.request.query.userId, '2222222');
    }
    await expectShowRequest(['automation', 'sequences', 'status', '33333'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/automation/sequences/2026-03/enrollments/contact/33333',
      endpointId: 'automation.sequences.enrollment_status'
    });
    await expectShowRequest(['extensions', 'calling', 'settings', 'get', '12345'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/crm/extensions/calling/2026-03/12345/settings',
      endpointId: 'crm.extensions.calling.settings.get'
    });
    await expectShowRequest(['extensions', 'calling', 'settings', 'delete', '12345'], baseEnv, {
      requests,
      method: 'DELETE',
      pathname: '/crm/extensions/calling/2026-03/12345/settings',
      endpointId: 'crm.extensions.calling.settings.delete'
    });
    await expectShowRequest(['extensions', 'videoconferencing', 'settings', 'get', '12345'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/crm/extensions/videoconferencing/2026-03/settings/12345',
      endpointId: 'crm.extensions.videoconferencing.settings.get'
    });
    await expectShowRequest(['extensions', 'videoconferencing', 'settings', 'delete', '12345'], baseEnv, {
      requests,
      method: 'DELETE',
      pathname: '/crm/extensions/videoconferencing/2026-03/settings/12345',
      endpointId: 'crm.extensions.videoconferencing.settings.delete'
    });
    await expectShowRequest(['extensions', 'calling', 'recording-settings', 'get', '12345'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/crm/v3/extensions/calling/12345/settings/recording',
      endpointId: 'crm.extensions.calling.recording_settings.get'
    });
    await expectShowRequest(['extensions', 'calling', 'recording-settings', 'create', '12345', '--url', 'https://example.com/recordings/%s'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/v3/extensions/calling/12345/settings/recording',
      endpointId: 'crm.extensions.calling.recording_settings.create',
      body: { urlToRetrieveAuthedRecording: 'https://example.com/recordings/%s' }
    });
    await expectShowRequest(['extensions', 'calling', 'recording-settings', 'update', '12345', '--body', '{"urlToRetrieveAuthedRecording":"https://example.com/recordings/v2/%s"}'], baseEnv, {
      requests,
      method: 'PATCH',
      pathname: '/crm/v3/extensions/calling/12345/settings/recording',
      endpointId: 'crm.extensions.calling.recording_settings.update',
      body: { urlToRetrieveAuthedRecording: 'https://example.com/recordings/v2/%s' }
    });
    await expectShowRequest(['extensions', 'calling', 'channel-connection', 'delete', '12345'], baseEnv, {
      requests,
      method: 'DELETE',
      pathname: '/crm/extensions/calling/2026-03/12345/settings/channel-connection',
      endpointId: 'crm.extensions.calling.channel_connection.delete'
    });
    await expectShowRequest(['extensions', 'calling', 'recordings', 'ready', '--engagement-id', '987654321'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/extensions/calling/2026-03/recordings/ready',
      endpointId: 'crm.extensions.calling.recordings.ready',
      body: { engagementId: 987654321 }
    });
    await expectShowRequest(['extensions', 'calling', 'transcripts', 'create', '--engagement-id', '987654321', '--utterances', '[{"startTimeMillis":0,"endTimeMillis":1200,"text":"Hello","languageCode":"en","speaker":{"id":"rep-1","name":"Ada","email":"ada@example.com"}}]'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/extensions/calling/2026-03/transcripts',
      endpointId: 'crm.extensions.calling.transcripts.create',
      body: {
        engagementId: 987654321,
        transcriptCreateUtterances: [{
          startTimeMillis: 0,
          endTimeMillis: 1200,
          text: 'Hello',
          languageCode: 'en',
          speaker: {
            id: 'rep-1',
            name: 'Ada',
            email: 'ada@example.com'
          }
        }]
      }
    });
    await expectShowRequest(['extensions', 'calling', 'transcripts', 'get', 'transcript-123'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/crm/extensions/calling/2026-03/transcripts/transcript-123',
      endpointId: 'crm.extensions.calling.transcripts.get'
    });
    {
      const before = requests.length;
      const result = await run(['extensions', 'calling', 'transcripts', 'create', '--body', '[]', '--show-request'], baseEnv);
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /must be a JSON object/);
      assert.strictEqual(requests.length, before, 'extensions calling transcripts create invalid --body must not call network');
    }
    {
      const output = await expectShowRequest(['scheduler', 'links', '--organizer-user-id', '123', '--limit', '5'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/scheduler/2026-03/meetings/meeting-links',
        endpointId: 'scheduler.meeting_links.list'
      });
      assert.strictEqual(output.request.query.organizerUserId, '123');
      assert.strictEqual(output.request.query.limit, '5');
    }
    {
      const output = await expectShowRequest(['scheduler', 'booking-info', 'jdoe', '--timezone', 'America/New_York', '--month-offset', '1'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/scheduler/2026-03/meetings/meeting-links/book/jdoe',
        endpointId: 'scheduler.meeting_links.booking_info'
      });
      assert.strictEqual(output.request.query.timezone, 'America/New_York');
      assert.strictEqual(output.request.query.monthOffset, '1');
    }
    {
      const output = await expectShowRequest(['scheduler', 'availability', 'jdoe', '--timezone', 'America/New_York'], baseEnv, {
        requests,
        method: 'GET',
        pathname: '/scheduler/2026-03/meetings/meeting-links/book/availability-page/jdoe',
        endpointId: 'scheduler.meeting_links.availability'
      });
      assert.strictEqual(output.request.query.timezone, 'America/New_York');
    }
    await expectShowRequest([
      'scheduler',
      'book',
      'jdoe',
      '--email',
      'ada@example.com',
      '--first-name',
      'Ada',
      '--last-name',
      'Lovelace',
      '--start-time',
      '2026-06-01T15:00:00Z',
      '--duration',
      '1800000',
      '--timezone',
      'America/New_York'
    ], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/scheduler/2026-03/meetings/meeting-links/book',
      endpointId: 'scheduler.meeting_links.book',
      body: {
        email: 'ada@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        startTime: '2026-06-01T15:00:00Z',
        duration: 1800000,
        timezone: 'America/New_York',
        slug: 'jdoe'
      }
    });
    {
      const output = await expectShowRequest([
        'scheduler',
        'calendar-create',
        '--organizer-user-id',
        '123',
        '--properties',
        '{"hs_meeting_title":"Original title"}',
        '--title',
        'Discovery call',
        '--start-time',
        '2026-06-01T15:00:00Z',
        '--end-time',
        '2026-06-01T15:30:00Z',
        '--timezone',
        'America/New_York',
        '--associations',
        '[{"to":{"id":"101"},"types":[{"associationCategory":"HUBSPOT_DEFINED","associationTypeId":200}]}]'
      ], baseEnv, {
        requests,
        method: 'POST',
        pathname: '/scheduler/2026-03/meetings/calendar',
        endpointId: 'scheduler.calendar.create',
        body: {
          properties: {
            hs_meeting_title: 'Discovery call',
            hs_meeting_start_time: '2026-06-01T15:00:00Z',
            hs_meeting_end_time: '2026-06-01T15:30:00Z'
          },
          associations: [{
            to: { id: '101' },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 200 }]
          }],
          timezone: 'America/New_York'
        }
      });
      assert.strictEqual(output.request.query.organizerUserId, '123');
    }
    {
      const before = requests.length;
      const result = await run(['cms', 'site-pages', 'create', '--name', 'Blocked page', '--template-path', '/@hubspot/basic/templates/layouts/blank.html'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'cms site-pages create without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['cms', 'redirects', 'delete', '321'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'cms redirects delete without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['properties', 'create', 'deals', '--name', 'blocked_property', '--label', 'Blocked Property', '--type', 'string', '--field-type', 'text', '--group', 'dealinformation'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'properties create without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['associations', 'batch-create', 'contacts', 'companies', '--inputs', '[{"from":{"id":"101"},"to":{"id":"9001"},"types":[{"associationCategory":"HUBSPOT_DEFINED","associationTypeId":279}]}]'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'associations batch-create without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['imports', 'cancel', '456'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'imports cancel without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['subscriptions', 'batch-unsubscribe-all', '--emails', 'ada@example.com,grace@example.com'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'subscriptions batch-unsubscribe-all without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['files', 'upload', '--file', uploadFile, '--folder-path', '/library/brand', '--access', 'PRIVATE'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'files upload without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['cms', 'source-code', 'upload', 'draft', '/theme/main.css', '--file', uploadFile], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'cms source-code upload without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['files', 'gdpr-delete', '123', '--yes'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /--danger-gdpr-delete/);
      assert.strictEqual(requests.length, before, 'files gdpr-delete without danger flag must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['events', 'send', '--event-name', 'pe_test_event', '--email', 'ada@example.com'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'events send without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['marketing', 'transactional', 'send', '--email-id', '4126643121', '--to', 'ada@example.com'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'marketing transactional send without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['automation', 'sequences', 'enroll', '--user-id', '2222222', '--sequence-id', 'seq-123', '--contact-id', '33333', '--sender-email', 'seller@example.com'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'automation sequences enroll without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['automation', 'workflows', 'enroll', '10900', 'ada@example.com'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(output.body, null);
      assert.strictEqual(requests.length, before, 'automation workflows enroll without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['extensions', 'calling', 'recordings', 'ready', '--engagement-id', '987654321'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.deepStrictEqual(output.body, { engagementId: 987654321 });
      assert.strictEqual(requests.length, before, 'extensions calling recordings ready without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['extensions', 'calling', 'recording-settings', 'update', '12345', '--url', 'https://example.com/recordings/%s'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.deepStrictEqual(output.body, { urlToRetrieveAuthedRecording: 'https://example.com/recordings/%s' });
      assert.strictEqual(requests.length, before, 'extensions calling recording-settings update without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['extensions', 'calling', 'settings', 'delete', '12345'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'extensions calling settings delete without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['extensions', 'videoconferencing', 'settings', 'delete', '12345'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(output.body, null);
      assert.strictEqual(requests.length, before, 'extensions videoconferencing settings delete without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['webhook-journal', 'subscription-delete', 'sub-1'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'webhook-journal subscription-delete without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['conversations', 'message-create', 'thread-1', '--text', 'Hi'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'conversations message-create without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['forms', 'create', '--name', 'Blocked form', '--field-groups', '[]'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'forms create without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['forms', 'submit', '999', 'form-guid-123', '--fields', '[{"name":"email","value":"ada@example.com"}]'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'forms submit without --yes must not call network');
      assert.match(output.target, /^https:\/\/api\.hsforms\.com\/submissions\/v3\/integration\/submit\/999\/form-guid-123$/);
    }
    {
      const before = requests.length;
      const result = await run(['forms', 'secure-submit', '999', 'form-guid-123', '--fields', '[{"name":"email","value":"ada@example.com"}]'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'forms secure-submit without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['scheduler', 'book', 'jdoe', '--email', 'ada@example.com', '--start-time', '2026-06-01T15:00:00Z', '--duration', '1800000'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'scheduler book without --yes must not call network');
    }
    {
      const before = requests.length;
      const result = await run(['scheduler', 'calendar-create', '--organizer-user-id', '123', '--title', 'Discovery call', '--start-time', '2026-06-01T15:00:00Z', '--end-time', '2026-06-01T15:30:00Z'], {
        ...baseEnv,
        HSAPI_TEST_TOKEN: 'profile-token'
      });
      assert.strictEqual(result.status, 2);
      const output = parseJsonOutput(result);
      assert.strictEqual(output.dryRun, true);
      assert.match(output.message, /Mutation blocked/);
      assert.strictEqual(requests.length, before, 'scheduler calendar-create without --yes must not call network');
    }
    await expectShowRequest(['property-groups', 'create', 'deals', '--name', 'test_group', '--label', 'Test Group', '--display-order', '5'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/properties/2026-03/deals/groups',
      endpointId: 'property_groups.create',
      body: { name: 'test_group', label: 'Test Group', displayOrder: 5 }
    });
    await expectShowRequest(['property-groups', 'archive', 'deals', 'test_group'], baseEnv, {
      requests,
      method: 'DELETE',
      pathname: '/crm/properties/2026-03/deals/groups/test_group',
      endpointId: 'property_groups.archive'
    });
    await expectShowRequest(['property-validations', 'set', '0-3', 'dealname', 'NON_EMPTY', '--arguments', '{"value":true}'], baseEnv, {
      requests,
      method: 'PUT',
      pathname: '/crm/property-validations/2026-03/0-3/dealname/rule-type/NON_EMPTY',
      endpointId: 'property_validations.set',
      body: { ruleArguments: { value: true } }
    });
    await expectShowRequest(['schemas', 'delete', '2-123', '--danger-archive-schema'], baseEnv, {
      requests,
      method: 'DELETE',
      pathname: '/crm-object-schemas/2026-03/schemas/2-123',
      endpointId: 'schemas.delete'
    });
    await expectShowRequest(['pipelines', 'stage-audit', 'deals', 'default', 'appointmentscheduled'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/crm/pipelines/2026-03/deals/default/stages/appointmentscheduled/audit',
      endpointId: 'pipeline_stages.audit'
    });
    await expectShowRequest(['pipelines', 'stage-create', 'deals', 'default', '--label', 'Contract signed', '--display-order', '4', '--metadata', '{"probability":"0.8"}'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/pipelines/2026-03/deals/default/stages',
      endpointId: 'pipeline_stages.create',
      body: { label: 'Contract signed', displayOrder: 4, metadata: { probability: '0.8' } }
    });
    await expectShowRequest(['pipelines', 'stage-update', 'deals', 'default', 'contractsigned', '--label', 'Contract signed updated'], baseEnv, {
      requests,
      method: 'PATCH',
      pathname: '/crm/pipelines/2026-03/deals/default/stages/contractsigned',
      endpointId: 'pipeline_stages.update',
      body: { label: 'Contract signed updated' }
    });
    await expectShowRequest(['pipelines', 'stage-delete', 'deals', 'default', 'contractsigned'], baseEnv, {
      requests,
      method: 'DELETE',
      pathname: '/crm/pipelines/2026-03/deals/default/stages/contractsigned',
      endpointId: 'pipeline_stages.delete'
    });
    await expectShowRequest(['association-limits', 'create', 'deals', 'contacts', '--category', 'HUBSPOT_DEFINED', '--type-id', '3', '--max-to-object-ids', '5'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/associations/2026-03/definitions/configurations/deals/contacts/batch/create',
      endpointId: 'association_limits.create',
      body: { inputs: [{ category: 'HUBSPOT_DEFINED', typeId: 3, maxToObjectIds: 5 }] }
    });
    await expectShowRequest(['association-limits', 'delete', 'deals', 'contacts', '--category', 'USER_DEFINED', '--type-id', '35'], baseEnv, {
      requests,
      method: 'POST',
      pathname: '/crm/associations/2026-03/definitions/configurations/deals/contacts/batch/purge',
      endpointId: 'association_limits.delete',
      body: { inputs: [{ category: 'USER_DEFINED', typeId: 35 }] }
    });
    await expectShowRequest(['limits', 'associations', '0-1', '0-2'], baseEnv, {
      requests,
      method: 'GET',
      pathname: '/crm/v3/limits/associations/records/0-1/0-2',
      endpointId: 'limits.associations.pair'
    });

});

test('75 block (50)', async () => {
    await run(['limits', 'custom-properties'], { ...baseEnv, HSAPI_TEST_TOKEN: 'profile-token' });
    await run(['limits', 'calculated-properties'], { ...baseEnv, HSAPI_TEST_TOKEN: 'profile-token' });
    await run(['limits', 'association-labels', '0-1', '0-2'], { ...baseEnv, HSAPI_TEST_TOKEN: 'profile-token' });
    await run(['limits', 'custom-object-types'], { ...baseEnv, HSAPI_TEST_TOKEN: 'profile-token' });
    const recentUrls = requests.slice(-4).map((request) => request.url);
    assert.deepStrictEqual(recentUrls, [
      '/crm/v3/limits/custom-properties',
      '/crm/v3/limits/calculated-properties',
      '/crm/v3/limits/associations/labels?fromObjectTypeId=0-1&toObjectTypeId=0-2',
      '/crm/v3/limits/custom-object-types'
    ]);

});

test('76 Issue #11: ~ expansion must work when HOME is absent (Windows sets USERPROFILE,', async () => {
    // Issue #11: ~ expansion must work when HOME is absent (Windows sets USERPROFILE,
    // not HOME). os.homedir() is the fallback; explicit HOME still wins.
    const homeFixConfigPath = writeTempConfig(baseUrl, {
      auth: {
        portalBearer: { tokenEnv: 'HSAPI_TEST_TOKEN' },
        oauth: {
          clientIdEnv: 'HSAPI_TEST_CLIENT_ID',
          clientSecretEnv: 'HSAPI_TEST_CLIENT_SECRET',
          refreshTokenEnv: 'HSAPI_TEST_REFRESH_TOKEN',
          tokenCachePath: '~/hsapi-home-expansion-cache.json'
        }
      }
    });
    const noHome = await run(['profiles', 'list'], {
      HSAPI_PORTALS_CONFIG: homeFixConfigPath,
      HOME: undefined
    });
    assert.strictEqual(noHome.status, 0, noHome.stderr || noHome.stdout);
    const noHomeOutput = JSON.parse(noHome.stdout);
    assert.strictEqual(noHomeOutput.ok, true);
    assert.strictEqual(noHomeOutput.profiles[0].oauth.tokenCache.path, '~/hsapi-home-expansion-cache.json');

    const homeOverrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsapi-home-'));
    const withHome = await run(['auth', 'doctor', '--portal', 'test'], {
      HSAPI_PORTALS_CONFIG: homeFixConfigPath,
      HOME: homeOverrideDir
    });
    assert.strictEqual(withHome.status, 0, withHome.stderr || withHome.stdout);
    assert.strictEqual(JSON.parse(withHome.stdout).ok, true);

});

test('77 Issue #24: automation v4 flows - typed CRUD surface', async () => {
  const env = { ...baseEnv, HSAPI_TEST_TOKEN: 'profile-token' };

  const listed = parseJsonOutput(await run(['automation', 'flows', 'list', '--paginate'], env));
  assert.strictEqual(listed.ok, true);
  assert.strictEqual(listed.pageCount, 2);
  assert.deepStrictEqual(listed.results.map((flow) => flow.id), ['flow-1', 'flow-2']);

  await expectShowRequest(['automation', 'flows', 'get', '12345'], env, {
    requests,
    method: 'GET',
    pathname: '/automation/v4/flows/12345',
    endpointId: 'automation.flows.get'
  });

  await expectShowRequest(['automation', 'flows', 'batch-read', '--ids', '1,2'], env, {
    requests,
    method: 'POST',
    pathname: '/automation/v4/flows/batch/read',
    endpointId: 'automation.flows.batch_read',
    body: { inputs: [{ type: 'FLOW_ID', flowId: '1' }, { type: 'FLOW_ID', flowId: '2' }] }
  });

  await expectShowRequest(['automation', 'flows', 'update', '12345', '--body', '{"revisionId":"9","name":"Renamed"}'], env, {
    requests,
    method: 'PUT',
    pathname: '/automation/v4/flows/12345',
    endpointId: 'automation.flows.update',
    body: { revisionId: '9', name: 'Renamed' }
  });

  const blockedCreate = await run(['automation', 'flows', 'create', '--body', '{"name":"x"}'], env);
  assert.strictEqual(blockedCreate.status, 2, 'flows create without --yes must be a blocked preview');

  const deleteWithoutDanger = await run(['automation', 'flows', 'delete', '12345', '--yes'], env);
  assert.notStrictEqual(deleteWithoutDanger.status, 0);
  assert.match(deleteWithoutDanger.stderr, /--danger-delete-flow/);

  const flowsHelp = parseJsonOutput(await run(['help', 'automation', 'flows', 'update'], env));
  assert.strictEqual(flowsHelp.endpointId, 'automation.flows.update');
  assert.strictEqual(flowsHelp.argsDocumented, true);

  const typo = await run(['automation', 'flows', 'list', '--limt', '5'], env);
  assert.notStrictEqual(typo.status, 0);
  assert.match(typo.stderr, /Unknown flag --limt/);
});
