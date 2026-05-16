# OAuth and App Auth

The OAuth slice covers HubSpot app install URLs, 2026-03 token exchange, refresh, introspection, and revocation. Use it when a workflow requires public-app OAuth instead of a portal private app token.

OAuth values are credentials. Treat authorization codes, access tokens, refresh tokens, client secrets, and token metadata as sensitive. The CLI redacts token-like request fields in `--show-request` and redacts token-like response values unless `--show-secrets` is explicitly provided.

Portal profiles can also define `auth.oauth` with `clientIdEnv`, `clientSecretEnv`, `refreshTokenEnv`, and `tokenCachePath`. For catalog endpoints marked `auth.family = oauth`, `hsapi` reuses a non-expired cached access token or refreshes one from the configured refresh token env vars. `--show-request` reports only env var names and redacted cache expiry metadata; it does not refresh a token.

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
- The CLI can store short-lived OAuth access tokens only in the configured `tokenCachePath`. Keep that cache outside the package, and keep long-lived refresh tokens in a proper secret manager or environment injection path.
- Developer client-credentials tokens use a separate cache schema and `auth.developer.tokenCachePath`; do not point it at `auth.oauth.tokenCachePath`.
- Latest HubSpot docs describe 2026-03 OAuth endpoints and note that app listing/certification work is moving away from older OAuth v1/v3 paths.

## Official References

- 2026-03 OAuth token guide: https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens
- Personal access key guide: https://developers.hubspot.com/docs/cms/start-building/introduction/developer-environment/personal-access-key
- Revoke OAuth token: https://developers.hubspot.com/docs/api-reference/latest/authentication/oauth-tokens/revoke-token
- App listing/certification OAuth update: https://developers.hubspot.com/changelog/app-listing-and-app-certification-requirement-updates-for-may-2026
