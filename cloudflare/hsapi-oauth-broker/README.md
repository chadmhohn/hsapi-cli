# hsapi OAuth broker

This standalone Cloudflare Worker keeps the HubSpot client secret off hsapi
users' machines. The CLI creates PKCE and consume credentials locally, the
Worker receives HubSpot's callback, and a SQLite-backed Durable Object holds
each authorization code only until it is exchanged or expires.

Each broker deployment is deliberately fixed to one HubSpot app, redirect URI,
maximum scope set, and `HSAPI_BROKER_ROLE`. The tracked local config uses role
`local`; `wrangler.remote.jsonc` uses role `remote`. Deploy them with different
HubSpot apps, Worker names, domains, client secrets, signing keys, and state. A
session may narrow configured optional scopes but cannot add to them. HubSpot's
account chooser may install that deployment's app into any account the user is
allowed to authorize.

## Security model

- `HUBSPOT_CLIENT_SECRET` and `BROKER_SIGNING_KEY` are independent Cloudflare
  Worker secrets. They do not belong in this directory, Wrangler config, shell
  history, or chat. Normal hosted users never receive either one.
- A `local` broker accepts a session only when it supplies an exact
  `http://127.0.0.1:<ephemeral-port>/oauth/hsapi/callback` completion URI.
  HubSpot returns to the fixed HTTPS broker callback; the broker then redirects
  a fresh one-time completion grant to that exact loopback URI. Exchange
  requires that grant plus the initiating CLI's consume secret and PKCE
  verifier. A remote caller therefore cannot collect another user's completed
  consent result.
- A separate `remote` broker rejects loopback and accepts only exact HTTPS
  completion URLs in `HSAPI_ALLOWED_REMOTE_COMPLETION_REDIRECT_URIS`. Its
  sessions must name an exact configured URL and explicitly supply a
  duplicate-free `optionalScopes` subset of `HUBSPOT_OPTIONAL_SCOPES`. Similar
  hosts, alternate paths, URL credentials, ports, query strings, fragments,
  placeholders, and unconfigured URLs remain rejected. A local broker requires
  an empty remote allowlist; a remote broker requires a non-empty allowlist.
- Every successful session response includes `brokerRole`. The remote MCP
  requires `remote`; the installed CLI rejects an explicitly reported role
  other than `local`.
- The completion URL is bound into the Durable Object session. The broker sends
  only `state` plus a fresh one-time `completion_grant` to either completion
  surface; it never forwards HubSpot's authorization code or token data.
- The CLI creates a high-entropy consume secret and sends only its SHA-256
  base64url digest to the start endpoint. The raw secret is sent once as a
  Bearer credential when exchanging the authorization code. An exchange also
  presents the one-time completion grant bound to that deployment's protocol.
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
- Every successful exchange or refresh is introspected by the broker using the
  confidential app credentials. The response is accepted only when active and
  consistent with the exact token being queried, access-token use, Bearer token
  type, configured client, numeric HubSpot account/user identity, required
  scopes, signed identity fields, and expiry. The broker returns
  `clientId`, `isUserLevel`, optional `hubDomain`, and authoritative `hubId`,
  `userId`, and `scopes`; it does not return the introspection email or signed
  token payload. A normal first exchange may accept any selected account; the CLI
  binds it to the cache. Refresh sends that bound ID as `expectedHubId`, and
  the broker rejects a different or missing response identity.
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
- Token, introspection, and revoke requests use HubSpot's canonical
  `api.hubspot.com` 2026-03 OAuth endpoints. Redirects are handled manually and every upstream `3xx` is
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

Returns `200` with `ready: true` only when all public configuration and both
runtime secrets are present. It also reports `brokerRole` as `local` or
`remote`; clients use that value to reject cross-wired deployments.

### Start

`POST /v1/oauth/sessions`

Normal native-loopback request (no authorization header):

```json
{
  "codeChallenge": "<43-character S256 base64url digest>",
  "completionRedirectUri": "http://127.0.0.1:<ephemeral-port>/oauth/hsapi/callback",
  "consumeSecretHash": "<43-character SHA-256 base64url digest>"
}
```

Returns `201`:

```json
{
  "sessionId": "<random 43-character ID>",
  "authorizationUrl": "https://app.hubspot.com/oauth/authorize?...",
  "expiresIn": 600,
  "interval": 1,
  "brokerRole": "local"
}
```

The CLI opens `authorizationUrl`; HubSpot displays its account chooser. The URL
contains the broker-created state and PKCE challenge, never the consume secret
or localhost completion grant.

There is no authorization header or `accountId` in this request. HubSpot's
standard authorization page presents the account chooser.

On the separate remote-role deployment, an allowlisted remote service starts
the same flow with an explicit scope subset; its response reports
`brokerRole: "remote"`:

```json
{
  "codeChallenge": "<43-character S256 base64url digest>",
  "completionRedirectUri": "https://hsapi-mcp.REPLACE.example/hubspot/callback",
  "consumeSecretHash": "<43-character SHA-256 base64url digest>",
  "optionalScopes": ["crm.objects.contacts.read"]
}
```

`optionalScopes` is required for HTTPS completion and may be empty. Every entry
must be present in the broker's configured optional-scope set. Native loopback
callers may omit it and retain the existing full configured optional-scope
behavior; either caller may provide it to request a narrower subset.

### Callback

`GET /v1/oauth/callback?code=...&state=...`

HubSpot calls this endpoint. The Worker stores the code, creates a fresh
one-time completion grant, and returns `303` to the exact session-bound
loopback or configured HTTPS URI with `state` and `completion_grant`. The
HubSpot authorization code never goes to that completion surface, and the
completion surface contains no token data.

### Exchange

`POST /v1/oauth/sessions/{sessionId}/exchange`

Header: `Authorization: Bearer <raw consume secret>`

```json
{
  "codeVerifier": "<RFC 7636 verifier>",
  "completionGrant": "<one-time 43-character completion grant>"
}
```

- Clients exchange only after receiving the bound completion redirect.
- `200` once, with `accessToken`, `refreshToken`, `brokerCredential`,
  `expiresIn`, `tokenType`, required HubSpot `hubId`, `userId`, `scopes`,
  `clientId`, `isUserLevel`, and optional `hubDomain`.
- `401` for an invalid completion grant, consume secret, or verifier.
- `409` after consumption or while another exchange is active.

Identity fields come from HubSpot's 2026-03 access-token introspection response,
not solely from the token issuance body. The broker fails closed with a HubSpot
OAuth error if `signed_access_token.isUserLevel` or another required metadata
field is absent or inconsistent. This dependency on HubSpot's current
introspection shape should be rechecked when that API changes.

Session status and authorization errors are revealed only after the session's
required completion grant, consume secret, and PKCE verifier are
authenticated. Once an exchange starts, any
failure—or loss of the successful response—is terminal for that session; start
a new login rather than replaying the authorization code.

### Refresh

`POST /v1/oauth/tokens/refresh`

```json
{
  "refreshToken": "<HubSpot refresh token>",
  "brokerCredential": "v1.<HMAC>",
  "expectedHubId": "<numeric account binding>"
}
```

Returns the same normalized token shape as exchange and always returns the
credential corresponding to the returned refresh token. `expectedHubId` is
required by the normal CLI's cache-binding contract; the broker rejects a
missing or different HubSpot `hub_id`.

### Revoke

`POST /v1/oauth/tokens/revoke`

The body contains `refreshToken` and `brokerCredential`; it does not include
`expectedHubId`. A successful HubSpot revocation returns `204`.

## Configured HubSpot scopes

Both tracked broker templates model required scope `oauth` plus the current 51
optional-scope app maximum. The remote MCP requests a read-only subset from its
dedicated broker by default:

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

`data/hubspot-oauth-apps.json` is the machine-readable source of truth. Run
`npm run oauth-apps:check` from the repository root and do not let either
Worker scope list drift from its separate HubSpot app Auth configuration.

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

The checked-in root/local client and redirect values are deliberate
placeholders. For local OAuth calls, use a disposable HubSpot test app, add the
exact local callback to that app, and create an ignored `.dev.vars` containing
the local client/redirect plus development values for
`HUBSPOT_CLIENT_SECRET` and `BROKER_SIGNING_KEY`. Never commit it. The
configured redirect and the HubSpot app registration must match exactly.

## Staging setup and deployment

1. Run `npx wrangler login` and verify the intended account with
   `npx wrangler whoami`.
2. For the local broker, copy `wrangler.jsonc` to the gitignored
   `wrangler.operator.jsonc`. For the remote broker, copy
   `wrangler.remote.jsonc` to the gitignored
   `wrangler.remote.operator.jsonc`. Never commit either operator file.
3. Deploy once or determine the account's `workers.dev` subdomain.
4. In `wrangler.operator.jsonc`, replace the local app's staging client ID,
   redirect URI, and account-local rate-limit namespace IDs. Keep
   `HSAPI_BROKER_ROLE=local` and
   `HSAPI_ALLOWED_REMOTE_COMPLETION_REDIRECT_URIS` empty. In the separate remote
   operator config, keep `HSAPI_BROKER_ROLE=remote`, set its different app
   client ID and callback, and allow only the exact remote MCP HTTPS completion
   URL. There is no HubSpot account ID in Worker configuration; account
   selection occurs during consent.
5. Add that exact HTTPS redirect URL to the HubSpot app's Auth configuration.
6. Set secrets interactively so neither value appears in command history:

```powershell
npx wrangler secret put HUBSPOT_CLIENT_SECRET --config wrangler.operator.jsonc --env staging
npx wrangler secret put BROKER_SIGNING_KEY --config wrangler.operator.jsonc --env staging
```

Use independent, high-entropy values. The signing key must be at least 32
bytes. Do not distribute either secret to normal users or reuse the HubSpot
client secret as the signing key.

7. Validate and deploy:

```powershell
npm run typecheck
npm test
npx wrangler deploy --dry-run --config wrangler.operator.jsonc --env staging
npm run deploy:staging
```

8. Confirm `GET /healthz` reports `ready: true` and `brokerRole: "local"`, then perform a full normal
   session start, account selection, localhost completion, exchange, refresh,
   and revoke against disposable/test HubSpot accounts. Include an account
   mismatch test for an optional CLI pin or existing cache binding.

### Verified staging deployment

On July 18, 2026, an earlier staging flow was verified against
an isolated HubSpot developer test account:

- the browser authorization-code flow completed and the CLI wrote a
  portal-matched, redacted v2 token cache;
- **All** was selected on the 49-optional-scope consent page;
- the token contained `oauth` plus 46 optional grants;
- a broker-mediated refresh succeeded on Worker version
  `5a333109-82bc-42d4-bc71-0364c6b9de1d`;
- `GET /healthz` returned `ready: true`.

The currently deployed staging version is
`a7a9641e-0324-402d-83cc-61d04fe4075a`. Its health check passed, but a fresh
authorization/exchange/refresh was not completed on that exact version. Do not
describe it as proof of the public native-loopback flow. Deploy and revalidate
the release-candidate Worker before describing staging as production-ready.

The current staging Worker URL and public client ID may be recorded in an
operator-only deployment inventory, but they are not secrets. Never record the
HubSpot client secret, signing key, access/refresh tokens, or broker
credentials. Staging is not approved as a production identity service.

## Remote-role deployment

Use `wrangler.remote.operator.jsonc`, `npm run deploy:remote:staging`, and
`npm run deploy:remote:production` for the remote broker. Its HubSpot app,
secret, signing key, callback hostname, completion allowlist, and state must be
independent from the local deployment. Follow the complete provisioning and
cutover order in
[`docs/OAUTH_APP_SPLIT.md`](../../docs/OAUTH_APP_SPLIT.md).

## Production

First choose the local production HubSpot app and operator boundary. In the
gitignored `wrangler.operator.jsonc`, replace and validate the production
client ID, exact registered broker callback, and account-local rate-limit
namespace ID; keep the role local and the remote completion allowlist empty.
The checked-in values are deliberate placeholders. Do not add a customer portal
ID. Then provision independent production secrets and deploy:

```powershell
npx wrangler secret put HUBSPOT_CLIENT_SECRET --config wrangler.operator.jsonc --env production
npx wrangler secret put BROKER_SIGNING_KEY --config wrangler.operator.jsonc --env production
npx wrangler deploy --dry-run --config wrangler.operator.jsonc --env production
npm run deploy:production
```

Staging and production secrets are independent because Wrangler environment
secrets are non-inheritable. Do not deploy production until the bundled custom
domain, loopback completion flow, introspected multi-account/user identity
checks, monitoring, incident response,
refresh-failure recovery, and rollback are validated.

Official references:

- [HubSpot OAuth token API](https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/get-started/)
- [Cloudflare rate-limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Cloudflare Workers invocation logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs)
