#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hsapi-cli-pack-smoke-'));
const prefix = path.join(tempRoot, 'prefix');
const cacheDir = path.join(tempRoot, 'npm-cache');
const env = {
  ...process.env,
  npm_config_cache: cacheDir,
  npm_config_update_notifier: 'false',
};

let tarballPath;

function runNpm(args, options = {}) {
  return execFileSync('npm', args, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

try {
  fs.mkdirSync(prefix, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const packOutput = runNpm(['pack', '--json']);
  const pack = JSON.parse(packOutput)[0];
  tarballPath = path.join(root, pack.filename);

  execFileSync('npm', ['install', '-g', '--prefix', prefix, tarballPath], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const installedRoot = path.join(prefix, 'lib', 'node_modules', 'hsapi-cli');
  const requiredFiles = [
    'AGENTS.md',
    'CLAUDE.md',
    'README.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
    path.join('docs', 'INSTALL.md'),
  ];

  for (const relative of requiredFiles) {
    const absolute = path.join(installedRoot, relative);
    if (!fs.existsSync(absolute)) {
      throw new Error(`missing installed file: ${relative}`);
    }
  }

  const helpOutput = execFileSync(path.join(prefix, 'bin', 'hsapi'), ['--help'], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (!helpOutput.includes('hsapi - portal-aware HubSpot API CLI')) {
    throw new Error('installed binary did not respond with expected help output');
  }

  console.log('pack install smoke passed');
} finally {
  if (tarballPath && fs.existsSync(tarballPath)) {
    fs.unlinkSync(tarballPath);
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
