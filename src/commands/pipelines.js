// hsapi pipelines: pipeline + stage CRUD and audits.
const {
  fail,
} = require('../runtime');
const {
  boolFlag,
  parseBody,
  pathPart,
  values,
} = require('../flags');
const {
  printJson,
} = require('../output');
const {
  bodyFromFlags,
  pipelineStageBodyFromFlags,
} = require('../command-inputs');
const {
  guardedFetch,
  hubspotFetch,
} = require('../request');
const {
  resolvedCrmPathObjectType,
} = require('../crm-object-types');

async function runPipelines(portal, action, rest, flags) {
  const objectTypeInput = rest[0];
  if (!objectTypeInput) fail('pipelines requires <objectType>.');
  const objectType = resolvedCrmPathObjectType(objectTypeInput);
  const base = `/crm/pipelines/2026-03/${pathPart(objectType)}`;

  if (action === 'list') {
    printJson(await hubspotFetch(portal, 'GET', base, flags));
    return;
  }

  if (action === 'get') {
    const pipelineId = rest[1];
    if (!pipelineId) fail('pipelines get requires <objectType> <pipelineId>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(pipelineId)}`, flags));
    return;
  }

  if (action === 'create') {
    const body = parseBody(flags.body);
    if (!body) fail('pipelines create requires --body <json|@file>.');
    printJson(await guardedFetch(portal, 'POST', base, flags, body));
    return;
  }

  if (action === 'update') {
    const pipelineId = rest[1];
    if (!pipelineId) fail('pipelines update requires <objectType> <pipelineId>.');
    const body = parseBody(flags.body) || bodyFromFlags(flags, ['label']);
    if (!Object.keys(body).length) fail('pipelines update needs --body or --label.');
    printJson(await guardedFetch(portal, 'PATCH', `${base}/${pathPart(pipelineId)}`, flags, body));
    return;
  }

  if (action === 'delete') {
    const pipelineId = rest[1];
    if (!pipelineId) fail('pipelines delete requires <objectType> <pipelineId>.');
    const queryFlags = { ...flags, query: values(flags.query) };
    if (boolFlag(flags, 'validate-references')) queryFlags.query.push('validateReferencesBeforeDelete=true');
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(pipelineId)}`, queryFlags));
    return;
  }

  if (action === 'stages') {
    const pipelineId = rest[1];
    if (!pipelineId) fail('pipelines stages requires <objectType> <pipelineId>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(pipelineId)}/stages`, flags));
    return;
  }

  if (action === 'stage-create') {
    const pipelineId = rest[1];
    if (!pipelineId) fail('pipelines stage-create requires <objectType> <pipelineId>.');
    const body = pipelineStageBodyFromFlags(flags, { requireCreateFields: true });
    printJson(await guardedFetch(portal, 'POST', `${base}/${pathPart(pipelineId)}/stages`, flags, body));
    return;
  }

  if (action === 'stage-update') {
    const [pipelineId, stageId] = [rest[1], rest[2]];
    if (!pipelineId || !stageId) fail('pipelines stage-update requires <objectType> <pipelineId> <stageId>.');
    const body = pipelineStageBodyFromFlags(flags);
    if (!Object.keys(body).length) fail('pipelines stage-update requires --body or at least one stage field.');
    printJson(await guardedFetch(portal, 'PATCH', `${base}/${pathPart(pipelineId)}/stages/${pathPart(stageId)}`, flags, body));
    return;
  }

  if (action === 'stage-delete') {
    const [pipelineId, stageId] = [rest[1], rest[2]];
    if (!pipelineId || !stageId) fail('pipelines stage-delete requires <objectType> <pipelineId> <stageId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(pipelineId)}/stages/${pathPart(stageId)}`, flags));
    return;
  }

  if (action === 'stage-audit') {
    const [pipelineId, stageId] = [rest[1], rest[2]];
    if (!pipelineId || !stageId) fail('pipelines stage-audit requires <objectType> <pipelineId> <stageId>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(pipelineId)}/stages/${pathPart(stageId)}/audit`, flags));
    return;
  }

  fail(`Unknown pipelines action: ${action}`);
}

module.exports = {
  runPipelines,
};
