#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function usage() {
  return `probe-hubspot-user-level-scopes

Probes whether HubSpot currently accepts scopes on a user-level app. Each
candidate is tested as baseline optional scopes plus one candidate scope. The
exact baseline is uploaded again in a finally block.

Usage:
  node scripts/probe-hubspot-user-level-scopes.js \\
    --project-dir <downloaded-project-dir> \\
    --baseline-meta <user-level-app-hsmeta.json> \\
    --hs-cli <path-to-@hubspot/cli/bin/hs.js> \\
    --account <account-name-or-id> \\
    --config <hubspot.config.yml> \\
    --result <result.json> \\
    --scope <scope> [--scope <scope> ...] [--combined]

This script uploads HubSpot project builds. Use it only with an isolated test
account/project whose deployed baseline is known. By default each scope is
tested independently. --combined tests all supplied scopes in one build.`;
}

function parseArgs(argv) {
  const flags = { scopes: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      flags.help = true;
    } else if (arg === '--project-dir') {
      flags.projectDir = argv[++index];
    } else if (arg === '--baseline-meta') {
      flags.baselineMeta = argv[++index];
    } else if (arg === '--hs-cli') {
      flags.hsCli = argv[++index];
    } else if (arg === '--account') {
      flags.account = argv[++index];
    } else if (arg === '--config') {
      flags.config = argv[++index];
    } else if (arg === '--result') {
      flags.result = argv[++index];
    } else if (arg === '--scope') {
      flags.scopes.push(argv[++index]);
    } else if (arg === '--combined') {
      flags.combined = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return flags;
}

function requireValue(flags, name) {
  if (!flags[name]) throw new Error(`Missing --${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
}

function assertInputs(flags) {
  for (const name of ['projectDir', 'baselineMeta', 'hsCli', 'account', 'config', 'result']) {
    requireValue(flags, name);
  }
  if (!flags.scopes.length) throw new Error('At least one --scope is required');
  if (flags.scopes.some((scope) => !scope || !scope.trim())) {
    throw new Error('--scope values must be non-empty strings');
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function authConfig(meta) {
  const auth = meta && meta.config && meta.config.auth;
  if (!auth || !Array.isArray(auth.optionalScopes)) {
    throw new Error('Baseline metadata must contain config.auth.optionalScopes');
  }
  if (!meta.config.isUserLevel) {
    throw new Error('Baseline metadata must describe a user-level app');
  }
  return auth;
}

function candidateMeta(baseline, scopes) {
  const candidate = cloneJson(baseline);
  const auth = authConfig(candidate);
  const additions = Array.isArray(scopes) ? scopes : [scopes];
  auth.optionalScopes = [...new Set([...auth.optionalScopes, ...additions])];
  return candidate;
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      resolve({ status: null, stdout, stderr, spawnError: error.message });
    });
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function classifyUpload(result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const success = /\[SUCCESS\]|successfully (?:uploaded|deployed)|deployed build/i.test(output);
  const warning = /\[WARNING\]|\bwarning\b|not fully supported|may not be supported/i.test(output);
  const failure = /\[ERROR\]|\bbuild failed\b|failed to (?:build|deploy|upload)|validation (?:error|failed)/i.test(output);

  if (success && !failure) return warning ? 'accepted_with_warning' : 'accepted';
  return 'rejected';
}

function compactOutput(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join('\n');
}

async function uploadProject(flags, message) {
  return run(process.execPath, [
    flags.hsCli,
    'project',
    'upload',
    '--account',
    flags.account,
    '--config',
    flags.config,
    '--message',
    message
  ], {
    cwd: flags.projectDir
  });
}

async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  if (flags.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  assertInputs(flags);

  flags.projectDir = path.resolve(flags.projectDir);
  flags.baselineMeta = path.resolve(flags.baselineMeta);
  flags.hsCli = path.resolve(flags.hsCli);
  flags.config = path.resolve(flags.config);
  flags.result = path.resolve(flags.result);

  const workingMetaPath = path.join(
    flags.projectDir,
    'src',
    'app',
    'user-level-app-hsmeta.json'
  );
  const baselineRaw = fs.readFileSync(flags.baselineMeta, 'utf8');
  const baseline = JSON.parse(baselineRaw);
  const baselineScopes = authConfig(baseline).optionalScopes;
  const existing = flags.scopes.filter((scope) => baselineScopes.includes(scope));
  if (existing.length) {
    throw new Error(`Scopes already present in baseline: ${existing.join(', ')}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    account: flags.account,
    projectDir: flags.projectDir,
    baselineMeta: flags.baselineMeta,
    baselineOptionalScopeCount: baselineScopes.length,
    probes: [],
    restore: null
  };

  try {
    const probeGroups = flags.combined
      ? [{ scopes: [...flags.scopes] }]
      : flags.scopes.map((scope) => ({ scopes: [scope] }));

    for (const probeGroup of probeGroups) {
      const label = probeGroup.scopes.join(', ');
      const candidate = candidateMeta(baseline, probeGroup.scopes);
      fs.writeFileSync(workingMetaPath, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
      process.stdout.write(`PROBE ${label}\n`);
      const result = await uploadProject(
        flags,
        `${flags.combined ? 'Combined scope probe' : 'Scope probe'}: ${label}`
      );
      const classification = classifyUpload(result);
      report.probes.push({
        scope: probeGroup.scopes.length === 1 ? probeGroup.scopes[0] : null,
        scopes: probeGroup.scopes,
        classification,
        exitCode: result.status,
        spawnError: result.spawnError || null,
        stdout: compactOutput(result.stdout || ''),
        stderr: compactOutput(result.stderr || '')
      });
      process.stdout.write(`RESULT ${label} ${classification} exit=${result.status}\n`);
    }
  } finally {
    fs.writeFileSync(workingMetaPath, baselineRaw, 'utf8');
    process.stdout.write('RESTORE baseline\n');
    const restore = await uploadProject(flags, 'Restore scope baseline after validation');
    report.restore = {
      classification: classifyUpload(restore),
      exitCode: restore.status,
      spawnError: restore.spawnError || null,
      stdout: compactOutput(restore.stdout || ''),
      stderr: compactOutput(restore.stderr || '')
    };
    fs.mkdirSync(path.dirname(flags.result), { recursive: true });
    fs.writeFileSync(flags.result, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`RESTORE_RESULT ${report.restore.classification} exit=${restore.status}\n`);
    process.stdout.write(`REPORT ${flags.result}\n`);
  }

  const rejected = report.probes.some((probe) => probe.classification === 'rejected');
  const restoreFailed = !report.restore || !report.restore.classification.startsWith('accepted');
  return rejected || restoreFailed ? 2 : 0;
}

if (require.main === module) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  authConfig,
  candidateMeta,
  classifyUpload,
  parseArgs
};
