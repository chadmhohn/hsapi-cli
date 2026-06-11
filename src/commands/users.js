// hsapi users: settings v3 user provisioning plus teams/roles reads.
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
  appendMappedSearchQuery,
  mappedBodyFromFlags,
} = require('../command-inputs');
const {
  collectPages,
  guardedFetch,
  hubspotFetch,
} = require('../request');

async function runUsers(portal, action, rest, flags) {
  const base = '/settings/v3/users';

  const idPropertyQueryFlags = () => {
    const queryFlags = { ...flags, query: values(flags.query) };
    if (flags['id-property'] !== undefined) queryFlags.query.push(`idProperty=${String(flags['id-property']).toUpperCase()}`);
    return queryFlags;
  };

  if (action === 'list') {
    const queryFlags = appendMappedSearchQuery(flags, { limit: 'limit', after: 'after' });
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', base, queryFlags)
      : await hubspotFetch(portal, 'GET', base, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'get') {
    const userId = rest[0] || flags['user-id'];
    if (!userId) fail('users get requires <userId> or --user-id (use --id-property EMAIL to pass an email).');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(userId)}`, idPropertyQueryFlags()));
    return;
  }

  if (action === 'teams') {
    printJson(await hubspotFetch(portal, 'GET', `${base}/teams`, flags));
    return;
  }

  if (action === 'roles') {
    printJson(await hubspotFetch(portal, 'GET', `${base}/roles`, flags));
    return;
  }

  if (action === 'create') {
    const body = mappedBodyFromFlags(flags, 'users create', {
      email: 'email',
      'first-name': 'firstName',
      'last-name': 'lastName',
      'role-id': 'roleId',
      'role-ids': { name: 'roleIds', type: 'string-list' },
      'primary-team-id': 'primaryTeamId',
      'secondary-team-ids': { name: 'secondaryTeamIds', type: 'string-list' },
      'send-welcome-email': { name: 'sendWelcomeEmail', type: 'boolean' }
    }, { requiredFlags: ['email'] });
    printJson(await guardedFetch(portal, 'POST', base, flags, body));
    return;
  }

  if (action === 'update') {
    const userId = rest[0] || flags['user-id'];
    if (!userId) fail('users update requires <userId> or --user-id.');
    const body = mappedBodyFromFlags(flags, 'users update', {
      'first-name': 'firstName',
      'last-name': 'lastName',
      'role-id': 'roleId',
      'role-ids': { name: 'roleIds', type: 'string-list' },
      'primary-team-id': 'primaryTeamId',
      'secondary-team-ids': { name: 'secondaryTeamIds', type: 'string-list' }
    });
    printJson(await guardedFetch(portal, 'PUT', `${base}/${pathPart(userId)}`, idPropertyQueryFlags(), body));
    return;
  }

  if (action === 'delete' || action === 'remove') {
    const userId = rest[0] || flags['user-id'];
    if (!userId) fail(`users ${action} requires <userId> or --user-id.`);
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(userId)}`, idPropertyQueryFlags()));
    return;
  }

  fail(`Unknown users action: ${action}`);
}

module.exports = {
  runUsers,
};
