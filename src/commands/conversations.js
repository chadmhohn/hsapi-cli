// hsapi conversations: threads, messages, actors, custom channels, visitor tokens.
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
  conversationBodyFromFlags,
  genericListQueryFlags,
  inputsBodyFromFlags,
} = require('../command-inputs');
const {
  collectPages,
  guardedFetch,
  hubspotFetch,
} = require('../request');

async function runConversations(portal, action, rest, flags) {
  const betaBase = '/conversations/conversations/2026-09-beta';
  const customBase = '/conversations/custom-channels/2026-03';

  if (action === 'threads') {
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', `${betaBase}/threads`, genericListQueryFlags(flags))
      : await hubspotFetch(portal, 'GET', `${betaBase}/threads`, genericListQueryFlags(flags));
    printJson(result);
    return;
  }

  if (action === 'thread-get') {
    const threadId = rest[0];
    if (!threadId) fail('conversations thread-get requires <threadId>.');
    printJson(await hubspotFetch(portal, 'GET', `${betaBase}/threads/${pathPart(threadId)}`, flags));
    return;
  }

  if (action === 'thread-update') {
    const threadId = rest[0];
    if (!threadId) fail('conversations thread-update requires <threadId>.');
    printJson(await guardedFetch(portal, 'PATCH', `${betaBase}/threads/${pathPart(threadId)}`, flags, conversationBodyFromFlags(flags, 'conversations thread-update')));
    return;
  }

  if (action === 'thread-delete') {
    const threadId = rest[0];
    if (!threadId) fail('conversations thread-delete requires <threadId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${betaBase}/threads/${pathPart(threadId)}`, flags));
    return;
  }

  if (action === 'assignee-update') {
    const threadId = rest[0];
    if (!threadId) fail('conversations assignee-update requires <threadId>.');
    printJson(await guardedFetch(portal, 'PUT', `${betaBase}/threads/${pathPart(threadId)}/assignee`, flags, conversationBodyFromFlags(flags, 'conversations assignee-update')));
    return;
  }

  if (action === 'assignee-delete') {
    const threadId = rest[0];
    if (!threadId) fail('conversations assignee-delete requires <threadId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${betaBase}/threads/${pathPart(threadId)}/assignee`, flags));
    return;
  }

  if (action === 'messages') {
    const threadId = rest[0];
    if (!threadId) fail('conversations messages requires <threadId>.');
    printJson(await hubspotFetch(portal, 'GET', `${betaBase}/threads/${pathPart(threadId)}/messages`, genericListQueryFlags(flags)));
    return;
  }

  if (action === 'message-get' || action === 'message-original') {
    const [threadId, messageId] = rest;
    if (!threadId || !messageId) fail(`conversations ${action} requires <threadId> <messageId>.`);
    const suffix = action === 'message-original' ? '/original-content' : '';
    printJson(await hubspotFetch(portal, 'GET', `${betaBase}/threads/${pathPart(threadId)}/messages/${pathPart(messageId)}${suffix}`, flags));
    return;
  }

  if (action === 'message-create') {
    const threadId = rest[0];
    if (!threadId) fail('conversations message-create requires <threadId>.');
    printJson(await guardedFetch(portal, 'POST', `${betaBase}/threads/${pathPart(threadId)}/messages`, flags, conversationBodyFromFlags(flags, 'conversations message-create')));
    return;
  }

  if (action === 'actors-get') {
    const actorId = rest[0];
    if (!actorId) fail('conversations actors-get requires <actorId>.');
    printJson(await hubspotFetch(portal, 'GET', `${betaBase}/actors/${pathPart(actorId)}`, flags));
    return;
  }

  if (action === 'actors-batch-read') {
    printJson(await guardedFetch(portal, 'POST', `${betaBase}/actors/batch/read`, flags, inputsBodyFromFlags(flags, 'conversations actors-batch-read'), { readOnly: true }));
    return;
  }

  if (action === 'channels' || action === 'channel-accounts' || action === 'inboxes') {
    const route = action === 'channel-accounts' ? 'channel-accounts' : action;
    printJson(await hubspotFetch(portal, 'GET', `${betaBase}/${route}`, genericListQueryFlags(flags)));
    return;
  }

  if (action === 'channel-get' || action === 'channel-account-get' || action === 'inbox-get') {
    const id = rest[0];
    if (!id) fail(`conversations ${action} requires <id>.`);
    const route = action === 'channel-get' ? 'channels' : action === 'channel-account-get' ? 'channel-accounts' : 'inboxes';
    printJson(await hubspotFetch(portal, 'GET', `${betaBase}/${route}/${pathPart(id)}`, flags));
    return;
  }

  if (action === 'custom-channels') {
    printJson(await hubspotFetch(portal, 'GET', customBase, genericListQueryFlags(flags)));
    return;
  }

  if (action === 'custom-channel-get') {
    const channelId = rest[0];
    if (!channelId) fail('conversations custom-channel-get requires <channelId>.');
    printJson(await hubspotFetch(portal, 'GET', `${customBase}/${pathPart(channelId)}`, flags));
    return;
  }

  if (action === 'custom-channel-create') {
    printJson(await guardedFetch(portal, 'POST', customBase, flags, conversationBodyFromFlags(flags, 'conversations custom-channel-create')));
    return;
  }

  if (action === 'custom-channel-update') {
    const channelId = rest[0];
    if (!channelId) fail('conversations custom-channel-update requires <channelId>.');
    printJson(await guardedFetch(portal, 'PATCH', `${customBase}/${pathPart(channelId)}`, flags, conversationBodyFromFlags(flags, 'conversations custom-channel-update')));
    return;
  }

  if (action === 'custom-channel-delete') {
    const channelId = rest[0];
    if (!channelId) fail('conversations custom-channel-delete requires <channelId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${customBase}/${pathPart(channelId)}`, flags));
    return;
  }

  if (action === 'custom-channel-accounts') {
    const channelId = rest[0];
    if (!channelId) fail('conversations custom-channel-accounts requires <channelId>.');
    printJson(await hubspotFetch(portal, 'GET', `${customBase}/${pathPart(channelId)}/channel-accounts`, genericListQueryFlags(flags)));
    return;
  }

  if (action === 'custom-channel-account-get') {
    const [channelId, channelAccountId] = rest;
    if (!channelId || !channelAccountId) fail('conversations custom-channel-account-get requires <channelId> <channelAccountId>.');
    printJson(await hubspotFetch(portal, 'GET', `${customBase}/${pathPart(channelId)}/channel-accounts/${pathPart(channelAccountId)}`, flags));
    return;
  }

  if (action === 'custom-channel-account-create') {
    const channelId = rest[0];
    if (!channelId) fail('conversations custom-channel-account-create requires <channelId>.');
    printJson(await guardedFetch(portal, 'POST', `${customBase}/${pathPart(channelId)}/channel-accounts`, flags, conversationBodyFromFlags(flags, 'conversations custom-channel-account-create')));
    return;
  }

  if (action === 'custom-message-create') {
    const channelId = rest[0];
    if (!channelId) fail('conversations custom-message-create requires <channelId>.');
    printJson(await guardedFetch(portal, 'POST', `${customBase}/${pathPart(channelId)}/messages`, flags, conversationBodyFromFlags(flags, 'conversations custom-message-create')));
    return;
  }

  if (action === 'custom-message-get' || action === 'custom-message-update') {
    const [channelId, messageId] = rest;
    if (!channelId || !messageId) fail(`conversations ${action} requires <channelId> <messageId>.`);
    const target = `${customBase}/${pathPart(channelId)}/messages/${pathPart(messageId)}`;
    if (action === 'custom-message-get') {
      printJson(await hubspotFetch(portal, 'GET', target, flags));
    } else {
      printJson(await guardedFetch(portal, 'PATCH', target, flags, conversationBodyFromFlags(flags, 'conversations custom-message-update')));
    }
    return;
  }

  if (action === 'visitor-token') {
    printJson(await guardedFetch(portal, 'POST', '/visitor-identification/2026-03/tokens/create', flags, conversationBodyFromFlags(flags, 'conversations visitor-token')));
    return;
  }

  fail(`Unknown conversations action: ${action}`);
}

module.exports = {
  runConversations,
};
