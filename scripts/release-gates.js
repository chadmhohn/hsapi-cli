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
  ['docs/hubspot-api-context/agent-cli-bridge.md', 'official_hubspot_agent_cli'],
  ['docs/hubspot-api-context/agent-cli-bridge.md', 'single-account cache'],
  ['README.md', 'hsapi project doctor'],
  ['README.md', 'hsapi agent-cli doctor'],
  ['docs/INSTALL.md', 'hsapi project doctor'],
  ['docs/INSTALL.md', 'Optional HubSpot Agent CLI Bridge'],
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
  ['cloudflare/hsapi-oauth-broker/README.md', 'Normal hosted users'],
  ['cloudflare/hsapi-oauth-broker/README.md', 'wrangler.operator.jsonc'],
  ['README.md', 'OAuth-only remote MCP'],
  ['docs/MCP.md', 'REMOTE_WRITES_ENABLED'],
  ['docs/REMOTE_MCP.md', 'ServiceKey'],
  ['docs/OAUTH_APP_SPLIT.md', 'Local and Remote OAuth App Operations'],
  ['SECURITY.md', 'OAuth-only'],
  ['cloudflare/hsapi-remote-mcp/README.md', 'wrangler.operator.jsonc']
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

const REQUIRED_REMOTE_MCP_PACKAGE_FILES = [
  'docs/REMOTE_MCP.md',
  'docs/OAUTH_APP_SPLIT.md',
  'cloudflare/hsapi-remote-mcp/README.md',
  'examples/mcp-dual-connector.sample.json'
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
  'hsapi_request_execute',
  'hsapi_agent_cli_doctor',
  'hsapi_reports_read',
  'hsapi_reports_write',
  'hsapi_views_read',
  'hsapi_views_write'
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
  const remoteConfigPath = 'cloudflare/hsapi-oauth-broker/wrangler.remote.jsonc';
  const remoteConfigText = readText(remoteConfigPath);
  const localPlaceholderClientId = '00000000-0000-4000-8000-000000000001';
  const remotePlaceholderClientId = '00000000-0000-4000-8000-000000000002';
  const placeholderClientIds = new Set([localPlaceholderClientId, remotePlaceholderClientId]);
  const syntheticTestAccountIds = new Set(['123456789', '999999999']);

  if (/"HUBSPOT_ACCOUNT_ID"\s*:\s*"\d{5,}"/.test(configText)) {
    failures.push(`${configPath} must not contain a concrete HubSpot account ID.`);
  }

  const clientIds = [...configText.matchAll(/"HUBSPOT_CLIENT_ID"\s*:\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  if (!clientIds.length || clientIds.some((value) => value !== localPlaceholderClientId)) {
    failures.push(`${configPath} must use only the documented local-app placeholder HubSpot client ID.`);
  }

  const remoteClientIds = [...remoteConfigText.matchAll(/"HUBSPOT_CLIENT_ID"\s*:\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  if (!remoteClientIds.length || remoteClientIds.some((value) => value !== remotePlaceholderClientId)) {
    failures.push(`${remoteConfigPath} must use only the documented remote-app placeholder HubSpot client ID.`);
  }
  if ((configText.match(/"HSAPI_BROKER_ROLE"\s*:\s*"local"/g) || []).length !== 3) {
    failures.push(`${configPath} must declare the local broker role in every environment.`);
  }
  if ((configText.match(/"HSAPI_ALLOWED_REMOTE_COMPLETION_REDIRECT_URIS"\s*:\s*""/g) || []).length !== 3) {
    failures.push(`${configPath} must reject remote completion redirects in every environment.`);
  }
  if ((remoteConfigText.match(/"HSAPI_BROKER_ROLE"\s*:\s*"remote"/g) || []).length !== 3) {
    failures.push(`${remoteConfigPath} must declare the remote broker role in every environment.`);
  }
  const remoteCompletionRedirects = [
    ...remoteConfigText.matchAll(/"HSAPI_ALLOWED_REMOTE_COMPLETION_REDIRECT_URIS"\s*:\s*"([^"]+)"/g)
  ].map((match) => match[1]);
  if (
    remoteCompletionRedirects.length !== 3
    || remoteCompletionRedirects.some((value) => !value.startsWith('https://') || !value.endsWith('/hubspot/callback'))
  ) {
    failures.push(`${remoteConfigPath} must allow one exact HTTPS remote MCP completion callback per environment.`);
  }

  const redirectUris = [...configText.matchAll(/"HUBSPOT_REDIRECT_URI"\s*:\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  const remoteRedirectUris = [...remoteConfigText.matchAll(/"HUBSPOT_REDIRECT_URI"\s*:\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  if (
    !redirectUris.length
    || redirectUris.some((value) => value.includes('.workers.dev') && !value.includes('.REPLACE.workers.dev'))
    || remoteRedirectUris.length !== 3
    || remoteRedirectUris.some((value) => !value.startsWith('https://'))
    || remoteRedirectUris.some((value) => value.includes('.workers.dev') && !value.includes('.REPLACE.workers.dev'))
  ) {
    failures.push('OAuth broker configs must use neutral callback placeholders and the remote broker must use HTTPS callbacks.');
  }

  const workerGitignore = readText('cloudflare/hsapi-oauth-broker/.gitignore');
  if (!workerGitignore.split(/\r?\n/).includes('wrangler.operator.jsonc')) {
    failures.push('The Worker must ignore wrangler.operator.jsonc so deployment-specific public metadata stays local.');
  }
  if (!workerGitignore.split(/\r?\n/).includes('wrangler.*.operator.jsonc')) {
    failures.push('The Worker must ignore role-specific operator configs so deployment metadata stays local.');
  }

  const workerPackage = readJson('cloudflare/hsapi-oauth-broker/package.json');
  for (const scriptName of ['deploy:staging', 'deploy:production']) {
    const script = workerPackage.scripts && workerPackage.scripts[scriptName];
    if (!script || !script.includes('--config wrangler.operator.jsonc')) {
      failures.push(`Worker script ${scriptName} must deploy through the gitignored operator config.`);
    }
  }
  for (const scriptName of ['deploy:remote:staging', 'deploy:remote:production']) {
    const script = workerPackage.scripts && workerPackage.scripts[scriptName];
    if (!script || !script.includes('--config wrangler.remote.operator.jsonc')) {
      failures.push(`Worker script ${scriptName} must deploy through the gitignored remote operator config.`);
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
      clientIds.some((value) => !placeholderClientIds.has(value) && !syntheticUuidPattern.test(value))
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
    remoteConfig: remoteConfigPath,
    operatorConfig: 'cloudflare/hsapi-oauth-broker/wrangler.operator.jsonc',
    remoteOperatorConfig: 'cloudflare/hsapi-oauth-broker/wrangler.remote.operator.jsonc',
    trackedValues: 'placeholders-and-synthetic-fixtures-only',
    scannedFileCount: trackedSourceFiles.length
  };
}

function validateRemoteMcpCheckoutNeutrality(failures, files) {
  const root = 'cloudflare/hsapi-remote-mcp';
  const configPath = `${root}/wrangler.jsonc`;
  const configText = readText(configPath);
  const packageFileSet = new Set(files);
  const requiredPlaceholders = {
    clientId: '00000000-0000-4000-8000-000000000002',
    kvId: '00000000000000000000000000000000'
  };

  for (const relativePath of REQUIRED_REMOTE_MCP_PACKAGE_FILES) {
    if (!packageFileSet.has(relativePath)) {
      failures.push(`Package dry-run must include remote MCP file: ${relativePath}.`);
    }
  }

  for (const [relativePath, markers] of [
    ['docs/REMOTE_MCP.md', ['OAuth-only', 'ServiceKey', 'REMOTE_WRITES_ENABLED', 'HUBSPOT_APP_SCOPE_CEILING']],
    [`${root}/README.md`, ['OAuth-only', 'ServiceKey', 'wrangler.operator.jsonc', 'CONFIRMATION_LEDGER', 'AUTHORIZATION_STATE', 'HUBSPOT_APP_SCOPE_CEILING']]
  ]) {
    const text = readText(relativePath);
    for (const marker of markers) {
      if (!text.toLowerCase().includes(marker.toLowerCase())) {
        failures.push(`${relativePath} must mention ${marker}.`);
      }
    }
  }

  const exactCount = (pattern) => (configText.match(pattern) || []).length;
  if (exactCount(/"REMOTE_WRITES_ENABLED"\s*:\s*"true"/g) !== 3) {
    failures.push(`${configPath} must enable the reviewed remote write boundary in local, staging, and production.`);
  }
  if (exactCount(/"HUBSPOT_REQUIRE_USER_LEVEL"\s*:\s*"true"/g) !== 3) {
    failures.push(`${configPath} must require user-level HubSpot OAuth in every environment.`);
  }
  if (exactCount(/"HUBSPOT_BROKER_URL"\s*:\s*"https:\/\/hsapi-remote-oauth\.REPLACE\.example"/g) !== 3) {
    failures.push(`${configPath} must pin the neutral dedicated remote OAuth broker placeholder in every environment.`);
  }
  if (exactCount(/"invocation_logs"\s*:\s*false/g) !== 3) {
    failures.push(`${configPath} must disable full invocation URL logs in every environment.`);
  }

  const clientIds = [...configText.matchAll(/"HUBSPOT_CLIENT_ID"\s*:\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  if (clientIds.length !== 3 || clientIds.some((value) => value !== requiredPlaceholders.clientId)) {
    failures.push(`${configPath} must contain only the placeholder HubSpot client ID.`);
  }
  const kvIds = [...configText.matchAll(/"id"\s*:\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  if (kvIds.length !== 3 || kvIds.some((value) => value !== requiredPlaceholders.kvId)) {
    failures.push(`${configPath} must contain one placeholder OAUTH_KV namespace ID per environment.`);
  }
  if (configText.includes('"AUTH_STATE_KV"')) {
    failures.push(`${configPath} must keep one-time authorization state out of eventually consistent KV.`);
  }
  if (
    !configText.includes('"nodejs_compat"')
    || !configText.includes('"global_fetch_strictly_public"')
  ) failures.push(`${configPath} must enable nodejs_compat and global_fetch_strictly_public.`);
  if (
    !configText.includes('"CONFIRMATION_LEDGER"')
    || !configText.includes('"storage": "sqlite"')
    || exactCount(/"name"\s*:\s*"CONFIRMATION_LEDGER"/g) !== 3
  ) failures.push(`${configPath} must bind the SQLite ConfirmationLedger in every environment.`);
  if (
    exactCount(/"name"\s*:\s*"AUTHORIZATION_STATE"/g) !== 3
    || exactCount(/"class_name"\s*:\s*"AuthorizationState"/g) !== 3
    || !/"AuthorizationState"\s*:\s*\{[\s\S]*?"type"\s*:\s*"durable-object"[\s\S]*?"storage"\s*:\s*"sqlite"/.test(configText)
  ) failures.push(`${configPath} must bind the SQLite AuthorizationState in every environment.`);
  if (
    exactCount(/"workers_dev"\s*:\s*false/g) !== 1
    || exactCount(/"custom_domain"\s*:\s*true/g) !== 1
  ) failures.push(`${configPath} production must use an explicit custom-domain route instead of an unreachable workers.dev origin.`);
  for (const binding of ['EDGE_RATE_LIMITER', 'REMOTE_RATE_LIMITER', 'AUTH_RATE_LIMITER']) {
    if (exactCount(new RegExp(`"name"\\s*:\\s*"${binding}"`, 'g')) !== 3) {
      failures.push(`${configPath} must configure ${binding} in every environment.`);
    }
  }

  const optionalScopeValues = [...configText.matchAll(/"HUBSPOT_OPTIONAL_SCOPES"\s*:\s*"([^"]*)"/g)]
    .map((match) => match[1]);
  const expectedRemoteWriteScopes = [
    'crm.objects.contacts.write',
    'crm.objects.companies.write',
    'crm.objects.deals.write',
    'crm.objects.tickets.write',
    'crm.objects.line_items.write',
    'crm.objects.products.write',
    'crm.objects.tasks.write',
    'crm.objects.notes.write',
    'crm.objects.calls.write',
    'crm.objects.meetings.write',
    'crm.objects.emails.write',
    'crm.objects.marketing_events.write',
    'automation.sequences.enrollments.write'
  ].sort();
  if (
    optionalScopeValues.length !== 3
    || optionalScopeValues.some((value) => {
      const writeScopes = value.split(/\s+/).filter((scope) => scope.endsWith('.write')).sort();
      return JSON.stringify(writeScopes) !== JSON.stringify(expectedRemoteWriteScopes);
    })
    || optionalScopeValues.some((value) => value.includes('crm.objects.custom.') || value.includes('crm.schemas.custom.'))
    || optionalScopeValues.some((value) => value.includes('cpq.price_books.'))
    || optionalScopeValues.some((value) => value.includes('cpq.quotes.write'))
  ) failures.push(`${configPath} must request exactly the reviewed remote write scopes and exclude unverified CPQ quote, custom-object, and ServiceKey-only Price Books scopes.`);
  const appScopeCeilingValues = [...configText.matchAll(/"HUBSPOT_APP_SCOPE_CEILING"\s*:\s*"([^"]*)"/g)]
    .map((match) => match[1].split(/\s+/).filter(Boolean));
  if (
    appScopeCeilingValues.length !== 3
    || appScopeCeilingValues.some((scopes) => !scopes.includes('oauth')
      || scopes.some((scope) => scope.startsWith('cpq.price_books.'))
      || new Set(scopes).size !== scopes.length)
  ) failures.push(`${configPath} must define one duplicate-free OAuth app scope ceiling without ServiceKey-only Price Books scopes per environment.`);
  for (let index = 0; index < Math.min(optionalScopeValues.length, appScopeCeilingValues.length); index += 1) {
    const ceiling = new Set(appScopeCeilingValues[index]);
    const optionalScopes = optionalScopeValues[index].split(/\s+/).filter(Boolean);
    if (optionalScopes.some((scope) => !ceiling.has(scope))) {
      failures.push(`${configPath} environment ${index + 1} has a remote optional scope outside its public-app ceiling.`);
    }
  }

  const secretBlocks = [...configText.matchAll(/"secrets"\s*:\s*\{\s*"required"\s*:\s*\[([^\]]+)\]/g)]
    .map((match) => [...match[1].matchAll(/"([A-Z0-9_]+)"/g)].map((entry) => entry[1]).sort());
  const expectedSecrets = ['STATE_ENCRYPTION_KEY'];
  if (
    secretBlocks.length !== 3
    || secretBlocks.some((names) => JSON.stringify(names) !== JSON.stringify(expectedSecrets))
  ) failures.push(`${configPath} must require only the documented state-encryption secret.`);

  const gitignore = readText(`${root}/.gitignore`).split(/\r?\n/);
  for (const entry of ['.dev.vars*', '.env*', '.wrangler/', 'wrangler.operator.jsonc', 'node_modules/']) {
    if (!gitignore.includes(entry)) failures.push(`${root}/.gitignore must include ${entry}.`);
  }
  const workerPackage = readJson(`${root}/package.json`);
  for (const scriptName of ['deploy:staging', 'deploy:production']) {
    const script = workerPackage.scripts && workerPackage.scripts[scriptName];
    if (!script || !script.includes('--config wrangler.operator.jsonc')) {
      failures.push(`Remote MCP script ${scriptName} must deploy through the ignored operator config.`);
    }
  }

  let checkoutFiles = [];
  try {
    checkoutFiles = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', root],
      { cwd: PACKAGE_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).split('\0').filter(Boolean);
  } catch (error) {
    failures.push(`Unable to enumerate remote MCP checkout files: ${error.message}.`);
  }

  const executableFiles = checkoutFiles.filter((relativePath) =>
    relativePath.startsWith(`${root}/src/`)
    || relativePath.endsWith('/wrangler.jsonc')
    || relativePath.endsWith('/worker-configuration.d.ts')
    || relativePath.endsWith('/package.json')
    || relativePath.endsWith('/vitest.config.ts')
  );
  const forbiddenCredentialHooks = /\b(?:HUBSPOT_CLIENT_SECRET|HUBSPOT_SERVICE_KEY|HSAPI_PORTALS_CONFIG|HUBSPOT_PRIVATE_APP_TOKEN|HUBSPOT_ACCESS_TOKEN|portalBearer|tokenEnv)\b|['"]service-key['"]/i;
  for (const relativePath of executableFiles) {
    const text = readText(relativePath);
    if (forbiddenCredentialHooks.test(text)) {
      failures.push(`Remote MCP executable/config file ${relativePath} contains a local/private credential hook.`);
    }
    if (/\b([a-z0-9-]+\.(?!REPLACE\.)[a-z0-9-]+\.workers\.dev)\b/i.test(text)) {
      failures.push(`Remote MCP file ${relativePath} contains a concrete Cloudflare Worker hostname.`);
    }
  }

  const oauthText = readText(`${root}/src/hubspot-oauth.ts`);
  for (const marker of [
    'config.brokerUrl',
    '/v1/oauth/sessions',
    '/v1/oauth/tokens/refresh',
    '/v1/oauth/tokens/revoke',
    'brokerCredential',
    'config.hubSpotAppScopeCeiling',
    'effectiveScopes',
    'hubspot_grant_scope_attenuated',
    'hubspot_grant_scope_rejected',
    'expectedHubId'
  ]) {
    if (!oauthText.includes(marker)) failures.push(`Remote MCP broker-backed OAuth client is missing marker ${marker}.`);
  }
  if (/https:\/\/api\.hub(?:api|spot)\.com\/oauth\//.test(oauthText)) {
    failures.push('Remote MCP OAuth client must not exchange tokens directly with HubSpot or hold the public-app secret.');
  }

  const policyText = readText(`${root}/src/remote-policy.ts`);
  const requestText = readText(`${root}/src/hubspot-request.ts`);
  const mcpText = readText(`${root}/src/mcp.ts`);
  const authText = readText(`${root}/src/auth-handler.ts`);
  const authorizationStateText = readText(`${root}/src/authorization-state.ts`);
  const inboundText = readText(`${root}/src/inbound.ts`);
  const indexText = readText(`${root}/src/index.ts`);
  for (const marker of ['assertRemoteManifestMatchesCatalog()', 'rawFallback', 'CUSTOM_OBJECT_WRITE_SCOPE']) {
    if (!policyText.includes(marker)) failures.push(`Remote MCP fail-closed policy is missing marker ${marker}.`);
  }
  for (const marker of ['https://api.hubapi.com', 'mcpClientId', 'mcpAccessTokenExpiresAtMs']) {
    if (!requestText.includes(marker)) failures.push(`Remote MCP request boundary is missing marker ${marker}.`);
  }
  for (const marker of ['config.remoteWritesEnabled', 'readConfirmationToken', 'confirmationLedger.getByName']) {
    if (!mcpText.includes(marker)) failures.push(`Remote MCP mutation boundary is missing marker ${marker}.`);
  }
  for (const marker of [
    'codeChallengeMethod !== "S256"',
    'request.resource !== config.resourceUrl',
    'request.headers.get("origin") !== config.publicOrigin',
    '"referrer-policy": "strict-origin"',
    '"content-security-policy": consentContentSecurityPolicy(oauthRequest, config.brokerUrl)',
    'HUBSPOT_AUTHORIZATION_ORIGIN',
    "form-action 'self'",
    "frame-ancestors 'none'",
    'name="csrf"',
    'cookieHeader(names.partitioned, browserBinding, "None", true)',
    'Partitioned',
  ]) {
    if (!authText.includes(marker)) failures.push(`Remote MCP downstream OAuth validation is missing marker ${marker}.`);
  }
  for (const marker of [
    'consumeIfProof(proofHash: string, nowMs = Date.now())',
    'proofHashesEqual(proofHash, row.proof_hash)',
    'DELETE FROM authorization_state WHERE id = 1',
  ]) {
    if (!authorizationStateText.includes(marker)) failures.push(`Remote MCP one-time OAuth state is missing marker ${marker}.`);
  }
  for (const marker of ['boundIncomingRequest', 'Request body too large.', 'reader.cancel()']) {
    if (!inboundText.includes(marker)) failures.push(`Remote MCP inbound body boundary is missing marker ${marker}.`);
  }
  for (const marker of ['EDGE_RATE_LIMITER', 'AUTH_RATE_LIMITER', 'supportedMcpScopes(config.remoteWritesEnabled)', 'boundIncomingRequest']) {
    if (!indexText.includes(marker)) failures.push(`Remote MCP edge/OAuth boundary is missing marker ${marker}.`);
  }

  return {
    config: configPath,
    operatorConfig: `${root}/wrangler.operator.jsonc`,
    packagedFiles: REQUIRED_REMOTE_MCP_PACKAGE_FILES,
    scannedFileCount: checkoutFiles.length,
    writesEnabledByDefault: true,
    serviceKeyAccepted: false
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
    || !serviceKeyProfile.agentCli
    || serviceKeyProfile.agentCli.authMode !== 'service-key'
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
  if (Object.prototype.hasOwnProperty.call(profile, 'portalId')) {
    failures.push('Hosted OAuth sample must let HubSpot account selection bind the first login; portalId is optional.');
  }
  if (profile.auth.defaultFamily !== AUTH_FAMILIES.OAUTH || oauth.mode !== 'hosted_broker') {
    failures.push('Hosted OAuth sample must default to oauth in hosted_broker mode.');
  }
  if (!profile.agentCli || profile.agentCli.authMode !== 'oauth') {
    failures.push('Hosted OAuth sample must explicitly default Agent CLI delegation to oauth.');
  }
  if (
    Object.prototype.hasOwnProperty.call(oauth, 'brokerUrl')
    || Object.prototype.hasOwnProperty.call(oauth, 'brokerStartKeyEnv')
    || typeof oauth.tokenCachePath !== 'string'
    || !oauth.tokenCachePath.startsWith('~/')
  ) {
    failures.push('Hosted OAuth sample must use the bundled broker with only an external user tokenCachePath.');
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
    || Object.prototype.hasOwnProperty.call(combinedProfile, 'portalId')
    || !combinedAuth
    || combinedAuth.defaultFamily !== AUTH_FAMILIES.OAUTH
    || !combinedOauth
    || combinedOauth.mode !== 'hosted_broker'
    || Object.prototype.hasOwnProperty.call(combinedOauth, 'brokerUrl')
    || Object.prototype.hasOwnProperty.call(combinedOauth, 'brokerStartKeyEnv')
    || !combinedPortalBearer
    || combinedPortalBearer.tokenEnv !== 'HUBSPOT_SERVICE_KEY_EXAMPLE'
    || combinedPortalBearer.kind !== 'private_app'
    || !combinedProfile.agentCli
    || combinedProfile.agentCli.authMode !== 'oauth'
  ) {
    failures.push('Combined portal sample must remain account-chooser neutral and contain hosted OAuth plus an explicit ServiceKey/private-app portal_bearer credential.');
  }

  return {
    guide: 'docs/hubspot-api-context/portal-auth-setup.md',
    serviceKeyProfile: 'service-key-example',
    hostedOAuthProfile: 'oauth-hosted-example',
    combinedProfile: 'oauth-and-service-key-example',
    hostedOAuthMode: oauth.mode,
    agentCliDefaults: {
      serviceKey: serviceKeyProfile.agentCli.authMode,
      hostedOAuth: profile.agentCli.authMode,
      combined: combinedProfile.agentCli.authMode
    }
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
  const remoteMcpCheckoutNeutrality = validateRemoteMcpCheckoutNeutrality(failures, files);

  const output = {
    ok: failures.length === 0,
    checkedAt: new Date().toISOString(),
    catalog,
    mcp,
    portalOnboarding,
    workerCheckoutNeutrality,
    remoteMcpCheckoutNeutrality,
    packageFileCount: files.length,
    failures
  };

  console.log(JSON.stringify(output, null, 2));
  if (failures.length) process.exit(1);
}

main();
