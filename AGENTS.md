# hsapi-cli Agent Guide

This repository packages `hsapi` as an installable HubSpot CLI.

Read first:

- `docs/hubspot-api-context/portal-auth-setup.md` for portal-profile onboarding
- `README.md`
- `docs/INSTALL.md`
- `SECURITY.md`
- `CONTRIBUTING.md`

Install:

```bash
npm install -g .
npm install -g git+https://github.com/chadmhohn/hsapi-cli.git#<tag-or-branch>
npm install -g ./hsapi-cli-<version>.tgz
```

Update:

- Reinstall from the newer git ref or tarball.
- Once a registry release exists, `npm update -g hsapi-cli` becomes the normal update path.

Rules:

- Never put tokens, portal configs, customer data, or local memory files in the package.
- Keep real portal config outside the package and point to it with `HSAPI_PORTALS_CONFIG`.
- Prefer `--show-request` before live HubSpot calls.
- Mutations require `--yes`; dangerous schema operations may require an additional danger flag.
- Add or update tests and catalog metadata with every command change.
- If packaging or install behavior changes, update `docs/INSTALL.md` and `README.md` together.

## Portal onboarding for assistants

When a user needs a portal profile:

1. Read `docs/hubspot-api-context/portal-auth-setup.md`. Through MCP, call
   `hsapi_context_doc` with `name: "portal-auth-setup"`.
2. Ask whether the operator intends hosted OAuth, ServiceKey/private-app auth,
   or an explicitly combined profile. Do not configure every auth family.
3. Start from the matching portal-neutral template under `examples/`.
4. Keep the real config and token cache outside the package. Put only
   environment-variable names in the config, never credential values.
5. Never ask the user to paste a token, client secret, authorization code, or
   cache contents into chat.
6. For normal hosted OAuth, configure only `mode: "hosted_broker"` and an
   external `tokenCachePath`, then run `auth doctor`, `auth login`, and
   `auth whoami`. The CLI uses its bundled broker, HubSpot presents the account
   chooser, and the returned `hub_id` binds an unpinned cache. Do not ask for a
   portal ID, broker credential, or local HubSpot app credentials.
7. The shared broker requires hsapi v0.5 or later. Update v0.4.x hosted
   installations and replace their old hosted profiles with the current
   template before browser login.
8. Treat `portalId` as an optional expected-account pin and `brokerUrl` as an
   optional private-deployment override. Use either only when the operator
   explicitly supplies it.
9. For ServiceKey/private-app auth, preview and then run the read-only
   `account details` identity check. Before combining it with OAuth, verify the
   ServiceKey belongs to the same HubSpot account as the OAuth `hub_id`.

`ServiceKey` maps to `auth.portalBearer` and is a HubSpot private-app access
token. Hosted OAuth teammates do not need the HubSpot app client ID or client
secret locally. Never invent an optional broker URL or portal-ID pin.

## MCP Tool Selection (for agents using the MCP server)

**Default to the read-only execute variants** — they are annotated `readOnlyHint: true` and can be always-approved by the MCP client without exposing mutations:

- `hsapi_command_execute_read` for typed commands (list, get, search, etc.)
- `hsapi_request_execute_read` for raw GET/HEAD/OPTIONS requests or catalog-marked read-only POSTs (search)

Switch to `hsapi_command_execute` / `hsapi_request_execute` **only when you need to write data** (create, update, delete). Those require `confirmMutation: true` and always show a blocked preview first.

The six catalog/meta tools (`hsapi_profiles_list`, `hsapi_catalog_coverage`, `hsapi_catalog_commands`, `hsapi_auth_doctor`, `hsapi_context_doc`, `hsapi_command_help`) are also `readOnlyHint: true`. Full tool surface and Co-Work always-approve setup: `docs/MCP.md`.

Saved reports and CRM saved views are deliberate first-party exceptions. Use
`hsapi_agent_cli_doctor`, then `hsapi_reports_read` / `hsapi_views_read` for
reads and the corresponding `*_write` tool for mutations. They delegate to a
separately installed HubSpot Agent CLI only after verifying its account matches
the selected HSAPI portal. Never treat its single-account OAuth cache as an
HSAPI multi-portal cache or silently fall back to ServiceKey mode. An omitted
MCP `authMode` uses the selected profile's optional `agentCli.authMode`, then
defaults to OAuth; an explicit tool argument overrides the profile.
