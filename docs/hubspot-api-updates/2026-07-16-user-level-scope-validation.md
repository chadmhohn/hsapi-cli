# HubSpot user-level app scope validation

Initial validation: July 16, 2026

Fresh build and runtime revalidation: July 18, 2026

## Outcome

The supplied HubSpot Agent CLI permissions export contains one required scope
(`oauth`) and 72 unique optional scopes.

- The HubSpot API CLI/MCP user-level app can currently declare 49 of the 72
  optional scopes.
- Two candidates are now accepted with HubSpot's warning tier:
  `crm.objects.marketing_events.write` from the earlier 18-scope set and
  `cpq.quotes.write` from the newer supplied additions.
- The remaining 23 candidates were re-tested individually on July 18. All 23
  still failed deployment as unrecognized.
- The exact 49-scope baseline was restored and is the current deployed app
  configuration.
- Browser consent does not guarantee that all declared scopes are issued. Even
  after selecting **All**, HubSpot granted 46 of the 49 optional scopes.
- Runtime behavior is mixed: some warning-tier scopes work, while eight
  scope categories explicitly reject a user-level OAuth token.

## Test target

| Field | Value |
|---|---|
| HubSpot account | isolated developer test account |
| Data region | NA2 |
| Project | `HubSpot API CLI MCP` |
| App UID | `hubspot-api-cli-mcp` |
| App type | user-level OAuth, marketplace distribution |
| Platform version | `2025.2` |
| Probe CLI | `@hubspot/cli` 8.9.1 |
| Current deployed build | #78 |
| Current deploy | #80 |

This is an isolated HubSpot developer test account, not either configured
customer portal. The authorizing user's email domain does not identify the
HubSpot account or its subscription tier. Cross-portal service-key calls were
not used as a control because their product entitlements and data differ.
The final browser identity check showed an active trial banner on the test
account, but that does not prove that every product-gated feature was enabled.

## Build-time validation

### Initial July 16 probe

Build #25 contained 47 optional scopes. The 25 missing permissions were tested
one at a time in builds #26 through #50.

| Scope | Individual build | Result | Combined result |
|---|---:|---|---|
| `cpq.quotes.write` | #26 | accepted with warning | accepted in #52 |
| `crm.objects.marketing_events.write` | #40 | accepted with warning | accepted in #52 |

Combined build #52 proved a 49-optional-scope configuration. Build #54 later
deployed that set with both localhost and staging-Worker callback URLs.

### Fresh July 18 rejection recheck

The 23 remaining candidates were tested individually again as the 49-scope
baseline plus one candidate:

- probe builds: #55 through #77;
- corresponding candidate deployments: #57 through #79;
- result: 23 of 23 deployments failed;
- common error: `The scope <scope> could not be recognized. Check your scope and try again.`;
- restoration build: #78;
- successful restoration deploy: #80.

The current HubSpot build list marks #78 as deployed. A successful project
build is not acceptance of the candidate app scope: each rejected candidate
failed during component deployment with the exact scope error above.

### Still rejected

From the prior 18-scope rejection set, these 17 remain rejected:

- `crm.objects.appointments.read`
- `crm.objects.appointments.write`
- `crm.objects.carts.write`
- `crm.objects.commercepayments.read`
- `crm.objects.courses.read`
- `crm.objects.courses.write`
- `crm.objects.custom.read`
- `crm.objects.custom.write`
- `crm.objects.feedback_submissions.read`
- `crm.objects.leads.read`
- `crm.objects.leads.write`
- `crm.objects.listings.read`
- `crm.objects.listings.write`
- `crm.objects.users.read`
- `crm.objects.users.write`
- `crm.schemas.custom.read`
- `crm.schemas.custom.write`

From the latest supplied export, these six also remain rejected:

- `crm.objects.quotes.write`
- `crm.objects.services.read`
- `crm.objects.services.write`
- `crm.schemas.quotes.read`
- `crm.schemas.quotes.write`
- `dashboard.external.read`

## Current deployed configuration

Build #78 contains:

- one required scope: `oauth`;
- 49 optional scopes;
- 33 clean optional scopes;
- 16 warning-tier optional scopes;
- localhost callback:
  `http://localhost:5123/callback`;
- staging broker callback:
  `https://<staging-worker-origin>/v1/oauth/callback`.

The 16 warning-tier scopes are:

- `cms.blogs.blog_posts.read`
- `cms.pages.landing_pages.read`
- `cms.pages.site_pages.read`
- `cpq.quote_templates.read`
- `cpq.quotes.read`
- `cpq.quotes.write`
- `crm.hubsql.execute`
- `crm.lists.read`
- `crm.objects.contracts.read`
- `crm.objects.marketing_events.read`
- `crm.objects.marketing_events.write`
- `marketing.campaigns.read`
- `marketing.campaigns.revenue.full.read`
- `marketing.campaigns.revenue.lite.read`
- `mcp.users.read`
- `settings.users.teams.read`

## Consent result

The hosted OAuth flow was authorized in the isolated test account. Consent
displayed `Optional (49)`, and **All** was explicitly selected. Every
selectable permission became checked.

These three permissions remained disabled and were not issued:

- `cpq.quotes.write`
- `crm.objects.marketing_events.write`
- `marketing.campaigns.revenue.lite.read`

The returned token contained:

- one required grant;
- 46 optional grants;
- 47 total grants;
- hub ID matched the configured test account.

The CLI verified the profile/hub match and stored only redacted metadata in
command output. The reason for the three disabled permissions cannot be
isolated from this consent page alone; possible causes include portal
entitlement, installing-user permission, or HubSpot's user-level consent
policy. They therefore remain inconclusive until tested in a portal and user
known to have the corresponding product features.

## Runtime validation

The token was exercised with read-only or semantically read-only requests. A
post-hardening refresh through the staging broker succeeded, and the refreshed
token repeated the same results.

| Scope or capability | Probe | Result | Interpretation |
|---|---|---|---|
| `oauth` | `GET /account-info/2026-03/details` | `200`, account matched | Identity control passed |
| `crm.objects.contracts.read` | current and legacy contract list routes | `200` | Isolated warning-tier scope works |
| `mcp.users.read` | current Users CRM list route | `200` | Strong evidence: token did not contain rejected `crm.objects.users.read` |
| `cpq.quote_templates.read` | current and legacy quote-template list routes | `200` | Capability works, but public docs also associate quote templates with standard quote read |
| `cpq.quotes.read` | current and legacy quotes list routes | `200` | Capability works, but token also had `crm.objects.quotes.read` |
| `crm.hubsql.execute` | none | grant present | No documented public raw REST endpoint was identified |

These eight scope categories returned `403` with the exact message
`User level OAuth token is not allowed for this endpoint.`:

| Scope | Read-only probe |
|---|---|
| `cms.blogs.blog_posts.read` | `GET /cms/blogs/2026-03/posts?limit=1` |
| `cms.pages.landing_pages.read` | `GET /cms/pages/2026-03/landing-pages?limit=1` |
| `cms.pages.site_pages.read` | `GET /cms/pages/2026-03/site-pages?limit=1` |
| `crm.lists.read` | `POST /crm/lists/2026-03/search` with a one-result search body |
| `crm.objects.marketing_events.read` | `GET /marketing/marketing-events/2026-03?limit=1` |
| `marketing.campaigns.read` | `GET /marketing/campaigns/2026-03?limit=1` |
| `marketing.campaigns.revenue.full.read` | current `/marketing/campaigns/2026-03/{id}/reports/revenue` and legacy `/marketing/v3/campaigns/{id}/reports/revenue` |
| `settings.users.teams.read` | current `/settings/users/2026-03/teams` and legacy `/settings/v3/users/teams` |

That message distinguishes these failures from an ordinary
product-entitlement response: HubSpot rejected the token type first. Adding
the visible/granted scope does not make those endpoints usable by this
user-level app.

Two clean-scope boundaries were also refreshed after comparing HubSpot's Agent
CLI documentation with this third-party app:

- `GET /crm/v3/owners?limit=1` returned the same explicit user-level-token
  rejection;
- `GET /crm/pipelines/2026-03/deals` returned the same explicit
  user-level-token rejection.

Those results are specific to this custom user-level app and test account as of
July 18, 2026. They do not imply that HubSpot's own first-party Agent CLI has
the same internal authorization path.

The two newly accepted write scopes were not issued, so no live write was
attempted. No production/customer portal data was mutated.

## Hosted broker validation

The Cloudflare staging broker completed:

- session creation;
- browser authorization;
- callback and one-time code exchange;
- portal-bound local cache creation;
- refresh through a hardened Worker version;
- public health check with `ready: true`.

The full authorization, exchange, and refresh flow was validated on Worker
version `5a333109-82bc-42d4-bc71-0364c6b9de1d`. The currently deployed staging
version is `a7a9641e-0324-402d-83cc-61d04fe4075a`; its public health check and
unauthenticated session-start rejection passed, but an authenticated session
start and fresh authorization, exchange, and refresh were not completed on
that exact version. Staging is not a production rollout.

Production still needs its own exact callback, independent secrets,
per-install enrollment, refresh-response retry/replay recovery, protected
local-cache policy, monitoring, custom-domain policy, incident response, and a
separate production deployment.

## Interpretation

HubSpot's first-party Agent CLI permission set is not a declaration template
for a third-party user-level marketplace app. A permission can fall into four
different states:

1. rejected during app deployment;
2. accepted in app configuration but disabled during consent;
3. granted to the token but rejected by the public endpoint because it is a
   user-level token;
4. granted and usable at runtime.

The current app reaches the maximum set HubSpot accepted in this test: 49 of
the supplied 72 optional permissions. Only 46 were issued in this portal, and
warning-tier runtime support must remain endpoint-specific.

## Recommended follow-up

- Keep the 23 rejected scopes out of the app until a later revalidation shows a
  changed HubSpot deployment result.
- Do not route the eight explicit token-type-rejected endpoints to user OAuth.
- Decide whether to keep the three consent-disabled permissions in the app
  configuration.
- Use separately authorized minimal-scope tokens to isolate CPQ quote scopes if
  exact attribution matters.
- Test a deliberately limited HubSpot user and, separately, a portal with the
  relevant paid features before broad rollout.
- Productionize the broker independently from staging.

Primary references:

- [HubSpot app scopes](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/scopes)
- [HubSpot OAuth](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/working-with-oauth)
- [HubSpot Lists API](https://developers.hubspot.com/docs/api-reference/latest/crm/lists/guide)
- [HubSpot marketing events API](https://developers.hubspot.com/docs/api-reference/latest/marketing/marketing-events/guide)
- [HubSpot campaigns API](https://developers.hubspot.com/docs/api-reference/latest/marketing/campaigns/guide)
- [HubSpot Agent CLI](https://developers.hubspot.com/docs/developer-tooling/local-development/agent-cli/guide)
