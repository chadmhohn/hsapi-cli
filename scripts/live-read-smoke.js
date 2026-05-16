#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(PACKAGE_ROOT, 'bin', 'hsapi.js');

function usage() {
  return `live-read-smoke

Runs safe read-only smoke checks against configured HubSpot test portals.

Usage:
  node scripts/live-read-smoke.js [--config path] [--portal name] [--json]

Environment:
  HSAPI_TEST_MATRIX_CONFIG  Default config path when --config is omitted.
  HSAPI_PORTALS_CONFIG      Fallback config path.

This script skips cleanly when config or token env vars are missing. It never
runs mutations.`;
}

function parseArgs(argv) {
  const flags = { portal: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      flags.help = true;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--config') {
      flags.config = argv[++index];
    } else if (arg === '--portal') {
      flags.portal.push(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return flags;
}

function readConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function resolveConfigPath(...values) {
  const value = values.find(Boolean);
  return value ? path.resolve(value) : null;
}

function configFileExists(configPath) {
  return Boolean(configPath && fs.existsSync(configPath) && fs.statSync(configPath).isFile());
}

function commandPlanForFixture(fixture) {
  const role = fixture.fixtureRole || 'generic';
  const commands = [
    { id: 'account.details', args: ['account', 'details'] },
    { id: 'tiers.portal', args: ['tiers', 'portal'] },
    { id: 'properties.contacts', args: ['properties', 'list', 'contacts', '--names-only'] },
    { id: 'pipelines.deals', args: ['pipelines', 'list', 'deals'] },
    { id: 'limits.custom_properties', args: ['limits', 'custom-properties'] }
  ];

  if (['professional_like', 'enterprise_like', 'no_custom_objects', 'disposable_write'].includes(role)) {
    commands.push(
      { id: 'limits.calculated_properties', args: ['limits', 'calculated-properties'] },
      { id: 'limits.association_labels', args: ['limits', 'association-labels', '0-1', '0-2'] }
    );
  }

  if (['enterprise_like', 'disposable_write'].includes(role)) {
    commands.push({ id: 'schemas.list', args: ['schemas', 'list'] });
  }

  if (role === 'no_custom_objects') {
    commands.push({ id: 'schemas.list.expected_empty', args: ['schemas', 'list'] });
  }

  return commands;
}

function commandExpectation(config, fixture, spec) {
  const expectations = {
    ...(config.commandExpectations || {}),
    ...(fixture.commandExpectations || {})
  };
  return expectations[spec.id] || expectations[spec.id.replace(/\.expected_[^.]+$/, '')] || {};
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: PACKAGE_ROOT,
      env,
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

function parseOutput(stdout) {
  if (!stdout.trim()) return null;
  try {
    return JSON.parse(stdout);
  } catch (_error) {
    return stdout.trim();
  }
}

function commandAccepted(result, spec) {
  if (result.status === 0) return true;
  const output = parseOutput(result.stdout);
  const acceptedHttpStatuses = new Set([
    ...(spec.acceptHttpStatuses || []),
    ...(spec.expectation && spec.expectation.acceptHttpStatuses || []),
    ...(spec.expectation && spec.expectation.expectedHttpStatuses || [])
  ]);
  return Boolean(
    acceptedHttpStatuses.size
    && output
    && typeof output === 'object'
    && acceptedHttpStatuses.has(output.status)
  );
}

function outputResultCount(output) {
  if (!output || typeof output !== 'object') return null;
  if (Array.isArray(output)) return output.length;
  if (Array.isArray(output.results)) return output.results.length;
  if (Array.isArray(output.data)) return output.data.length;
  if (output.data && Array.isArray(output.data.results)) return output.data.results.length;
  if (output.body && Array.isArray(output.body)) return output.body.length;
  if (output.body && Array.isArray(output.body.results)) return output.body.results.length;
  return null;
}

function commandExpectationMismatch(output, expectation) {
  if (!expectation || !output || typeof output !== 'object') return false;
  const resultCount = outputResultCount(output);
  if (
    typeof expectation.expectedResultCount === 'number'
    && resultCount !== expectation.expectedResultCount
  ) {
    return true;
  }
  if (
    typeof expectation.minResultCount === 'number'
    && (typeof resultCount !== 'number' || resultCount < expectation.minResultCount)
  ) {
    return true;
  }
  if (
    typeof expectation.maxResultCount === 'number'
    && (typeof resultCount !== 'number' || resultCount > expectation.maxResultCount)
  ) {
    return true;
  }
  return false;
}

function commandStatus(result, spec, output) {
  const accepted = commandAccepted(result, spec);
  if (!accepted) return 'failed';

  const expectedHttpStatuses = spec.expectation && spec.expectation.expectedHttpStatuses;
  if (
    expectedHttpStatuses
    && expectedHttpStatuses.length
    && output
    && typeof output === 'object'
    && !expectedHttpStatuses.includes(output.status)
  ) {
    return 'warning';
  }

  if (commandExpectationMismatch(output, spec.expectation)) {
    return 'warning';
  }

  return 'passed';
}

async function runPortal(configPath, config, portalName, fixture) {
  const tokenEnv = fixture.tokenEnv;
  if (!tokenEnv || !process.env[tokenEnv]) {
    return {
      portal: portalName,
      role: fixture.fixtureRole || null,
      status: 'skipped',
      reason: tokenEnv ? `Missing token env ${tokenEnv}` : 'Missing tokenEnv'
    };
  }

  const env = {
    ...process.env,
    HSAPI_PORTALS_CONFIG: configPath
  };
  const commands = [];

  for (const spec of commandPlanForFixture(fixture)) {
    spec.expectation = commandExpectation(config, fixture, spec);
    const result = await run([...spec.args, '--portal', portalName], env);
    const output = parseOutput(result.stdout);
    const status = commandStatus(result, spec, output);
    commands.push({
      id: spec.id,
      status,
      exitCode: result.status,
      httpStatus: output && typeof output === 'object' ? output.status || null : null,
      resultCount: outputResultCount(output),
      acceptedReason: status === 'passed' && result.status !== 0 && spec.expectation.reason ? spec.expectation.reason : undefined,
      warning: status === 'warning' && spec.expectation.reason ? spec.expectation.reason : undefined,
      stderr: result.stderr || undefined
    });
  }

  const hasFailures = commands.some((command) => command.status === 'failed');
  const hasWarnings = commands.some((command) => command.status === 'warning');
  return {
    portal: portalName,
    role: fixture.fixtureRole || null,
    status: hasFailures ? 'failed' : hasWarnings ? 'warning' : 'passed',
    commands
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  const configPath = resolveConfigPath(flags.config, process.env.HSAPI_TEST_MATRIX_CONFIG, process.env.HSAPI_PORTALS_CONFIG);
  if (!configFileExists(configPath)) {
    const result = { ok: true, status: 'skipped', reason: 'No test matrix config found.' };
    console.log(flags.json ? JSON.stringify(result, null, 2) : result.reason);
    return;
  }

  const config = readConfig(configPath);
  const portalNames = flags.portal.length ? flags.portal : Object.keys(config.portals || {});
  const portals = [];
  for (const portalName of portalNames) {
    const fixture = config.portals && config.portals[portalName];
    if (!fixture) {
      portals.push({ portal: portalName, status: 'failed', reason: 'Portal not found in config.' });
      continue;
    }
    portals.push(await runPortal(configPath, config, portalName, fixture));
  }

  const result = {
    ok: portals.every((portal) => portal.status !== 'failed'),
    status: portals.every((portal) => portal.status === 'skipped')
      ? 'skipped'
      : portals.some((portal) => portal.status === 'warning')
        ? 'completed_with_warnings'
        : 'completed',
    config: path.relative(PACKAGE_ROOT, configPath),
    portals
  };
  console.log(flags.json ? JSON.stringify(result, null, 2) : `${result.status}: ${portals.length} portal(s) checked`);
  if (!result.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
