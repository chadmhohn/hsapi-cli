#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(PACKAGE_ROOT, 'bin', 'hsapi.js');
const WRITE_GATE_ENV = 'HSAPI_RUN_DISPOSABLE_WRITES';

function usage() {
  return `disposable-write-smoke

Runs gated disposable write smoke checks against the disposable_write fixture.

Usage:
  node scripts/disposable-write-smoke.js [--config path] [--plan-only] [--json]

Environment:
  HSAPI_TEST_MATRIX_CONFIG       Default config path when --config is omitted.
  HSAPI_RUN_DISPOSABLE_WRITES    Must be exactly "true" before any write executes.

This script refuses to target any fixture except disposable_write and only uses
test asset names with the configured testAssetPrefix.`;
}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      flags.help = true;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--plan-only') {
      flags.planOnly = true;
    } else if (arg === '--config') {
      flags.config = argv[++index];
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

function slug(value) {
  return String(value).replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
}

function disposableContext(fixture) {
  const prefix = fixture.testAssetPrefix || 'hsapi_test_';
  if (!prefix.startsWith('hsapi_test_')) {
    throw new Error('disposable_write.testAssetPrefix must start with hsapi_test_.');
  }

  const runId = slug(process.env.HSAPI_DISPOSABLE_RUN_ID || new Date().toISOString().replace(/[-:.TZ]/g, ''));
  const emailRunId = runId.toLowerCase().replace(/_/g, '-').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'run';
  return {
    runId,
    groupName: `${prefix}group_${runId}`,
    propertyName: `${prefix}property_${runId}`,
    stageId: `${prefix}stage_${runId}`,
    stageLabel: `HSAPI Test Stage ${runId}`,
    listName: `${prefix}list_${runId}`,
    updatedListName: `${prefix}list_${runId}_updated`,
    email: `hsapi.test+${emailRunId}@example.com`,
    firstName: `HSAPI ${runId}`
  };
}

function disposablePlan(fixture) {
  const ctx = disposableContext(fixture);
  return {
    runId: ctx.runId,
    portal: 'disposable_write',
    plannedSteps: [
      {
        id: 'property_group.create',
        args: ['property-groups', 'create', 'deals', '--name', ctx.groupName, '--label', `HSAPI Test Group ${ctx.runId}`, '--yes'],
        cleanup: ['property-groups', 'archive', 'deals', ctx.groupName, '--yes']
      },
      {
        id: 'property.create',
        args: [
          'properties',
          'create',
          'deals',
          '--body',
          JSON.stringify({
            name: ctx.propertyName,
            label: `HSAPI Test Property ${ctx.runId}`,
            type: 'string',
            fieldType: 'text',
            groupName: ctx.groupName
          }),
          '--yes'
        ],
        cleanup: ['properties', 'archive', 'deals', ctx.propertyName, '--yes']
      },
      {
        id: 'pipeline_stage.create',
        args: ['pipelines', 'stage-create', 'deals', 'default', '--label', ctx.stageLabel, '--display-order', '99', '--metadata', '{"probability":"0.1"}', '--yes'],
        cleanup: ['pipelines', 'stage-delete', 'deals', 'default', '<created-stage-id>', '--yes']
      },
      {
        id: 'list.create',
        args: ['lists', 'create', '--name', ctx.listName, '--object-type-id', '0-1', '--processing-type', 'MANUAL', '--yes'],
        cleanup: ['lists', 'delete', '<created-list-id>', '--yes']
      },
      {
        id: 'crm_record.create',
        args: ['crm', 'create', 'contacts', '--properties', JSON.stringify({ email: ctx.email, firstname: ctx.firstName }), '--yes'],
        cleanup: ['crm', 'archive', 'contacts', '<created-record-id>', '--yes']
      },
      {
        id: 'import.start',
        args: ['imports', 'start', '--import-request', '<temp-import-request.json>', '--file', '<temp-contacts.csv>', '--yes'],
        cleanup: ['imports', 'cancel', '<created-import-id>', '--yes']
      }
    ]
  };
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

function expectationFor(config, fixture, stepId) {
  const expectations = {
    ...(config.disposableWriteExpectations || {}),
    ...(fixture.disposableWriteExpectations || {})
  };
  return expectations[stepId] || {};
}

function responseMessage(output) {
  if (!output || typeof output !== 'object') return null;
  return output.response && output.response.message
    ? output.response.message
    : output.data && output.data.message
      ? output.data.message
      : output.message || null;
}

function dataId(output) {
  const data = output && output.data;
  if (!data || typeof data !== 'object') return null;
  return data.id || data.listId || (data.list && data.list.listId) || data.importId || data.importRequestId || data.objectId || null;
}

function stepStatus(result, output, expectation) {
  if (result.status === 0) {
    const expectedHttpStatuses = expectation.expectedHttpStatuses || [];
    if (expectedHttpStatuses.length && output && typeof output === 'object' && !expectedHttpStatuses.includes(output.status)) {
      return 'warning';
    }
    return 'passed';
  }

  const accepted = new Set([...(expectation.acceptHttpStatuses || []), ...(expectation.expectedHttpStatuses || [])]);
  if (output && typeof output === 'object' && accepted.has(output.status)) return 'blocked';
  return 'failed';
}

async function runStep(steps, env, config, fixture, id, args, options = {}) {
  const result = await run([...args, '--portal', 'disposable_write'], env);
  const output = parseOutput(result.stdout);
  const expectation = expectationFor(config, fixture, id);
  const status = stepStatus(result, output, expectation);
  const step = {
    id,
    status,
    exitCode: result.status,
    httpStatus: output && typeof output === 'object' ? output.status || null : null,
    createdId: status === 'passed' ? dataId(output) : undefined,
    cleanup: options.cleanup === true || undefined,
    acceptedReason: status === 'blocked' && expectation.reason ? expectation.reason : undefined,
    warning: status === 'warning' && expectation.reason ? expectation.reason : undefined,
    responseMessage: responseMessage(output) || undefined,
    stderr: result.stderr || undefined
  };
  steps.push(step);
  return { step, output };
}

async function runCleanup(steps, env, id, args) {
  const result = await run([...args, '--portal', 'disposable_write'], env);
  const output = parseOutput(result.stdout);
  steps.push({
    id,
    status: result.status === 0 ? 'passed' : 'failed',
    exitCode: result.status,
    httpStatus: output && typeof output === 'object' ? output.status || null : null,
    cleanup: true,
    responseMessage: responseMessage(output) || undefined,
    stderr: result.stderr || undefined
  });
}

function createImportFiles(ctx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsapi-import-'));
  const csvPath = path.join(dir, 'contacts.csv');
  const requestPath = path.join(dir, 'import-request.json');
  fs.writeFileSync(csvPath, `email,firstname\n${ctx.email},${ctx.firstName}\n`);
  fs.writeFileSync(requestPath, JSON.stringify({
    name: `HSAPI Test Import ${ctx.runId}`,
    dateFormat: 'MONTH_DAY_YEAR',
    importOperations: { '0-1': 'CREATE' },
    files: [{
      fileName: 'contacts.csv',
      fileFormat: 'CSV',
      fileImportPage: {
        hasHeader: true,
        columnMappings: [
          {
            columnObjectTypeId: '0-1',
            columnName: 'email',
            propertyName: 'email'
          },
          {
            columnObjectTypeId: '0-1',
            columnName: 'firstname',
            propertyName: 'firstname'
          }
        ]
      }
    }]
  }, null, 2));
  return { dir, csvPath, requestPath };
}

async function runDisposableWrites(config, fixture, configPath, env) {
  const ctx = disposableContext(fixture);
  const steps = [];
  const created = {};
  let importFiles = null;

  try {
    const group = await runStep(
      steps,
      env,
      config,
      fixture,
      'property_group.create',
      ['property-groups', 'create', 'deals', '--name', ctx.groupName, '--label', `HSAPI Test Group ${ctx.runId}`, '--yes']
    );
    if (group.step.status === 'passed') created.groupName = ctx.groupName;

    const property = await runStep(
      steps,
      env,
      config,
      fixture,
      'property.create',
      [
        'properties',
        'create',
        'deals',
        '--body',
        JSON.stringify({
          name: ctx.propertyName,
          label: `HSAPI Test Property ${ctx.runId}`,
          type: 'string',
          fieldType: 'text',
          groupName: ctx.groupName
        }),
        '--yes'
      ]
    );
    if (property.step.status === 'passed') created.propertyName = ctx.propertyName;
    if (created.propertyName) {
      await runCleanup(steps, env, 'property.archive', ['properties', 'archive', 'deals', created.propertyName, '--yes']);
      delete created.propertyName;
    }
    if (created.groupName) {
      await runCleanup(steps, env, 'property_group.archive', ['property-groups', 'archive', 'deals', created.groupName, '--yes']);
      delete created.groupName;
    }

    const stage = await runStep(
      steps,
      env,
      config,
      fixture,
      'pipeline_stage.create',
      ['pipelines', 'stage-create', 'deals', 'default', '--label', ctx.stageLabel, '--display-order', '99', '--metadata', '{"probability":"0.1"}', '--yes']
    );
    if (stage.step.status === 'passed' && stage.step.createdId) {
      const stageId = String(stage.step.createdId);
      await runStep(steps, env, config, fixture, 'pipeline_stage.update', ['pipelines', 'stage-update', 'deals', 'default', stageId, '--label', `${ctx.stageLabel} Updated`, '--yes']);
      await runCleanup(steps, env, 'pipeline_stage.delete', ['pipelines', 'stage-delete', 'deals', 'default', stageId, '--yes']);
    }

    const list = await runStep(
      steps,
      env,
      config,
      fixture,
      'list.create',
      ['lists', 'create', '--name', ctx.listName, '--object-type-id', '0-1', '--processing-type', 'MANUAL', '--yes']
    );
    if (list.step.status === 'passed' && list.step.createdId) {
      const listId = String(list.step.createdId);
      await runStep(steps, env, config, fixture, 'list.update_name', ['lists', 'update-name', listId, '--name', ctx.updatedListName, '--yes']);
      await runCleanup(steps, env, 'list.delete', ['lists', 'delete', listId, '--yes']);
    }

    const record = await runStep(
      steps,
      env,
      config,
      fixture,
      'crm_record.create',
      ['crm', 'create', 'contacts', '--properties', JSON.stringify({ email: ctx.email, firstname: ctx.firstName }), '--yes']
    );
    if (record.step.status === 'passed' && record.step.createdId) {
      const recordId = String(record.step.createdId);
      await runStep(steps, env, config, fixture, 'crm_record.update', ['crm', 'update', 'contacts', recordId, '--properties', JSON.stringify({ firstname: `${ctx.firstName} Updated` }), '--yes']);
      await runCleanup(steps, env, 'crm_record.archive', ['crm', 'archive', 'contacts', recordId, '--yes']);
    }

    importFiles = createImportFiles(ctx);
    const importStart = await runStep(
      steps,
      env,
      config,
      fixture,
      'import.start',
      ['imports', 'start', '--import-request', `@${importFiles.requestPath}`, '--file', importFiles.csvPath, '--yes']
    );
    if (importStart.step.status === 'passed' && importStart.step.createdId) {
      await runCleanup(steps, env, 'import.cancel', ['imports', 'cancel', String(importStart.step.createdId), '--yes']);
    }
  } finally {
    if (created.propertyName) {
      await runCleanup(steps, env, 'property.archive.finally', ['properties', 'archive', 'deals', created.propertyName, '--yes']);
    }
    if (created.groupName) {
      await runCleanup(steps, env, 'property_group.archive.finally', ['property-groups', 'archive', 'deals', created.groupName, '--yes']);
    }
    if (importFiles) {
      fs.rmSync(importFiles.dir, { recursive: true, force: true });
    }
  }

  const hardFailures = steps.filter((step) => step.status === 'failed');
  const expectedBlocks = steps.filter((step) => step.status === 'blocked');
  const warnings = steps.filter((step) => step.status === 'warning');
  return {
    ok: hardFailures.length === 0,
    status: hardFailures.length
      ? 'failed'
      : warnings.length
        ? 'completed_with_warnings'
        : expectedBlocks.length
          ? 'completed_with_expected_blocks'
          : 'completed',
    portal: 'disposable_write',
    config: path.relative(PACKAGE_ROOT, configPath),
    runId: ctx.runId,
    steps,
    summary: {
      passed: steps.filter((step) => step.status === 'passed').length,
      blocked: expectedBlocks.length,
      warnings: warnings.length,
      failed: hardFailures.length
    }
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  const configPath = resolveConfigPath(flags.config, process.env.HSAPI_TEST_MATRIX_CONFIG);
  if (!configFileExists(configPath)) {
    const result = { ok: true, status: 'skipped', reason: 'No test matrix config found.' };
    console.log(flags.json ? JSON.stringify(result, null, 2) : result.reason);
    return;
  }

  const config = readConfig(configPath);
  const fixture = config.portals && config.portals.disposable_write;
  if (!fixture) {
    throw new Error('Config must define a disposable_write portal fixture.');
  }
  if (fixture.fixtureRole !== 'disposable_write' || fixture.fixtureSafety !== 'write-disposable-only') {
    throw new Error('disposable_write fixture must declare fixtureRole=disposable_write and fixtureSafety=write-disposable-only.');
  }

  const plan = disposablePlan(fixture);
  if (flags.planOnly) {
    const result = { ok: true, status: 'planned', portal: 'disposable_write', ...plan };
    console.log(flags.json ? JSON.stringify(result, null, 2) : `planned: ${plan.plannedSteps.length} step(s)`);
    return;
  }

  if (process.env[WRITE_GATE_ENV] !== 'true') {
    const result = {
      ok: true,
      status: 'skipped',
      reason: `${WRITE_GATE_ENV} must be exactly "true" before disposable writes run.`,
      portal: 'disposable_write',
      plannedStepCount: plan.plannedSteps.length
    };
    console.log(flags.json ? JSON.stringify(result, null, 2) : result.reason);
    return;
  }

  if (!fixture.tokenEnv || !process.env[fixture.tokenEnv]) {
    const result = {
      ok: true,
      status: 'skipped',
      reason: fixture.tokenEnv ? `Missing token env ${fixture.tokenEnv}` : 'Missing disposable_write tokenEnv.',
      portal: 'disposable_write',
      plannedStepCount: plan.plannedSteps.length
    };
    console.log(flags.json ? JSON.stringify(result, null, 2) : result.reason);
    return;
  }

  const env = {
    ...process.env,
    HSAPI_PORTALS_CONFIG: configPath
  };
  const result = await runDisposableWrites(config, fixture, configPath, env);
  console.log(flags.json ? JSON.stringify(result, null, 2) : `${result.status}: ${result.steps.length} step(s)`);
  if (!result.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
