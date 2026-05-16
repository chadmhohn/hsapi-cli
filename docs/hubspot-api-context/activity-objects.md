# Activity objects and projects

The generic CRM record commands cover HubSpot activity objects and projects through their object type names. Use `hsapi crm object-types --family activity` to list the current known names and docs URLs before building a request.

Activity and project object types currently tracked by the CLI:

- `calls`
- `meetings`
- `notes`
- `emails`
- `tasks`
- `communications`
- `postal_mail`
- `projects`

Examples:

```bash
hsapi crm object-types --family activity
hsapi crm search tasks --filter hs_task_status:EQ:NOT_STARTED --properties hs_task_subject,hs_timestamp --show-request
hsapi crm create notes --properties '{"hs_note_body":"Follow-up note","hs_timestamp":"2026-05-10T15:00:00Z"}' --show-request
hsapi crm create communications --properties '{"hs_communication_channel_type":"SMS","hs_communication_logged_from":"CRM","hs_communication_body":"Confirmed next steps.","hs_timestamp":"2026-05-10T15:00:00Z"}' --show-request
hsapi crm search projects --filter hs_project_status:HAS_PROPERTY: --properties hs_project_name,hs_project_status --show-request
```

Operational guardrails:

- Activities often need associations to be useful on a CRM timeline. Use `hsapi associations ...` helpers after previewing the activity write.
- `communications` are for CRM timeline WhatsApp, LinkedIn, and SMS logging, not marketing SMS.
- `postal_mail` records represent postal mail engagements; confirm required properties in the portal before writes.
- Projects may vary by portal configuration and product access. Start with safe reads and property inspection.
