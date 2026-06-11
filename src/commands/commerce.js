// hsapi quotes / currencies / business-units.
const {
  fail,
} = require('../runtime');
const {
  boolFlag,
  parsePropertiesList,
  pathPart,
  values,
} = require('../flags');
const {
  printJson,
} = require('../output');
const {
  appendMappedSearchQuery,
} = require('../command-inputs');
const {
  endpointDefinitionById,
} = require('../catalog');
const {
  collectPages,
  guardedFetch,
  hubspotFetch,
} = require('../request');

const QUOTE_STATUS_PROPERTIES = ['hs_status', 'hs_title', 'hs_expiration_date', 'hs_quote_amount', 'hs_quote_link', 'hs_sender_company_name'];

async function runQuotes(portal, action, rest, flags) {
  const quoteId = rest[0] || flags['quote-id'];
  if (!quoteId) fail(`quotes ${action || ''} requires <quoteId> or --quote-id.`.trim());
  const target = `/crm/objects/2026-03/quotes/${pathPart(quoteId)}`;

  if (action === 'status') {
    const queryFlags = { ...flags, query: values(flags.query) };
    const extra = parsePropertiesList(flags.properties);
    for (const property of [...QUOTE_STATUS_PROPERTIES, ...extra]) {
      queryFlags.query.push(`properties=${property}`);
    }
    printJson(await hubspotFetch(portal, 'GET', target, queryFlags, undefined, endpointDefinitionById('quotes.status')));
    return;
  }

  if (action === 'publish') {
    const status = boolFlag(flags, 'request-approval') ? 'PENDING_APPROVAL' : 'APPROVAL_NOT_NEEDED';
    const body = { properties: { hs_status: status } };
    printJson(await guardedFetch(portal, 'PATCH', target, flags, body, { endpoint: endpointDefinitionById('quotes.publish') }));
    return;
  }

  if (action === 'recall' || action === 'unpublish') {
    const body = { properties: { hs_status: 'DRAFT' } };
    printJson(await guardedFetch(portal, 'PATCH', target, flags, body, { endpoint: endpointDefinitionById('quotes.recall') }));
    return;
  }

  fail(`Unknown quotes action: ${action}`);
}

// Multi-currency reads (issue #24): supported codes + portal exchange rates.
// HubSpot exposes no company-currency endpoint (404 verified live); the home
// currency rides in the exchange-rates payload on multi-currency portals.

async function runCurrencies(portal, action, flags) {
  if (action === 'codes') {
    printJson(await hubspotFetch(portal, 'GET', '/settings/v3/currencies/codes', flags));
    return;
  }

  if (action === 'exchange-rates' || action === 'rates') {
    const queryFlags = appendMappedSearchQuery(flags, { limit: 'limit', after: 'after' });
    const target = '/settings/v3/currencies/exchange-rates';
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', target, queryFlags)
      : await hubspotFetch(portal, 'GET', target, queryFlags);
    printJson(result);
    return;
  }

  fail(`Unknown currencies action: ${action}`);
}

// Business units (issue #24): the public surface is per-user visibility.

async function runBusinessUnits(portal, action, rest, flags) {
  if (action === 'user') {
    const userId = rest[0] || flags['user-id'];
    if (!userId) fail('business-units user requires <userId> or --user-id (hsapi users list).');
    printJson(await hubspotFetch(portal, 'GET', `/business-units/v3/business-units/user/${pathPart(userId)}`, flags));
    return;
  }

  fail(`Unknown business-units action: ${action}`);
}

module.exports = {
  QUOTE_STATUS_PROPERTIES,
  runBusinessUnits,
  runCurrencies,
  runQuotes,
};
