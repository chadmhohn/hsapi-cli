# Marketing Surfaces

This slice collects HubSpot marketing areas that need extra care because they affect customer-facing content, campaign records, event records, or transactional sends.

## What Is Covered

- Marketing emails: create, update, and delete live at the date-versioned `/marketing/emails/2026-03` surface.
- Campaigns: campaign CRUD lives under `/marketing/campaigns/2026-03`.
- Marketing events: the event object API uses `/marketing/marketing-events/2026-03/...` and app-scoped external IDs.
- Transactional email: single-send uses `/marketing/transactional/2026-03/single-email/send`.
- CTAs: HubSpot documents CTAs as a browser JavaScript SDK under `window.HubSpotCallsToActions`, not as a REST resource.

## Typed Commands

- `hsapi marketing emails create|update|delete`
- `hsapi marketing campaigns create|get|delete`
- `hsapi marketing events list|create|upsert`
- `hsapi marketing transactional send`

No `hsapi marketing ctas` command is intentionally present; the CTA catalog row is a non-HTTP browser SDK disposition only.

## Safety Notes

- Marketing email, campaign, and transactional email work can affect live customer communications. Use `--show-request` before any mutation and keep `--yes` gated.
- Marketing events can create or update CRM-visible event records and attendance state.
- CTA work should not be modeled as a server-side HubSpot API call. The catalog entry here is intentionally a browser SDK surface under `window.HubSpotCallsToActions`, so it is tracked separately from HTTP endpoints and typed `hsapi` commands.
- Transactional email requires the dedicated transactional-email capability and should be treated separately from ordinary marketing email.

## Official References

- Marketing emails guide: https://developers.hubspot.com/docs/api-reference/latest/marketing/marketing-emails/guide
- Create marketing email: https://developers.hubspot.com/docs/api-reference/latest/marketing/marketing-emails/create-email
- Update marketing email: https://developers.hubspot.com/docs/api-reference/latest/marketing/marketing-emails/emails/update-email
- Delete marketing email: https://developers.hubspot.com/docs/api-reference/latest/marketing/marketing-emails/emails/delete-email
- Campaigns guide: https://developers.hubspot.com/docs/api-reference/latest/marketing/campaigns/guide
- Create campaign: https://developers.hubspot.com/docs/api-reference/latest/marketing/campaigns/create-campaign
- Retrieve campaign: https://developers.hubspot.com/docs/api-reference/latest/marketing/campaigns/get-campaign
- Delete campaign: https://developers.hubspot.com/docs/api-reference/latest/marketing/campaigns/delete-campaign
- Marketing events guide: https://developers.hubspot.com/docs/api-reference/latest/marketing/marketing-events/guide
- Transactional email guide: https://developers.hubspot.com/docs/api/marketing/single-send-api
- Send transactional email: https://developers.hubspot.com/docs/api-reference/latest/marketing/transactional-emails/create-transactional-email
- CTAs JavaScript API: https://developers.hubspot.com/docs/api-reference/latest/marketing/ctas-sdk/guide
