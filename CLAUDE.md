# hsapi-cli

`AGENTS.md` is the canonical repo guide. This file mirrors the same operational rules for Claude-aware tools.

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

- Never store tokens, portal configs, customer data, or local memory files in the package.
- Keep real portal config outside the package and point to it with `HSAPI_PORTALS_CONFIG`.
- Use `--show-request` before live HubSpot calls.
- Mutations require `--yes`; dangerous schema operations may require an additional danger flag.

## Portal onboarding for assistants

When a user needs a portal profile:

1. Read `docs/hubspot-api-context/portal-auth-setup.md`. Through MCP, call
   `hsapi_context_doc` with `name: "portal-auth-setup"`.
2. Ask whether the operator intends hosted OAuth, ServiceKey/private-app auth,
   or an explicitly combined profile. Do not configure every auth family.
3. Start from the matching portal-neutral template under `examples/`.
4. Keep the real config and token cache outside the package. Put only
   environment-variable names in the config, never credential values.
5. Never ask the user to paste a token, client secret, broker start credential,
   authorization code, or cache contents into chat.
6. Run `hsapi auth doctor --portal <name> --require-env` before live access.
   For hosted OAuth, follow with `auth login` and `auth whoami`. For
   ServiceKey/private-app auth, preview and then run the read-only
   `account details` identity check.

`ServiceKey` maps to `auth.portalBearer` and is a HubSpot private-app access
token. Hosted OAuth teammates do not need the HubSpot app client ID or client
secret locally. Never invent a broker URL, portal ID, or enrollment credential.

## MCP Tool Selection (for agents using the MCP server)

**Default to the read-only execute variants** — they are annotated `readOnlyHint: true` and can be always-approved by the MCP client without exposing mutations:

- `hsapi_command_execute_read` for typed commands (list, get, search, etc.)
- `hsapi_request_execute_read` for raw GET/HEAD/OPTIONS requests or catalog-marked read-only POSTs (search)

Switch to `hsapi_command_execute` / `hsapi_request_execute` **only when you need to write data** (create, update, delete). Those require `confirmMutation: true` and always show a blocked preview first.

The six catalog/meta tools (`hsapi_profiles_list`, `hsapi_catalog_coverage`, `hsapi_catalog_commands`, `hsapi_auth_doctor`, `hsapi_context_doc`, `hsapi_command_help`) are also `readOnlyHint: true`. Full tool surface and Co-Work always-approve setup: `docs/MCP.md`.
