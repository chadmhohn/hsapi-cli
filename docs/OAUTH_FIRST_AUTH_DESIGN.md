# Design: OAuth-First, Per-User Authentication for hsapi

**Status:** Proposed · **Date:** 2026-06-16 · **Owner:** Chad Hohn

## Goal

Distribute the hsapi MCP to the team so each teammate authenticates **once via OAuth**
("first-run login") and the tools then act **as that user, with exactly the HubSpot
permissions they already have** — never elevated, never requiring a private-app token.
A single HubSpot **developer app** is the authentication service for the whole team.

- A non-admin who can't edit schemas in the UI simply can't edit schemas through hsapi.
- A super admin gets the full ceiling that OAuth allows for a super admin.
- No teammate is ever asked for a private-app token or service key in the normal flow.

## Non-goals

- Multi-identity inside one MCP process (not needed — see Architecture).
- Removing the existing private-app / developer auth families (kept, demoted to opt-in).
- Certifying / marketplace-listing the app.

## Decision #1 (RESOLVED 2026-06-16): the exchange model for a distributed client

**HubSpot reality (validated against HubSpot docs + live testing):**

- HubSpot **user-level OAuth tokens** come from the **standard Authorization Code flow**;
  the resulting token is **bound to the authorizing user and mirrors their UI-level
  permissions** (confirmed by HubSpot's Agent CLI docs and our own `whoami`/403 testing).
- Standard developer/public-app OAuth **requires `client_secret`** on both the code→token
  exchange and the refresh, and **does NOT support PKCE**. PKCE (secret-less) is offered
  **only** by HubSpot's hosted MCP server (`mcp.hubspot.com`) — a different product, not
  applicable to our own app.
- Current endpoints are OAuth **v3** (`/oauth/2026-03/token`); v1 is deprecated. The app
  must target developer platform **v2025.2 or v2026.03**.

**Implication:** a distributed CLI that performs the exchange locally needs the app
`client_secret` on each machine. There is no PKCE escape hatch for our own developer app.

**Critical clarification (addresses the elevation concern):** the `client_secret`
authenticates the **app**, not the user. Sharing it does **not** grant anyone extra
HubSpot permissions — every teammate still receives a **user-bound token scoped to their
own permissions**, enforced by HubSpot at consent/issue time. A leaked app secret only
lets someone stand up a *rogue client* that could phish a user's consent — a bounded,
internal-tool risk, not a permission-elevation risk.

**Two viable distribution models (no PKCE option for our app):**

| Model | How | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A. Shared app secret** | Ship `client_id` + `client_secret` to each machine via env / `HSAPI_SECRET_LOOKUP_CMD` wrapper (never in config files). CLI does code + refresh exchange locally. | Simplest; no infra; reuses existing resolver plumbing | App secret distributed to the team (rogue-client phishing risk if leaked) | **Recommended for v1** |
| **B. Token broker** | Self-host a tiny HTTPS service holding the secret; `redirect_uri` → broker; broker does code→token + refresh; CLI never holds the secret. | Secret stays server-side; revocable; mirrors how HubSpot's own CLI works | Requires hosting + becomes critical infra | Hardening path (later) |

**Decision:** ship **Model A** for v1 (internal team; does not compromise the per-user
goal), with **Model B** documented as the future hardening option. Both keep the user
flow pure-OAuth; neither asks a teammate for a private-app token.

## Current state (code-grounded, 2026-06-16)

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

## Target architecture

1. **One HubSpot user-level app** = the team's auth service (validated 2026-06-16: must be a
   *user-level app*, not a classic public app — the latter grants app-scoped tokens). Defined
   via a `*-hsmeta.json` config deployed with the `hs` CLI (`hubspotdev/user-level-app-template`);
   standard auth-code + `client_secret` (no PKCE); the issued token is enforced at the
   authorizing user's permissions against the REST API. Requests a **superset of scopes**;
   HubSpot intersects with each user's real permissions at runtime. (New scopes need the
   super-admin **App Marketplace Access** permission to approve — App Install Governance.)
2. **`hsapi auth login`** — new interactive flow: start a localhost loopback listener →
   open the browser to `app.hubspot.com/oauth/authorize?...` → user consents with their
   own HubSpot login → capture `code` on the loopback → exchange
   (`client_id` + `client_secret` + `code`) at `/oauth/2026-03/token` → persist **both
   access + refresh tokens** to a per-user `0600` cache → auto-refresh (already implemented)
   thereafter. `hsapi auth logout` clears it; `hsapi whoami` shows the signed-in user.
3. **Catalog gains `auth.tokenAudience`** = `user` (default) | `admin` | `scope-dependent`.
   Seed `admin` for the platform-gated set (owners, pipelines, pipeline-stages, schemas,
   and destructive deletes) from HubSpot's documented auth-sensitive list + our live 403s.
4. **Resolver → least-privilege selection.** A portal has a **user OAuth identity by
   default** and an **optional admin credential** (service key / private app). Per request:
   use OAuth unless `tokenAudience: admin` **and** an admin credential is configured; if an
   admin-required endpoint has no admin credential, **hard-fail with an actionable message**
   — escalation is explicit and catalog-driven, never a silent retry (preserves the
   "no silent fallback" ethos). Default family flips `portal_bearer → oauth`.
5. **No private-app token in the normal flow.** The admin credential is *optional* and only
   a super admin who needs the auth-sensitive ops configures one. Everyone else runs pure OAuth.
6. **Onboarding skill** walks a teammate: install → point config at the shared app
   (client_id/secret env) → `hsapi auth login` (browser consent) → register MCP entry →
   `hsapi whoami` to verify. Far shorter than today's bring-your-own-refresh-token dance.

## The irreducible service-key set

Under user-OAuth, HubSpot **platform-gates** certain endpoints regardless of scope:

- **Hard token-type gates** (scopes can't fix): `owners list`, `pipelines list` / `stages`.
- **Scope-dependent** (an admin user with the right app scope may pass): `properties create`,
  schema writes, deal/company-type `associations create`.
- **Destructive deletes** generally require admin.

These are encoded via `tokenAudience` so the CLI can tell a teammate *before* calling:
"this op needs your super-admin to configure a service key." This is HubSpot's gate, not ours.

## Security model

- `client_secret` is the **app's** secret (shared, app-level) — not a user credential and
  not a permission grant. Provision via env or `HSAPI_SECRET_LOOKUP_CMD`; **never** in
  config files (config stores env-var names only — preserves the existing isolation model).
- Per-user OAuth tokens cached `0600` on each user's machine; the cache now also holds the
  refresh token (a user secret — same protections).
- No elevation: HubSpot binds the token to the user at issue time.
- App on platform v2025.2 / v2026.03; OAuth v3 endpoints.

## Workstreams (→ issues)

1. `hsapi auth login` interactive loopback flow.
2. OAuth cache stores the refresh token.
3. Catalog `auth.tokenAudience` field (schema + generator default + seed + tests).
4. Resolver: least-privilege selection + flip default to `oauth` + explicit admin escalation.
5. `whoami` / `auth doctor`: surface signed-in user + flag admin-required ops.
6. Provision the HubSpot user-level dev app + secret distribution (Model A) + config samples.
7. Team onboarding skill + docs (DESKTOP_MCP_QUICKSTART / MCP.md).
8. (Later) Model B token broker.

## File-level change map

- `src/commands/auth.js` (`runAuth` :320-376) — add `login` / `logout`; `profileDoctor` checks.
- `src/command-inputs.js` (:1164-1252) — reuse/extend authorize-URL + token-exchange builders; loopback wiring.
- `src/auth-resolvers.js` — `oauthTokenCacheFromRefreshPayload` (:392-418) + `writeOAuthTokenCache` (:420-431) to persist the refresh token; `resolveOAuthCredential` (:495-517) login fallback; `resolveRequestCredential` (:870-876) least-privilege selection; `resolvePortal` (:154-186) optional admin cred.
- `src/auth.js` — `tokenAudience` constants + `normalizeEndpointAuth` (:64-98) + `endpointAuthRequirement` (:100-123) default flip.
- `src/catalog.js` — `validateEndpointDefinition` (:88-149) field; re-emit (:222-226).
- `data/hubspot-api-catalog.json` — seed `tokenAudience: admin` rows.
- `scripts/update-hubspot-api-catalog.js` (:476-480) — generator default for new proposals.
- `test/test-hsapi.js` — assert the pre-flight gate against the mocked 403s (:295,325); auth-shape gates (:825-829,:1994-2003).
- `examples/portals.sample.json` — OAuth-first profile (user OAuth + optional admin cred).
- `docs/DESKTOP_MCP_QUICKSTART.md`, `docs/MCP.md` — onboarding rewrite.

## Open questions / risks

- ~~Confirm the dev app must be "user-level"...~~ **RESOLVED 2026-06-16:** must be a
  **user-level app** (not a classic public app, which grants app-scoped tokens) — defined via
  `*-hsmeta.json` + `hs project upload` (`hubspotdev/user-level-app-template`), standard
  auth-code + `client_secret`, token enforced at the user's permissions against REST. Steps in #82.
- Decide the exact requested scope superset (and which scopes require super-admin app approval).
- Model A secret-distribution mechanism for the team (env vs `HSAPI_SECRET_LOOKUP_CMD` wrapper
  vs an internal secrets manager).
- Loopback redirect handling: HubSpot requires an **exact** registered `redirect_uri`, so
  register a fixed `http://localhost:<PORT>/callback` (and decide fixed port vs a small
  pre-registered range) on the app.

## Provisioning findings (2026-06-17)

App **created + deployed** as a user-level app (`hubspot-api-cli-mcp`, display name "HubSpot API CLI/MCP") in the isolated developer **test account `246523489`** via `hs project upload` (build #3, redirect `http://localhost:5123/callback`). Confirmed the test account hosts a user-level app fine — **no separate developer account needed**. (Mechanics gotcha: write the `*-hsmeta.json` as UTF-8 **without BOM** — PowerShell `Set-Content -Encoding utf8` adds a BOM that fails HubSpot's "Invalid JSON" validation.)

**⚠️ User-level app scope constraint (HubSpot-enforced).** On upload HubSpot flags these as "not fully supported for user-level apps" (and `crm.objects.custom.read` is outright *unrecognized*, which fails the deploy): **custom objects (`crm.objects.custom.*`), `crm.lists.*`, `crm.schemas.*`, `crm.hubsql.execute`, `marketing.campaigns.read`, `cms.*`.** So the per-user OAuth surface ≈ HubSpot's MCP-server object set: **standard CRM objects + engagements** (contacts, companies, deals, tickets, line_items, products, quotes, owners, carts/orders/invoices/subscriptions, tasks/notes/calls/meetings/emails) — **read+write**. Everything else — notably **custom objects** (Product Subscription, Customer Story), plus lists, schema writes, HubSQL, marketing, CMS — **falls back to the service-key/admin tier.** This widens the "irreducible service-key set" beyond the original auth-sensitive list and is a key input to the resolver design (#80).

**Still to validate:** per-user enforcement + writes, by authorizing as an admin vs a non-admin test user (pending Client ID/Secret + the `hsapi auth login` flow or a manual code exchange).

**Account model (HubSpot facelift, confirmed 2026-06-17).** As of **2026-03-09 HubSpot migrated all legacy standalone developer accounts into standard accounts**; developer tooling now lives inside a standard account's "development" area, and **developer test accounts** (free, ≤10 per standard account) are the build/test sandboxes. The app currently lives in test account `246523489` — correct + isolated for build/validation. **Open (rollout only):** whether a test-account-built app can be installed into a separate production portal (rad-ai `19834038`), or whether the production-distributable app must live in a standard account's development area (post-facelift = rad-ai's dev area — which stores only the app definition, **not** prod CRM data). Confirm before rollout; does not block validation.
