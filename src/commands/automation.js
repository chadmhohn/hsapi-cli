// hsapi automation: v4 flows, v3 workflows, sequences.
const {
  fail,
} = require('../runtime');
const {
  boolFlag,
  parseBody,
  parseStringList,
  pathPart,
  requireFlag,
} = require('../flags');
const {
  printJson,
} = require('../output');
const {
  appendMappedSearchQuery,
  sequenceEnrollmentBodyFromFlags,
  sequenceQueryFlags,
  workflowGetQueryFlags,
} = require('../command-inputs');
const {
  collectPages,
  guardedFetch,
  hubspotFetch,
} = require('../request');

async function runAutomation(portal, action, rest, flags) {
  if (action === 'flows' || action === 'flow') {
    await runAutomationFlows(portal, rest, flags);
    return;
  }

  if (action === 'workflows') {
    await runAutomationWorkflows(portal, rest, flags);
    return;
  }

  if (action === 'sequences') {
    await runAutomationSequences(portal, rest, flags);
    return;
  }

  fail(`Unknown automation action: ${action}`);
}

// Automation v4 flows (issue #24): CRUD parity with HubSpot's official Agent
// CLI. Update is a full-document PUT - fetch the flow, edit, and send it back
// with the current revisionId.

async function runAutomationFlows(portal, rest, flags) {
  const action = rest[0];
  const actionRest = rest.slice(1);
  const base = '/automation/v4/flows';

  if (action === 'list') {
    const queryFlags = appendMappedSearchQuery(flags, { limit: 'limit', after: 'after' });
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', base, queryFlags)
      : await hubspotFetch(portal, 'GET', base, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'get') {
    const flowId = actionRest[0] || flags['flow-id'];
    if (!flowId) fail('automation flows get requires <flowId> or --flow-id.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(flowId)}`, flags));
    return;
  }

  if (action === 'email-campaigns') {
    const queryFlags = appendMappedSearchQuery(flags, { limit: 'limit', after: 'after' });
    printJson(await hubspotFetch(portal, 'GET', `${base}/email-campaigns`, queryFlags));
    return;
  }

  if (action === 'batch-read') {
    const explicitBody = parseBody(flags.body);
    const body = explicitBody !== undefined ? explicitBody : {
      inputs: parseStringList(requireFlag(flags, 'ids'), 'ids')
        .map((flowId) => ({ type: 'FLOW_ID', flowId: String(flowId) }))
    };
    printJson(await guardedFetch(portal, 'POST', `${base}/batch/read`, flags, body, { readOnly: true }));
    return;
  }

  if (action === 'create') {
    const body = parseBody(flags.body || flags.flow);
    if (!body) fail('automation flows create requires --body <json|@file> (full flow definition).');
    printJson(await guardedFetch(portal, 'POST', base, flags, body));
    return;
  }

  if (action === 'update') {
    const flowId = actionRest[0] || flags['flow-id'];
    if (!flowId) fail('automation flows update requires <flowId> or --flow-id.');
    const body = parseBody(flags.body || flags.flow);
    if (!body) fail('automation flows update requires --body <json|@file> (full flow document including current revisionId).');
    printJson(await guardedFetch(portal, 'PUT', `${base}/${pathPart(flowId)}`, flags, body));
    return;
  }

  if (action === 'delete' || action === 'archive') {
    const flowId = actionRest[0] || flags['flow-id'];
    if (!flowId) fail(`automation flows ${action} requires <flowId> or --flow-id.`);
    if (!boolFlag(flags, 'danger-delete-flow')) {
      fail('automation flows delete requires --danger-delete-flow plus --yes (deleted flows are unrecoverable after 90 days).');
    }
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(flowId)}`, flags));
    return;
  }

  fail(`Unknown automation flows action: ${action}`);
}

async function runAutomationWorkflows(portal, rest, flags) {
  const action = rest[0];
  const actionRest = rest.slice(1);
  const base = '/automation/v3/workflows';

  if (action === 'list') {
    printJson(await hubspotFetch(portal, 'GET', base, flags));
    return;
  }

  if (action === 'get') {
    const workflowId = actionRest[0] || flags['workflow-id'];
    if (!workflowId) fail('automation workflows get requires <workflowId> or --workflow-id.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(workflowId)}`, workflowGetQueryFlags(flags)));
    return;
  }

  if (action === 'current-enrollment' || action === 'current_enrollment') {
    const vid = actionRest[0] || flags.vid || flags['contact-id'];
    if (!vid) fail(`automation workflows ${action} requires <vid>, --vid, or --contact-id.`);
    printJson(await hubspotFetch(portal, 'GET', `/automation/v2/workflows/enrollments/contacts/${pathPart(vid)}`, flags));
    return;
  }

  if (action === 'enroll' || action === 'enroll-contact') {
    const workflowId = actionRest[0] || flags['workflow-id'];
    const email = actionRest[1] || flags.email;
    if (!workflowId) fail(`automation workflows ${action} requires <workflowId> or --workflow-id.`);
    if (!email) fail(`automation workflows ${action} requires <email> or --email.`);
    printJson(await guardedFetch(portal, 'POST', `/automation/v2/workflows/${pathPart(workflowId)}/enrollments/contacts/${pathPart(email)}`, flags));
    return;
  }

  fail(`Unknown automation workflows action: ${action}`);
}

async function runAutomationSequences(portal, rest, flags) {
  const action = rest[0];
  const actionRest = rest.slice(1);
  const base = '/automation/sequences/2026-03';

  if (action === 'list') {
    const queryFlags = sequenceQueryFlags(flags, 'automation sequences list', {
      list: true,
      requireUser: true
    });
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', base, queryFlags)
      : await hubspotFetch(portal, 'GET', base, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'get') {
    const sequenceId = actionRest[0] || flags['sequence-id'];
    if (!sequenceId) fail('automation sequences get requires <sequenceId> or --sequence-id.');
    const queryFlags = sequenceQueryFlags(flags, 'automation sequences get', {
      requireUser: true
    });
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(sequenceId)}`, queryFlags));
    return;
  }

  if (action === 'enroll' || action === 'enroll-contact') {
    const queryFlags = sequenceQueryFlags(flags, 'automation sequences enroll', {
      requireUser: true
    });
    printJson(await guardedFetch(portal, 'POST', `${base}/enrollments`, queryFlags, sequenceEnrollmentBodyFromFlags(flags)));
    return;
  }

  if (action === 'status' || action === 'enrollment-status') {
    const contactId = actionRest[0] || flags['contact-id'];
    if (!contactId) fail(`automation sequences ${action} requires <contactId> or --contact-id.`);
    printJson(await hubspotFetch(portal, 'GET', `${base}/enrollments/contact/${pathPart(contactId)}`, flags));
    return;
  }

  fail(`Unknown automation sequences action: ${action}`);
}

module.exports = {
  runAutomation,
  runAutomationFlows,
  runAutomationSequences,
  runAutomationWorkflows,
};
