// hsapi associations / association-labels / association-limits.
const {
  fail,
} = require('../runtime');
const {
  boolFlag,
  parseIdInputs,
  pathPart,
  requireFlag,
  values,
} = require('../flags');
const {
  printJson,
} = require('../output');
const {
  associationBatchBodyFromFlags,
  associationLimitBodyFromFlags,
  associationTypesBodyFromFlags,
} = require('../command-inputs');
const {
  endpointDefinitionById,
} = require('../catalog');
const {
  collectPages,
  guardedFetch,
  hubspotFetch,
} = require('../request');
const {
  resolvedCrmPathObjectType,
} = require('../crm-object-types');

async function runAssociations(portal, action, rest, flags) {
  const [fromTypeInput, second, third, fourth] = rest;
  if (!fromTypeInput || !second) fail('Missing association arguments.');
  const fromType = resolvedCrmPathObjectType(fromTypeInput);

  if (action === 'types') {
    const toType = resolvedCrmPathObjectType(second);
    const result = await hubspotFetch(portal, 'GET', `/crm/associations/2026-03/${pathPart(fromType)}/${pathPart(toType)}/labels`, flags, undefined, endpointDefinitionById('associations.labels'));
    printJson(result);
    return;
  }

  if (action === 'list') {
    const fromId = second;
    if (!third) fail('associations list requires <fromType> <fromId> <toType>.');
    const toType = resolvedCrmPathObjectType(third);
    const queryFlags = { ...flags, query: values(flags.query) };
    queryFlags.query.push(`limit=${flags.limit || 100}`);
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', `/crm/objects/2026-03/${pathPart(fromType)}/${pathPart(fromId)}/associations/${pathPart(toType)}`, queryFlags)
      : await hubspotFetch(portal, 'GET', `/crm/objects/2026-03/${pathPart(fromType)}/${pathPart(fromId)}/associations/${pathPart(toType)}`, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'create-default') {
    const fromId = second;
    const toId = fourth;
    if (!third || !toId) fail('associations create-default requires <fromType> <fromId> <toType> <toId>.');
    const toType = resolvedCrmPathObjectType(third);
    printJson(await guardedFetch(portal, 'PUT', `/crm/objects/2026-03/${pathPart(fromType)}/${pathPart(fromId)}/associations/default/${pathPart(toType)}/${pathPart(toId)}`, flags));
    return;
  }

  if (action === 'create') {
    const fromId = second;
    const toId = fourth;
    if (!third || !toId) fail('associations create requires <fromType> <fromId> <toType> <toId>.');
    const toType = resolvedCrmPathObjectType(third);
    const body = associationTypesBodyFromFlags(flags);
    printJson(await guardedFetch(portal, 'PUT', `/crm/objects/2026-03/${pathPart(fromType)}/${pathPart(fromId)}/associations/${pathPart(toType)}/${pathPart(toId)}`, flags, body));
    return;
  }

  if (action === 'delete' || action === 'archive') {
    const fromId = second;
    const toId = fourth;
    if (!third || !toId) fail(`associations ${action} requires <fromType> <fromId> <toType> <toId>.`);
    const toType = resolvedCrmPathObjectType(third);
    printJson(await guardedFetch(portal, 'DELETE', `/crm/objects/2026-03/${pathPart(fromType)}/${pathPart(fromId)}/associations/${pathPart(toType)}/${pathPart(toId)}`, flags));
    return;
  }

  if (action === 'batch-read') {
    const toType = resolvedCrmPathObjectType(second);
    const body = { inputs: parseIdInputs(flags.ids, 'ids') };
    const result = await hubspotFetch(portal, 'POST', `/crm/associations/2026-03/${pathPart(fromType)}/${pathPart(toType)}/batch/read`, flags, body);
    printJson(result);
    return;
  }

  if (action === 'batch-create-default') {
    const toType = resolvedCrmPathObjectType(second);
    const body = associationBatchBodyFromFlags(flags, 'associations batch-create-default');
    printJson(await guardedFetch(portal, 'POST', `/crm/associations/2026-03/${pathPart(fromType)}/${pathPart(toType)}/batch/associate/default`, flags, body));
    return;
  }

  if (action === 'batch-create') {
    const toType = resolvedCrmPathObjectType(second);
    const body = associationBatchBodyFromFlags(flags, 'associations batch-create');
    printJson(await guardedFetch(portal, 'POST', `/crm/associations/2026-03/${pathPart(fromType)}/${pathPart(toType)}/batch/create`, flags, body));
    return;
  }

  if (action === 'batch-archive') {
    const toType = resolvedCrmPathObjectType(second);
    const body = associationBatchBodyFromFlags(flags, 'associations batch-archive');
    printJson(await guardedFetch(portal, 'POST', `/crm/associations/2026-03/${pathPart(fromType)}/${pathPart(toType)}/batch/archive`, flags, body));
    return;
  }

  if (action === 'batch-labels-archive') {
    const toType = resolvedCrmPathObjectType(second);
    const body = associationBatchBodyFromFlags(flags, 'associations batch-labels-archive');
    printJson(await guardedFetch(portal, 'POST', `/crm/associations/2026-03/${pathPart(fromType)}/${pathPart(toType)}/batch/labels/archive`, flags, body));
    return;
  }

  fail(`Unknown associations action: ${action}`);
}

// Settings v3 user provisioning (issue #24): list/get/create/update/delete
// plus the teams and roles reference reads. Get/update/delete accept
// --id-property EMAIL to address users by email instead of user ID.

async function runAssociationLabels(portal, action, rest, flags) {
  const [fromTypeInput, toTypeInput, typeId] = rest;
  if (!fromTypeInput || !toTypeInput) fail('association-labels requires <fromType> <toType>.');
  const fromType = resolvedCrmPathObjectType(fromTypeInput);
  const toType = resolvedCrmPathObjectType(toTypeInput);
  const base = `/crm/associations/2026-03/${pathPart(fromType)}/${pathPart(toType)}/labels`;

  if (action === 'list') {
    printJson(await hubspotFetch(portal, 'GET', base, flags));
    return;
  }

  if (action === 'create') {
    const body = {
      name: requireFlag(flags, 'name'),
      label: requireFlag(flags, 'label')
    };
    if (flags['inverse-label']) body.inverseLabel = flags['inverse-label'];
    printJson(await guardedFetch(portal, 'POST', base, flags, body));
    return;
  }

  if (action === 'update') {
    if (!typeId) fail('association-labels update requires <fromType> <toType> <typeId>.');
    const body = {
      associationTypeId: Number(typeId),
      label: requireFlag(flags, 'label')
    };
    if (flags['inverse-label']) body.inverseLabel = flags['inverse-label'];
    printJson(await guardedFetch(portal, 'PUT', base, flags, body));
    return;
  }

  if (action === 'delete') {
    if (!typeId) fail('association-labels delete requires <fromType> <toType> <typeId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(typeId)}`, flags));
    return;
  }

  fail(`Unknown association-labels action: ${action}`);
}

async function runAssociationLimits(portal, action, rest, flags) {
  const [fromTypeInput, toTypeInput] = rest;
  if (!fromTypeInput || !toTypeInput) fail('association-limits requires <fromType> <toType>.');
  const fromType = resolvedCrmPathObjectType(fromTypeInput);
  const toType = resolvedCrmPathObjectType(toTypeInput);
  const base = `/crm/associations/2026-03/definitions/configurations/${pathPart(fromType)}/${pathPart(toType)}`;

  if (action === 'list') {
    printJson(await hubspotFetch(portal, 'GET', base, flags));
    return;
  }

  if (action === 'create' || action === 'update' || action === 'delete' || action === 'purge') {
    const isDelete = action === 'delete' || action === 'purge';
    const body = associationLimitBodyFromFlags(flags, { requireMax: !isDelete });
    const suffix = isDelete
      ? 'batch/purge'
      : action === 'create' ? 'batch/create' : 'batch/update';
    printJson(await guardedFetch(portal, 'POST', `${base}/${suffix}`, flags, body));
    return;
  }

  fail(`Unknown association-limits action: ${action}`);
}

module.exports = {
  runAssociationLabels,
  runAssociationLimits,
  runAssociations,
};
