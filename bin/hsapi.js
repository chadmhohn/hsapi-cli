#!/usr/bin/env node

const { runCli } = require('../src/cli.js');

runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  capture: false
}).then((result) => {
  if (result.status !== 0) process.exit(result.status);
}).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
