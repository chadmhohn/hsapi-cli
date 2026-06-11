// hsapi scheduler: meeting links, availability, booking, calendar events.
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
  schedulerBookBodyFromFlags,
  schedulerBookingQueryFlags,
  schedulerCalendarBodyFromFlags,
  schedulerLinksQueryFlags,
} = require('../command-inputs');
const {
  collectPages,
  guardedFetch,
  hubspotFetch,
} = require('../request');

async function runScheduler(portal, action, rest, flags) {
  const meetingsBase = '/scheduler/2026-03/meetings';
  const meetingLinksBase = `${meetingsBase}/meeting-links`;

  if (action === 'links' || action === 'meeting-links') {
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', meetingLinksBase, schedulerLinksQueryFlags(flags))
      : await hubspotFetch(portal, 'GET', meetingLinksBase, schedulerLinksQueryFlags(flags));
    printJson(result);
    return;
  }

  if (action === 'booking-info' || action === 'link') {
    const slug = rest[0] || flags.slug;
    if (!slug) fail(`scheduler ${action} requires <slug>.`);
    printJson(await hubspotFetch(portal, 'GET', `${meetingLinksBase}/book/${pathPart(slug)}`, schedulerBookingQueryFlags(flags)));
    return;
  }

  if (action === 'availability') {
    const slug = rest[0] || flags.slug;
    if (!slug) fail('scheduler availability requires <slug>.');
    printJson(await hubspotFetch(portal, 'GET', `${meetingLinksBase}/book/availability-page/${pathPart(slug)}`, schedulerBookingQueryFlags(flags)));
    return;
  }

  if (action === 'book') {
    const slug = rest[0] || flags.slug;
    printJson(await guardedFetch(portal, 'POST', `${meetingLinksBase}/book`, flags, schedulerBookBodyFromFlags(slug, flags)));
    return;
  }

  if (action === 'calendar-create') {
    const queryFlags = appendMappedSearchQuery(flags, {
      'organizer-user-id': 'organizerUserId'
    });
    if (!flags['organizer-user-id'] && !values(flags.query).some((item) => String(item).startsWith('organizerUserId='))) {
      fail('scheduler calendar-create requires --organizer-user-id or --query organizerUserId=<id>.');
    }
    printJson(await guardedFetch(portal, 'POST', `${meetingsBase}/calendar`, queryFlags, schedulerCalendarBodyFromFlags(flags)));
    return;
  }

  fail(`Unknown scheduler action: ${action}`);
}

module.exports = {
  runScheduler,
};
