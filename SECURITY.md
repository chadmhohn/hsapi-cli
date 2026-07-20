# Security

## Secrets

Do not put HubSpot private app tokens, OAuth access or refresh tokens, broker
credentials, client secrets, real portal configs, local memory files, or
customer data in this package.

Portal config files may contain environment-variable names, portal IDs, and
non-secret broker URLs, never credential values. Keep real configs and OAuth
token caches outside the package directory and point to the config with
`HSAPI_PORTALS_CONFIG`.

For `auth.oauth.mode: "hosted_broker"`, store `HUBSPOT_CLIENT_SECRET`,
`BROKER_SIGNING_KEY`, and `BROKER_SESSION_START_KEY` only as platform secrets.
Do not place them in `wrangler.jsonc`, `.dev.vars` committed to Git, shell
history, deployment logs, or chat. Use three independent high-entropy values;
never reuse the HubSpot client secret or signing key as the session-start key.

Each enrolled CLI receives the session-start credential through the
environment variable named by `auth.oauth.brokerStartKeyEnv`. It is not a
HubSpot credential, but it is a broker admission secret and must use the same
secret-injection protections as other credentials. Users also hold access
tokens, refresh tokens, and broker credentials in their local cache; protect
that file with the operating-system user account and restrictive permissions.
The CLI requests restrictive file modes where the filesystem supports them,
but this is best-effort and does not replace a protected per-user directory or
appropriate Windows ACLs.
Production should replace a shared team start key with per-install enrollment
or an equivalent authenticated bootstrap.

## Safe Operation

- Prefer `--show-request` before using unfamiliar commands.
- Mutations require `--yes`; destructive schema operations may require an additional danger flag.
- Do not run live write tests against production portals.
- Use disposable HubSpot developer/test portals for write tests.
- Keep broker production configuration separate from staging, including
  independent secrets and an exact registered callback URL.
- Require an authenticated broker client credential before allocating an OAuth
  consent session; callback and completion routes remain public for the
  HubSpot/browser redirect.
- Disable request/invocation logging for OAuth callback URLs because HubSpot
  necessarily sends an authorization code in the callback query string.
- Verify returned `hubId` against the configured numeric portal ID before
  accepting or refreshing a hosted OAuth cache.

## Reporting Security Issues

Do not place credentials, authorization codes, portal data, or exploit details
in a public issue. Use GitHub's private security-reporting/advisory channel when
available, or contact the repository owner privately. Internal operators should
also follow their organization's incident-response process.
