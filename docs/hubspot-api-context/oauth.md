# OAuth and App Auth

For portal-profile onboarding, read `portal-auth-setup` first. Through MCP,
call `hsapi_context_doc` with `name: "portal-auth-setup"`.

The OAuth slice covers HubSpot app install URLs, 2026-03 token exchange,
refresh, introspection, and revocation. Hosted OAuth is the normal distributed
team flow; local OAuth is reserved for app operators, development, and
recovery.

OAuth values are credentials. Treat authorization codes, access tokens, refresh tokens, client secrets, and token metadata as sensitive. The CLI redacts token-like request fields in `--show-request` and redacts token-like response values unless `--show-secrets` is explicitly provided.

## Hosted OAuth

Distributed CLI/MCP profiles should define `auth.oauth.mode:
"hosted_broker"` with the operator-issued HTTPS `brokerUrl`,
`brokerStartKeyEnv`, and an external per-user `tokenCachePath`. The full profile
also requires the exact numeric portal ID supplied by the app operator.

Hosted users do not configure a local HubSpot client ID, client secret,
redirect URL, or scope list. Those values are fixed server-side. Never invent
or download a broker URL or admission credential.

The external v2 cache can hold the access token, refresh token, broker refresh
credential, expiry metadata, and source binding needed for automatic refresh.
Protect it as a credential file.

Common hosted commands:

- `hsapi auth doctor --portal <name> --require-env`
- `hsapi auth login --portal <name>`
- `hsapi auth whoami --portal <name>`
- `hsapi auth logout --portal <name>`

## ServiceKey/private-app auth

`ServiceKey` maps to `auth.portalBearer`: a HubSpot private-app access token
whose value is injected through the environment named by
`auth.portalBearer.tokenEnv`. It is not an OAuth client secret. Some cataloged
operations require this non-user credential because HubSpot rejects a
user-level OAuth token for those endpoints.

HSAPI never silently falls back from OAuth to ServiceKey. Use the combined
template only when the operator has explicitly provisioned both.

## Local OAuth

Local profiles define `auth.oauth` with `mode: "local"`, `clientIdEnv`,
`clientSecretEnv`, optional `refreshTokenEnv`, an exact loopback `redirectUrl`,
scopes, and an external `tokenCachePath`. For catalog endpoints marked
`auth.family = oauth`, `hsapi` reuses a non-expired cached access token or
refreshes it. `--show-request` reports only env var names and redacted cache
metadata; it does not refresh a token.

Developer auth is separate from installed-app OAuth and portal bearer tokens:

- `personal_access_key` is for HubSpot CLI and local developer-tooling surfaces. In `hsapi`, it is sent as `Authorization: Bearer ...` only when endpoint catalog metadata explicitly requires `auth.family = developer` and `auth.subtype = personal_access_key`.
- `developer_api_key` is for app-management surfaces documented with `hapikey` and sometimes `appId` query parameters. `hsapi` injects those query parameters only for endpoints explicitly cataloged as `developer_api_key`; current typed coverage uses this for classic app webhooks.
- `client_credentials` is for app-global developer APIs such as Webhooks Journal. `hsapi` uses `auth.developer.clientIdEnv`, `auth.developer.clientSecretEnv`, and `auth.developer.tokenCachePath` to request and cache short-lived app-level OAuth tokens with the endpoint scopes declared in catalog metadata.

Never use a personal access key or developer API key as an implicit fallback for `portal_bearer` endpoints.

## Common Commands

- `hsapi auth authorize-url --client-id <id> --redirect-uri https://example.com/callback --scopes crm.objects.contacts.read,oauth`
- `hsapi auth token --client-id-env HUBSPOT_CLIENT_ID --client-secret-env HUBSPOT_CLIENT_SECRET --code-env HUBSPOT_OAUTH_CODE --redirect-uri https://example.com/callback --show-request`
- `hsapi auth refresh --client-id-env HUBSPOT_CLIENT_ID --client-secret-env HUBSPOT_CLIENT_SECRET --refresh-token-env HUBSPOT_REFRESH_TOKEN --show-request`
- `hsapi auth introspect --client-id-env HUBSPOT_CLIENT_ID --client-secret-env HUBSPOT_CLIENT_SECRET --refresh-token-env HUBSPOT_REFRESH_TOKEN`
- `hsapi auth revoke --client-id-env HUBSPOT_CLIENT_ID --client-secret-env HUBSPOT_CLIENT_SECRET --refresh-token-env HUBSPOT_REFRESH_TOKEN --danger-revoke-token`

## Safety Notes

- Token exchange and refresh calls require `--yes` unless using `--show-request`.
- `auth introspect` is a read-only POST and does not require `--yes`, but it still sends token material to HubSpot.
- `auth revoke` requires both `--danger-revoke-token` and `--yes`.
- Prefer `--client-secret-env`, `--code-env`, `--refresh-token-env`, and `--token-env` over passing secrets directly on the command line.
- Token responses are redacted by default. Use `--show-secrets` only in a local shell where stdout, logs, and history are controlled.
- The CLI stores OAuth access/refresh state only in the configured external `tokenCachePath`. Protect the entire cache as credential material.
- Developer client-credentials tokens use a separate cache schema and `auth.developer.tokenCachePath`; do not point it at `auth.oauth.tokenCachePath`.
- Latest HubSpot docs describe 2026-03 OAuth endpoints and note that app listing/certification work is moving away from older OAuth v1/v3 paths.

## Official References

- 2026-03 OAuth token guide: https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens
- Portal profile onboarding: `portal-auth-setup`
- Private app guidance: https://developers.hubspot.com/docs/apps/legacy-apps/private-apps/build-with-projects/create-private-apps-with-projects
- Personal access key guide: https://developers.hubspot.com/docs/cms/start-building/introduction/developer-environment/personal-access-key
- Revoke OAuth token: https://developers.hubspot.com/docs/api-reference/latest/authentication/oauth-tokens/revoke-token
- App listing/certification OAuth update: https://developers.hubspot.com/changelog/app-listing-and-app-certification-requirement-updates-for-may-2026
