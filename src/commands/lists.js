// hsapi lists.
const {
  fail,
} = require('../runtime');
const {
  boolFlag,
  pathPart,
  requireFlag,
  values,
} = require('../flags');
const {
  printJson,
} = require('../output');
const {
  listCreateBodyFromFlags,
  listMembershipBodyFromFlags,
  listSearchBodyFromFlags,
} = require('../command-inputs');
const {
  guardedFetch,
  hubspotFetch,
} = require('../request');
const {
  resolvedCrmObjectTypeIdOrInput,
} = require('../crm-object-types');

async function runLists(portal, action, rest, flags) {
  const base = '/crm/lists/2026-03';

  if (action === 'search') {
    const body = listSearchBodyFromFlags(flags);
    printJson(await hubspotFetch(portal, 'POST', `${base}/search`, flags, body));
    return;
  }

  if (action === 'get') {
    const listId = rest[0];
    if (!listId) fail('lists get requires <listId>.');
    const queryFlags = { ...flags, query: values(flags.query) };
    if (boolFlag(flags, 'include-filters')) queryFlags.query.push('includeFilters=true');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(listId)}`, queryFlags));
    return;
  }

  if (action === 'get-by-name') {
    const [objectTypeIdInput, listName] = rest;
    if (!objectTypeIdInput || !listName) fail('lists get-by-name requires <objectTypeId> <listName>.');
    const objectTypeId = resolvedCrmObjectTypeIdOrInput(objectTypeIdInput);
    const queryFlags = { ...flags, query: values(flags.query) };
    if (boolFlag(flags, 'include-filters')) queryFlags.query.push('includeFilters=true');
    printJson(await hubspotFetch(portal, 'GET', `${base}/object-type-id/${pathPart(objectTypeId)}/name/${pathPart(listName)}`, queryFlags));
    return;
  }

  if (action === 'create') {
    const body = listCreateBodyFromFlags(flags);
    printJson(await guardedFetch(portal, 'POST', base, flags, body));
    return;
  }

  if (action === 'update-name') {
    const listId = rest[0];
    if (!listId) fail('lists update-name requires <listId>.');
    const queryFlags = { ...flags, query: values(flags.query) };
    queryFlags.query.push(`listName=${requireFlag(flags, 'name')}`);
    if (boolFlag(flags, 'include-filters')) queryFlags.query.push('includeFilters=true');
    printJson(await guardedFetch(portal, 'PUT', `${base}/${pathPart(listId)}/update-list-name`, queryFlags));
    return;
  }

  if (action === 'delete') {
    const listId = rest[0];
    if (!listId) fail('lists delete requires <listId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(listId)}`, flags));
    return;
  }

  if (action === 'restore') {
    const listId = rest[0];
    if (!listId) fail('lists restore requires <listId>.');
    printJson(await guardedFetch(portal, 'PUT', `${base}/${pathPart(listId)}/restore`, flags));
    return;
  }

  if (action === 'memberships') {
    const listId = rest[0];
    if (!listId) fail('lists memberships requires <listId>.');
    const queryFlags = { ...flags, query: values(flags.query) };
    queryFlags.query.push(`limit=${flags.limit || 100}`);
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(listId)}/memberships`, queryFlags));
    return;
  }

  if (action === 'membership-update') {
    const listId = rest[0];
    if (!listId) fail('lists membership-update requires <listId>.');
    const body = listMembershipBodyFromFlags(flags);
    printJson(await guardedFetch(portal, 'PUT', `${base}/${pathPart(listId)}/memberships/add-and-remove`, flags, body));
    return;
  }

  if (action === 'memberships-clear') {
    const listId = rest[0];
    if (!listId) fail('lists memberships-clear requires <listId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(listId)}/memberships`, flags));
    return;
  }

  if (action === 'record-memberships') {
    const [objectTypeIdInput, recordId] = rest;
    if (!objectTypeIdInput || !recordId) fail('lists record-memberships requires <objectTypeId> <recordId>.');
    const objectTypeId = resolvedCrmObjectTypeIdOrInput(objectTypeIdInput);
    printJson(await hubspotFetch(portal, 'GET', `${base}/records/${pathPart(objectTypeId)}/${pathPart(recordId)}/memberships`, flags));
    return;
  }

  fail(`Unknown lists action: ${action}`);
}

module.exports = {
  runLists,
};
