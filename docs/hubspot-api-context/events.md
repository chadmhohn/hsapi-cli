# Events

The Events surface covers event occurrence reads, event definitions, definition properties, and event ingestion.

Event occurrences can expose behavioral history tied to CRM records. Treat occurrence output as sensitive customer activity data, especially when filtering by contact, company, deal, ticket, or custom object IDs.

## Common Commands

- `hsapi events types`
- `hsapi events occurrences --event-type e_visited_page --object-type contact --object-id <contactId>`
- `hsapi events definitions`
- `hsapi events definition-get <eventName>`
- `hsapi events definition-create --name <eventName> --label <label> --object-type contact`
- `hsapi events property-create <eventName> --name <propertyName> --label <label> --type string --field-type text`
- `hsapi events send --event-name <eventName> --email <email> --properties '{"source":"agent"}'`
- `hsapi events send-batch --inputs '[{"eventName":"pe_test","email":"ada@example.com","properties":{}}]'`

## Safety Notes

- Mutating commands require `--yes`.
- Event definition changes can affect reporting, workflows, and downstream analytics. Preview with `--show-request` before changing definitions or properties.
- Event send commands write analytics/event data. Use a test event definition or sandbox portal before sending production events.
- The convenience flags cover common fields only. Use `--body <json|@file>` when HubSpot requires a more specific payload shape.
- Required scopes depend on the event and associated object type. Occurrence reads may require the scope for the associated CRM object.
- Use `--query key=value` for newly published filters that the CLI has not promoted to a typed flag yet.

## Official References

- Event occurrences: https://developers.hubspot.com/docs/api-reference/latest/events/guide
- Define events: https://developers.hubspot.com/docs/api-reference/latest/events/define-events/guide
- Send event data: https://developers.hubspot.com/docs/api-reference/latest/events/send-event-data/guide
