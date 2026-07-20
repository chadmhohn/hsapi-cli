# hsapi OAuth broker

This standalone Cloudflare Worker keeps the HubSpot client secret off hsapi
users' machines. The CLI creates PKCE and consume credentials locally, the
Worker receives HubSpot's callback, and a SQLite-backed Durable Object holds
each authorization code only until it is exchanged or expires.

The broker is deliberately fixed to one HubSpot app, account, redirect URI,
and scope set through server-side Worker configuration. A client cannot add
scopes or select a different account. Session creation also requires an
independently issued broker client credential.

## Security model

- `HUBSPOT_CLIENT_SECRET`, `BROKER_SIGNING_KEY`, and
  `BROKER_SESSION_START_KEY` are independent Cloudflare Worker secrets. They
  do not belong in this directory, Wrangler config, shell history, or chat.
- `POST /v1/oauth/sessions` requires
  `Authorization: Bearer <BROKER_SESSION_START_KEY>`. This closes the
  consent-phishing path that an unauthenticated session-start endpoint would
  create. A shared key is acceptable only for controlled staging/internal enrollment;
  production should use per-install credentials or an equivalent
  authenticated bootstrap.
- The CLI creates a high-entropy consume secret and sends only its SHA-256
  base64url digest to the start endpoint. The raw secret is sent once as a
  Bearer credential when exchanging the authorization code.
- The CLI sends the PKCE challenge at session creation and withholds the
  verifier until exchange. HubSpot receives the verifier in the token request.
- A separate SQLite-backed Durable Object coordinates each random session.
  An alarm removes its session row after ten minutes, shortened to two minutes
  after HubSpot calls back.
- Exchange is terminal once the first HubSpot token request begins, whether
  that request succeeds or fails. A cryptographically random attempt ID and a
  compare-and-set completion prevent a late request from changing replacement
  session state. A failed or response-lost exchange requires a new login.
  Constant-time comparison uses `node:crypto`'s `timingSafeEqual`;
  refresh/revoke credentials use Web Crypto HMAC verification.
- The exchange response includes a stateless `brokerCredential`:
  `v1.HMAC(BROKER_SIGNING_KEY, version || SHA-256(refreshToken))`.
  Refresh and revoke require both the refresh token and this credential. A
  rotated refresh token receives a replacement credential.
- Every response has `Cache-Control: no-store`. No token is accepted in a
  broker URL, and application logs never include URLs, bodies, authorization
  codes, credentials, or tokens.
- Inbound JSON is capped at 64 KiB. HubSpot OAuth JSON is independently capped
  at 1 MiB so unusually large tokens remain supported without allowing an
  unbounded upstream response.
- Token and revoke requests use HubSpot's canonical `api.hubspot.com` OAuth
  endpoints. Redirects are handled manually and every upstream `3xx` is
  rejected rather than followed, so a redirect cannot carry OAuth credentials
  to another origin.
- Upstream transport failures emit only a structured event, phase, failure
  category, and JavaScript error class. The exception message, request URL,
  request or response body, authorization code, and credentials are never
  logged.
- HubSpot necessarily sends the short-lived authorization code in the callback
  query string. `observability.logs.invocation_logs` is therefore disabled so
  Cloudflare does not automatically record the callback URL.
- Cloudflare's built-in rate-limit binding limits starts by source, callbacks
  by source and state, exchanges by source and session, and token operations
  by source and a token digest. It is defense in depth, not exact accounting.

## HTTP contract

All request bodies are JSON and all JSON responses use camelCase.

### Health

`GET /healthz`

Returns `200` with `ready: true` only when all public configuration and all
three runtime secrets are present.

### Start

`POST /v1/oauth/sessions`

Header: `Authorization: Bearer <broker session-start credential>`

```json
{
  "accountId": "<numeric-test-account-id>",
  "codeChallenge": "<43-character S256 base64url digest>",
  "consumeSecretHash": "<43-character SHA-256 base64url digest>"
}
```

Returns `201`:

```json
{
  "sessionId": "<random 43-character ID>",
  "authorizationUrl": "https://app.hubspot.com/oauth/<account-id>/authorize?...",
  "expiresIn": 600,
  "interval": 1
}
```

The CLI opens `authorizationUrl`; it never places the consume secret there.

### Callback

`GET /v1/oauth/callback?code=...&state=...`

HubSpot calls this endpoint. It stores the code and returns `303` to the clean,
query-free `/v1/oauth/complete` page so the authorization code is not left in
the active browser address. The completion route serves generic HTML without
token data.

### Poll and exchange

`POST /v1/oauth/sessions/{sessionId}/exchange`

Header: `Authorization: Bearer <raw consume secret>`

```json
{
  "codeVerifier": "<RFC 7636 verifier>"
}
```

- `202 {"status":"pending"}` before the callback, with `Retry-After: 1`.
- `200` once, with `accessToken`, `refreshToken`, `brokerCredential`,
  `expiresIn`, `tokenType`, and any HubSpot-provided `hubId`, `userId`, and
  `scopes`.
- `401` for an invalid consume secret or verifier.
- `409` after consumption or while another exchange is active.

Session status and authorization errors are revealed only after the consume
secret and PKCE verifier are authenticated. Once an exchange starts, any
failure—or loss of the successful response—is terminal for that session; start
a new login rather than replaying the authorization code.

### Refresh

`POST /v1/oauth/tokens/refresh`

```json
{
  "refreshToken": "<HubSpot refresh token>",
  "brokerCredential": "v1.<HMAC>"
}
```

Returns the same normalized token shape as exchange and always returns the
credential corresponding to the returned refresh token.

### Revoke

`POST /v1/oauth/tokens/revoke`

The body matches refresh. A successful HubSpot revocation returns `204`.

## Fixed HubSpot scopes

`wrangler.jsonc` requests required scope `oauth` plus the 49 optional scopes
accepted by the current HubSpot user-level app configuration:

```text
crm.objects.contacts.read
crm.objects.companies.read
crm.objects.deals.read
crm.objects.contacts.write
crm.objects.companies.write
crm.objects.deals.write
crm.objects.tickets.read
crm.objects.tickets.write
crm.objects.line_items.read
crm.objects.line_items.write
crm.objects.products.read
crm.objects.products.write
crm.objects.quotes.read
crm.objects.owners.read
crm.objects.subscriptions.read
crm.objects.carts.read
crm.objects.orders.read
crm.objects.invoices.read
crm.objects.tasks.read
crm.objects.tasks.write
crm.objects.notes.read
crm.objects.notes.write
crm.objects.calls.read
crm.objects.calls.write
crm.objects.meetings.read
crm.objects.meetings.write
crm.objects.emails.read
crm.objects.emails.write
crm.objects.contracts.read
crm.objects.marketing_events.read
crm.schemas.calls.read
crm.schemas.emails.read
crm.schemas.meetings.read
crm.schemas.notes.read
crm.schemas.tasks.read
crm.lists.read
crm.hubsql.execute
cpq.quote_templates.read
cpq.quotes.read
cms.blogs.blog_posts.read
cms.pages.landing_pages.read
cms.pages.site_pages.read
marketing.campaigns.read
marketing.campaigns.revenue.full.read
marketing.campaigns.revenue.lite.read
settings.users.teams.read
mcp.users.read
cpq.quotes.write
crm.objects.marketing_events.write
```

Do not let the Worker scope list drift from the deployed HubSpot app's Auth
configuration.

## Local development

Requirements: Node.js, npm, and an installed dependency tree in this
subproject.

```powershell
cd cloudflare/hsapi-oauth-broker
npm install
npm run types
npm run typecheck
npm test
npm run deploy:dry-run
```

The checked-in root/local account and client values are deliberate
placeholders. For local OAuth calls, use a disposable HubSpot test app, add the
exact local callback to that app, and create an ignored `.dev.vars` containing
the local account/client/redirect plus development values for
`HUBSPOT_CLIENT_SECRET`, `BROKER_SIGNING_KEY`, and
`BROKER_SESSION_START_KEY`. Never commit it. The configured redirect and the
HubSpot app registration must match exactly.

## Staging setup and deployment

1. Run `npx wrangler login` and verify the intended account with
   `npx wrangler whoami`.
2. Copy `wrangler.jsonc` to the gitignored `wrangler.operator.jsonc`. Never
   commit that operator file.
3. Deploy once or determine the account's `workers.dev` subdomain.
4. In `wrangler.operator.jsonc`, replace the staging account ID, client ID,
   redirect URI, and any account-local rate-limit namespace IDs. The redirect
   must exactly match the staging Worker callback URL.
5. Add that exact HTTPS redirect URL to the HubSpot app's Auth configuration.
6. Set secrets interactively so neither value appears in command history:

```powershell
npx wrangler secret put HUBSPOT_CLIENT_SECRET --config wrangler.operator.jsonc --env staging
npx wrangler secret put BROKER_SIGNING_KEY --config wrangler.operator.jsonc --env staging
npx wrangler secret put BROKER_SESSION_START_KEY --config wrangler.operator.jsonc --env staging
```

Use independent, high-entropy values. The signing key must be at least 32
bytes, and the session-start key must be a 32-byte base64url value (43
characters). Do not reuse the HubSpot client secret.

7. Validate and deploy:

```powershell
npm run typecheck
npm test
npx wrangler deploy --dry-run --config wrangler.operator.jsonc --env staging
npm run deploy:staging
```

8. Confirm `GET /healthz` reports `ready: true`, then perform a full install,
   exchange, refresh, and revoke against a disposable/test HubSpot account.

### Verified staging deployment

On July 18, 2026, staging was verified against an isolated HubSpot developer
test account:

- the browser authorization-code flow completed and the CLI wrote a
  portal-matched, redacted v2 token cache;
- **All** was selected on the 49-optional-scope consent page;
- the token contained `oauth` plus 46 optional grants;
- a broker-mediated refresh succeeded on Worker version
  `5a333109-82bc-42d4-bc71-0364c6b9de1d`;
- an authenticated session start rejected a missing credential and accepted
  the provisioned session-start credential;
- `GET /healthz` returned `ready: true`.

The currently deployed staging version is
`a7a9641e-0324-402d-83cc-61d04fe4075a`. Its health check and unauthenticated
session-start rejection passed, but an authenticated session start and fresh
authorization/exchange/refresh were not completed on that exact version. Do
not describe staging as production-ready.

The current staging Worker URL and public client ID may be recorded in an
operator-only deployment inventory, but they are not secrets. Never record the
HubSpot client secret, signing key, access/refresh tokens, or broker
credentials. Staging is not approved as a production identity service.

## Production

First choose the production HubSpot account/app boundary. In the gitignored
`wrangler.operator.jsonc`, replace and validate the production account ID,
client ID, exact registered callback, and account-local rate-limit namespace
ID; the checked-in values are deliberate placeholders. Then provision
independent production secrets and deploy:

```powershell
npx wrangler secret put HUBSPOT_CLIENT_SECRET --config wrangler.operator.jsonc --env production
npx wrangler secret put BROKER_SIGNING_KEY --config wrangler.operator.jsonc --env production
npx wrangler secret put BROKER_SESSION_START_KEY --config wrangler.operator.jsonc --env production
npx wrangler deploy --dry-run --config wrangler.operator.jsonc --env production
npm run deploy:production
```

Staging and production secrets are independent because Wrangler environment
secrets are non-inheritable. Do not deploy production until enrolled-client
credential distribution, monitoring, incident response, refresh-failure
recovery, and rollback are defined.

Official references:

- [HubSpot OAuth token API](https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/get-started/)
- [Cloudflare rate-limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Cloudflare Workers invocation logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs)
