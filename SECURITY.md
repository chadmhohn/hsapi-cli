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

The separate OAuth-only `cloudflare/hsapi-remote-mcp` Worker uses a dedicated
remote-role broker and a different HubSpot public app as its upstream OAuth
trust anchor. The Worker itself keeps only an independent
`STATE_ENCRYPTION_KEY` as a Cloudflare secret. The HubSpot client secret and
broker signing key remain in the broker. The remote Worker never accepts a
ServiceKey/private-app token. Do not add a private app token or HubSpot app
secret to Worker variables, secrets, KV, request inputs, deployment config, or
logs. `OAUTH_KV` contains the remote OAuth provider's encrypted grant state;
the SQLite `AUTHORIZATION_STATE` Durable Object atomically consumes each
ten-minute consent or upstream authorization record once.
`CONFIRMATION_LEDGER` is a SQLite Durable Object binding that atomically
consumes each mutation confirmation nonce before the upstream write begins.
Use independent OAuth KV, Durable Object state, and secrets for staging and
production, and limit operator access to each.

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
- Keep the local and remote broker deployments separate from each other. They
  must use different HubSpot apps, client secrets, signing keys, Worker names,
  domains, callback protocols, and state. A local role requires an empty remote
  completion allowlist; a remote role rejects loopback completion.
- Keep remote-MCP production configuration separate from staging, including
  an independent OAuth KV namespace, Durable Object state, state-encryption
  secret, public origin, rate-limit namespaces, exact broker completion
  allowlist entry, and reviewed public-app scopes.
- Require the production `PUBLIC_ORIGIN` to be the exact reachable canonical
  origin. A custom domain requires its matching route and `workers_dev=false`;
  otherwise use the actual `workers.dev` origin. Dry-run that exact operator
  config rather than a template or differently routed config.
- Keep remote writes disabled by default. Enabling them does not bypass the
  endpoint allowlist, downstream `hsapi.write` scope, HubSpot write scope, or
  exact preview-bound, single-use confirmation token. Destructive endpoints
  remain local only.
- Keep the default remote HubSpot scope request read-only. Add only the exact
  reviewed write scope immediately before its approved rollout, require fresh
  consent, and verify the new grant. Price Books are local-only because their
  permissions are private-app scopes; the remote OAuth connector does not
  expose their endpoints.
- Treat the public app's reviewed scope set as a separate
  `HUBSPOT_APP_SCOPE_CEILING`. HubSpot reauthorization can retain older scopes
  that remain configured on the same app, so preserve the broker-reported
  actual set for refresh continuity but expose only its intersection with this
  remote deployment's scopes. Retained scopes must not unlock MCP capabilities;
  reject and compensating-revoke any grant outside the app ceiling. Prefer a
  dedicated remote-only HubSpot app.
- Treat the remote and local connectors as explicit trust boundaries. Never
  automatically route an OAuth failure to the local ServiceKey connector, and
  never send the downstream MCP bearer to HubSpot.
- For normal public session creation, require a PKCE challenge and a
  consume-secret digest. A local-role broker accepts only the exact native
  ephemeral `127.0.0.1` callback shape. A remote-role broker accepts only an
  exact canonical HTTPS callback in
  `HSAPI_ALLOWED_REMOTE_COMPLETION_REDIRECT_URIS`. Remote sessions must send an
  explicit, duplicate-free optional-scope subset. Deliver a fresh one-time
  completion grant only to the validated callback, and require that grant, the
  raw consume secret, and verifier together for exchange. There is no
  shared-admission-secret fallback.
- Disable request/invocation logging for OAuth callback URLs because HubSpot
  necessarily sends an authorization code in the callback query string.
- The remote Worker has its own broker-completion `/hubspot/callback`; keep
  automatic invocation URL logging disabled there because its query contains
  a one-time completion grant. Application logs must not contain OAuth codes,
  completion grants, broker credentials, MCP or HubSpot tokens, request
  bodies, or callback URLs.
- Remote consent and broker state in the SQLite `AuthorizationState` Durable
  Object must be ten-minute and proof-bound. Consent requires a one-time hidden
  CSRF proof plus the exact public origin. Its document must use a `strict-origin`
  referrer policy so a basic form POST does not serialize that origin as `null`;
  OAuth redirect responses remain `no-referrer`. The successful consent CSP's
  `form-action` permits only self, HubSpot's fixed authorization origin, and the
  configured broker and initiating client's registered redirect origins so
  Chromium can follow the POST redirect chain; error pages remain self-only. The
  upstream exchange is separately
  bound to per-session Secure, HttpOnly SameSite=Lax and Partitioned fallback
  cookies, a consume secret, and PKCE. Proof validation must happen before the
  atomic one-time consume. Staging acceptance must reject expiry, replay,
  wrong-origin, wrong-proof, wrong-cookie, wrong-PKCE, and concurrent duplicate
  callback attempts without allowing an invalid proof to burn valid state.
- Exercise parallel downstream refreshes in staging. Add serialization around
  the OAuth-provider dependency only if repeated tests reproduce a rotation
  race; do not describe that follow-up as an implemented control beforehand.
- Use broker revoke as compensating cleanup for a rejected newly issued grant
  or failed downstream grant completion. The current downstream OAuth provider
  exposes no supported upstream-revocation callback; do not decrypt or
  reimplement its private refresh-token format. Until that hook exists,
  ordinary downstream revocation does not revoke the upstream HubSpot grant;
  remove the app authorization in HubSpot for immediate invalidation.
- Require a numeric returned `hubId`. Verify it against the optional configured
  portal ID or the cache's existing account binding before accepting login,
  cache use, or refresh. Never silently rebind an established profile.
- Add ServiceKey/private-app auth only through an explicit operator action,
  verify it belongs to the OAuth-bound account, and never silently retry an
  OAuth failure with it.
- Saved-report and saved-view delegation requires the separately installed
  HubSpot Agent CLI. HSAPI disables that binary's automatic upgrade in child
  processes, verifies `hubspot whoami` against the selected portal before every
  delegated command, and blocks OAuth mode when an implicit
  `HUBSPOT_ACCESS_TOKEN` override could take precedence.
- In Agent CLI ServiceKey mode—selected explicitly by profile or call—pass the
  selected portal token only in the child process environment. Never place it
  in delegated argv, previews, logs, MCP payloads, or the Agent CLI OAuth
  cache.

## Reporting Security Issues

Do not place credentials, authorization codes, portal data, or exploit details
in a public issue. Use GitHub's private security-reporting/advisory channel when
available, or contact the repository owner privately. Internal operators should
also follow their organization's incident-response process.
