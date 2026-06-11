// hsapi project: guarded bridge to the official HubSpot CLI plus its doctor.
const { spawnSync } = require('child_process');
const {
  exitCli,
  fail,
  writeStdout,
} = require('../runtime');
const { buildUsage } = require('../usage');
const { CATALOG_FILE, DEFAULT_CONFIG } = require('../config-paths');

function usage() {
  return buildUsage(DEFAULT_CONFIG, CATALOG_FILE);
}
const {
  boolFlag,
  configString,
  values,
} = require('../flags');
const {
  printJson,
} = require('../output');

const PROJECT_BRIDGE_READ_COMMANDS = new Set([
  'list',
  'ls',
  'info',
  'list-builds',
  'logs',
  'validate',
  'lint'
]);

const PROJECT_BRIDGE_CONFIRM_COMMANDS = new Set([
  'upload',
  'deploy',
  'delete',
  'create',
  'init',
  'add',
  'download',
  'migrate',
  'install-deps',
  'update-deps'
]);

const PROJECT_BRIDGE_UNSUPPORTED_COMMANDS = new Set([
  'dev',
  'watch',
  'open',
  'profile',
  'profiles'
]);

const PROJECT_BRIDGE_INTERNAL_FLAGS = new Set([
  'account',
  'hs-bin',
  'yes',
  'show-request',
  'select',
  'pick',
  'raw-value',
  'ids-only',
  'names-only',
  'id-name-map',
  'compact',
  'max-results',
  'max-chars',
  'include-truncated',
  'agent'
]);

function projectBridgeHsBin(flags) {
  return String(flags['hs-bin'] || process.env.HSAPI_HS_BIN || 'hs');
}

function projectBridgeAccount(flags) {
  const account = configString(flags.account);
  if (!account) fail('hsapi project requires --account <account>. Refusing to rely on the HubSpot CLI default account.');
  return account;
}

function projectBridgeRedactText(text) {
  return String(text || '')
    .replace(/\/root\/\.hscli\/config\.yml/g, '~/.hscli/config.yml')
    .replace(/pat-[A-Za-z0-9_-]{20,}/g, 'pat-REDACTED')
    .replace(/(hapikey=)[A-Za-z0-9_-]+/gi, '$1REDACTED')
    .replace(/(access[_-]?token["':=\s]+)(?!REDACTED)[A-Za-z0-9._-]{16,}/gi, '$1REDACTED')
    .replace(/(refresh[_-]?token["':=\s]+)(?!REDACTED)[A-Za-z0-9._-]{16,}/gi, '$1REDACTED')
    .replace(/(client[_-]?secret["':=\s]+)(?!REDACTED)[A-Za-z0-9._-]{16,}/gi, '$1REDACTED')
    .replace(/(personal[_-]?access[_-]?key["':=\s]+)(?!REDACTED)[A-Za-z0-9._-]{16,}/gi, '$1REDACTED');
}

function projectBridgeNormalizeResult(action, result) {
  if (
    projectBridgeNormalizeAction(action) === 'list'
    && !result.ok
    && result.exitCode === 1
    && /no projects found/i.test(`${result.stderr}\n${result.stdout}`)
  ) {
    return {
      ...result,
      ok: true,
      normalized: true,
      empty: true,
      normalizedReason: 'no_projects_found'
    };
  }
  return result;
}

function projectBridgeTextSummary(text, maxLines = 80) {
  const redacted = projectBridgeRedactText(text).trim();
  if (!redacted) return { text: '', lineCount: 0, truncated: false };
  const lines = redacted.split(/\r?\n/);
  const selected = lines.slice(0, maxLines);
  return {
    text: selected.join('\n'),
    lineCount: lines.length,
    truncated: lines.length > selected.length
  };
}

function projectBridgeCommandPreview(hsBin, args) {
  return {
    binary: hsBin,
    args,
    display: ['hs', ...args].join(' ')
  };
}

function runHubSpotCliProjectCommand(hsBin, args, options = {}) {
  const useCmdShim = process.platform === 'win32' && !/\.(?:exe|com)$/i.test(hsBin);
  const command = useCmdShim ? (process.env.ComSpec || 'cmd.exe') : hsBin;
  const commandArgs = useCmdShim ? ['/d', '/c', hsBin, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  if (result.error) {
    return {
      ok: false,
      exitCode: null,
      error: result.error.code || result.error.message,
      stdout: '',
      stderr: projectBridgeRedactText(result.error.message || String(result.error))
    };
  }
  const stdout = projectBridgeTextSummary(result.stdout, options.maxLines || 120);
  const stderr = projectBridgeTextSummary(result.stderr, options.maxLines || 80);
  return {
    ok: result.status === 0,
    exitCode: result.status,
    signal: result.signal || null,
    stdout: stdout.text,
    stdoutLineCount: stdout.lineCount,
    stdoutTruncated: stdout.truncated,
    stderr: stderr.text,
    stderrLineCount: stderr.lineCount,
    stderrTruncated: stderr.truncated
  };
}

function projectBridgeFlagArg(flagName, value) {
  const flag = `--${flagName}`;
  if (value === true) return [flag];
  if (value === false) return [flag, 'false'];
  return [flag, String(value)];
}

function projectBridgeArgsFromFlags(flags) {
  const args = [];
  for (const [flagName, value] of Object.entries(flags)) {
    if (PROJECT_BRIDGE_INTERNAL_FLAGS.has(flagName)) continue;
    for (const item of values(value)) {
      args.push(...projectBridgeFlagArg(flagName, item));
    }
  }
  return args;
}

function projectBridgeNormalizeAction(action) {
  if (action === 'ls') return 'list';
  if (action === 'init') return 'create';
  return action;
}

function projectBridgeDelegatedArgs(action, rest, flags, account) {
  const normalizedAction = projectBridgeNormalizeAction(action);
  const args = ['project', normalizedAction, ...rest, ...projectBridgeArgsFromFlags(flags)];
  if (account) args.push('--account', account);
  return args;
}

function projectBridgeSafety(action) {
  if (PROJECT_BRIDGE_READ_COMMANDS.has(action)) {
    return {
      class: 'read_only_or_local_validation',
      requiresConfirmation: false,
      reason: 'Allowed project bridge command.'
    };
  }
  if (PROJECT_BRIDGE_CONFIRM_COMMANDS.has(action)) {
    return {
      class: 'mutating_or_local_write',
      requiresConfirmation: true,
      reason: 'This project command can create, upload, deploy, delete, download, migrate, or change local dependencies.'
    };
  }
  if (PROJECT_BRIDGE_UNSUPPORTED_COMMANDS.has(action)) {
    return {
      class: 'unsupported_interactive_or_browser',
      requiresConfirmation: true,
      unsupported: true,
      reason: 'This project command is interactive, long-running, browser-opening, deprecated, or better run directly with the official HubSpot CLI.'
    };
  }
  return {
    class: 'unknown_project_command',
    requiresConfirmation: true,
    unsupported: true,
    reason: 'Unknown project bridge command. Run the official HubSpot CLI directly or add explicit hsapi support first.'
  };
}

function projectBridgeBaseOutput(action, account, hsBin, args, safety) {
  return {
    delegated: true,
    delegatedTo: 'official_hubspot_cli',
    commandFamily: 'hs project',
    action,
    account: {
      selector: account,
      provenance: '--account',
      note: 'HubSpot Projects auth is owned by the official hs CLI account configuration, not hsapi portal bearer auth.'
    },
    safety,
    command: projectBridgeCommandPreview(hsBin, args)
  };
}

function projectBridgePreview(action, account, hsBin, args, safety, message, options = {}) {
  printJson({
    ok: options.ok === true,
    dryRun: true,
    showRequest: true,
    message,
    ...projectBridgeBaseOutput(action, account, hsBin, args, safety)
  });
}

async function runProjectDoctor(flags) {
  const hsBin = projectBridgeHsBin(flags);
  const account = projectBridgeAccount(flags);
  const bridgeArgs = projectBridgeArgsFromFlags(flags);
  const checks = [
    {
      id: 'hs_cli.version',
      label: 'HubSpot CLI version',
      args: ['--version']
    },
    {
      id: 'hs_cli.account_info',
      label: 'HubSpot CLI account info',
      args: ['accounts', 'info', account, ...bridgeArgs]
    },
    {
      id: 'hs_cli.project_list',
      label: 'HubSpot CLI project list',
      args: ['project', 'list', ...bridgeArgs, '--account', account]
    }
  ];
  const preview = checks.map((check) => ({
    id: check.id,
    label: check.label,
    command: projectBridgeCommandPreview(hsBin, check.args)
  }));
  if (boolFlag(flags, 'show-request')) {
    printJson({
      ok: true,
      dryRun: true,
      showRequest: true,
      message: 'Project doctor would run non-mutating official HubSpot CLI checks only.',
      delegated: true,
      delegatedTo: 'official_hubspot_cli',
      commandFamily: 'hs project',
      account: {
        selector: account,
        provenance: '--account'
      },
      checks: preview
    });
    return;
  }

  const results = checks.map((check) => {
    const result = projectBridgeNormalizeResult(
      check.id === 'hs_cli.project_list' ? 'list' : check.args[1],
      runHubSpotCliProjectCommand(hsBin, check.args, { maxLines: 60 })
    );
    return {
      id: check.id,
      label: check.label,
      status: result.ok ? 'pass' : 'fail',
      command: projectBridgeCommandPreview(hsBin, check.args),
      result
    };
  });
  const summary = results.reduce((counts, check) => {
    counts[check.status] = (counts[check.status] || 0) + 1;
    return counts;
  }, {});
  const ready = !summary.fail;
  printJson({
    ok: ready,
    ready,
    delegated: true,
    delegatedTo: 'official_hubspot_cli',
    commandFamily: 'hs project',
    message: ready
      ? 'Project bridge doctor checks passed.'
      : 'Project bridge doctor checks failed. Review the official HubSpot CLI account/auth output.',
    hsCli: {
      binary: hsBin,
      version: results[0] && results[0].result && results[0].result.stdout ? results[0].result.stdout.split(/\r?\n/)[0] : null
    },
    account: {
      selector: account,
      provenance: '--account',
      note: 'Project commands delegate to the official hs CLI. hsapi does not treat ~/.hscli/config.yml as portal bearer auth.'
    },
    summary,
    checks: results
  });
  if (!ready) exitCli(1);
}

async function runProjectBridge(action, rest, flags) {
  if (!action || action === 'help') {
    writeStdout(usage());
    return;
  }
  if (action === 'doctor' || action === 'diagnose') {
    await runProjectDoctor(flags);
    return;
  }

  const normalizedAction = projectBridgeNormalizeAction(action);
  const safety = projectBridgeSafety(action);
  const hsBin = projectBridgeHsBin(flags);
  const account = projectBridgeAccount(flags);
  const delegatedArgs = projectBridgeDelegatedArgs(action, rest, flags, account);
  const base = projectBridgeBaseOutput(normalizedAction, account, hsBin, delegatedArgs, safety);

  if (safety.unsupported) {
    printJson({
      ok: false,
      message: safety.reason,
      ...base
    });
    exitCli(1);
  }

  if (boolFlag(flags, 'show-request')) {
    projectBridgePreview(normalizedAction, account, hsBin, delegatedArgs, safety, 'Project bridge preview only. No HubSpot CLI command was executed.', { ok: true });
    return;
  }

  if (safety.requiresConfirmation && !boolFlag(flags, 'yes')) {
    projectBridgePreview(normalizedAction, account, hsBin, delegatedArgs, safety, 'Project bridge command blocked. Re-run with --yes to delegate to the official HubSpot CLI.');
    exitCli(2);
    return;
  }

  const result = projectBridgeNormalizeResult(normalizedAction, runHubSpotCliProjectCommand(hsBin, delegatedArgs));
  printJson({
    ok: result.ok,
    ...base,
    mutationConfirmed: safety.requiresConfirmation ? true : undefined,
    result
  });
  if (!result.ok) exitCli(result.exitCode || 1);
}

module.exports = {
  PROJECT_BRIDGE_CONFIRM_COMMANDS,
  PROJECT_BRIDGE_INTERNAL_FLAGS,
  PROJECT_BRIDGE_READ_COMMANDS,
  PROJECT_BRIDGE_UNSUPPORTED_COMMANDS,
  projectBridgeAccount,
  projectBridgeArgsFromFlags,
  projectBridgeBaseOutput,
  projectBridgeCommandPreview,
  projectBridgeDelegatedArgs,
  projectBridgeFlagArg,
  projectBridgeHsBin,
  projectBridgeNormalizeAction,
  projectBridgeNormalizeResult,
  projectBridgePreview,
  projectBridgeRedactText,
  projectBridgeSafety,
  projectBridgeTextSummary,
  runHubSpotCliProjectCommand,
  runProjectBridge,
  runProjectDoctor,
};
