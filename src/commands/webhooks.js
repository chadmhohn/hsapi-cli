// hsapi webhooks / webhook-journal.
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
  genericListQueryFlags,
  mappedBodyFromFlags,
  offsetsBodyFromFlags,
  webhookJournalSubscriptionBodyFromFlags,
  webhookSettingsBodyFromFlags,
  webhookSubscriptionBodyFromFlags,
} = require('../command-inputs');
const {
  guardedFetch,
  hubspotFetch,
} = require('../request');

async function runWebhooks(portal, action, rest, flags) {
  const appId = rest[0] || flags['app-id'];
  if (!appId) fail('webhooks requires <appId> or --app-id.');
  const base = `/webhooks/2026-03/${pathPart(appId)}`;

  if (action === 'settings') {
    printJson(await hubspotFetch(portal, 'GET', `${base}/settings`, flags));
    return;
  }

  if (action === 'settings-update') {
    printJson(await guardedFetch(portal, 'PUT', `${base}/settings`, flags, webhookSettingsBodyFromFlags(flags)));
    return;
  }

  if (action === 'settings-delete') {
    printJson(await guardedFetch(portal, 'DELETE', `${base}/settings`, flags));
    return;
  }

  if (action === 'subscription-create') {
    printJson(await guardedFetch(portal, 'POST', `${base}/subscriptions`, flags, webhookSubscriptionBodyFromFlags(flags, 'webhooks subscription-create')));
    return;
  }

  if (action === 'subscription-update') {
    const subscriptionId = rest[1] || flags['subscription-id'];
    if (!subscriptionId) fail('webhooks subscription-update requires <appId> <subscriptionId>.');
    printJson(await guardedFetch(portal, 'PATCH', `${base}/subscriptions/${pathPart(subscriptionId)}`, flags, webhookSubscriptionBodyFromFlags(flags, 'webhooks subscription-update')));
    return;
  }

  if (action === 'subscription-batch-update') {
    const body = batchWriteBodyFromFlags(flags, 'webhooks subscription-batch-update');
    printJson(await guardedFetch(portal, 'POST', `${base}/subscriptions/batch/update`, flags, body));
    return;
  }

  fail(`Unknown webhooks action: ${action}`);
}

async function runWebhookJournal(portal, action, rest, flags) {
  const journalBase = '/webhooks-journal/journal/2026-03';
  const localBase = '/webhooks-journal/journal-local/2026-03';
  const subscriptionsBase = '/webhooks-journal/subscriptions/2026-03';

  if (action === 'journal-earliest') {
    printJson(await hubspotFetch(portal, 'GET', `${journalBase}/earliest`, flags));
    return;
  }

  if (action === 'journal-status') {
    const statusId = rest[0];
    if (!statusId) fail('webhook-journal journal-status requires <statusId>.');
    printJson(await hubspotFetch(portal, 'GET', `${journalBase}/status/${pathPart(statusId)}`, flags));
    return;
  }

  if (action === 'journal-batch-read') {
    printJson(await guardedFetch(portal, 'POST', `${journalBase}/batch/read`, flags, offsetsBodyFromFlags(flags, 'webhook-journal journal-batch-read'), { readOnly: true }));
    return;
  }

  if (action === 'local-earliest') {
    printJson(await hubspotFetch(portal, 'GET', `${localBase}/earliest`, flags));
    return;
  }

  if (action === 'local-latest') {
    printJson(await hubspotFetch(portal, 'GET', `${localBase}/latest`, flags));
    return;
  }

  if (action === 'local-next') {
    const offset = rest[0] || flags.offset;
    if (offset === undefined) fail('webhook-journal local-next requires <offset>.');
    printJson(await hubspotFetch(portal, 'GET', `${localBase}/offset/${pathPart(offset)}/next`, flags));
    return;
  }

  if (action === 'local-status') {
    const statusId = rest[0];
    if (!statusId) fail('webhook-journal local-status requires <statusId>.');
    printJson(await hubspotFetch(portal, 'GET', `${localBase}/status/${pathPart(statusId)}`, flags));
    return;
  }

  if (action === 'local-batch-earliest' || action === 'local-batch-latest') {
    const count = rest[0] || flags.count;
    if (count === undefined) fail(`webhook-journal ${action} requires <count>.`);
    const direction = action === 'local-batch-earliest' ? 'earliest' : 'latest';
    printJson(await hubspotFetch(portal, 'GET', `${localBase}/batch/${direction}/${pathPart(count)}`, flags));
    return;
  }

  if (action === 'local-batch-read') {
    printJson(await guardedFetch(portal, 'POST', `${localBase}/batch/read`, flags, offsetsBodyFromFlags(flags, 'webhook-journal local-batch-read'), { readOnly: true }));
    return;
  }

  if (action === 'snapshot-crm') {
    printJson(await guardedFetch(portal, 'POST', '/webhooks-journal/snapshots/2026-03/crm', flags, mappedBodyFromFlags(flags, 'webhook-journal snapshot-crm', {
      'portal-id': 'portalId',
      'object-type': 'objectType',
      properties: { name: 'properties', type: 'json' }
    })));
    return;
  }

  if (action === 'subscription-list') {
    printJson(await hubspotFetch(portal, 'GET', subscriptionsBase, genericListQueryFlags(flags)));
    return;
  }

  if (action === 'subscription-create') {
    printJson(await guardedFetch(portal, 'POST', subscriptionsBase, flags, webhookJournalSubscriptionBodyFromFlags(flags, 'webhook-journal subscription-create')));
    return;
  }

  if (action === 'subscription-delete') {
    const subscriptionId = rest[0] || flags['subscription-id'];
    if (!subscriptionId) fail('webhook-journal subscription-delete requires <subscriptionId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${subscriptionsBase}/${pathPart(subscriptionId)}`, flags));
    return;
  }

  if (action === 'subscription-delete-portal') {
    const portalId = rest[0] || flags['portal-id'];
    if (!portalId) fail('webhook-journal subscription-delete-portal requires <portalId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${subscriptionsBase}/portals/${pathPart(portalId)}`, flags));
    return;
  }

  if (action === 'filter-create') {
    printJson(await guardedFetch(portal, 'POST', `${subscriptionsBase}/filters`, flags, mappedBodyFromFlags(flags, 'webhook-journal filter-create', {
      'subscription-id': 'subscriptionId',
      'object-type': 'objectType',
      'property-name': 'propertyName',
      operator: 'operator',
      value: 'value',
      filters: { name: 'filters', type: 'json' }
    })));
    return;
  }

  if (action === 'filter-list') {
    const subscriptionId = rest[0] || flags['subscription-id'];
    if (!subscriptionId) fail('webhook-journal filter-list requires <subscriptionId>.');
    printJson(await hubspotFetch(portal, 'GET', `${subscriptionsBase}/filters/subscription/${pathPart(subscriptionId)}`, flags));
    return;
  }

  if (action === 'filter-get') {
    const filterId = rest[0] || flags['filter-id'];
    if (!filterId) fail('webhook-journal filter-get requires <filterId>.');
    printJson(await hubspotFetch(portal, 'GET', `${subscriptionsBase}/filters/${pathPart(filterId)}`, flags));
    return;
  }

  if (action === 'filter-delete') {
    const filterId = rest[0] || flags['filter-id'];
    if (!filterId) fail('webhook-journal filter-delete requires <filterId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${subscriptionsBase}/filters/${pathPart(filterId)}`, flags));
    return;
  }

  fail(`Unknown webhook-journal action: ${action}`);
}

module.exports = {
  runWebhookJournal,
  runWebhooks,
};
