// hsapi schemas / object-library.
const {
  fail,
} = require('../runtime');
const {
  boolFlag,
  parseBody,
  pathPart,
} = require('../flags');
const {
  printJson,
} = require('../output');
const {
  guardedFetch,
  hubspotFetch,
} = require('../request');
const {
  resolveCrmObjectType,
} = require('../crm-object-types');

async function runSchemas(portal, action, rest, flags) {
  const base = '/crm-object-schemas/2026-03/schemas';

  if (action === 'list') {
    printJson(await hubspotFetch(portal, 'GET', base, flags));
    return;
  }

  if (action === 'get') {
    const objectType = rest[0];
    if (!objectType) fail('schemas get requires <objectTypeId|fullyQualifiedName>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(objectType)}`, flags));
    return;
  }

  if (action === 'create') {
    const body = parseBody(flags.body || flags.schema);
    if (!body) fail('schemas create requires --body <json|@file>.');
    printJson(await guardedFetch(portal, 'POST', base, flags, body));
    return;
  }

  if (action === 'update') {
    const objectType = rest[0];
    if (!objectType) fail('schemas update requires <objectTypeId>.');
    const body = parseBody(flags.body || flags.schema);
    if (!body) fail('schemas update requires --body <json|@file>.');
    printJson(await guardedFetch(portal, 'PATCH', `${base}/${pathPart(objectType)}`, flags, body));
    return;
  }

  if (action === 'delete') {
    const objectType = rest[0];
    if (!objectType) fail('schemas delete requires <objectTypeId>.');
    if (!boolFlag(flags, 'danger-archive-schema')) {
      fail('schemas delete requires --danger-archive-schema plus --yes.');
    }
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(objectType)}`, flags));
    return;
  }

  fail(`Unknown schemas action: ${action}`);
}

async function runObjectLibrary(portal, action, rest, flags) {
  if (action === 'status') {
    const objectTypeInput = rest[0];
    const resolution = objectTypeInput ? resolveCrmObjectType(objectTypeInput) : null;
    const objectTypeId = resolution && resolution.objectTypeId ? resolution.objectTypeId : objectTypeInput;
    const target = objectTypeInput
      ? `/crm/object-library/2026-03/enablement/${pathPart(objectTypeId)}`
      : '/crm/object-library/2026-03/enablement';
    printJson(await hubspotFetch(portal, 'GET', target, flags));
    return;
  }

  fail(`Unknown object-library action: ${action}`);
}

module.exports = {
  runObjectLibrary,
  runSchemas,
};
