// Local mutation audit log (issue #25): executed mutations append a redacted
// JSONL entry; payload flag values are recorded as lengths only.
const fs = require('fs');
const path = require('path');
const { fail, writeStderr } = require('./runtime');
const { SAFE_METHODS, configString, resolveHomeDirectory } = require('./flags');
const { redactTokenUrl } = require('./output');

const HISTORY_PAYLOAD_FLAGS = new Set(['--body', '--properties', '--inputs', '--fields', '--data', '--search-body']);

let currentHistoryArgv = [];

function setHistoryArgv(argv) {
  currentHistoryArgv = (argv || []).map((item) => String(item));
}

function historyFilePath() {
  const explicit = configString(process.env.HSAPI_HISTORY_FILE);
  if (explicit) return path.resolve(explicit);
  const home = resolveHomeDirectory();
  if (!home) return null;
  return path.join(home, '.local', 'state', 'hsapi', 'history.jsonl');
}

function historyEnabled() {
  const raw = configString(process.env.HSAPI_HISTORY);
  if (raw && ['0', 'false', 'off', 'no'].includes(raw.toLowerCase())) return false;
  return true;
}

function redactedHistoryArgv(argv) {
  const output = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    output.push(arg);
    if (HISTORY_PAYLOAD_FLAGS.has(arg) && index + 1 < argv.length) {
      output.push(`[payload:${String(argv[index + 1]).length} chars]`);
      index += 1;
    }
  }
  return output;
}

function recordMutationHistory(portal, method, url, endpoint, response) {
  if (!historyEnabled()) return;
  if (SAFE_METHODS.has(method)) return;
  if (endpoint && endpoint.readOnlyPost === true && endpoint.risk === 'read') return;
  const filePath = historyFilePath();
  if (!filePath) return;
  const entry = {
    ts: new Date().toISOString(),
    portal: portal.name,
    portalId: portal.portalId || null,
    method,
    url: redactTokenUrl(url.toString()),
    endpointId: endpoint && endpoint.id || null,
    risk: endpoint && endpoint.risk || null,
    status: response.status,
    ok: response.ok,
    requestId: response.headers.get('x-hubspot-correlation-id') || null,
    argv: redactedHistoryArgv(currentHistoryArgv)
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (error) {
    if (process.env.HSAPI_DEBUG) writeStderr(`history write failed: ${error.message}`);
  }
}

function recordDelegatedMutationHistory(portal, details, result) {
  if (!historyEnabled()) return;
  const filePath = historyFilePath();
  if (!filePath) return;
  const entry = {
    ts: new Date().toISOString(),
    portal: portal.name,
    portalId: portal.portalId || (details && details.actualPortalId) || null,
    method: 'DELEGATE',
    url: null,
    endpointId: details && details.surfaceId || null,
    risk: details && details.risk || null,
    status: result && result.exitCode,
    ok: Boolean(result && result.ok),
    requestId: null,
    provider: details && details.provider || null,
    commandFamily: details && details.commandFamily || null,
    action: details && details.action || null,
    // Delegated positional arguments can contain CRM SQL, names, and filters.
    // Keep only the stable command identity in the audit record.
    argv: ['hsapi', details && details.commandFamily, details && details.action].filter(Boolean)
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (error) {
    if (process.env.HSAPI_DEBUG) writeStderr(`history write failed: ${error.message}`);
  }
}

function parseHistorySince(raw) {
  if (raw === undefined || raw === true || raw === '') return null;
  const text = String(raw).trim();
  const match = /^(\d+)([hdm])$/i.exec(text);
  if (match) {
    const value = Number(match[1]);
    const unitMs = { h: 3600000, d: 86400000, m: 60000 }[match[2].toLowerCase()];
    return Date.now() - value * unitMs;
  }
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return parsed;
  fail(`Invalid --since "${raw}". Use forms like 24h, 7d, 30m, or an ISO date.`);
}

module.exports = {
  historyEnabled,
  historyFilePath,
  parseHistorySince,
  recordDelegatedMutationHistory,
  recordMutationHistory,
  redactedHistoryArgv,
  setHistoryArgv
};
