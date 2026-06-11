// hsapi account: details/usage/subscription and the activity log reads.
const {
  fail,
} = require('../runtime');
const {
  boolFlag,
} = require('../flags');
const {
  printJson,
} = require('../output');
const {
  appendMappedSearchQuery,
} = require('../command-inputs');
const {
  collectPages,
  hubspotFetch,
} = require('../request');

async function runAccount(portal, action, flags) {
  if (action === 'details') {
    printJson(await hubspotFetch(portal, 'GET', '/account-info/2026-03/details', flags));
    return;
  }

  if (action === 'usage') {
    printJson(await hubspotFetch(portal, 'GET', '/account-info/2026-03/api-usage/daily/private-apps', flags));
    return;
  }

  if (action === 'audit-logs' || action === 'login-activity' || action === 'security-activity') {
    const route = action === 'audit-logs' ? 'audit-logs' : action === 'login-activity' ? 'login' : 'security';
    const queryFlags = appendMappedSearchQuery(flags, { limit: 'limit', after: 'after' });
    const target = `/account-info/2026-03/activity/${route}`;
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', target, queryFlags)
      : await hubspotFetch(portal, 'GET', target, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'subscription') {
    const account = await hubspotFetch(portal, 'GET', '/account-info/2026-03/details', flags);
    printJson({
      ok: true,
      portal: portal.name,
      label: portal.label,
      portalId: portal.portalId,
      accountType: account.data && account.data.accountType ? account.data.accountType : null,
      knownPlanLabel: portal.knownPlanLabel,
      knownPlanSource: portal.knownPlanSource,
      note: 'HubSpot account-info exposes portal/account metadata, but not a complete Starter/Pro/Enterprise bundle field. Use the tier matrix plus enabled features to infer what is available.',
      data: account.data
    });
    return;
  }

  fail(`Unknown account action: ${action}`);
}

// Quote lifecycle helpers (issue #24): publish/recall are hs_status property
// transitions on the quote CRM object - there is no dedicated publish endpoint.
// Publish sets APPROVAL_NOT_NEEDED (or PENDING_APPROVAL with --request-approval
// on portals using quote approvals); recall returns the quote to DRAFT.

module.exports = {
  runAccount,
};
