#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hsapi-cli-pack-smoke-'));
const prefix = path.join(tempRoot, 'prefix');
const cacheDir = path.join(tempRoot, 'npm-cache');
const npmCli = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find((candidate) => candidate && fs.existsSync(candidate)) || null;
const npmBin = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const npmPrefixArgs = npmCli ? [npmCli] : [];
const hsapiBin = process.platform === 'win32'
  ? path.join(prefix, 'hsapi.cmd')
  : path.join(prefix, 'bin', 'hsapi');
const env = {
  ...process.env,
  npm_config_cache: cacheDir,
  npm_config_update_notifier: 'false',
};

let tarballPath;

function execCommand(command, args, options) {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command, ...args], options);
  }
  return execFileSync(command, args, options);
}

function runNpm(args, options = {}) {
  return execCommand(npmBin, [...npmPrefixArgs, ...args], {
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

  runNpm(['install', '-g', '--prefix', prefix, tarballPath]);

  const installedRoot = process.platform === 'win32'
    ? path.join(prefix, 'node_modules', 'hsapi-cli')
    : path.join(prefix, 'lib', 'node_modules', 'hsapi-cli');
  const requiredFiles = [
    'AGENTS.md',
    'CLAUDE.md',
    'README.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
    path.join('docs', 'INSTALL.md'),
    path.join('docs', 'OAUTH_FIRST_AUTH_DESIGN.md'),
    path.join('docs', 'OAUTH_SETUP.md'),
    path.join('cloudflare', 'hsapi-oauth-broker', 'README.md'),
    path.join('examples', 'portals.sample.json'),
    path.join('src', 'oauth-broker.js'),
  ];

  for (const relative of requiredFiles) {
    const absolute = path.join(installedRoot, relative);
    if (!fs.existsSync(absolute)) {
      throw new Error(`missing installed file: ${relative}`);
    }
  }

  const externalConfigDir = path.join(tempRoot, 'external-config');
  const externalConfigPath = path.join(externalConfigDir, 'portals.json');
  const externalCachePath = path.join(tempRoot, 'oauth-cache.json');
  const brokerStartKey = 'b'.repeat(43);
  fs.mkdirSync(externalConfigDir, { recursive: true });
  const externalConfigText = `${JSON.stringify({
    default: 'hosted-smoke',
    portals: {
      'hosted-smoke': {
        label: 'Hosted OAuth package smoke',
        portalId: '246523489',
        baseUrl: 'https://api.hubapi.com',
        auth: {
          defaultFamily: 'oauth',
          oauth: {
            mode: 'hosted_broker',
            brokerUrl: 'https://oauth.example.test',
            brokerStartKeyEnv: 'HSAPI_OAUTH_BROKER_START_KEY',
            tokenCachePath: externalCachePath,
          },
        },
      },
    },
  }, null, 2)}\n`;
  fs.writeFileSync(externalConfigPath, externalConfigText, { mode: 0o600 });
  const installedEnv = {
    ...env,
    HSAPI_OAUTH_BROKER_START_KEY: brokerStartKey,
    HSAPI_PORTALS_CONFIG: externalConfigPath,
  };

  const helpOutput = execCommand(hsapiBin, ['--help'], {
    cwd: root,
    env: installedEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (!helpOutput.includes('hsapi - portal-aware HubSpot API CLI')) {
    throw new Error('installed binary did not respond with expected help output');
  }

  const doctorText = execCommand(hsapiBin, ['auth', 'doctor', '--portal', 'hosted-smoke', '--require-env'], {
    cwd: root,
    env: installedEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const doctor = JSON.parse(doctorText);
  if (!doctor.ok || !doctor.ready || doctor.profiles?.[0]?.authDefaultFamily !== 'oauth') {
    throw new Error('installed hosted OAuth profile did not pass offline auth doctor');
  }
  if (doctorText.includes(brokerStartKey)) {
    throw new Error('installed auth doctor printed the broker session-start credential');
  }
  if (doctorText.includes('HUBSPOT_CLIENT_SECRET') || doctorText.includes('HUBSPOT_CLIENT_ID')) {
    throw new Error('hosted OAuth package smoke unexpectedly required local HubSpot app credentials');
  }

  const configBeforeReinstall = fs.readFileSync(externalConfigPath);
  runNpm(['install', '-g', '--prefix', prefix, tarballPath]);
  const configAfterReinstall = fs.readFileSync(externalConfigPath);
  if (!configBeforeReinstall.equals(configAfterReinstall)) {
    throw new Error('package reinstall modified the external portal config');
  }

  console.log('pack install smoke passed');
} finally {
  if (tarballPath && fs.existsSync(tarballPath)) {
    fs.unlinkSync(tarballPath);
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
