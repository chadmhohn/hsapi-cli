# Webhooks

The CLI splits HubSpot webhook coverage into classic app webhooks and the Webhooks Journal API.

Classic app webhooks configure an app callback URL and subscriptions. Webhooks Journal provides replayable CRM change journal reads, snapshots, subscriptions, and subscription filters.

## Common Commands

- `hsapi webhooks settings <appId>`
- `hsapi webhooks settings-update <appId> --target-url https://example.com/hubspot/webhooks`
- `hsapi webhooks subscription-create <appId> --subscription-type contact.propertyChange --property-name email --active true`
- `hsapi webhooks subscription-update <appId> <subscriptionId> --active false`
- `hsapi webhooks subscription-batch-update <appId> --inputs '[{"id":"123","active":false}]'`
- `hsapi webhook-journal journal-earliest`
- `hsapi webhook-journal journal-batch-read --offsets 101,102`
- `hsapi webhook-journal local-next <offset>`
- `hsapi webhook-journal snapshot-crm --portal-id <portalId> --object-type contact`
- `hsapi webhook-journal subscription-create --portal-id <portalId> --callback-url https://example.com/hubspot/journal`
- `hsapi webhook-journal filter-create --subscription-id <subscriptionId> --object-type contact --property-name lifecycleStage`

## Safety Notes

- Mutating commands require `--yes`.
- Classic app webhook endpoints are app-level configuration endpoints. They use developer API key auth in `hsapi`: the profile supplies `auth.developer.developerApiKeyEnv`, and the CLI injects `hapikey` only for catalog endpoints marked `developer/developer_api_key`.
- Classic webhook commands still require an app ID in the command path, for example `hsapi webhooks settings <appId>`. Endpoints that document `appId` as a query parameter must be cataloged with `auth.queryParams: ["hapikey", "appId"]` before `hsapi` will inject it from `auth.developer.appIdEnv`.
- Personal access keys are a separate developer auth subtype for HubSpot CLI and local developer-tooling surfaces. They are bearer credentials and must not be used as a fallback for portal private-app endpoints or developer API key endpoints.
- Webhooks Journal uses OAuth 2.0 client credentials tokens, not ordinary private-app tokens. Configure `auth.developer.clientIdEnv`, `auth.developer.clientSecretEnv`, and a developer-only `auth.developer.tokenCachePath`; `--show-request` reports the intended grant type and scopes without reading or printing secret values.
- Webhooks Journal scopes include `developer.webhooks_journal.read`, `developer.webhooks_journal.subscriptions.read`, `developer.webhooks_journal.subscriptions.write`, `developer.webhooks_journal.snapshots.read`, and `developer.webhooks_journal.snapshots.write`.
- Journal reads and snapshots can expose CRM change payloads. Treat offsets, snapshots, and replay output as sensitive operational data.
- Deleting journal subscriptions, portal subscriptions, or filters can stop downstream syncs and automations. Confirm the app, portal, and subscription IDs before running destructive commands.
- The convenience flags cover common fields only. Use `--body <json|@file>` for exact HubSpot payloads.

## Official References

- Classic webhooks guide: https://developers.hubspot.com/docs/api-reference/latest/webhooks/guide
- Webhooks Journal guide: https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/guide
- Request validation: https://developers.hubspot.com/docs/apps/legacy-apps/authentication/validating-requests
