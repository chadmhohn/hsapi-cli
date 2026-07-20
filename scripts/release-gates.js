#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  endpointDefinitions,
  loadCatalogData,
  summarizeCatalogCoverage
} = require('../src/catalog');
const {
  AUTH_FAMILIES,
  DEVELOPER_AUTH_SUBTYPES,
  VALID_AUTH_FAMILIES,
  VALID_DEVELOPER_AUTH_SUBTYPES
} = require('../src/auth');
const { TOOLS: MCP_TOOLS } = require('../src/mcp-server');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const CATALOG_FILE = path.join(PACKAGE_ROOT, 'data', 'hubspot-api-catalog.json');
const NPM_CLI = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
].find((candidate) => candidate && fs.existsSync(candidate)) || null;
const NPM_BIN = NPM_CLI
  ? process.execPath
  : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const NPM_PREFIX_ARGS = NPM_CLI ? [NPM_CLI] : [];

function execCommand(command, args, options) {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command, ...args], options);
  }
  return execFileSync(command, args, options);
}

const REQUIRED_DOC_PHRASES = [
  ['README.md', 'hsapi auth doctor'],
  ['README.md', 'Package installs and upgrades never create or overwrite'],
  ['README.md', 'hsapi cms doctor'],
  ['README.md', 'hsapi catalog commands'],
  ['docs/INSTALL.md', 'Auth Families'],
  ['docs/INSTALL.md', 'hsapi auth doctor'],
  ['docs/INSTALL.md', 'Package installs and upgrades never create or replace'],
  ['docs/INSTALL.md', 'hsapi cms doctor'],
  ['docs/INSTALL.md', 'MCP Server Mode'],
  ['docs/hubspot-api-context/cms.md', 'hsapi cms doctor'],
  ['docs/hubspot-api-context/projects.md', 'hsapi project doctor'],
  ['docs/hubspot-api-context/projects.md', 'delegatedTo: "official_hubspot_cli"'],
  ['README.md', 'hsapi project doctor'],
  ['docs/INSTALL.md', 'hsapi project doctor'],
  ['docs/MCP.md', 'Direct CLI Mode'],
  ['docs/MCP.md', 'MCP Server Mode'],
  ['docs/MCP.md', 'OpenClaw Config'],
  ['docs/MCP.md', 'Generic MCP Clients'],
  ['docs/MCP.md', 'Neutral Token Source'],
  ['docs/DESKTOP_MCP_QUICKSTART.md', 'Codex Desktop Quickstart'],
  ['docs/DESKTOP_MCP_QUICKSTART.md', 'Claude Desktop Quickstart'],
  ['docs/DESKTOP_MCP_QUICKSTART.md', 'HSAPI_PORTALS_CONFIG'],
  ['docs/MCP.md', 'Reversible Local Migration Runbook'],
  ['docs/CMS_PROJECTS_AUTH_BOUNDARY.md', 'CMS and Projects Auth Boundary'],
  ['docs/CMS_PROJECTS_AUTH_BOUNDARY.md', 'hsapi --portal <profile>'],
  ['docs/CMS_PROJECTS_AUTH_BOUNDARY.md', 'hs project'],
  ['docs/CMS_PROJECTS_AUTH_BOUNDARY.md', '~/.hscli/config.yml'],
  ['docs/CMS_PROJECTS_AUTH_BOUNDARY.md', 'must not silently consume'],
  ['docs/OPENCLAW_MCP_CUTOVER.md', 'OpenClaw MCP Cutover Runbook'],
  ['docs/OPENCLAW_MCP_CUTOVER.md', 'hubspot-portal-alpha'],
  ['docs/OPENCLAW_MCP_CUTOVER.md', 'hubspot-portal-beta'],
  ['docs/OPENCLAW_MCP_CUTOVER.md', 'openclaw mcp set <name> <JSON object>'],
  ['docs/OPENCLAW_MCP_CUTOVER.md', 'Local MCP Smoke Tests Before Live Change'],
  ['docs/OPENCLAW_MCP_CUTOVER.md', 'Live Smoke Tests After Cutover'],
  ['docs/OPENCLAW_MCP_CUTOVER.md', 'Approval Gate For Live Cutover'],
  ['docs/OPENCLAW_MCP_CUTOVER.md', 'Rollback'],
  ['docs/TEST_PORTAL_MATRIX.md', 'auth family'],
  ['README.md', 'MCP server mode'],
  ['README.md', 'neutral token-source wrapper'],
  ['docs/RELEASE_CHECKLIST.md', 'secret redaction'],
  ['docs/RELEASE_CHECKLIST.md', 'auth-family coverage'],
  ['docs/RELEASE_CHECKLIST.md', 'MCP release gate'],
  ['docs/RELEASE_CHECKLIST.md', 'hsapi auth doctor'],
  ['docs/OAUTH_SETUP.md', 'Package installs and upgrades never create, download, or overwrite'],
  ['docs/hubspot-api-context/portal-auth-setup.md', 'Portal Profile Setup for Users and AI Assistants'],
  ['docs/hubspot-api-context/portal-auth-setup.md', 'ServiceKey'],
  ['docs/hubspot-api-context/portal-auth-setup.md', 'hosted_broker'],
  ['docs/hubspot-api-context/portal-auth-setup.md', 'hsapi_context_doc'],
  ['AGENTS.md', 'portal-auth-setup'],
  ['CLAUDE.md', 'portal-auth-setup'],
  ['README.md', 'portals.oauth-hosted.sample.json'],
  ['docs/INSTALL.md', 'portals.oauth-service-key.sample.json'],
  ['docs/DESKTOP_MCP_QUICKSTART.md', 'npx --yes --package=github:chadmhohn/hsapi-cli'],
  ['cloudflare/hsapi-oauth-broker/README.md', 'controlled staging/internal enrollment'],
  ['cloudflare/hsapi-oauth-broker/README.md', 'wrangler.operator.jsonc']
];

const DISALLOWED_PACKAGE_PATHS = [
  /^config\//,
  /(^|\/)openclaw\.json$/i,
  /(^|\/)\.env($|\.)/,
  /(^|\/)(hubspot-portals|portals|test-matrix)\.json$/,
  /(^|\/).*local.*config.*\.json$/i,
  /(^|\/).*token-cache.*\.json$/i,
  /(^|\/).*oauth.*cache.*\.json$/i
];

const ALLOWED_PACKAGE_PATHS = new Set([
  'examples/mcp-server.sample.json',
  'examples/portals.sample.json',
  'examples/portals.test-matrix.sample.json'
]);

const REQUIRED_MCP_PACKAGE_FILES = [
  'bin/hsapi-mcp.js',
  'docs/MCP.md',
  'docs/OPENCLAW_MCP_CUTOVER.md',
  'docs/DESKTOP_MCP_QUICKSTART.md',
  'examples/mcp-server.sample.json',
  'examples/openclaw-cutover.mcp.sample.json',
  'src/mcp-server.js'
];

const REQUIRED_NEUTRAL_TOKEN_FILES = [
  'examples/neutral-token-wrapper.sample.sh',
  'examples/portals.multi-portal.sample.json'
];

const REQUIRED_AUTH_BOUNDARY_PACKAGE_FILES = [
  'docs/CMS_PROJECTS_AUTH_BOUNDARY.md'
];

const REQUIRED_PORTAL_ONBOARDING_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'docs/hubspot-api-context/portal-auth-setup.md',
  'examples/portals.sample.json',
  'examples/portals.oauth-hosted.sample.json',
  'examples/portals.oauth-service-key.sample.json'
];

const REQUIRED_BIN_ENTRIES = {
  hsapi: 'bin/hsapi.js',
  'hsapi-mcp': 'bin/hsapi-mcp.js'
};

const REQUIRED_MCP_TOOLS = [
  'hsapi_profiles_list',
  'hsapi_catalog_coverage',
  'hsapi_catalog_commands',
  'hsapi_auth_doctor',
  'hsapi_command_execute',
  'hsapi_request_execute'
];

const FORBIDDEN_MCP_TOOL_ARGUMENTS = new Set([
  'yes',
  'showSecrets',
  'show-secrets',
  'rawValue',
  'raw-value'
]);

const REQUIRED_MCP_SERVER_MARKERS = [
  'redactMcpValue',
  'FORBIDDEN_COMMAND_FLAGS',
  'show-secrets',
  'mutation_blocked',
  'not_catalog_backed'
];

const PRIVATE_BRAND_PATTERN = new RegExp('\\b(?:' + ['ground' + 'work', 'blue' + 'fish'].join('|') + ')\\b', 'i');
const PRIVATE_MAINTAINER_PATTERN = new RegExp('\\b' + 'Ch' + 'ad' + '\\b');

const DISALLOWED_CONTENT_PATTERNS = [
  {
    pattern: /\/root\/(?:\.config|\.ssh|\.openclaw)\//,
    label: 'local root config path'
  },
  {
    pattern: /\bHOME=\/root\b/,
    label: 'local HOME override'
  },
  {
    pattern: /pat-[A-Za-z0-9_-]{20,}/,
    label: 'HubSpot private-app-token-like value'
  },
  {
    pattern: /hapikey=(?!REDACTED)[A-Za-z0-9_-]{10,}/,
    label: 'developer API key query value'
  },
  {
    pattern: /"(?:accessToken|access_token|refreshToken|refresh_token|clientSecret|client_secret|developerApiKey|developer_api_key|personalAccessKey|personal_access_key)"\s*:\s*"(?!REDACTED|<|\$|HUBSPOT_|HSAPI_)[^"]{8,}"/,
    label: 'JSON secret value'
  },
  {
    pattern: PRIVATE_BRAND_PATTERN,
    label: 'branded portal/org name'
  },
  {
    pattern: PRIVATE_MAINTAINER_PATTERN,
    label: 'private maintainer name'
  },
  {
    pattern: /\b(?:portalId|accountId|hubId|HUBSPOT_ACCOUNT_ID)\s*[:=]\s*["']?\d{5,}["']?/,
    label: 'concrete HubSpot account/portal ID'
  },
  {
    pattern: /https:\/\/app\.hubspot\.com\/oauth\/\d{5,}\//i,
    label: 'concrete HubSpot OAuth account URL'
  },
  {
    pattern: /https:\/\/[a-z0-9-]+\.(?!REPLACE\.)[a-z0-9-]+\.workers\.dev\b/i,
    label: 'concrete Cloudflare Worker hostname'
  }
];

function readText(relativePath) {
  return fs.readFileSync(path.join(PACKAGE_ROOT, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function packageFiles() {
  const npmCache = fs.mkdtempSync(path.join(os.tmpdir(), 'hsapi-release-gates-npm-'));
  try {
    const output = execCommand(NPM_BIN, [...NPM_PREFIX_ARGS, 'pack', '--dry-run', '--json'], {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        npm_config_cache: npmCache,
        npm_config_update_notifier: 'false'
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const pack = JSON.parse(output)[0];
    return (pack.files || []).map((file) => file.path).sort();
  } finally {
    fs.rmSync(npmCache, { recursive: true, force: true });
  }
}

function validateCatalog(failures) {
  const catalog = loadCatalogData(CATALOG_FILE);
  const coverage = summarizeCatalogCoverage(catalog);
  const definitions = endpointDefinitions(CATALOG_FILE);
  const typedDefinitions = definitions.filter((definition) => definition.status === 'typed');

  for (const definition of definitions) {
    if (!definition.auth) {
      failures.push(`${definition.id} is missing auth metadata.`);
      continue;
    }
    if (definition.auth.fallback !== 'none') {
      failures.push(`${definition.id} must declare auth.fallback "none".`);
    }
    if (definition.auth.required === false) {
      if (definition.auth.family !== null) {
        failures.push(`${definition.id} unauthenticated metadata must not declare an auth family.`);
      }
      continue;
    }
    if (!VALID_AUTH_FAMILIES.has(definition.auth.family)) {
      failures.push(`${definition.id} uses unsupported auth family ${definition.auth.family || '<missing>'}.`);
    }
    if (definition.auth.family === AUTH_FAMILIES.DEVELOPER) {
      if (!VALID_DEVELOPER_AUTH_SUBTYPES.has(definition.auth.subtype)) {
        failures.push(`${definition.id} uses unsupported developer auth subtype ${definition.auth.subtype || '<missing>'}.`);
      }
      if (
        definition.auth.subtype === DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS
        && (!definition.auth.scopes || !definition.auth.scopes.length)
      ) {
        failures.push(`${definition.id} developer/client_credentials auth must declare scopes.`);
      }
    }
  }

  for (const definition of typedDefinitions) {
    if (!definition.command) failures.push(`${definition.id} is typed but missing command metadata.`);
    if (!definition.auth) failures.push(`${definition.id} typed command is missing auth metadata.`);
  }

  for (const family of Object.values(AUTH_FAMILIES)) {
    if (!coverage.byAuthFamily[family]) {
      failures.push(`Catalog coverage must include at least one endpoint for auth family ${family}.`);
    }
  }
  if (!coverage.noAuthRequiredCount) {
    failures.push('Catalog coverage must include intentional unauthenticated endpoint metadata.');
  }

  return {
    endpointCount: definitions.length,
    typedCommandCount: typedDefinitions.length,
    byAuthFamily: coverage.byAuthFamily,
    noAuthRequiredCount: coverage.noAuthRequiredCount
  };
}

function validateDocs(failures) {
  for (const [relativePath, phrase] of REQUIRED_DOC_PHRASES) {
    const text = readText(relativePath);
    if (!text.toLowerCase().includes(phrase.toLowerCase())) {
      failures.push(`${relativePath} must mention "${phrase}".`);
    }
  }
}

function validateMcpPackageSurface(failures, files) {
  const packageJson = readJson('package.json');
  const packageFileSet = new Set(files);

  for (const relativePath of REQUIRED_MCP_PACKAGE_FILES) {
    if (!packageFileSet.has(relativePath)) {
      failures.push('Package dry-run must include MCP file: ' + relativePath + '.');
    }
  }

  for (const [binName, relativePath] of Object.entries(REQUIRED_BIN_ENTRIES)) {
    if (!packageJson.bin || packageJson.bin[binName] !== relativePath) {
      failures.push('package.json bin.' + binName + ' must point to ' + relativePath + '.');
    }
    if (!packageFileSet.has(relativePath)) {
      failures.push('Package dry-run must include bin entry file: ' + relativePath + '.');
    }
    const absolutePath = path.join(PACKAGE_ROOT, relativePath);
    if (!fs.existsSync(absolutePath)) {
      failures.push('Bin entry file is missing: ' + relativePath + '.');
      continue;
    }
    const text = fs.readFileSync(absolutePath, 'utf8');
    if (!text.startsWith('#!/usr/bin/env node')) {
      failures.push('Bin entry file must start with a node shebang: ' + relativePath + '.');
    }
    if (process.platform !== 'win32' && (fs.statSync(absolutePath).mode & 0o111) === 0) {
      failures.push('Bin entry file must be executable: ' + relativePath + '.');
    }
  }

  const cliText = readText('src/cli.js');
  if (!cliText.includes("area === 'mcp' && action === 'serve'")) {
    failures.push('src/cli.js must route hsapi mcp serve to the MCP stdio server.');
  }

  const mcpBinText = readText('bin/hsapi-mcp.js');
  if (!mcpBinText.includes('serveMcpStdio')) {
    failures.push('bin/hsapi-mcp.js must start the shared MCP stdio server.');
  }

  return {
    requiredFiles: REQUIRED_MCP_PACKAGE_FILES,
    binEntries: REQUIRED_BIN_ENTRIES
  };
}

function validateAuthBoundaryPackageSurface(failures, files) {
  const packageFileSet = new Set(files);
  for (const relativePath of REQUIRED_AUTH_BOUNDARY_PACKAGE_FILES) {
    if (!packageFileSet.has(relativePath)) {
      failures.push('Package dry-run must include auth-boundary doc: ' + relativePath + '.');
    }
  }
  return { requiredFiles: REQUIRED_AUTH_BOUNDARY_PACKAGE_FILES };
}

function validateMcpToolMetadata(failures) {
  if (!Array.isArray(MCP_TOOLS) || MCP_TOOLS.length === 0) {
    failures.push('MCP server must export at least one tool.');
    return { toolCount: 0, tools: [] };
  }

  const seen = new Set();
  const tools = [];
  for (const tool of MCP_TOOLS) {
    const name = tool && tool.name;
    tools.push(name || '<missing>');
    if (typeof name !== 'string' || !/^hsapi_[a-z0-9_]+$/.test(name)) {
      failures.push('MCP tool has invalid name: ' + (name || '<missing>') + '.');
    } else if (seen.has(name)) {
      failures.push('MCP tool name is duplicated: ' + name + '.');
    } else {
      seen.add(name);
    }

    if (typeof tool.description !== 'string' || tool.description.trim().length < 20) {
      failures.push('MCP tool ' + (name || '<missing>') + ' must have a meaningful description.');
    }

    const schema = tool.inputSchema;
    if (!schema || schema.type !== 'object') {
      failures.push('MCP tool ' + (name || '<missing>') + ' inputSchema must be an object schema.');
      continue;
    }
    if (schema.additionalProperties !== false) {
      failures.push('MCP tool ' + (name || '<missing>') + ' inputSchema must set additionalProperties false.');
    }
    const properties = schema.properties || {};
    for (const propertyName of Object.keys(properties)) {
      if (FORBIDDEN_MCP_TOOL_ARGUMENTS.has(propertyName)) {
        failures.push('MCP tool ' + (name || '<missing>') + ' exposes forbidden argument ' + propertyName + '.');
      }
    }
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required)) {
        failures.push('MCP tool ' + (name || '<missing>') + ' required field must be an array.');
      } else {
        for (const requiredName of schema.required) {
          if (!Object.prototype.hasOwnProperty.call(properties, requiredName)) {
            failures.push('MCP tool ' + (name || '<missing>') + ' requires unknown property ' + requiredName + '.');
          }
        }
      }
    }
  }

  for (const requiredName of REQUIRED_MCP_TOOLS) {
    if (!seen.has(requiredName)) {
      failures.push('MCP server is missing required tool: ' + requiredName + '.');
    }
  }

  return {
    toolCount: MCP_TOOLS.length,
    tools
  };
}

function validateMcpSampleConfig(failures) {
  const sample = readJson('examples/mcp-server.sample.json');
  const expectedServers = [
    { name: 'hubspot-portal-alpha', portal: 'portal-alpha' },
    { name: 'hubspot-portal-beta', portal: 'portal-beta' }
  ];
  const sections = [
    ['openclaw.mcp.servers', sample.openclaw && sample.openclaw.mcp && sample.openclaw.mcp.servers],
    ['genericMcpClient.mcpServers', sample.genericMcpClient && sample.genericMcpClient.mcpServers]
  ];

  for (const [sectionName, servers] of sections) {
    if (!servers || typeof servers !== 'object') {
      failures.push('MCP sample config must include ' + sectionName + '.');
      continue;
    }
    for (const expected of expectedServers) {
      const server = servers[expected.name];
      if (!server) {
        failures.push('MCP sample config missing ' + sectionName + '.' + expected.name + '.');
        continue;
      }
      if (server.command !== 'hsapi-mcp') {
        failures.push('MCP sample ' + sectionName + '.' + expected.name + ' must use command hsapi-mcp.');
      }
      if (!server.env || server.env.HSAPI_PORTAL !== expected.portal) {
        failures.push('MCP sample ' + sectionName + '.' + expected.name + ' must set HSAPI_PORTAL to ' + expected.portal + '.');
      }
      if (!server.env || !server.env.HSAPI_PORTALS_CONFIG || !/outside-package/.test(server.env.HSAPI_PORTALS_CONFIG)) {
        failures.push('MCP sample ' + sectionName + '.' + expected.name + ' must point HSAPI_PORTALS_CONFIG outside the package.');
      }
      for (const envName of Object.keys(server.env || {})) {
        if (/TOKEN|SECRET|API_KEY|PASSWORD|PRIVATE/i.test(envName)) {
          failures.push('MCP sample ' + sectionName + '.' + expected.name + ' must not inline credential env keys; use portal config tokenEnv names instead.');
        }
      }
    }
  }

  const portals = sample.portalConfigShape && sample.portalConfigShape.portals;
  for (const expected of expectedServers) {
    const portal = portals && portals[expected.portal];
    const tokenEnv = portal && portal.auth && portal.auth.portalBearer && portal.auth.portalBearer.tokenEnv;
    if (!portal) {
      failures.push('MCP sample portalConfigShape missing portal ' + expected.portal + '.');
    } else if (!/^HUBSPOT_ACCESS_TOKEN_[A-Z0-9_]+$/.test(tokenEnv || '')) {
      failures.push('MCP sample portal ' + expected.portal + ' must use a HubSpot token env var name, not a token value.');
    }
  }

  const sampleText = readText('examples/mcp-server.sample.json');
  if (/"portalId"\s*:\s*"\d{5,}"/.test(sampleText)) {
    failures.push('MCP sample config must not include concrete portal IDs.');
  }
  if (/Bearer\s+[A-Za-z0-9]/.test(sampleText)) {
    failures.push('MCP sample config must not include bearer token values.');
  }

  return {
    sections: sections.map(([sectionName]) => sectionName),
    servers: expectedServers.map((entry) => entry.name)
  };
}

function validateMcpServerSafety(failures) {
  const text = readText('src/mcp-server.js');
  for (const marker of REQUIRED_MCP_SERVER_MARKERS) {
    if (!text.includes(marker)) {
      failures.push('src/mcp-server.js must include MCP safety/redaction marker: ' + marker + '.');
    }
  }
  return { markers: REQUIRED_MCP_SERVER_MARKERS };
}

function validateNeutralTokenSource(failures, files) {
  const packageFileSet = new Set(files);
  for (const relativePath of REQUIRED_NEUTRAL_TOKEN_FILES) {
    if (!packageFileSet.has(relativePath)) {
      failures.push('Package dry-run must include neutral token-source file: ' + relativePath + '.');
    }
  }

  const sample = readJson('examples/portals.multi-portal.sample.json');
  const portals = sample && sample.portals;
  const expected = {
    'portal-alpha': 'HUBSPOT_ACCESS_TOKEN_PORTAL_ALPHA',
    'portal-beta': 'HUBSPOT_ACCESS_TOKEN_PORTAL_BETA'
  };
  for (const [profile, tokenEnv] of Object.entries(expected)) {
    const portal = portals && portals[profile];
    const configuredTokenEnv = portal
      && portal.auth
      && portal.auth.portalBearer
      && portal.auth.portalBearer.tokenEnv;
    if (!portal) {
      failures.push('Neutral token-source portal sample must preserve profile ' + profile + '.');
    } else if (configuredTokenEnv !== tokenEnv) {
      failures.push('Neutral token-source portal ' + profile + ' must use token env ' + tokenEnv + '.');
    }
    if (portal && portal.tokenEnv) {
      failures.push('Neutral token-source portal ' + profile + ' should use auth.portalBearer.tokenEnv, not legacy tokenEnv.');
    }
  }

  const wrapperText = readText('examples/neutral-token-wrapper.sample.sh');
  const requiredMarkers = [
    'HSAPI_PORTALS_CONFIG',
    'HSAPI_SECRET_LOOKUP_CMD',
    'HSAPI_NEUTRAL_TOKEN_PROFILES',
    'HSAPI_NEUTRAL_TOKEN_DRY_RUN',
    'portalBearer.tokenEnv',
    'brokerStartKeyEnv',
    'exec "$@"'
  ];
  for (const marker of requiredMarkers) {
    if (!wrapperText.includes(marker)) {
      failures.push('Neutral token-source wrapper must include marker: ' + marker + '.');
    }
  }
  if (/hubspot-portal-alpha|hubspot-portal-beta/.test(wrapperText)) {
    failures.push('Neutral token-source wrapper must not depend on old HubSpot MCP entry names.');
  }

  if (process.platform !== 'win32') {
    try {
      const dryRun = execFileSync('bash', ['examples/neutral-token-wrapper.sample.sh'], {
        cwd: PACKAGE_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          HSAPI_PORTALS_CONFIG: path.join(PACKAGE_ROOT, 'examples', 'portals.multi-portal.sample.json'),
          HSAPI_SECRET_LOOKUP_CMD: '/bin/false',
          HSAPI_NEUTRAL_TOKEN_PROFILES: 'portal-alpha,portal-beta',
          HSAPI_NEUTRAL_TOKEN_DRY_RUN: '1',
          HUBSPOT_ACCESS_TOKEN_PORTAL_ALPHA: '',
          HUBSPOT_ACCESS_TOKEN_PORTAL_BETA: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      if (/pat-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9]/.test(dryRun)) {
        failures.push('Neutral token-source dry-run output must not include token-like values.');
      }
    } catch (error) {
      failures.push('Neutral token-source wrapper dry-run failed: ' + error.message + '.');
    }
  }

  return {
    requiredFiles: REQUIRED_NEUTRAL_TOKEN_FILES,
    profiles: Object.keys(expected)
  };
}

function validateOpenClawCutover(failures, files) {
  const packageFileSet = new Set(files);
  for (const relativePath of [
    'docs/OPENCLAW_MCP_CUTOVER.md',
    'examples/openclaw-cutover.mcp.sample.json'
  ]) {
    if (!packageFileSet.has(relativePath)) {
      failures.push('Package dry-run must include OpenClaw cutover file: ' + relativePath + '.');
    }
  }

  const sample = readJson('examples/openclaw-cutover.mcp.sample.json');
  const servers = sample && sample.servers;
  const expected = {
    'hubspot-portal-alpha': 'portal-alpha',
    'hubspot-portal-beta': 'portal-beta'
  };

  for (const [serverName, portal] of Object.entries(expected)) {
    const server = servers && servers[serverName];
    if (!server) {
      failures.push('OpenClaw cutover sample must define server ' + serverName + '.');
      continue;
    }
    if (server.command !== '/path/outside-package/hsapi/neutral-token-wrapper') {
      failures.push('OpenClaw cutover sample ' + serverName + ' must use the neutral token wrapper command.');
    }
    if (!Array.isArray(server.args) || server.args.length !== 1 || server.args[0] !== 'hsapi-mcp') {
      failures.push('OpenClaw cutover sample ' + serverName + ' must exec hsapi-mcp through args.');
    }
    if (!server.env || server.env.HSAPI_PORTAL !== portal) {
      failures.push('OpenClaw cutover sample ' + serverName + ' must set HSAPI_PORTAL to ' + portal + '.');
    }
    if (!server.env || server.env.HSAPI_NEUTRAL_TOKEN_PROFILES !== 'portal-alpha,portal-beta') {
      failures.push('OpenClaw cutover sample ' + serverName + ' must load both neutral token profiles.');
    }
    if (!server.env || !/outside-package/.test(server.env.HSAPI_PORTALS_CONFIG || '')) {
      failures.push('OpenClaw cutover sample ' + serverName + ' must point HSAPI_PORTALS_CONFIG outside the package.');
    }
    if (!server.env || !/outside-package/.test(server.env.HSAPI_SECRET_LOOKUP_CMD || '')) {
      failures.push('OpenClaw cutover sample ' + serverName + ' must point HSAPI_SECRET_LOOKUP_CMD outside the package.');
    }
  }

  const sampleText = readText('examples/openclaw-cutover.mcp.sample.json');
  if (/HUBSPOT_ACCESS_TOKEN_[A-Z0-9_]+\\s*[:=]\\s*["'][^"']{8,}/.test(sampleText)) {
    failures.push('OpenClaw cutover sample must not include HubSpot token values.');
  }
  if (/pat-[A-Za-z0-9_-]{20,}|Bearer\\s+[A-Za-z0-9]/.test(sampleText)) {
    failures.push('OpenClaw cutover sample must not include token-like values.');
  }

  return {
    servers: Object.keys(expected),
    sample: 'examples/openclaw-cutover.mcp.sample.json'
  };
}

function validateMcp(failures, files) {
  return {
    packageSurface: validateMcpPackageSurface(failures, files),
    authBoundaryPackageSurface: validateAuthBoundaryPackageSurface(failures, files),
    toolMetadata: validateMcpToolMetadata(failures),
    sampleConfig: validateMcpSampleConfig(failures),
    safety: validateMcpServerSafety(failures),
    neutralTokenSource: validateNeutralTokenSource(failures, files),
    openClawCutover: validateOpenClawCutover(failures, files)
  };
}

function validatePackagedFiles(failures) {
  const files = packageFiles();
  for (const relativePath of files) {
    if (/^examples\/.*\.(json|env)$/i.test(relativePath) && !/\.sample\.json$/i.test(relativePath)) {
      failures.push('Package examples must be sample-only and exclude local config files: ' + relativePath + '.');
    }

    if (!ALLOWED_PACKAGE_PATHS.has(relativePath)) {
      for (const pattern of DISALLOWED_PACKAGE_PATHS) {
        if (pattern.test(relativePath)) {
          failures.push(`Package dry-run includes disallowed local/config path: ${relativePath}.`);
        }
      }
    }

    const absolutePath = path.join(PACKAGE_ROOT, relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
    const text = fs.readFileSync(absolutePath, 'utf8');
    for (const { pattern, label } of DISALLOWED_CONTENT_PATTERNS) {
      if (pattern.test(text)) {
        failures.push(`Package file ${relativePath} contains ${label}.`);
      }
    }
  }
  return files;
}

function validateWorkerCheckoutNeutrality(failures) {
  const configPath = 'cloudflare/hsapi-oauth-broker/wrangler.jsonc';
  const configText = readText(configPath);
  const placeholderClientId = '00000000-0000-4000-8000-000000000001';
  const syntheticTestAccountIds = new Set(['123456789', '999999999']);

  if (/"HUBSPOT_ACCOUNT_ID"\s*:\s*"\d{5,}"/.test(configText)) {
    failures.push(`${configPath} must not contain a concrete HubSpot account ID.`);
  }

  const clientIds = [...configText.matchAll(/"HUBSPOT_CLIENT_ID"\s*:\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  if (!clientIds.length || clientIds.some((value) => value !== placeholderClientId)) {
    failures.push(`${configPath} must use only the documented placeholder HubSpot client ID.`);
  }

  const redirectUris = [...configText.matchAll(/"HUBSPOT_REDIRECT_URI"\s*:\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  if (
    !redirectUris.length
    || redirectUris.some((value) => value.includes('.workers.dev') && !value.includes('.REPLACE.workers.dev'))
  ) {
    failures.push(`${configPath} must not contain a concrete Cloudflare Worker callback hostname.`);
  }

  const workerGitignore = readText('cloudflare/hsapi-oauth-broker/.gitignore');
  if (!workerGitignore.split(/\r?\n/).includes('wrangler.operator.jsonc')) {
    failures.push('The Worker must ignore wrangler.operator.jsonc so deployment-specific public metadata stays local.');
  }

  const workerPackage = readJson('cloudflare/hsapi-oauth-broker/package.json');
  for (const scriptName of ['deploy:staging', 'deploy:production']) {
    const script = workerPackage.scripts && workerPackage.scripts[scriptName];
    if (!script || !script.includes('--config wrangler.operator.jsonc')) {
      failures.push(`Worker script ${scriptName} must deploy through the gitignored operator config.`);
    }
  }

  let trackedSourceFiles = [];
  try {
    trackedSourceFiles = execFileSync(
      'git',
      ['ls-files', '-z', '--', 'cloudflare/hsapi-oauth-broker'],
      { cwd: PACKAGE_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
      .split('\0')
      .filter(Boolean)
      .map((relativePath) => path.join(PACKAGE_ROOT, relativePath));
  } catch (error) {
    failures.push(`Unable to enumerate tracked Worker files for neutrality checks: ${error.message}.`);
  }

  const syntheticUuidPattern = /^([0-9a-f])\1{7}-\1{4}-4\1{3}-[89ab]\1{3}-\1{12}$/i;
  for (const absolutePath of trackedSourceFiles) {
    const relativePath = path.relative(PACKAGE_ROOT, absolutePath).replaceAll('\\', '/');
    const text = fs.readFileSync(absolutePath, 'utf8');

    const accountIds = [
      ...text.matchAll(/\b(?:accountId|hubId|hub_id|HUBSPOT_ACCOUNT_ID)\b["']?\s*[:=]\s*["']?(\d{5,})/gi),
      ...text.matchAll(/\/oauth\/(\d{5,})\//gi)
    ].map((match) => match[1]);
    if (accountIds.some((value) => !syntheticTestAccountIds.has(value))) {
      failures.push(`Tracked Worker file ${relativePath} contains a non-synthetic HubSpot account ID.`);
    }

    const clientIds = [...text.matchAll(/\bHUBSPOT_CLIENT_ID\b["']?\s*[:=]\s*["']([0-9a-f-]{36})["']/gi)]
      .map((match) => match[1]);
    if (
      clientIds.some((value) => value !== placeholderClientId && !syntheticUuidPattern.test(value))
    ) {
      failures.push(`Tracked Worker file ${relativePath} contains a non-placeholder HubSpot client ID.`);
    }

    const workerHosts = [...text.matchAll(/\b([a-z0-9-]+\.[a-z0-9-]+\.workers\.dev)\b/gi)]
      .map((match) => match[1]);
    if (workerHosts.some((value) => !value.includes('.REPLACE.workers.dev'))) {
      failures.push(`Tracked Worker file ${relativePath} contains a concrete Cloudflare Worker hostname.`);
    }
  }

  return {
    config: configPath,
    operatorConfig: 'cloudflare/hsapi-oauth-broker/wrangler.operator.jsonc',
    trackedValues: 'placeholders-and-synthetic-fixtures-only',
    scannedFileCount: trackedSourceFiles.length
  };
}

function validatePortalOnboarding(failures, files) {
  const packageFileSet = new Set(files);
  for (const relativePath of REQUIRED_PORTAL_ONBOARDING_FILES) {
    if (!packageFileSet.has(relativePath)) {
      failures.push('Package dry-run must include portal onboarding file: ' + relativePath + '.');
    }
  }

  const serviceKeySample = readJson('examples/portals.sample.json');
  const serviceKeyProfile = serviceKeySample.portals
    && serviceKeySample.portals['service-key-example'];
  const serviceKeyAuth = serviceKeyProfile && serviceKeyProfile.auth;
  const portalBearer = serviceKeyProfile
    && serviceKeyAuth
    && serviceKeyAuth.portalBearer;
  if (
    serviceKeySample.default !== 'service-key-example'
    || !serviceKeyProfile
    || !serviceKeyAuth
    || serviceKeyAuth.defaultFamily !== AUTH_FAMILIES.PORTAL_BEARER
    || !portalBearer
    || portalBearer.tokenEnv !== 'HUBSPOT_SERVICE_KEY_EXAMPLE'
    || portalBearer.kind !== 'private_app'
  ) {
    failures.push('examples/portals.sample.json must be the minimal ServiceKey/private-app portal_bearer template.');
  }
  if (
    serviceKeyAuth
    && (serviceKeyAuth.oauth || serviceKeyAuth.developer)
  ) {
    failures.push('ServiceKey sample must not require OAuth or developer credentials.');
  }

  const sample = readJson('examples/portals.oauth-hosted.sample.json');
  const profile = sample.portals && sample.portals['oauth-hosted-example'];
  const oauth = profile && profile.auth && profile.auth.oauth;
  if (!profile || !oauth) {
    failures.push('examples/portals.oauth-hosted.sample.json must include oauth-hosted-example with auth.oauth.');
    return null;
  }
  if (profile.portalId !== 'REPLACE_WITH_NUMERIC_PORTAL_ID') {
    failures.push('Hosted OAuth sample must retain a non-concrete portalId placeholder.');
  }
  if (profile.auth.defaultFamily !== AUTH_FAMILIES.OAUTH || oauth.mode !== 'hosted_broker') {
    failures.push('Hosted OAuth sample must default to oauth in hosted_broker mode.');
  }
  if (
    typeof oauth.brokerUrl !== 'string'
    || oauth.brokerUrl !== 'https://replace-with-operator-broker.example'
    || typeof oauth.brokerStartKeyEnv !== 'string'
    || !/^[A-Z][A-Z0-9_]*$/.test(oauth.brokerStartKeyEnv)
    || typeof oauth.tokenCachePath !== 'string'
    || !oauth.tokenCachePath.startsWith('~/')
  ) {
    failures.push('Hosted OAuth sample must declare HTTPS brokerUrl, brokerStartKeyEnv, and an external user tokenCachePath.');
  }
  for (const forbidden of ['clientId', 'clientIdEnv', 'clientSecret', 'clientSecretEnv', 'refreshToken', 'refreshTokenEnv']) {
    if (Object.prototype.hasOwnProperty.call(oauth, forbidden)) {
      failures.push(`Hosted OAuth sample must not declare local ${forbidden}.`);
    }
  }

  const combinedSample = readJson('examples/portals.oauth-service-key.sample.json');
  const combinedProfile = combinedSample.portals
    && combinedSample.portals['oauth-and-service-key-example'];
  const combinedAuth = combinedProfile && combinedProfile.auth;
  const combinedOauth = combinedAuth && combinedAuth.oauth;
  const combinedPortalBearer = combinedAuth && combinedAuth.portalBearer;
  if (
    combinedSample.default !== 'oauth-and-service-key-example'
    || !combinedProfile
    || combinedProfile.portalId !== 'REPLACE_WITH_NUMERIC_PORTAL_ID'
    || !combinedAuth
    || combinedAuth.defaultFamily !== AUTH_FAMILIES.OAUTH
    || !combinedOauth
    || combinedOauth.mode !== 'hosted_broker'
    || combinedOauth.brokerUrl !== 'https://replace-with-operator-broker.example'
    || !combinedPortalBearer
    || combinedPortalBearer.tokenEnv !== 'HUBSPOT_SERVICE_KEY_EXAMPLE'
    || combinedPortalBearer.kind !== 'private_app'
  ) {
    failures.push('Combined portal sample must contain hosted OAuth plus an explicit ServiceKey/private-app portal_bearer credential.');
  }

  return {
    guide: 'docs/hubspot-api-context/portal-auth-setup.md',
    serviceKeyProfile: 'service-key-example',
    hostedOAuthProfile: 'oauth-hosted-example',
    combinedProfile: 'oauth-and-service-key-example',
    hostedOAuthMode: oauth.mode,
    brokerStartKeyEnv: oauth.brokerStartKeyEnv
  };
}

function main() {
  const failures = [];
  const catalog = validateCatalog(failures);
  validateDocs(failures);
  const files = validatePackagedFiles(failures);
  const mcp = validateMcp(failures, files);
  const portalOnboarding = validatePortalOnboarding(failures, files);
  const workerCheckoutNeutrality = validateWorkerCheckoutNeutrality(failures);

  const output = {
    ok: failures.length === 0,
    checkedAt: new Date().toISOString(),
    catalog,
    mcp,
    portalOnboarding,
    workerCheckoutNeutrality,
    packageFileCount: files.length,
    failures
  };

  console.log(JSON.stringify(output, null, 2));
  if (failures.length) process.exit(1);
}

main();
