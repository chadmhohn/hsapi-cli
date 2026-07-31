# HSAPI Remote MCP Worker

This package is the Cloudflare-hosted, OAuth-only HSAPI connector. It exposes a
stateless MCP endpoint at `/mcp`, acts as an OAuth authorization server to MCP
clients, and performs a separate upstream HubSpot user OAuth flow.

A transition production Worker is live, but it still uses the original shared
upstream app/broker. Do not deploy this role-enforcing build there until the
dedicated remote HubSpot app and remote-role broker have passed staging. The
checked-in URLs, client ID, KV IDs, and rate-limit namespace IDs remain
placeholders; operator values stay in the ignored config.

## Connector boundary

Use two explicitly named connectors:

| Connector | Runs where | Authentication | Intended use |
|---|---|---|---|
| `hubspot-oauth-remote` | Cloudflare Worker | HubSpot user-level OAuth app (marketplace distribution) only | The default connector for allowlisted operations that the app and installing user can perform |
| `hubspot-local-superset` | The operator's machine over stdio | Hosted/local OAuth and, when explicitly configured, ServiceKey/private-app auth | Endpoints that require a non-user token, local portal profiles, broader CLI coverage, and local Agent CLI bridges |

The remote Worker never accepts a ServiceKey/private-app token. Do not add a
ServiceKey binding, environment variable, request field, or fallback path to
this package. An OAuth failure is not retried with a stronger credential.

The two OAuth relationships are also separate:

1. The MCP client obtains an OAuth token from this Worker for `hsapi.read` and,
   only when enabled, `hsapi.write`.
2. The Worker creates a proof-bound session at the dedicated remote-role OAuth
   broker. The broker sends the user through HubSpot consent, exchanges and
   refreshes the HubSpot grant with the remote public app secret held only by
   that broker, and returns normalized token and identity data to the Worker.
3. The Worker stores that upstream grant in `OAUTH_KV` and calls only
   `https://api.hubapi.com` with the HubSpot access token.

The downstream MCP token is never forwarded to HubSpot. HubSpot access and
refresh tokens are never returned by MCP tools.

This Worker uses the `cloudflare/hsapi-oauth-broker` source deployed separately
with `HSAPI_BROKER_ROLE=remote` for upstream HubSpot OAuth session start,
completion-grant exchange, refresh, and compensating revoke. It rejects a
session response from a local-role broker. It still owns the downstream MCP
authorize/token/register routes and its own
`/hubspot/callback`. The broker sends a one-time completion grant to that exact
allowlisted HTTPS callback; the HubSpot authorization code and public-app
secret never reach this Worker. The CLI uses an independent local-role broker,
HubSpot app, and loopback-completion shape. The remote Worker has no local
token cache or loopback listener.

See [`docs/REMOTE_MCP.md`](../../docs/REMOTE_MCP.md) for the cross-connector
architecture and routing policy. A repo-safe client shape is in
[`examples/mcp-dual-connector.sample.json`](../../examples/mcp-dual-connector.sample.json).
App/broker provisioning and cutover order are in
[`docs/OAUTH_APP_SPLIT.md`](../../docs/OAUTH_APP_SPLIT.md).

## Remote capability policy

The Worker combines named catalog endpoints with a scope-bound raw fallback.
Catalog drift fails startup rather than silently changing named operations. A
raw call may supply method, path, query, and JSON body, but never an origin,
authorization header, portal, or auth mode. The path must be a strict CRM-object
or Marketing Events path, or match a catalog endpoint whose scope is in the
remote manifest.

Current remote policy includes:

- account identity;
- CRM reads, writes, archives, merges, GDPR deletes, and batch operations for
  object types whose exact read/write scope is in the current OAuth grant;
- Contracts list, get, search, and batch-read with
  `crm.objects.contracts.read`;
- typed and raw Marketing Events operations; and
- raw calls within the same exposed OAuth scope boundary when a named wrapper
  does not yet exist.

Use `hsapi_remote_endpoint_help` after capability discovery. It returns the
exact path parameters, required scope, feature-gate status, and an input example
for `hsapi_request_execute_read` or the gated mutation tool, so a remote client
does not have to guess the generic executor shape.

Deliberately unavailable:

- every ServiceKey/private-app operation, including all Price Books endpoints;
- contract writes pending HubSpot's public beta, published endpoint contract,
  catalog review, and live validation;
- custom record/schema reads: their strict `2-<digits>` policy is staged, but
  the active 2026.03 user-level app still rejects
  `crm.objects.custom.read` as an unrecognized scope;
- custom-object record writes remain staged behind
  `crm.objects.custom.write`; custom schema writes remain local; and
- saved reports, CRM saved views, and other local HubSpot Agent CLI bridges.

`REMOTE_WRITES_ENABLED` is `true` in every checked-in environment. The Worker
registers the write tool only for a downstream grant containing `hsapi.write`.
Every write still requires all of the following:

- the named endpoint or raw path is tied to a scope in the remote manifest;
- the MCP grant includes `hsapi.write`;
- the HubSpot grant contains the endpoint's write scope;
- the caller first obtains a short-lived confirmation token from the blocked
  preview; and
- the confirmed request exactly matches that preview, HubSpot account, user,
  and capability revision.

The model may make that second call itself when the preview is consistent with
the user's request; the Worker does not require a separate human approval click.

The checked-in HubSpot optional-scope list requests the 19 reviewed read scopes
and 12 reviewed write scopes used by this manifest. The write surface covers
named and raw create/update/archive/merge/delete/batch calls for contacts,
companies, deals, tickets, line items, products, tasks, notes, calls, meetings,
and emails, plus Marketing Events. Price Books private-app scopes,
`cpq.quotes.write`, custom-object scopes, and unpublished Contracts writes
remain excluded from the active OAuth request. A user must reauthorize after a
scope expansion before the new grant can expose those writes.

## Required Cloudflare configuration

Each environment needs:

- one `OAUTH_KV` namespace for downstream OAuth clients, grants, and tokens;
- one SQLite Durable Object binding named `AUTHORIZATION_STATE` whose
  `AuthorizationState` class atomically stores and consumes short-lived consent
  and upstream state;
- one SQLite Durable Object binding named `CONFIRMATION_LEDGER` for atomic,
  one-time mutation-confirmation claims;
- the `EDGE_RATE_LIMITER`, `AUTH_RATE_LIMITER`, and `REMOTE_RATE_LIMITER`
  bindings with namespace IDs unique within the target Cloudflare account;
- `REMOTE_WRITES_ENABLED=true` for the reviewed, confirmation-gated write surface;
- `HUBSPOT_REQUIRE_USER_LEVEL=true` for the user-level app connector boundary;
- `HUBSPOT_BROKER_URL` as the exact dedicated remote-role broker origin;
- `HUBSPOT_CLIENT_ID` as the matching dedicated remote-app client ID and a
  normal Worker variable;
- `HUBSPOT_REQUIRED_SCOPES` and `HUBSPOT_OPTIONAL_SCOPES` as the exact scopes
  this remote deployment may expose;
- `HUBSPOT_APP_SCOPE_CEILING` as the reviewed maximum scope set configured on
  the dedicated remote HubSpot public app;
- an independent, high-entropy `STATE_ENCRYPTION_KEY` Worker secret;
- an exact `PUBLIC_ORIGIN` with no path, query, or fragment; and
- an exact allowlist in `MCP_ALLOWED_ORIGINS`.

Both `AuthorizationState` and `ConfirmationLedger` are declared as SQLite
Durable Object exports in Wrangler config. Do not create a second KV namespace
or manually provision a Durable Object namespace; keep both bindings and both
declarative class exports in the exact operator config used for deployment.

`AuthorizationState` records expire after ten minutes and are atomically taken
once. Consent uses a one-time hidden CSRF proof whose hash is stored server-side;
the form POST must also carry the exact configured public origin. Invalid origin
or proof attempts do not consume valid state. The consent document uses a
`strict-origin` referrer policy so standards-compliant form POSTs retain that
origin; OAuth redirects continue to use `no-referrer`. Its CSP keeps forms
same-origin while allowing Chromium's redirect check only for HubSpot's fixed
authorization origin, the configured broker origin, and the initiating client's
registered redirect origin. Other HTML responses retain a same-origin-only form
policy. The upstream HubSpot state is
separately bound to an S256 PKCE verifier and per-session Secure, HttpOnly browser
cookies: a SameSite=Lax primary cookie plus a SameSite=None, Partitioned fallback
for embedded MCP authorization windows. Both carry the same random proof, and
that proof is validated before state is consumed. A replay or simultaneous take
receives no record.

The broker completion callback for this Worker is always:

```text
<PUBLIC_ORIGIN>/hubspot/callback
```

The broker must list that exact canonical HTTPS URL in
`HSAPI_ALLOWED_REMOTE_COMPLETION_REDIRECT_URIS`. The HubSpot app itself remains
registered to the broker's `/v1/oauth/callback`, not to this Worker.

The MCP resource URL is always:

```text
<PUBLIC_ORIGIN>/mcp
```

Outside local development, `PUBLIC_ORIGIN` must be HTTPS, reachable, and equal
to the origin that actually routes to this Worker. Deployment placeholders are
rejected at runtime. Keep staging and production OAuth KV namespaces, Durable
Object state, secrets, public origins, and rate-limit namespaces separate.

`HUBSPOT_REQUIRED_SCOPES` must include `oauth`. The checked-in
`HUBSPOT_OPTIONAL_SCOPES` value contains only scopes referenced by the remote
manifest, including its reviewed writes. HubSpot can retain
previously authorized scopes when the same public app is reauthorized with a
narrower request. The Worker therefore preserves the broker-reported actual
scope set for refresh and audit continuity, rejects and revokes any scope outside
`HUBSPOT_APP_SCOPE_CEILING`, and issues remote access with only the intersection
of the actual grant and this deployment's required/optional scopes. Retained
app-approved scopes never make an MCP capability eligible.

Keep the ceiling synchronized with the HubSpot app and broker, but do not treat
either configuration list as evidence that HubSpot granted a scope or that its
endpoint accepts a user-level token. `hsapi_remote_identity` reports the
effective remote grant and
`hsapi_remote_capabilities` reports policy eligibility; a representative live
request is still required to prove product entitlement and user-level-token
acceptance.

## Local checks

Requirements: Node.js, npm, and this subproject's dependency tree.

```powershell
cd cloudflare/hsapi-remote-mcp
npm install
npm run types:check
npm run typecheck
npm test
npm run deploy:dry-run
```

`npm run check` runs the same validation sequence. The checked-in dry run uses
only placeholder/local configuration and does not publish a Worker.

The checked-in `http://localhost:8787` origin is suitable for Worker tests,
local request handling, generated-type checks, and dry-runs, but it cannot
complete interactive remote OAuth. For an interactive `wrangler dev` login,
route an HTTPS tunnel or dedicated HTTPS development hostname to the local
Worker, set `PUBLIC_ORIGIN` and `MCP_ALLOWED_ORIGINS` to that exact canonical
HTTPS origin, and have an approved development broker add exactly
`<PUBLIC_ORIGIN>/hubspot/callback` to
`HSAPI_ALLOWED_REMOTE_COMPLETION_REDIRECT_URIS`. Set `HUBSPOT_BROKER_URL` to
that broker origin and put only the local `STATE_ENCRYPTION_KEY` fixture in a
gitignored `.dev.vars` file. Never commit that file.

The broker's `http://127.0.0.1:<ephemeral-port>/oauth/hsapi/callback` exception
is exclusively the native CLI/local-stdio completion protocol. It is not a
remote Worker callback and does not make a localhost `wrangler dev` origin
eligible for remote completion.

## Staging-first deployment

Do not deploy directly from `wrangler.jsonc`. It is a repo-safe template.

1. Confirm the intended Cloudflare account:

```powershell
npx wrangler login
npx wrangler whoami
```

2. Copy the template to the gitignored operator file:

```powershell
Copy-Item wrangler.jsonc wrangler.operator.jsonc
```

3. Create one dedicated staging KV namespace and copy the returned ID into the
   staging `OAUTH_KV` binding in `wrangler.operator.jsonc`:

```powershell
npx wrangler kv namespace create hsapi-remote-mcp-staging-oauth --binding OAUTH_KV --config wrangler.operator.jsonc --env staging
```

   Retain the declarative SQLite `AUTHORIZATION_STATE` / `AuthorizationState`
   and `CONFIRMATION_LEDGER` / `ConfirmationLedger` bindings and exports. There
   is no authorization-state KV ID to create or paste.

4. Replace every staging placeholder in the operator config:

   - `PUBLIC_ORIGIN` and `MCP_ALLOWED_ORIGINS`;
   - `HUBSPOT_BROKER_URL` and the dedicated remote broker/app client ID;
   - the `OAUTH_KV` ID; and
   - all three account-local rate-limit namespace IDs, keeping them distinct
     from other Workers and from one another.

   Keep `REMOTE_WRITES_ENABLED` set to `true` so staging exercises the same
   confirmation-gated surface as production.

5. Deploy the broker with `wrangler.remote.operator.jsonc` and
   `HSAPI_BROKER_ROLE=remote`, then have that broker operator add the exact
   canonical HTTPS callback
   `<PUBLIC_ORIGIN>/hubspot/callback` to
   `HSAPI_ALLOWED_REMOTE_COMPLETION_REDIRECT_URIS`. Confirm the Worker's
   duplicate-free `HUBSPOT_OPTIONAL_SCOPES` is a subset of both
   `HUBSPOT_APP_SCOPE_CEILING` and the broker's configured optional-scope
   manifest. The app ceiling must exactly reflect the public app's reviewed
   maximum. The HubSpot app callback stays pointed at the remote broker. Do not
   add a customer account ID or a private-app token.

6. Set secrets interactively:

```powershell
npx wrangler secret put STATE_ENCRYPTION_KEY --config wrangler.operator.jsonc --env staging
```

The state key must contain at least 32 high-entropy characters. It does not
belong in command arguments, the operator config, deployment logs, or chat.
The HubSpot client secret and broker signing key remain only in the broker's
secret store.

7. Validate the exact staging bundle without publishing it:

```powershell
npm run types:check
npm run typecheck
npm test
npx wrangler deploy --dry-run --config wrangler.operator.jsonc --env staging
```

8. After operator approval, deploy staging:

```powershell
npm run deploy:staging
```

9. Validate the deployed staging service before any production work:

   - remote broker `GET /healthz` returns `ready: true` and
     `brokerRole: "remote"`;
   - remote MCP `GET /healthz` returns the expected service, protocol version,
     and staging environment;
   - an MCP client discovers the protected resource and completes PKCE;
   - HubSpot displays the intended app, scopes, and account chooser;
   - the broker returns introspection-validated `isUserLevel=true`, the exact
     configured HubSpot client ID, account, user, and granted scopes; an
     ordinary app-scoped public-app grant fails closed;
   - `hsapi_remote_identity` returns the selected `hubId` without tokens;
   - `hsapi_remote_capabilities` matches the actual HubSpot grant;
   - representative CRM and Contracts reads succeed only when their scopes are
     present;
   - missing scopes, custom objects, Price Books, developer endpoints, and
     unconfirmed writes fail closed; named and raw destructive calls require an
     exact single-use confirmation; and
   - an expired or replayed consent/state value is rejected; missing, wrong,
     or duplicate consent Origin/CSRF inputs do not burn valid state; both the
     primary and partitioned per-session callback cookies work; and concurrent
     callback attempts cannot complete the same authorization twice; and
   - parallel downstream refresh requests preserve the same HubSpot account,
     user, and scopes and leave a usable refreshed grant. If repeated staging
     tests reproduce a dependency-level refresh-rotation race, record
     dependency serialization as a follow-up; do not claim or add that
     serialization preemptively; and
   - reconnecting with another test account produces the other account's
     identity and cannot reuse the first account's authorization context.

Only after that staging matrix passes should an operator create an independent
production `OAUTH_KV` namespace and secrets, replace the production
placeholders, and retain both declarative SQLite Durable Object bindings and
exports.

The production operator config must choose one real canonical origin:

- for a custom domain, set `PUBLIC_ORIGIN` and `MCP_ALLOWED_ORIGINS` to its
  exact reachable HTTPS origin, set production `workers_dev` to `false`, and
  configure the matching custom-domain route in that same operator config; or
- for `workers.dev`, keep production `workers_dev` enabled and use the actual
  deployed `workers.dev` origin, including the real account subdomain, in both
  variables.

A custom-domain `PUBLIC_ORIGIN` without the matching route, a placeholder, or a
different `workers.dev` origin fails the canonical request-origin contract.
Dry-run the exact production operator config before deployment:

```powershell
npx wrangler deploy --dry-run --config wrangler.operator.jsonc --env production
```

Only then consider `npm run deploy:production`. Keep both production write
gates disabled until a separate, approved write validation has completed. That
validation must add only the exact required write scope to the app and Worker
config, reauthorize the test user, verify the new grant, and test the
preview/confirmation boundary before production reconsent.

### Revocation boundary

The Worker sends a compensating revoke to the broker if a newly issued grant
fails account/user/client/scope continuity checks or if downstream grant
completion fails after the broker exchange. The pinned Cloudflare OAuth
provider does not expose a supported hook from downstream refresh-token
revocation to upstream grant cleanup. This Worker does not decrypt or
reimplement provider-private token internals, so an ordinary MCP client revoke
does not currently revoke the HubSpot grant at the broker. Remove the app
authorization in HubSpot when immediate upstream invalidation is required, and
revisit this boundary when the provider exposes an upstream-revocation hook.

## Scope recheck before expansion

Before changing the remote manifest or enabling writes, re-authorize the
current user-level OAuth app in an isolated HubSpot test account and record:

1. which optional scopes are selectable and actually granted;
2. which endpoints accept that user-level token at runtime;
3. whether custom record/schema reads are granted for the account tier and work
   with canonical `2-<digits>` object type IDs;
4. the published Contracts write method, path, scope, tier, and beta terms; and
5. whether any Price Books capability becomes available through public-app
   OAuth rather than only private-app access scopes.

Update the root catalog first, then the remote manifest snapshot, tests, and
these docs. Never infer a new method or path from a scope name or an announced
timeline.

## Operational notes

- Automatic invocation URL logs stay disabled because OAuth callbacks contain
  short-lived completion grants in their query string. HubSpot authorization
  codes terminate only at the broker callback.
- Structured application logs contain event categories and non-secret IDs,
  not request bodies, OAuth codes, or tokens.
- A cron at minute 17 of every hour purges expired OAuth-provider data in
  batches of 200.
- Broker redirects are not followed by server-to-server requests; OAuth
  transport targets are fixed to `HUBSPOT_BROKER_URL`, and HubSpot API request
  targets remain fixed to `https://api.hubapi.com`.
- Staging and production require separate incident-response, revocation, and
  rollback procedures before they are considered ready.

Official references:

- [Cloudflare MCP handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [Cloudflare MCP authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/)
- [HubSpot OAuth token management](https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens)
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
