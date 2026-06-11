// hsapi owners.
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
  collectPages,
  hubspotFetch,
} = require('../request');

async function runOwners(portal, action, rest, flags) {
  const base = '/crm/v3/owners';

  if (action === 'list') {
    const queryFlags = { ...flags, query: values(flags.query) };
    if (flags.email !== undefined) queryFlags.query.push(`email=${flags.email}`);
    if (flags.limit !== undefined) queryFlags.query.push(`limit=${flags.limit}`);
    if (flags.after !== undefined) queryFlags.query.push(`after=${flags.after}`);
    if (boolFlag(flags, 'archived')) queryFlags.query.push('archived=true');
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', base, queryFlags)
      : await hubspotFetch(portal, 'GET', base, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'get') {
    const ownerId = rest[0];
    if (!ownerId) fail('owners get requires <ownerId>.');
    const queryFlags = { ...flags, query: values(flags.query) };
    if (flags['id-property'] !== undefined) queryFlags.query.push(`idProperty=${flags['id-property']}`);
    if (boolFlag(flags, 'archived')) queryFlags.query.push('archived=true');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(ownerId)}`, queryFlags));
    return;
  }

  fail(`Unknown owners action: ${action}`);
}

module.exports = {
  runOwners,
};
