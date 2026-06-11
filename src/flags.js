// Flag and argument parsing shared by the CLI surface: argv -> positionals +
// flags, @file / @- argument loading, and the small coercion helpers command
// handlers use. Pure besides fs reads; failures route through runtime.fail.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fail } = require('./runtime');

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);
    if (inlineValue !== null) {
      addFlag(flags, key, inlineValue);
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      addFlag(flags, key, true);
    } else {
      addFlag(flags, key, next);
      index += 1;
    }
  }
  return { positionals, flags };
}
function addFlag(flags, key, value) {
  if (flags[key] === undefined) {
    flags[key] = value;
  } else if (Array.isArray(flags[key])) {
    flags[key].push(value);
  } else {
    flags[key] = [flags[key], value];
  }
}
function values(flag) {
  if (flag === undefined) return [];
  return Array.isArray(flag) ? flag : [flag];
}
function boolFlag(flags, name) {
  return flags[name] === true || flags[name] === 'true';
}
function configString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}
function requireFlag(flags, name) {
  if (flags[name] === undefined || flags[name] === true || flags[name] === '') {
    fail(`Missing required --${name}.`);
  }
  return flags[name];
}
function optionalNumber(raw) {
  if (raw === undefined || raw === true || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`Expected number, got "${raw}".`);
  return value;
}
function optionalBoolean(raw, flagName) {
  if (raw === undefined) return undefined;
  if (raw === true || raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`Expected boolean for --${flagName}, got "${raw}".`);
}
function pathPart(value) {
  return encodeURIComponent(String(value));
}
function pathTail(value, label = 'path') {
  const normalized = String(value || '').replace(/^\/+/, '');
  if (!normalized) fail(`Missing required ${label}.`);
  return normalized.split('/').map((part) => {
    if (!part || part === '.' || part === '..') fail(`Invalid ${label}: ${value}`);
    return pathPart(part);
  }).join('/');
}
function readStdinText() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (error) {
    fail(`Failed to read stdin for "@-": ${error.message}`);
  }
}
function readAtArgumentText(raw) {
  const value = String(raw);
  if (value === '@-') return readStdinText();
  return fs.readFileSync(path.resolve(value.slice(1)), 'utf8');
}
function readArgumentText(raw, label) {
  if (raw === undefined || raw === true || raw === '') fail(`Missing required --${label}.`);
  return String(raw).startsWith('@') ? readAtArgumentText(raw) : String(raw);
}
function parseBody(raw) {
  if (raw === undefined) return undefined;
  const text = String(raw).startsWith('@') ? readAtArgumentText(raw) : String(raw);
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`Body/properties must be valid JSON: ${error.message}`);
  }
}
function parseMaybeJson(raw, fallback = raw) {
  if (raw === undefined) return undefined;
  if (String(raw).startsWith('@')) return parseBody(raw);
  try {
    return JSON.parse(String(raw));
  } catch (_error) {
    return fallback;
  }
}
function parsePropertiesList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
function parseIdInputs(raw, label = 'ids') {
  const text = readArgumentText(raw, label).trim();
  if (!text) fail(`--${label} must not be empty.`);

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(normalizeBatchIdInput);
    if (parsed && Array.isArray(parsed.inputs)) return parsed.inputs.map(normalizeBatchIdInput);
  } catch (_error) {
    // Fall through to CSV/newline parsing.
  }

  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(normalizeBatchIdInput);
}
function parseStringList(raw, label) {
  if (raw === undefined) return [];
  const text = readArgumentText(raw, label).trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item));
  } catch (_error) {
    // Fall through to CSV/newline parsing.
  }

  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => String(item));
}
function normalizeBatchIdInput(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  return { id: String(input) };
}

function resolveHomeDirectory() {
  const explicitHome = configString(process.env.HOME);
  if (explicitHome) return explicitHome;
  const detectedHome = os.homedir();
  return detectedHome && detectedHome.trim() ? detectedHome : null;
}
function expandUserPath(rawPath) {
  const value = String(rawPath);
  if (value === '~') {
    const home = resolveHomeDirectory();
    if (!home) fail('Cannot expand "~" because no home directory is available (HOME is unset and os.homedir() returned nothing).');
    return home;
  }
  if (value.startsWith('~/')) {
    const home = resolveHomeDirectory();
    if (!home) fail(`Cannot expand "${value}" because no home directory is available (HOME is unset and os.homedir() returned nothing).`);
    return path.join(home, value.slice(2));
  }
  return path.resolve(value);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`Failed to read JSON from ${filePath}: ${error.message}`);
  }
}
function assertConfigObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value;
}

module.exports = {
  assertConfigObject,
  readJsonFile,
  SAFE_METHODS,
  expandUserPath,
  resolveHomeDirectory,
  addFlag,
  boolFlag,
  configString,
  normalizeBatchIdInput,
  optionalBoolean,
  optionalNumber,
  parseArgs,
  parseBody,
  parseIdInputs,
  parseMaybeJson,
  parsePropertiesList,
  parseStringList,
  pathPart,
  pathTail,
  readArgumentText,
  readAtArgumentText,
  readStdinText,
  requireFlag,
  values,
};
