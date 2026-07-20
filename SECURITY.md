# Security

## Secrets

Do not put HubSpot private app tokens, OAuth access or refresh tokens, broker
credentials, client secrets, real portal configs, local memory files, or
customer data in this package.

Portal config files may contain environment-variable names, optional portal
IDs, and non-secret broker URLs, never credential values. The normal hosted
profile contains only its mode and external token-cache path. Keep real configs
and OAuth token caches outside the package directory and point to the config
with `HSAPI_PORTALS_CONFIG`.

For `auth.oauth.mode: "hosted_broker"`, store `HUBSPOT_CLIENT_SECRET` and
`BROKER_SIGNING_KEY` only as platform secrets. Do not place them in
`wrangler.jsonc`, `.dev.vars` committed to Git, shell history, deployment logs,
or chat. These values must be independent. Normal hosted users never receive
or configure either one.

Users hold access tokens, refresh tokens, and broker credentials in their local
cache; protect that file with the operating-system user account and restrictive
permissions. The CLI requests restrictive file modes where the filesystem
supports them, but this is best-effort and does not replace a protected
per-user directory or appropriate Windows ACLs.

## Safe Operation

- Prefer `--show-request` before using unfamiliar commands.
- Mutations require `--yes`; destructive schema operations may require an additional danger flag.
- Do not run live write tests against production portals.
- Use disposable HubSpot developer/test portals for write tests.
- Keep broker production configuration separate from staging, including
  independent secrets and an exact registered callback URL.
- For normal public session creation, require an exact ephemeral
  `127.0.0.1` completion redirect, a PKCE challenge, and a consume-secret
  digest. Deliver a fresh one-time completion grant only to that loopback
  redirect, and require the grant, raw consume secret, and verifier together
  for exchange. Reject every hosted session that does not supply the native
  localhost completion proof; the shared broker has no alternate non-loopback
  or shared-admission-secret fallback.
- Disable request/invocation logging for OAuth callback URLs because HubSpot
  necessarily sends an authorization code in the callback query string.
- Require a numeric returned `hubId`. Verify it against the optional configured
  portal ID or the cache's existing account binding before accepting login,
  cache use, or refresh. Never silently rebind an established profile.
- Add ServiceKey/private-app auth only through an explicit operator action,
  verify it belongs to the OAuth-bound account, and never silently retry an
  OAuth failure with it.

## Reporting Security Issues

Do not place credentials, authorization codes, portal data, or exploit details
in a public issue. Use GitHub's private security-reporting/advisory channel when
available, or contact the repository owner privately. Internal operators should
also follow their organization's incident-response process.
