# Design: OAuth-First, Per-User Authentication for hsapi

**Status:** Hosted-broker staging implemented; exact-version full-flow revalidation pending · **Date:** 2026-07-18

## Goal

Distribute the hsapi MCP to the team so each teammate authenticates **once via OAuth**
("first-run login") and the tools then act **as that user, bounded by the
HubSpot permissions they already have, the app scopes, endpoint token policy,
and account entitlements** — never elevated, never requiring a private-app token.
A single HubSpot **developer app** is the authentication service for the whole team.

- A non-admin who can't edit schemas in the UI simply can't edit schemas through hsapi.
- A super admin gets the full ceiling that OAuth allows for a super admin.
- No teammate is ever asked for a private-app token or service key in the normal flow.

## Non-goals

- Multi-identity inside one MCP process (not needed — see Architecture).
- Removing the existing private-app / developer auth families (kept, demoted to opt-in).
- Certifying / marketplace-listing the app.

## Decision #1 (UPDATED 2026-07-18): the exchange model for a distributed client

**HubSpot reality (validated against HubSpot docs + live testing):**

- HubSpot **user-level OAuth tokens** come from the **standard Authorization Code flow**;
  the resulting token is **bound to the authorizing user**. HubSpot documents
  user-permission enforcement; this app has live identity/403 evidence, while
  a deliberately limited second-user comparison remains open.
- The app's `client_secret` is still required for the code exchange and refresh.
  PKCE does not replace that confidential-client credential. The live
  user-level flow accepted S256 PKCE, so the implementation also uses it as a
  CLI-to-broker proof: the broker will exchange a callback code only when the
  CLI presents both its consume secret and the matching verifier.
- Current endpoints are OAuth **v3** (`/oauth/2026-03/token`); v1 is deprecated. The app
  must target developer platform **v2025.2 or v2026.03**.

**Implication:** a distributed CLI that performs the exchange locally needs the
app `client_secret` on each machine. A hosted broker avoids that distribution
by performing code exchange, refresh, and revoke server-side.

**Critical clarification (addresses the elevation concern):** the `client_secret`
authenticates the **app**, not the user. Sharing it does **not** grant anyone extra
HubSpot permissions — every teammate still receives a **user-bound token scoped to their
own permissions**, enforced by HubSpot at consent/issue time. A leaked app secret only
lets someone stand up a *rogue client* that could phish a user's consent — a bounded,
internal-tool risk, not a permission-elevation risk.

**Two viable distribution models:**

| Model | How | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A. Local confidential client** | Supply `client_id` + `client_secret` through environment variables; the CLI handles loopback callback, exchange, and refresh. | Simple recovery/developer path | Distributes the app secret | Supported fallback |
| **B. Hosted token broker** | A fixed HTTPS service holds the secret; the CLI creates the login session and the broker performs exchange, refresh, and revoke. | Secret stays server-side; users only authorize in the browser | Requires operated infrastructure | **Selected team flow** |

**Decision:** use **Model B** for distributed team installs and retain **Model
A** for app operators, local development, and recovery. The Cloudflare Worker
staging implementation completed a live authorization and post-deploy refresh
without placing the HubSpot client secret on the CLI machine.

## Historical starting state (code-grounded, 2026-06-16)

- **MCP is single-credential-per-process, env-driven** — `bin/hsapi-mcp.js` →
  `serveMcpStdio()` does no startup auth; each tool call shells into the CLI in-process
  reading the same `process.env`; portal = `--portal` / `HSAPI_PORTAL` / default
  (`auth-resolvers.js:155`). **→ Per-user works with zero multi-tenancy: each teammate
  runs their own MCP instance reading their own token cache.**
- **OAuth family is refresh-token-only and half-built** — no interactive login, no
  loopback, no PKCE anywhere; `hsapi auth authorize-url|token|refresh` are stateless and
  **never write the cache** (`commands/auth.js:320-376`). The cache stores only the access
  token + expiry, **not** the refresh token (`auth-resolvers.js:392-418`).
- **Catalog has no token-audience concept** — entries encode `auth.family/subtype`,
  `risk`, `requiredScopes`, `tierRequirement`; all 579 `portal_bearer` endpoints share one
  subtype. The user-token 403 is handled **reactively** (`tiers.js:76-100`), not pre-flight.
  (Fixtures already mock the exact 403 at `test-hsapi.js:295,325`.)
- **Family is selected per-endpoint from the catalog**, defaulting to `portal_bearer`
  (`auth.js:100-123`); resolvers hard-fail on family mismatch ("no silent fallback").

## Implemented state (2026-07-18)

- `hsapi auth login` and `auth logout` support `local` and `hosted_broker`
  OAuth modes.
- Hosted profiles need a numeric `portalId`, an HTTPS `brokerUrl`, a
  `brokerStartKeyEnv`, and an external token-cache path; they do not need local
  HubSpot client credentials.
- Cache metadata is bound to OAuth mode, broker URL, and portal ID. A returned
  `hubId` mismatch is rejected before use.
- The Cloudflare Worker fixes the HubSpot app, account, redirect, and scope set
  server-side. Durable Objects retain callback codes briefly; exchange is
  one-time and authenticated with a consume secret plus PKCE verifier.
- Starting a hosted consent session requires an independently issued broker
  client credential. The shared staging key is an internal enrollment control,
  not a HubSpot credential; production still needs per-install enrollment or
  an equivalent authenticated bootstrap.
- Refresh and revoke require the HubSpot refresh token plus a broker-bound HMAC
  credential. The app secret, signing key, and session-start key are
  independent Worker secrets.
- Staging authorization, exchange, portal identity, API calls, and refresh
  completed against an isolated developer test account on Worker version
  `5a333109-82bc-42d4-bc71-0364c6b9de1d`. The currently deployed version,
  `a7a9641e-0324-402d-83cc-61d04fe4075a`, has current health and
  unauthenticated session-start rejection proof; its authenticated session
  start and exact authorization/exchange/refresh flow have not yet been
  repeated.

## Target architecture

1. **One HubSpot user-level app** = the team's auth service (validated 2026-06-16: must be a
   *user-level app*, not a classic public app — the latter grants app-scoped tokens). Defined
   via a `*-hsmeta.json` config deployed with the `hs` CLI (`hubspotdev/user-level-app-template`);
   standard auth-code + `client_secret`; the issued token is enforced at the
   authorizing user's permissions against the REST API. Requests a **superset of scopes**;
   HubSpot intersects with each user's real permissions at runtime. (New scopes need the
   super-admin **App Marketplace Access** permission to approve — App Install Governance.)
2. **`hsapi auth login`** — in hosted mode the CLI creates a broker session,
   opens HubSpot consent, and polls with a one-time consume secret plus PKCE
   verifier. The broker captures the callback, exchanges the code with its
   server-side app secret, and returns access/refresh tokens plus a
   broker-bound refresh credential. Local mode retains the exact loopback
   callback flow for app operators. Both modes write a cache outside the
   package; operators must place it in an operating-system-protected per-user
   directory.
3. **Token audience is explicit and conservative.** The implemented enum is
   `user | admin`; missing metadata defaults to `admin` for backward
   compatibility. Command-level CRM routing injects `user` only for
   live/config-supported read and write operations. The account identity rows
   are explicitly user-audience; broad raw-catalog seeding remains future work.
4. **Resolver → least-privilege selection.** A portal has a **user OAuth identity by
   default** and an **optional admin credential** (service key / private app). Per request:
   use OAuth unless `tokenAudience: admin` **and** an admin credential is configured; if an
   admin-required endpoint has no admin credential, **hard-fail with an actionable message**
   — escalation is explicit and catalog-driven, never a silent retry (preserves the
   "no silent fallback" ethos). A profile can select OAuth as its default
   family; the catalog's absent-audience default remains `admin`.
5. **No private-app token in the normal flow.** The admin credential is *optional* and only
   a super admin who needs the auth-sensitive ops configures one. Everyone else runs pure OAuth.
6. **Onboarding** walks a teammate: install → add the portal ID, hosted broker
   URL, and start-key env name → inject the enrolled broker credential →
   `hsapi auth login` (browser consent) → register MCP entry → `hsapi auth
   whoami` to verify. No HubSpot app secret is provisioned to the teammate.

## The irreducible service-key set

For this custom user-level app, HubSpot currently **platform-gates** certain
endpoints regardless of the granted scope:

- **Hard token-type gates rechecked July 18:** `owners list` and `pipelines
  list` returned the explicit user-level-token rejection. HubSpot's own Agent
  CLI documentation describes broader first-party behavior, so these results
  must not be generalized to HubSpot's internal client.
- **Scope-dependent** (an admin user with the right app scope may pass): `properties create`,
  schema writes, deal/company-type `associations create`.
- **Destructive deletes** generally require admin.

Known CRM destructive/custom operations are encoded via operation-aware
`tokenAudience` so the CLI can tell a teammate before calling that a
non-user credential is required. Other warning-tier routes remain runtime
boundaries until they are added to catalog preflight metadata.

## Security model

- `client_secret` is the **app's** secret, not a user permission grant. Hosted
  mode stores it only as a Cloudflare Worker secret; local mode supplies it
  through the app operator's environment. It is never a portal-config value.
- `BROKER_SIGNING_KEY` is an independent Worker secret. It binds refresh and
  revoke requests to tokens issued by this broker.
- `BROKER_SESSION_START_KEY` is a third independent Worker secret. Enrolled
  CLIs present it only when starting a consent session; callback/completion
  remain public for HubSpot/browser redirects.
- Per-user OAuth tokens and broker credentials are cached outside the package.
  Credential use, writes, refresh, and logout fail closed when the configured
  cache path resolves inside the package; diagnostics report that unsafe path
  without reading it. The CLI requests restrictive file modes where supported,
  but operators must enforce a protected per-user directory and appropriate
  Windows ACLs.
- Broker sessions are short-lived, callback codes are removed after one
  exchange, all responses use `Cache-Control: no-store`, and callback
  invocation logging is disabled.
- No elevation: HubSpot binds the token to the user at issue time.
- App on platform v2025.2 / v2026.03; OAuth v3 endpoints.

## Workstreams (→ issues)

1. `hsapi auth login` interactive local and hosted-broker flows. **Implemented**
2. OAuth cache stores refresh token and broker credential. **Implemented**
3. `auth.tokenAudience` schema and conservative default; targeted account/CRM
   routing is implemented, broader catalog coverage remains in progress.
4. Resolver least-privilege selection and explicit admin escalation.
5. `whoami` / `auth doctor`: surface signed-in user + flag admin-required ops. **Implemented**
6. Provision the HubSpot user-level app and hosted Worker staging. **Implemented**
7. Team onboarding docs for the controlled internal beta. **Implemented**
8. Production operations runbook, broker, custom domain/access policy, and
   monitoring. **Pending**
9. Per-install broker enrollment and refresh-rotation recovery policy.
   **Pending before production**

## File-level change map

- `src/commands/auth.js` — local/hosted `login`, `logout`, start-key checks,
  cache-path enforcement, and profile diagnostics.
- `src/oauth-broker.js` — bounded broker HTTP client, authorization URL
  validation, exchange, refresh, and revoke.
- `cloudflare/hsapi-oauth-broker/` — fixed-account Worker, Durable Object
  session storage, rate limits, secret bindings, and deployment runbook.
- `src/command-inputs.js` (:1164-1252) — reuse/extend authorize-URL + token-exchange builders; loopback wiring.
- `src/auth-resolvers.js` — profile parsing, portal-bound cache metadata,
  redaction, outside-package enforcement, refresh locking, and least-privilege
  credential selection.
- `src/auth.js` / `src/catalog.js` — `user | admin` token-audience validation
  with a conservative `admin` default.
- `data/hubspot-api-catalog.json` — targeted user-audience identity rows.
- `src/crm-object-types.js` / `src/commands/crm.js` — operation-aware
  readable/writable CRM object routing.
- `test/test-hsapi.js` — auth, redaction, routing, and concurrency coverage.
- `examples/portals.sample.json` — minimal ServiceKey/private-app profile.
- `examples/portals.oauth-hosted.sample.json` — minimal hosted OAuth profile.
- `examples/portals.oauth-service-key.sample.json` — deliberately combined
  OAuth plus ServiceKey profile.

## Open questions / risks

- ~~Confirm the dev app must be "user-level"...~~ **RESOLVED 2026-06-16:** must be a
  **user-level app** (not a classic public app, which grants app-scoped tokens) — defined via
  `*-hsmeta.json` + `hs project upload` (`hubspotdev/user-level-app-template`), standard
  auth-code + `client_secret`, token enforced at the user's permissions against REST. Steps in #82.
- Authorize a second test user with intentionally limited HubSpot permissions
  to separate user-permission behavior from token-type restrictions.
- Decide whether the three consent-disabled optional scopes should remain in
  the app configuration.
- Productionize the broker separately from staging: exact production redirect,
  independent secrets, monitoring, incident response, and rollback.
- Resolve refresh-response loss before production. If HubSpot rotates a refresh
  token and the successful broker response is lost, the CLI can retain the
  invalidated predecessor; staging recovery is an explicit re-login, while
  production needs a serialized, authenticated short-lived retry/replay design
  or a documented HubSpot idempotency guarantee.
- Refine catalog routing so warning-tier endpoints known to reject user OAuth
  fail before network access or route only to an explicitly configured
  non-user credential.

## Provisioning findings (2026-06-17)

The app was created and deployed as a user-level app in an isolated developer
test account via `hs project upload` (initial build #3, loopback redirect
`http://localhost:5123/callback`). The test account hosts a user-level app
without a separate legacy developer account. Mechanics gotcha: write the
`*-hsmeta.json` as UTF-8 without BOM; a BOM fails HubSpot's JSON validation.

**Historical scope finding.** The initial June upload established that user-level apps have a separate deploy-time scope allowlist: some scopes deploy with a "not fully supported" warning, while others fail deployment as unrecognized. The current matrix supersedes the original approximation; see the 2026-07-16 validation report below.

**Runtime validation update (2026-07-18):** a hosted-broker login completed
with 47 total grants. The token was account-matched, refreshed through the
staging Worker, and used for read-only endpoint probes. Limited-user comparison
remains open.

## Scope revalidation (2026-07-16)

The supplied HubSpot Agent CLI permissions export contained `oauth` plus 72
unique optional scopes. Deployed build #25 already contained 47 of those
optional scopes. The remaining 25 were uploaded one at a time against the
isolated test project using `@hubspot/cli` 8.9.1:

- Newly deployable with HubSpot's user-level warning: `cpq.quotes.write` and `crm.objects.marketing_events.write`.
- Still rejected as unrecognized: the other 23 candidates, including all custom-record and custom-schema scopes, appointments, courses, leads, listings, services, CRM users, quote schemas, generic quote write, carts write, commerce payments, feedback submissions, and external dashboard read.
- Combined build #52 successfully carried both newly accepted scopes, proving a 49-of-72 optional-scope declaration set.
- Build #53 restored the exact build #25 baseline. Build #54 then deployed the
  49-scope configuration with both registered redirects. The fresh 23-scope
  rejection pass ended with restoration build #78/deploy #80, which is the
  current app state.

Build acceptance is not runtime proof. On July 18, **All** was selected during
consent, but `cpq.quotes.write`, `crm.objects.marketing_events.write`, and
`marketing.campaigns.revenue.lite.read` were disabled and omitted from the
token. Of the 13 granted warning-tier scopes, contracts read succeeded;
`mcp.users.read` strongly enabled the Users CRM route; quote and quote-template
reads succeeded with overlapping standard quote scope; eight scope categories
across ten route probes returned the explicit token-type error `User level
OAuth token is not allowed for this endpoint.`; HubSQL has no documented
public REST probe. Full evidence:
`docs/hubspot-api-updates/2026-07-16-user-level-scope-validation.md`.

**Account model (confirmed 2026-06-17).** HubSpot's current developer tooling
lives inside a standard account's development area, with developer test
accounts as isolated build/test sandboxes. The app currently lives in such a
test account. Before production, confirm whether this app can be installed
cross-account as intended or must be recreated in the production-owning
standard account's development area. That rollout decision does not change the
scope-validation result.
