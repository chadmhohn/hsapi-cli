// hsapi subscriptions: communication preferences.
const {
  fail,
} = require('../runtime');
const {
  pathPart,
} = require('../flags');
const {
  printJson,
} = require('../output');
const {
  batchWriteBodyFromFlags,
  subscriptionBatchEmailsBodyFromFlags,
  subscriptionGenerateLinksBodyFromFlags,
  subscriptionQueryFlags,
  subscriptionStatusBodyFromFlags,
} = require('../command-inputs');
const {
  guardedFetch,
  hubspotFetch,
} = require('../request');

async function runSubscriptions(portal, action, rest, flags) {
  const base = '/communication-preferences/2026-03';

  if (action === 'definitions') {
    const queryFlags = subscriptionQueryFlags(flags);
    printJson(await hubspotFetch(portal, 'GET', `${base}/definitions`, queryFlags));
    return;
  }

  if (action === 'status') {
    const subscriberIdString = rest[0] || flags.email || flags['subscriber-id-string'];
    if (!subscriberIdString) fail('subscriptions status requires <email>.');
    const queryFlags = subscriptionQueryFlags(flags, { defaultChannel: 'EMAIL' });
    printJson(await hubspotFetch(portal, 'GET', `${base}/statuses/${pathPart(subscriberIdString)}`, queryFlags));
    return;
  }

  if (action === 'unsubscribe-all-status') {
    const subscriberIdString = rest[0] || flags.email || flags['subscriber-id-string'];
    if (!subscriberIdString) fail('subscriptions unsubscribe-all-status requires <email>.');
    const queryFlags = subscriptionQueryFlags(flags);
    printJson(await hubspotFetch(portal, 'GET', `${base}/statuses/${pathPart(subscriberIdString)}/unsubscribe-all`, queryFlags));
    return;
  }

  if (action === 'set-status') {
    const subscriberIdString = rest[0] || flags.email || flags['subscriber-id-string'];
    if (!subscriberIdString) fail('subscriptions set-status requires <email>.');
    const body = subscriptionStatusBodyFromFlags(flags);
    printJson(await guardedFetch(portal, 'POST', `${base}/statuses/${pathPart(subscriberIdString)}`, flags, body));
    return;
  }

  if (action === 'unsubscribe-all') {
    const subscriberIdString = rest[0] || flags.email || flags['subscriber-id-string'];
    if (!subscriberIdString) fail('subscriptions unsubscribe-all requires <email>.');
    const queryFlags = subscriptionQueryFlags(flags);
    printJson(await guardedFetch(portal, 'POST', `${base}/statuses/${pathPart(subscriberIdString)}/unsubscribe-all`, queryFlags));
    return;
  }

  if (action === 'batch-read') {
    const queryFlags = subscriptionQueryFlags(flags, { defaultChannel: 'EMAIL' });
    const body = subscriptionBatchEmailsBodyFromFlags(flags, 'subscriptions batch-read');
    printJson(await guardedFetch(portal, 'POST', `${base}/statuses/batch/read`, queryFlags, body, { readOnly: true }));
    return;
  }

  if (action === 'batch-unsubscribe-all-read') {
    const queryFlags = subscriptionQueryFlags(flags, { defaultChannel: 'EMAIL' });
    const body = subscriptionBatchEmailsBodyFromFlags(flags, 'subscriptions batch-unsubscribe-all-read');
    printJson(await guardedFetch(portal, 'POST', `${base}/statuses/batch/unsubscribe-all/read`, queryFlags, body, { readOnly: true }));
    return;
  }

  if (action === 'batch-unsubscribe-all') {
    const queryFlags = subscriptionQueryFlags(flags, { defaultChannel: 'EMAIL' });
    const body = subscriptionBatchEmailsBodyFromFlags(flags, 'subscriptions batch-unsubscribe-all');
    printJson(await guardedFetch(portal, 'POST', `${base}/statuses/batch/unsubscribe-all`, queryFlags, body));
    return;
  }

  if (action === 'batch-write') {
    const queryFlags = subscriptionQueryFlags(flags);
    const body = batchWriteBodyFromFlags(flags, 'subscriptions batch-write');
    printJson(await guardedFetch(portal, 'POST', `${base}/statuses/batch/write`, queryFlags, body));
    return;
  }

  if (action === 'generate-links') {
    const queryFlags = subscriptionQueryFlags(flags, { defaultChannel: 'EMAIL' });
    const body = subscriptionGenerateLinksBodyFromFlags(rest[0], flags);
    printJson(await guardedFetch(portal, 'POST', '/communication-preferences/v4/links/generate', queryFlags, body, { readOnly: true }));
    return;
  }

  fail(`Unknown subscriptions action: ${action}`);
}

module.exports = {
  runSubscriptions,
};
