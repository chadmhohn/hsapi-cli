// hsapi exports / imports.
const {
  fail,
} = require('../runtime');
const {
  boolFlag,
  pathPart,
  values,
} = require('../flags');
const {
  printJson,
} = require('../output');
const {
  exportStartBodyFromFlags,
  importMultipartFromFlags,
} = require('../command-inputs');
const {
  guardedFetch,
  guardedMultipartFetch,
  hubspotFetch,
} = require('../request');

async function runExports(portal, action, rest, flags) {
  const base = '/crm/exports/2026-03/export';

  if (action === 'start') {
    const body = exportStartBodyFromFlags(flags);
    printJson(await guardedFetch(portal, 'POST', `${base}/async`, flags, body));
    return;
  }

  if (action === 'get') {
    const exportId = rest[0];
    if (!exportId) fail('exports get requires <exportId>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(exportId)}`, flags));
    return;
  }

  if (action === 'status') {
    const taskId = rest[0];
    if (!taskId) fail('exports status requires <taskId>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/async/tasks/${pathPart(taskId)}/status`, flags));
    return;
  }

  fail(`Unknown exports action: ${action}`);
}

async function runImports(portal, action, rest, flags) {
  const base = '/crm/imports/2026-03';

  if (action === 'list') {
    const queryFlags = { ...flags, query: values(flags.query) };
    if (flags.limit !== undefined) queryFlags.query.push(`limit=${flags.limit}`);
    if (flags.after !== undefined) queryFlags.query.push(`after=${flags.after}`);
    printJson(await hubspotFetch(portal, 'GET', base, queryFlags));
    return;
  }

  if (action === 'get') {
    const importId = rest[0];
    if (!importId) fail('imports get requires <importId>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(importId)}`, flags));
    return;
  }

  if (action === 'errors') {
    const importId = rest[0];
    if (!importId) fail('imports errors requires <importId>.');
    const queryFlags = { ...flags, query: values(flags.query) };
    if (flags.limit !== undefined) queryFlags.query.push(`limit=${flags.limit}`);
    if (flags.after !== undefined) queryFlags.query.push(`after=${flags.after}`);
    if (flags['include-error-message'] !== undefined) queryFlags.query.push(`includeErrorMessage=${boolFlag(flags, 'include-error-message')}`);
    if (flags['include-row-data'] !== undefined) queryFlags.query.push(`includeRowData=${boolFlag(flags, 'include-row-data')}`);
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(importId)}/errors`, queryFlags));
    return;
  }

  if (action === 'cancel') {
    const importId = rest[0];
    if (!importId) fail('imports cancel requires <importId>.');
    printJson(await guardedFetch(portal, 'POST', `${base}/${pathPart(importId)}/cancel`, flags));
    return;
  }

  if (action === 'start') {
    const { form, previewBody } = importMultipartFromFlags(flags);
    printJson(await guardedMultipartFetch(portal, 'POST', base, flags, form, previewBody));
    return;
  }

  fail(`Unknown imports action: ${action}`);
}

module.exports = {
  runExports,
  runImports,
};
