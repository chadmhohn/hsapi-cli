// hsapi marketing: emails, campaigns, marketing events, transactional sends.
const {
  fail,
} = require('../runtime');
const {
  boolFlag,
  pathPart,
} = require('../flags');
const {
  printJson,
} = require('../output');
const {
  campaignBodyFromFlags,
  genericListQueryFlags,
  marketingEmailBodyFromFlags,
  marketingEventBodyFromFlags,
  transactionalEmailBodyFromFlags,
} = require('../command-inputs');
const {
  collectPages,
  guardedFetch,
  hubspotFetch,
} = require('../request');

async function runMarketing(portal, action, rest, flags) {
  if (action === 'emails') {
    await runMarketingEmails(portal, rest, flags);
    return;
  }

  if (action === 'campaigns') {
    await runMarketingCampaigns(portal, rest, flags);
    return;
  }

  if (action === 'events') {
    await runMarketingEvents(portal, rest, flags);
    return;
  }

  if (action === 'transactional' || action === 'transactional-email' || action === 'transactional-emails') {
    await runMarketingTransactional(portal, rest, flags);
    return;
  }

  fail(`Unknown marketing action: ${action}`);
}

async function runMarketingEmails(portal, rest, flags) {
  const action = rest[0];
  const actionRest = rest.slice(1);
  const base = '/marketing/emails/2026-03';

  if (action === 'create') {
    printJson(await guardedFetch(portal, 'POST', base, flags, marketingEmailBodyFromFlags(flags, 'marketing emails create')));
    return;
  }

  if (action === 'update' || action === 'patch') {
    const emailId = actionRest[0] || flags['email-id'];
    if (!emailId) fail(`marketing emails ${action} requires <emailId>.`);
    printJson(await guardedFetch(portal, 'PATCH', `${base}/${pathPart(emailId)}`, flags, marketingEmailBodyFromFlags(flags, `marketing emails ${action}`)));
    return;
  }

  if (action === 'delete' || action === 'archive') {
    const emailId = actionRest[0] || flags['email-id'];
    if (!emailId) fail(`marketing emails ${action} requires <emailId>.`);
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(emailId)}`, flags));
    return;
  }

  fail(`Unknown marketing emails action: ${action}`);
}

async function runMarketingCampaigns(portal, rest, flags) {
  const action = rest[0];
  const actionRest = rest.slice(1);
  const base = '/marketing/campaigns/2026-03';

  if (action === 'create') {
    printJson(await guardedFetch(portal, 'POST', base, flags, campaignBodyFromFlags(flags, 'marketing campaigns create')));
    return;
  }

  if (action === 'get') {
    const campaignGuid = actionRest[0] || flags['campaign-guid'] || flags['campaign-id'];
    if (!campaignGuid) fail('marketing campaigns get requires <campaignGuid>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(campaignGuid)}`, genericListQueryFlags(flags)));
    return;
  }

  if (action === 'delete' || action === 'archive') {
    const campaignGuid = actionRest[0] || flags['campaign-guid'] || flags['campaign-id'];
    if (!campaignGuid) fail(`marketing campaigns ${action} requires <campaignGuid>.`);
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(campaignGuid)}`, flags));
    return;
  }

  fail(`Unknown marketing campaigns action: ${action}`);
}

async function runMarketingEvents(portal, rest, flags) {
  const action = rest[0];
  const base = '/marketing/marketing-events/2026-03';

  if (action === 'list') {
    const queryFlags = genericListQueryFlags(flags);
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', base, queryFlags)
      : await hubspotFetch(portal, 'GET', base, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'create') {
    printJson(await guardedFetch(portal, 'POST', `${base}/events`, flags, marketingEventBodyFromFlags(flags, 'marketing events create')));
    return;
  }

  if (action === 'upsert') {
    printJson(await guardedFetch(portal, 'POST', `${base}/events/upsert`, flags, marketingEventBodyFromFlags(flags, 'marketing events upsert', { wrapInputs: true })));
    return;
  }

  fail(`Unknown marketing events action: ${action}`);
}

async function runMarketingTransactional(portal, rest, flags) {
  const action = rest[0];
  if (action !== 'send') fail(`Unknown marketing transactional action: ${action}`);
  printJson(await guardedFetch(portal, 'POST', '/marketing/transactional/2026-03/single-email/send', flags, transactionalEmailBodyFromFlags(flags, 'marketing transactional send')));
}

module.exports = {
  runMarketing,
  runMarketingCampaigns,
  runMarketingEmails,
  runMarketingEvents,
  runMarketingTransactional,
};
