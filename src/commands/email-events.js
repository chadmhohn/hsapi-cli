// hsapi email-events: legacy email events API - the only public source for
// per-recipient deliverability detail (sent/delivered/open/click/bounce/spam).
// Legacy paging is offset-token based (hasMore/offset), not cursor paging.
const {
  fail,
} = require('./../runtime');
const {
  pathPart,
} = require('../flags');
const {
  appendMappedSearchQuery,
} = require('../command-inputs');
const {
  hubspotFetch,
} = require('../request');
const {
  printJson,
} = require('../output');

async function runEmailEvents(portal, action, rest, flags) {
  const base = '/email/public/v1';

  if (action === 'list') {
    const queryFlags = appendMappedSearchQuery(flags, {
      recipient: 'recipient',
      'campaign-id': 'campaignId',
      'app-id': 'appId',
      'event-type': 'eventType',
      'start-timestamp': 'startTimestamp',
      'end-timestamp': 'endTimestamp',
      limit: 'limit',
      offset: 'offset'
    });
    printJson(await hubspotFetch(portal, 'GET', `${base}/events`, queryFlags));
    return;
  }

  if (action === 'get') {
    const created = rest[0];
    const eventId = rest[1];
    if (!created || !eventId) fail('email-events get requires <created> <id> (both from a prior email-events list row).');
    printJson(await hubspotFetch(portal, 'GET', `${base}/events/${pathPart(created)}/${pathPart(eventId)}`, flags));
    return;
  }

  if (action === 'campaigns') {
    const queryFlags = appendMappedSearchQuery(flags, { limit: 'limit', offset: 'offset' });
    printJson(await hubspotFetch(portal, 'GET', `${base}/campaigns/by-id`, queryFlags));
    return;
  }

  if (action === 'campaign') {
    const campaignId = rest[0] || flags['campaign-id'];
    if (!campaignId) fail('email-events campaign requires <campaignId> (hsapi email-events campaigns).');
    const queryFlags = appendMappedSearchQuery(flags, { 'app-id': 'appId' });
    printJson(await hubspotFetch(portal, 'GET', `${base}/campaigns/${pathPart(campaignId)}`, queryFlags));
    return;
  }

  fail(`Unknown email-events action: ${action}`);
}

module.exports = {
  runEmailEvents,
};
