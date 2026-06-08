#!/usr/bin/env node
const { runCli } = require('../src/cli');

process.env.HSAPI_PORTALS_CONFIG = process.env.HSAPI_PORTALS_CONFIG || 'examples/portals.sample.json';

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
