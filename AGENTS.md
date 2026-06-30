# hsapi-cli Agent Guide

This repository packages `hsapi` as an installable HubSpot CLI.

Read first:

- `README.md`
- `docs/INSTALL.md`
- `SECURITY.md`
- `CONTRIBUTING.md`

Install:

```bash
npm install -g .
npm install -g git+ssh://git@github.com/your-org/hsapi-cli.git#<tag-or-branch>
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

## MCP Tool Selection (for agents using the MCP server)

**Default to the read-only execute variants** — they are annotated `readOnlyHint: true` and can be always-approved by the MCP client without exposing mutations:

- `hsapi_command_execute_read` for typed commands (list, get, search, etc.)
- `hsapi_request_execute_read` for raw GET/HEAD/OPTIONS requests or catalog-marked read-only POSTs (search)

Switch to `hsapi_command_execute` / `hsapi_request_execute` **only when you need to write data** (create, update, delete). Those require `confirmMutation: true` and always show a blocked preview first.

The six catalog/meta tools (`hsapi_profiles_list`, `hsapi_catalog_coverage`, `hsapi_catalog_commands`, `hsapi_auth_doctor`, `hsapi_context_doc`, `hsapi_command_help`) are also `readOnlyHint: true`. Full tool surface and Co-Work always-approve setup: `docs/MCP.md`.
