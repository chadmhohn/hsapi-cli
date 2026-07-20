// Guarded bridge to HubSpot's separate first-party Agent CLI (`hubspot`).
//
// HSAPI remains the portal selector and MCP/control plane. The delegated CLI
// owns its OAuth cache, so every OAuth-backed invocation is pinned to the
// selected HSAPI portal by comparing `hubspot whoami` with the profile or
// HSAPI OAuth-cache account binding before any report/view command runs.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  redactedOAuthTokenCacheContract,
} = require('../auth-resolvers');
const {
  boolFlag,
  configString,
  values,
} = require('../flags');
const {
  printJson,
} = require('../output');
const {
  exitCli,
  fail,
  writeStdout,
} = require('../runtime');
const { buildUsage } = require('../usage');
const { CATALOG_FILE, DEFAULT_CONFIG } = require('../config-paths');
const { recordDelegatedMutationHistory } = require('../history');

const AGENT_CLI_MIN_VERSION = '0.10.0';
const AGENT_CLI_AUTH_MODES = new Set(['oauth', 'service-key']);

const AGENT_CLI_INTERNAL_FLAGS = new Set([
  'portal',
  'agent-auth',
  'agent-cli-bin',
  'yes',
  'show-request',
  'show-secrets',
  'select',
  'pick',
  'raw-value',
  'ids-only',
  'names-only',
  'id-name-map',
  'compact',
  'agent',
  'max-results',
  'max-chars',
  'include-truncated',
  'format',
]);

const AGENT_CLI_SPECS = Object.freeze({
  reports: Object.freeze({
    list: { risk: 'read', positionals: 0, flags: ['limit', 'after'], format: true },
    get: { risk: 'read', positionals: 1, flags: [], format: true },
    'fetch-dataset': { risk: 'read', positionals: 1, flags: [], format: true },
    insights: { risk: 'read', positionals: 1, flags: [], format: true },
    create: {
      risk: 'mutation',
      positionals: 1,
      flags: [
        'chart-type', 'name', 'description', 'access-classification',
        'permission-level', 'date-range', 'filter-owners', 'filter-teams',
      ],
      format: true,
    },
    clone: { risk: 'mutation', positionals: 1, flags: ['name'], format: true },
    favorite: { risk: 'mutation', positionals: 1, flags: [], format: false },
    unfavorite: { risk: 'mutation', positionals: 1, flags: [], format: false },
    delete: {
      risk: 'destructive',
      positionals: 1,
      flags: ['dry-run', 'digest', 'confirm'],
      dryRunSafe: true,
      format: true,
    },
  }),
  views: Object.freeze({
    list: { risk: 'read', positionals: 1, flags: [], format: true },
    get: { risk: 'read', positionals: 2, flags: [], format: true },
    create: {
      risk: 'mutation',
      positionals: 1,
      flags: ['name', 'columns', 'sort', 'filters-file', 'dry-run'],
      dryRunSafe: true,
      format: true,
    },
    update: {
      risk: 'mutation',
      positionals: 2,
      flags: ['add', 'remove', 'reorder', 'dry-run'],
      dryRunSafe: true,
      format: true,
    },
    'replace-field': {
      risk: 'mutation',
      positionals: 2,
      flags: ['from', 'to', 'dry-run'],
      dryRunSafe: true,
      format: true,
    },
    delete: {
      risk: 'destructive',
      positionals: 2,
      flags: ['force', 'digest', 'confirm', 'dry-run'],
      dryRunSafe: true,
      format: true,
    },
  }),
});

function usage() {
  return buildUsage(DEFAULT_CONFIG, CATALOG_FILE);
}

function agentCliBin(flags = {}) {
  return String(flags['agent-cli-bin'] || process.env.HSAPI_AGENT_CLI_BIN || 'hubspot');
}

function agentCliAuthMode(flags = {}, portal = null) {
  return agentCliAuthSelection(flags, portal).mode;
}

function agentCliAuthSelection(flags = {}, portal = null) {
  const flagMode = configString(flags['agent-auth']);
  const profileMode = portal && portal.agentCli
    ? configString(portal.agentCli.authMode)
    : null;
  const mode = String(flagMode || profileMode || 'oauth').trim().toLowerCase();
  if (!AGENT_CLI_AUTH_MODES.has(mode)) {
    fail('--agent-auth must be oauth or service-key.');
  }
  return {
    mode,
    source: flagMode ? 'command_flag' : (profileMode ? 'profile' : 'default')
  };
}

function agentCliRedactText(text) {
  return String(text || '')
    .replace(/pat-[A-Za-z0-9_-]{16,}/g, 'pat-REDACTED')
    .replace(/(authorization:\s*bearer\s+)[A-Za-z0-9._-]{16,}/gi, '$1REDACTED')
    .replace(/(access[_-]?token["':=\s]+)(?!REDACTED)[A-Za-z0-9._-]{16,}/gi, '$1REDACTED')
    .replace(/(refresh[_-]?token["':=\s]+)(?!REDACTED)[A-Za-z0-9._-]{16,}/gi, '$1REDACTED')
    .replace(/(client[_-]?secret["':=\s]+)(?!REDACTED)[A-Za-z0-9._-]{16,}/gi, '$1REDACTED');
}

function agentCliTextSummary(text, maxLines = 200) {
  const redacted = agentCliRedactText(text).trim();
  if (!redacted) return { text: '', lineCount: 0, truncated: false };
  const lines = redacted.split(/\r?\n/);
  const selected = lines.slice(0, maxLines);
  return {
    text: selected.join('\n'),
    lineCount: lines.length,
    truncated: selected.length < lines.length,
  };
}

function agentCliStructuredOutput(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    try {
      const parsed = lines.map((line) => JSON.parse(line));
      return parsed.length === 1 ? parsed[0] : parsed;
    } catch (_lineError) {
      return null;
    }
  }
}

function agentCliChildEnv(portal, authMode) {
  const env = {
    ...process.env,
    HUBSPOT_NO_AUTO_UPGRADE: '1',
    NO_COLOR: '1',
  };
  if (authMode === 'service-key') {
    if (!portal.portalBearer) {
      fail(`Portal "${portal.name}" has no ServiceKey/private-app credential. Add auth.portalBearer explicitly or use --agent-auth oauth.`);
    }
    if (!portal.token) {
      fail(`Missing HubSpot ServiceKey. Set ${portal.tokenEnv} for portal "${portal.name}".`);
    }
    env.HUBSPOT_ACCESS_TOKEN = portal.token;
  } else {
    delete env.HUBSPOT_ACCESS_TOKEN;
  }
  return env;
}

function agentCliOAuthAdminOverrideSources() {
  const sources = [];
  if (configString(process.env.HUBSPOT_ACCESS_TOKEN)) sources.push('process environment HUBSPOT_ACCESS_TOKEN');
  const candidates = [
    { filePath: path.join(os.homedir(), '.hubspot', '.env'), display: '~/.hubspot/.env' },
    { filePath: path.join(os.homedir(), '.config', 'hubspot', '.env'), display: '~/.config/hubspot/.env' },
  ];
  if (configString(process.env.APPDATA)) {
    candidates.push({ filePath: path.join(process.env.APPDATA, 'hubspot', '.env'), display: '%APPDATA%/hubspot/.env' });
  }
  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate.filePath).toLowerCase();
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    try {
      if (!fs.existsSync(candidate.filePath)) continue;
      const contents = fs.readFileSync(candidate.filePath, 'utf8');
      if (/^\s*(?:export\s+)?HUBSPOT_ACCESS_TOKEN\s*=/m.test(contents)) {
        sources.push(candidate.display + ' HUBSPOT_ACCESS_TOKEN');
      }
    } catch (_error) {
      sources.push(candidate.display + ' unreadable');
    }
  }
  return sources;
}

function agentCliCommandPreview(binary, args) {
  return {
    binary,
    args,
    display: ['hubspot', ...args].join(' '),
  };
}

function runAgentCliCommand(binary, args, options = {}) {
  // Native names such as `hubspot` resolve through PATHEXT without a shell.
  // Only test/operator-supplied .cmd/.bat shims need cmd.exe; keeping normal
  // invocations shell-free prevents CRM SQL operators from being interpreted
  // as redirection or pipeline syntax on Windows.
  const useCmdShim = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(binary);
  const command = useCmdShim ? (process.env.ComSpec || 'cmd.exe') : binary;
  const commandArgs = useCmdShim ? ['/d', '/c', binary, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    env: options.env || process.env,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
    timeout: options.timeout || 180000,
  });
  if (result.error) {
    return {
      ok: false,
      exitCode: null,
      error: result.error.code || result.error.message,
      stdout: '',
      stderr: agentCliRedactText(result.error.message || String(result.error)),
      data: null,
    };
  }
  const data = agentCliStructuredOutput(result.stdout);
  const stdout = data === null
    ? agentCliTextSummary(result.stdout, options.maxLines || 500)
    : null;
  const stderr = agentCliTextSummary(result.stderr, options.maxErrorLines || 120);
  return {
    ok: result.status === 0,
    exitCode: result.status,
    signal: result.signal || null,
    outputFormat: data === null ? 'text' : 'json',
    ...(stdout ? {
      stdout: stdout.text,
      stdoutLineCount: stdout.lineCount,
      stdoutTruncated: stdout.truncated,
    } : {}),
    stderr: stderr.text,
    stderrLineCount: stderr.lineCount,
    stderrTruncated: stderr.truncated,
    data,
  };
}

function parseAgentCliVersion(text) {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(String(text || ''));
  if (!match) return null;
  return {
    raw: `${match[1]}.${match[2]}.${match[3]}`,
    parts: match.slice(1, 4).map(Number),
  };
}

function versionAtLeast(actual, minimum = AGENT_CLI_MIN_VERSION) {
  const actualVersion = typeof actual === 'string' ? parseAgentCliVersion(actual) : actual;
  const minimumVersion = parseAgentCliVersion(minimum);
  if (!actualVersion || !minimumVersion) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actualVersion.parts[index] > minimumVersion.parts[index]) return true;
    if (actualVersion.parts[index] < minimumVersion.parts[index]) return false;
  }
  return true;
}

function parseAgentCliWhoami(text) {
  const value = String(text || '');
  const portalMatch = /^\s*Portal:\s*([1-9][0-9]*)\s*$/im.exec(value);
  const userMatch = /^\s*User:\s*(.+?)\s*$/im.exec(value);
  const scopesMatch = /^\s*Scopes:\s*(.*?)\s*$/im.exec(value);
  return {
    portalId: portalMatch ? portalMatch[1] : null,
    user: userMatch ? userMatch[1] : null,
    scopes: scopesMatch && scopesMatch[1]
      ? scopesMatch[1].split(',').map((scope) => scope.trim()).filter(Boolean)
      : [],
  };
}

function agentCliExpectedPortal(portal) {
  if (portal.portalId) {
    return { portalId: String(portal.portalId), source: 'profile' };
  }
  if (portal.oauth) {
    const cache = redactedOAuthTokenCacheContract(portal.oauth);
    if (cache.status === 'usable' && cache.profileMatch && cache.hubId) {
      return { portalId: String(cache.hubId), source: 'hsapi_oauth_token_cache' };
    }
  }
  return { portalId: null, source: null };
}

function agentCliAuthContract(portal, authMode, modeSource = 'default') {
  const expected = agentCliExpectedPortal(portal);
  return {
    mode: authMode,
    modeSource,
    selectedPortal: portal.name,
    expectedPortalId: expected.portalId,
    expectedPortalIdSource: expected.source,
    credentialProvenance: authMode === 'oauth'
      ? 'official_agent_cli_oauth_cache'
      : portal.portalBearer && portal.portalBearer.profileField,
    tokenEnv: authMode === 'service-key' ? portal.tokenEnv : null,
    note: authMode === 'oauth'
      ? 'HubSpot Agent CLI OAuth is a separate, single-account cache. HSAPI verifies its account before every delegated command.'
      : 'The selected HSAPI profile ServiceKey is passed only in the delegated child process environment.',
  };
}

function runAgentCliPreflight(portal, flags, options = {}) {
  const binary = agentCliBin(flags);
  const authSelection = agentCliAuthSelection(flags, portal);
  const authMode = authSelection.mode;
  const auth = agentCliAuthContract(portal, authMode, authSelection.source);
  if (authMode === 'oauth') {
    const adminOverrides = agentCliOAuthAdminOverrideSources();
    if (adminOverrides.length) {
      return {
        ok: false,
        binary,
        auth,
        error: 'OAuth delegation is blocked because HubSpot Agent CLI would prioritize an admin token from: ' + adminOverrides.join(', ') + '. Remove that override or use --agent-auth service-key explicitly.',
      };
    }
  }
  const env = agentCliChildEnv(portal, authMode);
  if (authMode === 'oauth' && !auth.expectedPortalId) {
    return {
      ok: false,
      binary,
      auth,
      error: 'OAuth delegation requires a known HSAPI account binding. Add portalId to the selected profile or complete hsapi OAuth login so its token cache contains hubId.',
    };
  }

  const versionResult = runAgentCliCommand(binary, ['--version'], { env, timeout: 30000, maxLines: 10 });
  const version = parseAgentCliVersion(versionResult.stdout);
  if (!versionResult.ok || !version || !versionAtLeast(version)) {
    return {
      ok: false,
      binary,
      auth,
      version: version ? version.raw : null,
      versionResult,
      error: versionResult.ok
        ? `HubSpot Agent CLI ${AGENT_CLI_MIN_VERSION} or newer is required for reports and views.`
        : 'HubSpot Agent CLI was not available. Install it separately from HubSpot; HSAPI does not bundle or auto-upgrade it.',
    };
  }

  const whoamiResult = runAgentCliCommand(binary, ['whoami'], { env, timeout: 30000, maxLines: 80 });
  const identity = parseAgentCliWhoami(whoamiResult.stdout);
  if (!whoamiResult.ok || !identity.portalId) {
    return {
      ok: false,
      binary,
      version: version.raw,
      auth,
      identity,
      whoamiResult,
      error: authMode === 'oauth'
        ? 'HubSpot Agent CLI OAuth is not authenticated. Run hubspot auth login, then retry.'
        : 'The selected ServiceKey could not be validated by hubspot whoami.',
    };
  }
  if (auth.expectedPortalId && identity.portalId !== auth.expectedPortalId) {
    return {
      ok: false,
      binary,
      version: version.raw,
      auth,
      identity,
      whoamiResult,
      error: `HubSpot Agent CLI account ${identity.portalId} does not match selected HSAPI portal ${portal.name} (${auth.expectedPortalId}). Refusing cross-portal delegation.`,
    };
  }
  return {
    ok: true,
    binary,
    version: version.raw,
    minimumVersion: AGENT_CLI_MIN_VERSION,
    auth,
    identity,
    env,
    checks: options.includeResults === true ? { version: versionResult, whoami: whoamiResult } : undefined,
  };
}

function agentCliPreflightSummary(preflight) {
  const identity = preflight.identity
    ? {
      portalId: preflight.identity.portalId || null,
      user: preflight.identity.user || null,
      scopeCount: Array.isArray(preflight.identity.scopes) ? preflight.identity.scopes.length : 0,
    }
    : null;
  return {
    ok: preflight.ok,
    version: preflight.version || null,
    identity,
  };
}

function agentCliFlagArg(name, value) {
  const flag = `--${name}`;
  if (value === true) return [flag];
  if (value === false) return [flag, 'false'];
  return [flag, String(value)];
}

function agentCliSpec(family, action) {
  const familySpecs = AGENT_CLI_SPECS[family];
  const spec = familySpecs && familySpecs[action];
  if (!spec) {
    const actions = familySpecs ? Object.keys(familySpecs).join(', ') : 'reports, views';
    fail(`Unsupported HubSpot Agent CLI ${family} action "${action || ''}". Supported: ${actions}.`);
  }
  return spec;
}

function agentCliDelegatedArgs(family, action, rest, flags, spec = agentCliSpec(family, action)) {
  if (rest.length !== spec.positionals) {
    fail(`hsapi ${family} ${action} expects ${spec.positionals} positional argument${spec.positionals === 1 ? '' : 's'}; received ${rest.length}.`);
  }
  const allowedFlags = new Set(spec.flags);
  const args = [family, action, ...rest];
  for (const [name, rawValue] of Object.entries(flags)) {
    if (AGENT_CLI_INTERNAL_FLAGS.has(name)) continue;
    if (!allowedFlags.has(name)) {
      fail(`Flag --${name} is not supported for hsapi ${family} ${action}.`);
    }
    for (const value of values(rawValue)) {
      args.push(...agentCliFlagArg(name, value));
    }
  }
  if (spec.format) args.push('--format', 'json');
  return args;
}

function agentCliSafety(spec, flags) {
  const officialDryRun = spec.dryRunSafe === true && boolFlag(flags, 'dry-run');
  return {
    class: officialDryRun ? 'official_dry_run' : spec.risk,
    risk: spec.risk,
    officialDryRun,
    requiresConfirmation: spec.risk !== 'read' && !officialDryRun,
    reason: officialDryRun
      ? 'The delegated Agent CLI command is explicitly running its non-mutating --dry-run path.'
      : spec.risk === 'read'
        ? 'Read-only delegated Agent CLI command.'
        : 'This delegated Agent CLI command changes a saved HubSpot report or CRM view.',
  };
}

function agentCliBaseOutput(portal, family, action, binary, args, authMode, safety) {
  return {
    delegated: true,
    delegatedTo: 'official_hubspot_agent_cli',
    provider: 'hubspot_agent_cli',
    commandFamily: `hubspot ${family}`,
    action,
    portal: {
      name: portal.name,
      label: portal.label,
    },
    auth: agentCliAuthContract(portal, authMode.mode, authMode.source),
    safety,
    command: agentCliCommandPreview(binary, args),
  };
}

async function runAgentCliDoctor(portal, flags) {
  const binary = agentCliBin(flags);
  const authSelection = agentCliAuthSelection(flags, portal);
  const auth = agentCliAuthContract(portal, authSelection.mode, authSelection.source);
  if (boolFlag(flags, 'show-request')) {
    printJson({
      ok: true,
      ready: null,
      dryRun: true,
      showRequest: true,
      message: 'Agent CLI doctor would run version and whoami checks only. No report or view command was executed.',
      delegated: true,
      delegatedTo: 'official_hubspot_agent_cli',
      provider: 'hubspot_agent_cli',
      portal: { name: portal.name, label: portal.label },
      auth,
      checks: [
        agentCliCommandPreview(binary, ['--version']),
        agentCliCommandPreview(binary, ['whoami']),
      ],
    });
    return;
  }
  const preflight = runAgentCliPreflight(portal, flags, { includeResults: true });
  const output = {
    ok: preflight.ok,
    ready: preflight.ok,
    delegated: true,
    delegatedTo: 'official_hubspot_agent_cli',
    provider: 'hubspot_agent_cli',
    message: preflight.ok
      ? 'HubSpot Agent CLI bridge is ready for the selected portal.'
      : preflight.error,
    portal: { name: portal.name, label: portal.label },
    agentCli: {
      binary,
      version: preflight.version || null,
      minimumVersion: AGENT_CLI_MIN_VERSION,
    },
    auth: preflight.auth || auth,
    identity: preflight.identity || null,
    checks: preflight.checks || {
      version: preflight.versionResult,
      whoami: preflight.whoamiResult,
    },
  };
  printJson(output);
  if (!preflight.ok) exitCli(1);
}

async function runAgentCliBridge(portal, family, action, rest, flags) {
  if (!action || action === 'help') {
    writeStdout(usage());
    return;
  }
  const spec = agentCliSpec(family, action);
  const binary = agentCliBin(flags);
  const authMode = agentCliAuthSelection(flags, portal);
  const args = agentCliDelegatedArgs(family, action, rest, flags, spec);
  const safety = agentCliSafety(spec, flags);
  const base = agentCliBaseOutput(portal, family, action, binary, args, authMode, safety);

  if (boolFlag(flags, 'show-request')) {
    printJson({
      ok: true,
      executed: false,
      dryRun: true,
      showRequest: true,
      message: 'First-party capability preview only. No HubSpot Agent CLI command was executed.',
      ...base,
    });
    return;
  }
  if (safety.requiresConfirmation && !boolFlag(flags, 'yes')) {
    printJson({
      ok: false,
      executed: false,
      blocked: true,
      dryRun: true,
      message: 'First-party capability mutation blocked. Re-run with --yes after reviewing this delegated command preview.',
      ...base,
    });
    exitCli(2);
    return;
  }

  const preflight = runAgentCliPreflight(portal, flags);
  if (!preflight.ok) {
    printJson({
      ok: false,
      executed: false,
      message: preflight.error,
      ...base,
      preflight: agentCliPreflightSummary(preflight),
    });
    exitCli(1);
    return;
  }

  const result = runAgentCliCommand(binary, args, { env: preflight.env });
  if (spec.risk !== 'read' && !safety.officialDryRun) {
    recordDelegatedMutationHistory(portal, {
      provider: 'hubspot_agent_cli',
      commandFamily: family,
      action,
      risk: spec.risk,
      surfaceId: `first_party.${family}.agent_cli_bridge`,
      actualPortalId: preflight.identity.portalId,
    }, result);
  }
  printJson({
    ok: result.ok,
    executed: result.ok && !safety.officialDryRun,
    commandExecuted: result.ok,
    dryRun: safety.officialDryRun || undefined,
    ...base,
    mutationConfirmed: safety.requiresConfirmation ? true : undefined,
    preflight: agentCliPreflightSummary(preflight),
    result,
  });
  if (!result.ok) exitCli(result.exitCode || 1);
}

module.exports = {
  AGENT_CLI_AUTH_MODES,
  AGENT_CLI_INTERNAL_FLAGS,
  AGENT_CLI_MIN_VERSION,
  AGENT_CLI_SPECS,
  agentCliAuthContract,
  agentCliAuthMode,
  agentCliAuthSelection,
  agentCliBaseOutput,
  agentCliBin,
  agentCliChildEnv,
  agentCliCommandPreview,
  agentCliDelegatedArgs,
  agentCliExpectedPortal,
  agentCliFlagArg,
  agentCliRedactText,
  agentCliOAuthAdminOverrideSources,
  agentCliPreflightSummary,
  agentCliSafety,
  agentCliSpec,
  agentCliStructuredOutput,
  agentCliTextSummary,
  parseAgentCliVersion,
  parseAgentCliWhoami,
  runAgentCliBridge,
  runAgentCliCommand,
  runAgentCliDoctor,
  runAgentCliPreflight,
  versionAtLeast,
};
