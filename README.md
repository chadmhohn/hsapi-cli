# hsapi-cli

Portal-aware HubSpot API CLI for agents and RevOps operators.

`hsapi-cli` packages the `hsapi` workbench as an installable HubSpot CLI and MCP server. The primary command is `hsapi`; `hsapi-mcp` starts the MCP server. The legacy `hubspot-agent-cli` binary alias remains available for compatibility.

This package is a private beta build. It stays `private: true` until a release decision is made.

## Install and Update

For the full install/update flow, read `docs/INSTALL.md`.

Agent runtimes should start with `AGENTS.md` or `CLAUDE.md`.

Quick install from a checkout:

```bash
npm install -g .
```

## Safety Model

- Portal credentials are never stored in package files.
- Each portal profile points to its own token environment variable.
- Mutating requests require `--yes`.
- Use `--show-request` to inspect method, URL, query, body, portal, token env var, and endpoint metadata without making a HubSpot request.
- Generic `POST --read-only` only works for catalog-marked read-only POST endpoints.
- Absolute URLs must match the selected portal API origin before a bearer token is sent.

## Configure a Portal

Copy `examples/portals.sample.json` to a private location outside the package and edit it for your portal:

```bash
cp examples/portals.sample.json ~/.config/hsapi/portals.json
export HSAPI_PORTALS_CONFIG=~/.config/hsapi/portals.json
export HUBSPOT_ACCESS_TOKEN_EXAMPLE="<your-private-app-token>"
export HUBSPOT_CLIENT_ID_EXAMPLE="<your-oauth-client-id>"
export HUBSPOT_CLIENT_SECRET_EXAMPLE="<your-oauth-client-secret>"
export HUBSPOT_REFRESH_TOKEN_EXAMPLE="<your-oauth-refresh-token>"
export HUBSPOT_PERSONAL_ACCESS_KEY_EXAMPLE="<your-hubspot-cli-personal-access-key>"
export HUBSPOT_DEVELOPER_API_KEY_EXAMPLE="<your-developer-api-key>"
export HUBSPOT_APP_ID_EXAMPLE="<your-developer-app-id>"
```

The config stores labels, portal IDs, API base URLs, token environment variable names, and optional OAuth cache paths. New portal-bearer profiles should use `auth.portalBearer.tokenEnv`; legacy top-level `tokenEnv` profiles remain supported. OAuth-backed profiles use `auth.oauth.clientIdEnv`, `auth.oauth.clientSecretEnv`, `auth.oauth.refreshTokenEnv`, and `auth.oauth.tokenCachePath` to refresh short-lived installed-app access tokens. Developer profiles use `auth.developer.personalAccessKeyEnv` for HubSpot CLI/local developer-tooling surfaces, `auth.developer.developerApiKeyEnv` plus `auth.developer.appIdEnv` for app-management endpoints that explicitly require developer API key query parameters, and `auth.developer.clientIdEnv`, `auth.developer.clientSecretEnv`, and `auth.developer.tokenCachePath` for app-level OAuth client-credentials endpoints such as Webhooks Journal. Config files must not store token values, client secrets, customer data, or cache contents.

Validate profile wiring offline before running live commands:

```bash
hsapi auth doctor --portal example
hsapi auth doctor --portal example --require-env
```

`auth doctor` reports configured auth families, missing environment variables, and token-cache path safety without printing secret values or calling HubSpot. Use `--require-env` when a release or deployment gate should fail if a configured credential environment variable is missing.

For package-beta test coverage across multiple HubSpot tiers, use `examples/portals.test-matrix.sample.json` and `docs/TEST_PORTAL_MATRIX.md` as the fixture contract. Keep the real matrix config outside the package, and reserve live writes for the `disposable_write` fixture with an explicit write-test gate.

Auth-mode implementation planning lives in `docs/hubspot-api-context/auth-modes-project-plan.md`. The key rule: endpoint auth requirements must be explicit, and `hsapi` must never silently fall back between portal bearer, OAuth, and developer auth families.

Endpoint catalog entries declare auth metadata with one of the shared auth families: `portal_bearer`, `oauth`, or `developer`. Developer endpoints also declare one of `personal_access_key`, `developer_api_key`, or `client_credentials`. Public endpoints that intentionally send no credential must opt out with `auth.required: false`; missing or unknown endpoint auth metadata is rejected before a request is sent. `--show-request` reports the resolved auth family, subtype, catalog/default provenance, credential source names such as environment variable names, and redacted OAuth token-cache expiry metadata without printing secret values or refreshing live tokens.

Developer API keys are only injected for catalog endpoints marked `auth.family: developer` and `auth.subtype: developer_api_key`; current typed usage is classic app webhooks, where `hapikey` is added as a query parameter and the app ID comes from the command path. Personal access keys are treated as bearer credentials only for endpoints explicitly cataloged as `developer/personal_access_key`, matching HubSpot CLI and local developer-tooling workflows. Webhooks Journal is cataloged as `developer/client_credentials`; `hsapi` requests a short-lived app-level OAuth token with the endpoint scopes and stores it in the developer token cache, which is separate from the installed-app OAuth cache.

CMS REST API commands and HubSpot Projects use separate auth surfaces. Use `hsapi --portal <profile>` for CMS REST APIs backed by the selected portal profile, and use the official HubSpot CLI `hs project ... --account <account>` for Projects/local developer workflows unless a future explicit bridge delegates to it. `hsapi` must not silently consume `~/.hscli/config.yml` or pasted personal access keys. See `docs/CMS_PROJECTS_AUTH_BOUNDARY.md`.

For explicit HubSpot Projects delegation, use `hsapi project doctor --account <account>` first. The project bridge requires `--account`, reports that it is delegating to the official HubSpot CLI, previews delegated argv with `--show-request`, and blocks mutating or deploy-style commands such as upload/deploy/delete unless `--yes` is present. See `docs/hubspot-api-context/projects.md`.

## MCP Adapter Planning

Dual CLI/MCP adapter planning lives in docs/hubspot-api-context/mcp-adapter-project-plan.md. The target is one shared HubSpot config/auth/catalog/request core with two surfaces: direct hsapi CLI usage and a stdio MCP server for OpenClaw or other MCP clients. Live replacement of existing HubSpot MCP entries requires neutral token sourcing plus explicit operator approval for any Gateway restart.

## MCP Server Usage

Operational MCP docs live in `docs/MCP.md`; sample OpenClaw and generic MCP client config lives in `examples/mcp-server.sample.json`. For local Codex Desktop and Claude Desktop setup from a shared GitHub checkout, use `docs/DESKTOP_MCP_QUICKSTART.md`.

Use direct CLI mode when an operator or agent can run shell commands:

```bash
hsapi account details --portal example --show-request
hsapi crm list contacts --portal example --properties email --max-results 5
```

Use MCP server mode when OpenClaw or another MCP client should expose bounded HubSpot tools over stdio:

```bash
hsapi-mcp
# or
hsapi mcp serve
```

Both modes use the same portal config, auth families, endpoint catalog, request preview, mutation gates, output limits, and redaction behavior. Keep `HSAPI_PORTALS_CONFIG` pointed at a private config outside the package; that config stores environment variable names, not credential values. MCP client config should pass `HSAPI_PORTALS_CONFIG` and optionally `HSAPI_PORTAL`; actual HubSpot tokens, OAuth refresh tokens, client secrets, developer API keys, personal access keys, and token caches must come from env injection, an OpenClaw-supported SecretRef path, a wrapper, or another secret manager.

For cutover prep, `docs/MCP.md` documents a neutral token-source wrapper and reversible local migration runbook. The final OpenClaw cutover runbook is `docs/OPENCLAW_MCP_CUTOVER.md`, with a repo-safe payload template in `examples/openclaw-cutover.mcp.sample.json`. The neutral samples are `examples/neutral-token-wrapper.sample.sh` and `examples/portals.multi-portal.sample.json`; they preserve separate portal profile configuration without storing token values.

## Auth Families and Command Discovery

| Auth family | Used for | Profile fields |
| --- | --- | --- |
| `portal_bearer` | Account-scoped HubSpot APIs such as CRM, CMS, files, properties, associations, forms secure-submit, automation, and most typed commands. | `auth.portalBearer.tokenEnv` or legacy `tokenEnv` |
| `oauth` | OAuth helper commands and installed-app endpoint execution for catalog entries marked `auth.family: oauth`. | `auth.oauth.clientIdEnv`, `auth.oauth.clientSecretEnv`, `auth.oauth.refreshTokenEnv`, `auth.oauth.tokenCachePath` |
| `developer/personal_access_key` | HubSpot CLI or local developer-tooling surfaces that explicitly require a personal access key. | `auth.developer.personalAccessKeyEnv` |
| `developer/developer_api_key` | Classic app-management endpoints documented with `hapikey`; current typed usage is classic app webhooks. | `auth.developer.developerApiKeyEnv`, sometimes `auth.developer.appIdEnv` |
| `developer/client_credentials` | App-level developer APIs such as Webhooks Journal. | `auth.developer.clientIdEnv`, `auth.developer.clientSecretEnv`, `auth.developer.tokenCachePath` |

Before running an unfamiliar command, inspect its catalog auth metadata:

```bash
hsapi catalog commands --pick commands[].command,commands[].auth.family,commands[].auth.subtype
hsapi webhooks settings 12345 --show-request
```

The first command lists typed command auth requirements. The second previews one concrete command and shows `authFamily`, `authSubtype`, scopes, query-credential metadata, and redacted credential source names before any HubSpot request is made.

Run safe live-read smokes only when a private test matrix config exists:

```bash
HSAPI_TEST_MATRIX_CONFIG=~/.config/hsapi/test-matrix.json npm run test:live-read
```

The live-read runner skips cleanly when config or token environment variables are missing. It does not run write commands.

Run disposable write smokes only against the `disposable_write` fixture and only with the explicit gate:

```bash
HSAPI_TEST_MATRIX_CONFIG=~/.config/hsapi/test-matrix.json HSAPI_RUN_DISPOSABLE_WRITES=true npm run test:disposable-write
```

The disposable-write runner refuses non-disposable fixture roles, requires the `hsapi_test_` asset prefix, and skips unless the gate and token env are present.

## Common Commands

```bash
hsapi profiles list
hsapi auth doctor --portal example
hsapi account details --portal example --show-request
hsapi catalog coverage
hsapi catalog commands --pick commands[].command,commands[].auth.family,commands[].auth.subtype
hsapi request GET /crm/v3/owners --portal example --query limit=10
hsapi properties list deals --portal example --names-only
hsapi properties names deals --portal example
hsapi crm object-types --family commerce
hsapi crm object-types --family activity
hsapi crm search companies --filter hs_object_id:GT:0 --count-only
hsapi crm count companies --filter hs_object_id:GT:0
hsapi crm exists contacts --filter email:EQ:ada@example.com
hsapi crm find-one contacts --filter email:EQ:ada@example.com --properties email,firstname
hsapi crm get contacts 101 --properties email --properties-with-history lifecyclestage,hs_lead_status --show-request
hsapi crm search contacts --filter email:EQ:ada@example.com --properties email --properties-with-history lifecyclestage --show-request
hsapi crm create contacts --properties '{"email":"ada@example.com","firstname":"Ada"}' --show-request
hsapi crm update contacts 101 --properties '{"firstname":"Ada"}' --show-request
hsapi crm archive contacts 101 --show-request
hsapi crm merge contacts 101 202 --danger-merge --show-request
hsapi crm gdpr-delete contacts ada@example.com --id-property email --danger-gdpr-delete --show-request
hsapi crm batch-read contacts --ids 101,102 --properties email,firstname --show-request
hsapi crm batch-upsert contacts --id-property email --inputs '[{"id":"ada@example.com","properties":{"firstname":"Ada"}}]' --show-request
hsapi associations batch-read contacts companies --ids 101,102 --show-request
hsapi associations batch-create contacts companies --inputs '[{"from":{"id":"101"},"to":{"id":"9001"},"types":[{"associationCategory":"HUBSPOT_DEFINED","associationTypeId":279}]}]' --show-request
hsapi lists search --search Renewals --count 10 --show-request
hsapi exports start --export-name "Contact export" --object-type contacts --properties email,firstname --show-request
hsapi subscriptions status ada@example.com --show-request
hsapi subscriptions set-status ada@example.com --subscription-id 123 --status SUBSCRIBED --legal-basis LEGITIMATE_INTEREST_OTHER --legal-basis-explanation "Requested resubscribe" --show-request
hsapi files search --name logo --limit 10 --show-request
hsapi files upload --file ./logo.png --folder-path /library/brand --access PRIVATE --show-request
hsapi files signed-url 123456 --show-request
hsapi files folder-search --path /library --limit 10 --show-request
hsapi pipelines stage-create deals default --label "Contract signed" --display-order 4 --show-request
hsapi events occurrences --event-type e_visited_page --object-type contact --object-id 224834 --show-request
hsapi webhooks settings 12345 --show-request
hsapi webhook-journal journal-batch-read --offsets 101,102 --show-request
hsapi conversations threads --inbox-id inbox-1 --show-request
hsapi conversations message-create thread-1 --text "Following up from hsapi" --actor-id actor-1 --show-request
hsapi project doctor --account example
hsapi project list --account example
hsapi project deploy --account example --project "my-project" --build 5 --show-request
  hsapi forms list --form-types hubspot --limit 10 --show-request
  hsapi forms submissions form-guid-123 --limit 20 --show-request
  hsapi forms secure-submit 123456 form-guid-123 --fields '[{"name":"email","value":"ada@example.com"}]' --show-request
  hsapi cms doctor --portal example
  hsapi cms doctor --portal example --content-id 123 --type SITE_PAGE
  hsapi cms site-pages list --state PUBLISHED_OR_SCHEDULED --show-request
  hsapi cms blog-posts create --name "Draft post" --content-group-id 123 --post-body "<p>Hello</p>" --show-request
  hsapi cms redirects create --route-prefix /old --destination /new --redirect-style 301 --show-request
  hsapi cms search --q marketing --type BLOG_POST --show-request
  hsapi scheduler links --organizer-user-id 123456 --show-request
  hsapi scheduler booking-info jdoe --timezone America/New_York --show-request
  hsapi auth authorize-url --client-id "$HUBSPOT_CLIENT_ID" --redirect-uri https://example.com/oauth/callback --scopes oauth,crm.objects.contacts.read
hsapi auth refresh --client-id-env HUBSPOT_CLIENT_ID --client-secret-env HUBSPOT_CLIENT_SECRET --refresh-token-env HUBSPOT_REFRESH_TOKEN --show-request
npm run catalog:update:offline
```

## Token-Efficient Output

Global output flags work on typed commands and generic `hsapi request` output:

```bash
hsapi request GET /crm/v3/owners --select data.results[].id
hsapi request GET /crm/v3/owners --pick data.total,data.results[].email
hsapi account details --select data.portalId --raw-value
hsapi crm list contacts --properties email,firstname --compact --max-results 5
hsapi crm list contacts --properties email --ids-only
hsapi crm search companies --filter hs_object_id:GT:0 --properties name --id-name-map
hsapi files search --name logo --id-name-map --max-results 10
hsapi crm search companies --filter hs_object_id:GT:0 --count-only
hsapi crm count contacts --filter lifecyclestage:EQ:customer
hsapi crm exists contacts --filter email:EQ:ada@example.com
hsapi properties names contacts
hsapi request GET /crm/v3/owners --max-chars 1000 --include-truncated
```

Use `--compact` or its alias `--agent` to keep `ok`, `portal`, and payload fields while dropping routine envelope metadata such as rate limits, request IDs, method, and URL. `--show-request` keeps the request preview fields visible even in compact mode.

Use `--ids-only`, `--names-only`, or `--id-name-map` for discovery/list workflows when full records are unnecessary. These helpers return compact JSON contracts like `{ ok, portal, count, ids }`, `{ ok, portal, count, names }`, or `{ ok, portal, count, items: [{ id, name }] }` and work with common HubSpot result arrays, including CRM list/search, properties, pipelines, lists, files, and CMS list/search responses. Pair them with `--max-results` to cap large result sets. They are mutually exclusive with `--select`, `--pick`, and `--raw-value`.

`--count-only` on CRM search/list omits record arrays and returns `count`, `countType`, and the portal/object/filter provenance. CRM search counts are exact when HubSpot includes `total`; CRM list counts use a one-record page and mark the result exact, page-limited, or unavailable from the response shape.

Use `--properties-with-history` on `crm get`, `crm search`, or `crm batch-read` only when you need property version history. History responses can be much larger than current-value reads, so pair them with a narrow `--properties` list plus `--select`, `--pick`, `--compact`, or `--max-results` when working in token-sensitive contexts. `crm search --count-only` ignores both `--properties` and `--properties-with-history`.

Run a mutation only after reviewing the request:

```bash
hsapi properties create deals \
  --name test_agent_property \
  --label "Test Agent Property" \
  --type string \
  --field-type text \
  --group dealinformation \
  --show-request

hsapi properties create deals \
  --name test_agent_property \
  --label "Test Agent Property" \
  --type string \
  --field-type text \
  --group dealinformation \
  --yes
```

## Troubleshooting 401 and 403 by Auth Family

HubSpot 401 and 403 responses mean different things by auth family:

- `portal_bearer`: a 401 usually means the private/static app token env var is missing, revoked, or invalid for that portal. A 403 usually means missing private-app scopes, a portal subscription/tier block, or a feature that exists in HubSpot docs but is not enabled for that portal.
- `oauth`: a 401 usually points to an invalid client secret, expired/revoked refresh token, failed refresh, or unusable token cache. A 403 usually means the installed app lacks scopes, the app was not installed for that account, or the portal tier blocks the feature.
- `developer/developer_api_key`: a 401 usually means the developer API key env var is missing or invalid. A 403 can mean the app/account is not allowed to manage that developer surface or the endpoint does not accept that developer credential shape.
- `developer/personal_access_key`: a 401 usually means the personal access key is missing or invalid. A 403 can mean HubSpot rejected user-level developer auth for an account API endpoint; do not retry by falling back to portal bearer unless catalog metadata requires `portal_bearer`.
- `developer/client_credentials`: a 401 usually means the developer app client ID/secret pair is invalid. A 403 usually means the app-level token lacks required developer scopes or the developer feature is unavailable.

If `hsapi` CMS access and `hs project ...` access differ, treat that as a credential-boundary signal. `hsapi --portal <profile>` uses the portal profile auth configured for account-scoped REST APIs; the official HubSpot CLI uses its own account and developer-tooling auth. Diagnose each side independently and do not copy tokens between `hsapi` config and `~/.hscli/config.yml`.

For CMS-specific failures, start with `hsapi cms doctor --portal <profile>`. It runs read-only checks for domains, pages, blog posts, redirects, site search, and optional indexed-data access, then separates missing scopes or permissions from unavailable portal features and unexpected API failures without printing credential values.

For Projects/local developer tooling failures, run `hsapi project doctor --account <account>`. This verifies official HubSpot CLI availability, account selection, and project-list readiness without mutating HubSpot or reading `hsapi` portal credentials.

This matters most for custom objects, schema configuration, association labels/limits, calculated properties, and other tier-gated CRM configuration APIs.

## Current Scope

<!-- BEGIN GENERATED: current-scope (npm run readme:scope) -->

The catalog covers **276 typed commands** across **47 endpoint families**, every one with documented arguments (`hsapi help <command>`). Local tooling on top: multi-portal profiles, generic catalog-gated requests with previews, the MCP server (`hsapi mcp serve`), tier reporting, CMS/auth/project doctors, the mutation audit log (`hsapi history`), and `hsapi upgrade`.

- `hsapi account` — 3 commands
- `hsapi association-labels` — 4 commands
- `hsapi association-limits` — 4 commands
- `hsapi associations` — 10 commands
- `hsapi auth` — 4 commands
- `hsapi automation sequences` — 4 commands
- `hsapi automation workflows` — 4 commands
- `hsapi cms` — 2 commands
- `hsapi cms blog-posts` — 9 commands
- `hsapi cms domains` — 2 commands
- `hsapi cms hubdb rows` — 2 commands
- `hsapi cms hubdb tables` — 3 commands
- `hsapi cms landing-pages` — 9 commands
- `hsapi cms redirects` — 5 commands
- `hsapi cms site-pages` — 9 commands
- `hsapi cms source-code` — 3 commands
- `hsapi conversations` — 30 commands
- `hsapi crm` — 13 commands
- `hsapi events` — 12 commands
- `hsapi exports` — 3 commands
- `hsapi extensions calling channel-connection` — 1 command
- `hsapi extensions calling recording-settings` — 3 commands
- `hsapi extensions calling recordings` — 1 command
- `hsapi extensions calling settings` — 2 commands
- `hsapi extensions calling transcripts` — 2 commands
- `hsapi extensions videoconferencing settings` — 2 commands
- `hsapi files` — 16 commands
- `hsapi forms` — 9 commands
- `hsapi imports` — 5 commands
- `hsapi limits` — 7 commands
- `hsapi lists` — 11 commands
- `hsapi marketing campaigns` — 3 commands
- `hsapi marketing emails` — 3 commands
- `hsapi marketing events` — 3 commands
- `hsapi marketing transactional` — 1 command
- `hsapi object-library` — 1 command
- `hsapi owners` — 2 commands
- `hsapi pipelines` — 10 commands
- `hsapi properties` — 5 commands
- `hsapi property-groups` — 4 commands
- `hsapi property-validations` — 2 commands
- `hsapi scheduler` — 5 commands
- `hsapi schemas` — 5 commands
- `hsapi subscriptions` — 10 commands
- `hsapi webhook-journal` — 19 commands
- `hsapi webhooks` — 6 commands

Argspec coverage: 276/276 typed commands documented.

<!-- END GENERATED: current-scope -->

## Catalog Updater

Run a local-only catalog hygiene check:

```bash
npm run catalog:update:offline
```

Run the network docs check and write a dated report:

```bash
npm run catalog:update -- --write-report
```

Run the diff assistant and write reviewable proposal JSON:

```bash
npm run catalog:diff -- --write-report --write-proposals
```

Run the weekly maintenance alias used by cron:

```bash
npm run catalog:weekly
```

Run the current coverage dashboard generator:

```bash
npm run catalog:dashboard
```

The updater is intentionally non-mutating. It checks catalog health, fetches official HubSpot source pages, detects the current `llms.txt` login redirect, compares discovered docs links to catalog docs URLs, and reports triage candidates under `docs/hubspot-api-updates/`. Reports also summarize implementation coverage by status, API family, risk, tier requirement, and required scope.

Diff proposal mode fetches uncataloged docs pages, extracts likely `METHOD /path` endpoint references, filters out method/path pairs already in the catalog, and writes candidate endpoint stubs. Treat those stubs as review material: every proposed endpoint still needs command design, scope/tier notes, context docs, tests, and mutation-safety review before it belongs in `data/hubspot-api-catalog.json`.

Use `--candidate-url`, `--candidate-file`, `--proposal-limit`, and `--max-proposals` to focus a run. The default proposal output is capped so broad HubSpot docs pages do not flood normal reports; use `--max-proposals 0` only when you want the full raw discovery list.
