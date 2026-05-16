# Automation Surfaces

This slice covers HubSpot automation and embedded CRM-extension areas, including typed workflow, sequence, calling-extension, and video-conferencing REST commands plus catalog-only or docs-only surfaces that need operator context before deeper command coverage.

## What Is Covered

- Workflows: legacy v3 list/get, v2 current enrollment, and v2 contact enrollment are typed as `hsapi automation workflows list|get|current-enrollment|enroll`; the workflows guide remains a docs-only surface because the model spans legacy v2/v3 paths and newer workflow guides.
- Sequences: list/get, enrollment, and enrollment status are typed as `hsapi automation sequences list|get|enroll|status`; the sequence guide remains a docs-only surface for operator context.
- Call recordings and transcripts: recording settings, the ready notification, and transcript create/get are typed as `hsapi extensions calling recording-settings ...`, `hsapi extensions calling recordings ready`, and `hsapi extensions calling transcripts ...` because they form one recording-to-transcript flow.
- Calling extensions: general calling settings get/delete and the channel-connection delete helper are typed as `hsapi extensions calling settings ...` and `hsapi extensions calling channel-connection delete`; treat them as embedded CRM-extension configuration, not ordinary CRM data.
- Video conferencing: app-level settings get/delete are typed as `hsapi extensions videoconferencing settings ...`; the surface controls how HubSpot delegates meeting creation, updates, deletes, and account lookups.

## Working Notes

- Workflow reads can expose workflow criteria, actions, validation details, statistics, and contact-specific enrollment state.
- Workflow enrollment can trigger live automation immediately and the legacy enroll endpoint takes the workflow ID and contact email in the path with no request body.
- Sequence reads and enrollment require the acting HubSpot `userId` where the API documents it, plus an assigned Sales Hub Professional/Enterprise or Service Hub Professional/Enterprise seat.
- Sequence enrollment is sales-sensitive, requires connected sender setup, and counts against portal inbox enrollment limits.
- Call recording settings must return an authenticated recording URL and the configured endpoint URL should include `%s` so HubSpot can substitute the external ID. The CLI supports `--url` for recording settings or `--body <json|@file>` for exact payloads.
- Recording-ready notifications and transcript creation both touch CRM timeline data. The CLI supports `--engagement-id` for ready notifications and `--engagement-id` plus `--utterances <json|@file>` for transcript creation, with `--body <json|@file>` available for exact payloads.
- Calling and video-conferencing settings are extension configuration, so treat them as live app settings rather than ordinary object writes. Calling extension deletes, video-conferencing settings deletes, and mutation commands are `--yes` gated for live writes.

## Safety Notes

- Use `--show-request` before any workflow, sequence, or extension mutation, especially `hsapi automation workflows enroll`, `hsapi automation sequences enroll`, `hsapi extensions calling recordings ready`, and `hsapi extensions videoconferencing settings delete`.
- Keep `--yes` gated for anything that enrolls contacts, changes extension URLs, sends recording/transcript notifications, or deletes calling/video-conferencing settings.
- Treat the recording callback URL and transcript payloads as production-facing integration points.

## Official References

- Workflows guide: https://developers.hubspot.com/docs/guides/api/automation/create-manage-workflows
- Workflow v3 list: https://developers.hubspot.com/docs/api-reference/legacy/automation/workflows/v3/get-workflows
- Workflow v3 get: https://developers.hubspot.com/docs/api-reference/legacy/automation/workflows/v3/get-workflow
- Workflow current enrollment: https://developers.hubspot.com/docs/api-reference/legacy/automation/workflows/v2/get-current-enrollment
- Workflow enrollment: https://developers.hubspot.com/docs/api-reference/legacy/automation/workflows/v2/enroll-contact
- Sequences guide: https://developers.hubspot.com/docs/api-reference/automation-sequences-v4/guide
- Call recordings and transcripts guide: https://developers.hubspot.com/docs/api/create-and-transcribe-call-recordings
- Retrieve recording settings: https://developers.hubspot.com/docs/api-reference/legacy/crm/extensions/calling-extensions/recording-settings/get-recording-settings
- Create recording settings: https://developers.hubspot.com/docs/api-reference/legacy/crm/extensions/calling-extensions/recording-settings/create-recording-settings
- Update recording settings: https://developers.hubspot.com/docs/api-reference/legacy/crm/extensions/calling-extensions/recording-settings/update-recording-settings
- Mark recording ready: https://developers.hubspot.com/docs/api-reference/latest/crm/extensions/calling-extensions/recording/call-recording-ready
- Create transcript: https://developers.hubspot.com/docs/api-reference/latest/crm/extensions/transcriptions/create-transcript
- Retrieve transcript: https://developers.hubspot.com/docs/api-reference/latest/crm/extensions/transcriptions/get-transcript
- Retrieve calling settings: https://developers.hubspot.com/docs/api-reference/latest/crm/extensions/calling-extensions/settings/get-calling-extensions
- Delete calling settings: https://developers.hubspot.com/docs/api-reference/latest/crm/extensions/calling-extensions/settings/delete-calling-extension
- Third-party calling / channel connection: https://developers.hubspot.com/docs/api-reference/legacy/crm/extensions/calling-extensions/third-party-calling
- Video conferencing guide: https://developers.hubspot.com/docs/guides/api/crm/extensions/video-conferencing
- Retrieve video conferencing settings: https://developers.hubspot.com/docs/api-reference/latest/crm/extensions/video-conferencing-extension/get-video-conferencing-extension
- Delete video conferencing settings: https://developers.hubspot.com/docs/api-reference/crm-video-conferencing-extension-v3/settings/delete-crm-v3-extensions-videoconferencing-settings-appId
