// Runtime stream/exit state shared by every module. The CLI entrypoint swaps
// streams per invocation (runCli capture mode); everything else writes through
// these helpers so output stays redirectable and exits stay throwable.
class CliExitError extends Error {
  constructor(code = 0) {
    super(`CLI exited with status ${code}`);
    this.name = 'CliExitError';
    this.code = code;
  }
}

const DEFAULT_RUNTIME = {
  stdout: process.stdout,
  stderr: process.stderr,
  exit(code) {
    process.exit(code);
  }
};

let currentRuntime = DEFAULT_RUNTIME;

function getCurrentRuntime() {
  return currentRuntime;
}

function setCurrentRuntime(runtime) {
  currentRuntime = runtime || DEFAULT_RUNTIME;
}

function streamWrite(stream, text) {
  if (stream && typeof stream.write === 'function') {
    stream.write(`${text}\n`);
    return;
  }
  throw new Error('CLI runtime stream is missing a write method.');
}

function writeStdout(text) {
  streamWrite(currentRuntime.stdout, text);
}

function writeStderr(text) {
  streamWrite(currentRuntime.stderr, text);
}

function exitCli(code = 0) {
  return currentRuntime.exit(code);
}

function fail(message, code = 1) {
  writeStderr(message);
  exitCli(code);
}

function memoryStream(chunks) {
  return {
    write(text) {
      chunks.push(text);
      return true;
    }
  };
}

module.exports = {
  CliExitError,
  DEFAULT_RUNTIME,
  exitCli,
  fail,
  getCurrentRuntime,
  memoryStream,
  setCurrentRuntime,
  streamWrite,
  writeStderr,
  writeStdout
};
