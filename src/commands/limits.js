// hsapi limits: CRM limit reads.
const {
  fail,
} = require('../runtime');
const {
  pathPart,
  values,
} = require('../flags');
const {
  printJson,
} = require('../output');
const {
  hubspotFetch,
} = require('../request');

async function runLimits(portal, action, rest, flags) {
  if (action === 'association-labels') {
    const queryFlags = { ...flags, query: values(flags.query) };
    if (rest[0]) queryFlags.query.push(`fromObjectTypeId=${rest[0]}`);
    if (rest[1]) queryFlags.query.push(`toObjectTypeId=${rest[1]}`);
    printJson(await hubspotFetch(portal, 'GET', '/crm/v3/limits/associations/labels', queryFlags));
    return;
  }

  const routes = {
    records: '/crm/v3/limits/records',
    associations: rest[0]
      ? `/crm/v3/limits/associations/records/${pathPart(rest[0])}${rest[1] ? `/${pathPart(rest[1])}` : '/to'}`
      : '/crm/v3/limits/associations/records/from',
    properties: '/crm/v3/limits/custom-properties',
    'custom-properties': '/crm/v3/limits/custom-properties',
    'calculated-properties': '/crm/v3/limits/calculated-properties',
    pipelines: '/crm/v3/limits/pipelines',
    'custom-objects': '/crm/v3/limits/custom-object-types',
    'custom-object-types': '/crm/v3/limits/custom-object-types'
  };
  const target = routes[action];
  if (!target) fail(`Unknown limits action: ${action}`);
  printJson(await hubspotFetch(portal, 'GET', target, flags));
}

module.exports = {
  runLimits,
};
