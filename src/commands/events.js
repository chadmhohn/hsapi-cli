// hsapi events: occurrences, definitions, sends.
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
  eventDefinitionBodyFromFlags,
  eventOccurrencesQueryFlags,
  eventPropertyBodyFromFlags,
  eventSendBodyFromFlags,
  genericListQueryFlags,
} = require('../command-inputs');
const {
  collectPages,
  guardedFetch,
  hubspotFetch,
} = require('../request');

async function runEvents(portal, action, rest, flags) {
  const occurrencesBase = '/events/event-occurrences/2026-03';
  const definitionsBase = '/events/2026-03/event-definitions';
  const sendBase = '/events/2026-03/send';

  if (action === 'types') {
    printJson(await hubspotFetch(portal, 'GET', `${occurrencesBase}/event-types`, flags));
    return;
  }

  if (action === 'occurrences') {
    const queryFlags = eventOccurrencesQueryFlags(flags);
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', occurrencesBase, queryFlags)
      : await hubspotFetch(portal, 'GET', occurrencesBase, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'definitions') {
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', definitionsBase, genericListQueryFlags(flags))
      : await hubspotFetch(portal, 'GET', definitionsBase, genericListQueryFlags(flags));
    printJson(result);
    return;
  }

  if (action === 'definition-get') {
    const eventName = rest[0];
    if (!eventName) fail('events definition-get requires <eventName>.');
    printJson(await hubspotFetch(portal, 'GET', `${definitionsBase}/${pathPart(eventName)}`, flags));
    return;
  }

  if (action === 'definition-create') {
    printJson(await guardedFetch(portal, 'POST', definitionsBase, flags, eventDefinitionBodyFromFlags(flags, 'events definition-create')));
    return;
  }

  if (action === 'definition-update') {
    const eventName = rest[0];
    if (!eventName) fail('events definition-update requires <eventName>.');
    printJson(await guardedFetch(portal, 'PATCH', `${definitionsBase}/${pathPart(eventName)}`, flags, eventDefinitionBodyFromFlags(flags, 'events definition-update')));
    return;
  }

  if (action === 'definition-delete') {
    const eventName = rest[0];
    if (!eventName) fail('events definition-delete requires <eventName>.');
    printJson(await guardedFetch(portal, 'DELETE', `${definitionsBase}/${pathPart(eventName)}`, flags));
    return;
  }

  if (action === 'property-create') {
    const eventName = rest[0];
    if (!eventName) fail('events property-create requires <eventName>.');
    printJson(await guardedFetch(portal, 'POST', `${definitionsBase}/${pathPart(eventName)}/property`, flags, eventPropertyBodyFromFlags(flags, 'events property-create')));
    return;
  }

  if (action === 'property-update') {
    const [eventName, propertyName] = rest;
    if (!eventName || !propertyName) fail('events property-update requires <eventName> <propertyName>.');
    printJson(await guardedFetch(portal, 'PATCH', `${definitionsBase}/${pathPart(eventName)}/property/${pathPart(propertyName)}`, flags, eventPropertyBodyFromFlags(flags, 'events property-update')));
    return;
  }

  if (action === 'property-delete') {
    const [eventName, propertyName] = rest;
    if (!eventName || !propertyName) fail('events property-delete requires <eventName> <propertyName>.');
    printJson(await guardedFetch(portal, 'DELETE', `${definitionsBase}/${pathPart(eventName)}/property/${pathPart(propertyName)}`, flags));
    return;
  }

  if (action === 'send') {
    printJson(await guardedFetch(portal, 'POST', sendBase, flags, eventSendBodyFromFlags(flags, 'events send')));
    return;
  }

  if (action === 'send-batch') {
    printJson(await guardedFetch(portal, 'POST', `${sendBase}/batch`, flags, eventSendBodyFromFlags(flags, 'events send-batch')));
    return;
  }

  fail(`Unknown events action: ${action}`);
}

module.exports = {
  runEvents,
};
