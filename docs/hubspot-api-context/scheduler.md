# Scheduler

The Scheduler slice covers HubSpot meeting scheduling pages, booking information, availability, meeting bookings, and calendar-event creation.

Scheduler reads can expose user availability, scheduling-page setup, consent text, and meeting form fields. Booking and calendar-create commands can create real meetings and CRM meeting activities.

## Common Commands

- `hsapi scheduler links --organizer-user-id <userId> --type PERSONAL_LINK`
- `hsapi scheduler booking-info <slug> --timezone America/New_York --month-offset 1`
- `hsapi scheduler availability <slug> --timezone America/New_York`
- `hsapi scheduler book <slug> --email ada@example.com --first-name Ada --last-name Lovelace --start-time 2026-06-01T15:00:00Z --duration 1800000 --timezone America/New_York`
- `hsapi scheduler calendar-create --organizer-user-id <userId> --title "Discovery call" --start-time 2026-06-01T15:00:00Z --end-time 2026-06-01T15:30:00Z --timezone America/New_York --associations '[...]'`

## Safety Notes

- Mutating commands require `--yes`.
- HubSpot's meetings API does not support rescheduling through these endpoints.
- The meetings API does not support UTM/content tracking, CAPTCHA tokens, payment meetings, or caller IP submission.
- `scheduler book` creates a real booking through a meeting link. Confirm slug, start time, timezone, duration, and attendee email before using `--yes`.
- `scheduler calendar-create` creates a calendar event and meeting object. Confirm `organizerUserId`, associations, and meeting object properties before using `--yes`.
- HubSpot's calendar-create docs require OAuth authorization. If a private app token returns auth or permission errors, switch to an OAuth access token issued for the installed HubSpot app and expose it through that portal profile's `tokenEnv`.
- For CRM activity management on existing records, use CRM activity/meeting object APIs instead of scheduler booking endpoints.
- Use `--body <json|@file>` for exact scheduler payloads. Convenience flags cover common booking and calendar-create fields only.

## Official References

- Scheduler guide: https://developers.hubspot.com/docs/api-reference/latest/scheduler/guide
- Retrieve meeting scheduling pages: https://developers.hubspot.com/docs/api-reference/latest/scheduler/meetings/get-meeting-links
- Retrieve meeting link booking info: https://developers.hubspot.com/docs/api-reference/latest/scheduler/meetings/get-meeting-slug
- Retrieve meeting availability: https://developers.hubspot.com/docs/api-reference/latest/scheduler/meetings/get-availability
- Book a meeting: https://developers.hubspot.com/docs/api-reference/latest/scheduler/meetings/create-meeting
- Create calendar event: https://developers.hubspot.com/docs/api-reference/latest/scheduler/calendar/create-calendar-event
