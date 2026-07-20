#!/usr/bin/env node
const path = require('path');
const { runCli } = require('../src/cli');

// This packaged smoke must never inherit a developer's real portal config.
process.env.HSAPI_PORTALS_CONFIG = path.resolve(
  __dirname,
  '..',
  'examples',
  'portals.sample.json'
);

runCli(['account', 'details', '--show-request'], {
  stdout: process.stdout,
  stderr: process.stderr,
  capture: false
}).then((result) => {
  if (result.status !== 0) process.exit(result.status);
}).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
