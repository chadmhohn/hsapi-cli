# MCP Server Mode

`hsapi` can run in two modes:

- Direct CLI mode: an operator or agent runs `hsapi ...` commands directly in a shell.
- MCP server mode: an MCP client starts `hsapi-mcp` or `hsapi mcp serve` over stdio and calls the exposed tools.

Both modes use the same portal config, endpoint catalog, auth resolvers, request builder, mutation gates, origin guard, output projection, and redaction logic. MCP mode is an adapter over the CLI core, not a separate HubSpot implementation.

## Direct CLI Mode

Use direct CLI mode for scripts, local operator work, package smoke tests, and agent tasks that can safely execute shell commands:

```bash
export HSAPI_PORTALS_CONFIG=/path/outside-package/hsapi/portals.json
export HUBSPOT_SERVICE_KEY_EXAMPLE="<loaded-from-env-or-secret-manager>"

hsapi profiles list
hsapi auth doctor --portal service-key-example --require-env
hsapi account details --portal service-key-example --show-request
hsapi crm list contacts --portal service-key-example --properties email --max-results 5
```

Direct CLI mode gives the caller the full command surface. Keep using `--show-request` before unfamiliar writes, and keep mutating commands behind `--yes` plus any command-specific danger flags. Use `--agent`, `--max-results`, `--max-chars`, `--select`, `--pick`, `--ids-only`, `--names-only`, and `--id-name-map` to keep output bounded for agents.

## MCP Server Mode

Use MCP server mode when OpenClaw or another MCP client should expose HubSpot tools without giving the agent a general shell command path:

```bash
hsapi-mcp
```

The equivalent long form is:

```bash
hsapi mcp serve
```

The server uses stdio transport. Clients own the process lifetime and pass config through environment variables. ## Tool Surface

### Meta / catalog tools (`readOnlyHint: true` — always-approvable)

These tools are stateless and never call HubSpot:

- `hsapi_profiles_list`: list configured profiles with redacted credential metadata.
- `hsapi_catalog_coverage`: summarize endpoint coverage and auth-family coverage.
- `hsapi_catalog_commands`: inspect command metadata with bounded filters.
- `hsapi_auth_doctor`: validate profile wiring without printing secrets.
- `hsapi_context_doc`: fetch a named context document from the local docs
  library. For a missing profile or auth onboarding, fetch
  `portal-auth-setup` first.
- `hsapi_command_help`: return help text for a catalog command without executing it.

### First-party report/view tools

These capability-specific tools delegate only saved reports and CRM saved
views to HubSpot Agent CLI `0.10.0+`. They keep HSAPI portal selection,
redaction, output budgets, and preview/confirmation gates. Before execution,
HSAPI checks `hubspot whoami` against the selected profile; OAuth is the Agent
CLI's separate single-account cache, while `service-key` mode must be selected
explicitly in `agentCli.authMode` or the MCP call. An MCP `authMode` argument
overrides the selected profile; omitting it uses the profile and then defaults
to OAuth.

- `hsapi_agent_cli_doctor` (`readOnlyHint: true`): verify version, auth mode,
  and selected-account binding.
- `hsapi_reports_read` (`readOnlyHint: true`): list, get, fetch a dataset, or
  generate insights for a saved report.
- `hsapi_views_read` (`readOnlyHint: true`): list or get CRM saved views.
- `hsapi_reports_write`: create, clone, favorite, unfavorite, or run the
  digest-guarded delete flow.
- `hsapi_views_write`: create, update, replace a field, or run the
  digest-guarded delete flow.

Write tools return HSAPI's blocked delegated-command preview until
`confirmMutation: true`. Native Agent CLI `dryRun`, `digest`, and exact-name
confirmation inputs remain required where HubSpot requires them. The binary is
installed and updated separately; see
`docs/hubspot-api-context/agent-cli-bridge.md`.

Agent capability tools parse structured output once and do not echo the same
payload as raw stdout. Their default MCP result budget is 10 list items and
60,000 serialized characters. `maxResults`, `maxChars`, and
`includeTruncated` can adjust that envelope without changing the delegated
HubSpot command.

### Execute tools — read-only variants (`readOnlyHint: true` — always-approvable)

Use these for all read operations. They permanently block mutations and are safe to always-approve in any MCP client that respects `readOnlyHint`:

- `hsapi_command_execute_read`: run a catalog-backed typed command. Mutations are blocked with `mutation_not_allowed` — there is no `confirmMutation` escape hatch. An offline catalog fast path skips the preview round-trip for known-read commands.
- `hsapi_request_execute_read`: run a catalog-backed generic request. DELETE/PUT/PATCH and unsafe POST are blocked before any network call. GET/HEAD/OPTIONS always proceed; POST requires the endpoint to be catalog-marked `readOnly: true` (e.g. search endpoints).

### Execute tools — write variants (`readOnlyHint: false` — require per-call approval)

Use these only when you need to mutate data:

- `hsapi_command_execute`: run catalog-backed typed commands. Mutations return a blocked preview until `confirmMutation: true` is passed. Command-specific danger flags (e.g. `--danger-merge`) must still appear in `argv`.
- `hsapi_request_execute`: run catalog-backed generic requests. Same `confirmMutation` gate as above.

MCP input uses top-level fields for `portal`, `showRequest`, `confirmMutation`, compact output, projection, and limits; those flags are rejected if they are smuggled inside the raw command argv.

**Rule for agents:** default to the `_read` variants. Switch to the write variants only when you specifically need to create, update, or delete data — and always review the blocked preview before passing `confirmMutation: true`.

For a new connection, the assistant should call `hsapi_context_doc` with
`name: "portal-auth-setup"`, choose the ServiceKey, hosted OAuth, or combined
template, then run `hsapi_profiles_list` and `hsapi_auth_doctor`. Normal hosted
OAuth needs only `mode: "hosted_broker"` and an external token-cache path; the
CLI supplies the bundled broker URL. The assistant must not ask for a portal
ID, HubSpot client credential, or broker credential. It should have the user
run `hsapi auth login --portal <name>` in the local desktop environment, select
the intended account in HubSpot, and verify the returned `hub_id` binding with
`auth whoami` before starting normal MCP work. Login uses a short-lived
`127.0.0.1` listener and one-time completion grant, so the browser and CLI must
share the desktop's loopback interface. The guide is packaged locally;
MCP access is a convenience and does not require repository access.

The shared broker requires hsapi v0.5 or later. If an MCP host still has a
v0.4.x hosted installation, update the package and replace its old hosted
profile with the current template before running browser login.

## OpenClaw Config

OpenClaw manages outbound MCP definitions under `mcp.servers`. For a local stdio server, the relevant fields are `command`, optional `args`, `env`, and optional `cwd`.

Use `examples/mcp-server.sample.json` as a copy/paste starting point. It shows `portal-alpha` and `portal-beta` server entries that select separate portal profiles with `HSAPI_PORTAL` while sharing one private `HSAPI_PORTALS_CONFIG` file outside the package.

Keep token values out of the MCP config. The portal config should contain token environment variable names such as `HUBSPOT_ACCESS_TOKEN_PORTAL_ALPHA`, not token values. The runtime environment, wrapper command, OpenClaw-supported SecretRef surface, or another secret manager should inject the actual values.

Example OpenClaw command shape:

```bash
openclaw mcp set hubspot-portal-alpha '{"command":"hsapi-mcp","env":{"HSAPI_PORTALS_CONFIG":"/path/outside-package/hsapi/portals.json","HSAPI_PORTAL":"portal-alpha"}}'
```

OpenClaw's MCP registry command stores config only; it does not start the server or prove credentials resolve. After changing live OpenClaw MCP definitions, validate config with OpenClaw's native config commands and get operator approval before any Gateway restart.

## Generic MCP Clients

Most generic MCP clients use an `mcpServers` object:

```json
{
  "mcpServers": {
    "hubspot-portal-alpha": {
      "command": "hsapi-mcp",
      "env": {
        "HSAPI_PORTALS_CONFIG": "/path/outside-package/hsapi/portals.json",
        "HSAPI_PORTAL": "portal-alpha"
      }
    }
  }
}
```

If the client cannot inject secrets securely, use a wrapper command that loads credentials from the local secret manager and then execs `hsapi-mcp`. Do not place private app tokens, OAuth refresh tokens, client secrets, developer API keys, personal access keys, token caches, or local OpenClaw config contents in package files or client config committed to source control.

For copy/paste local setup on Codex Desktop or Claude Desktop, including Windows paths and multi-portal examples, see `docs/DESKTOP_MCP_QUICKSTART.md`.

## Neutral Token Source

Before replacing older HubSpot MCP entries with the CLI-backed MCP server, make local `hsapi` token loading independent of those entries. The neutral pattern is:

1. Keep a private `HSAPI_PORTALS_CONFIG` outside this package.
2. Store only profile names, portal metadata, cache paths, and credential
   environment variable names in that config. A normal hosted OAuth profile
   has no local credential env var.
3. Load ServiceKey or developer credential values through a local secret
   manager, OpenClaw-supported SecretRef wrapper, or another private injection
   command. Hosted OAuth access and refresh tokens remain in its protected
   external cache.
4. Start `hsapi` or `hsapi-mcp` through a wrapper that reads the needed env var names from `HSAPI_PORTALS_CONFIG` and exports values only for the child process.

Use `examples/portals.multi-portal.sample.json` as the ServiceKey profile-name
template. It preserves the `portal-alpha` and `portal-beta` profile names while
keeping token values out of the repo. Use
`examples/neutral-token-wrapper.sample.sh` as the wrapper template. The wrapper
calls `HSAPI_SECRET_LOOKUP_CMD <ENV_NAME>` for each missing credential
environment variable explicitly declared by selected profiles, including
ServiceKey `auth.portalBearer.tokenEnv` and local OAuth or developer credential
fields. Normal hosted OAuth declares none and needs no wrapper-loaded admission
credential. The lookup command is deliberately local and repo-external so it
can be backed by a password manager, an OpenClaw SecretRef command, a
locked-down file provider, or another operator-approved secret manager.

Direct CLI shape:

```bash
HSAPI_PORTALS_CONFIG=$HOME/.config/hsapi/portals.multi-portal.json \
HSAPI_NEUTRAL_TOKEN_PROFILES=portal-alpha,portal-beta \
HSAPI_SECRET_LOOKUP_CMD=$HOME/.local/bin/lookup-hsapi-secret \
$HOME/.local/bin/hsapi-neutral-token-wrapper hsapi profiles list
```

MCP client shape:

```json
{
  "mcpServers": {
    "hubspot-portal-alpha": {
      "command": "/path/outside-package/hsapi/neutral-token-wrapper",
      "args": ["hsapi-mcp"],
      "env": {
        "HSAPI_PORTALS_CONFIG": "/path/outside-package/hsapi/portals.multi-portal.json",
        "HSAPI_PORTAL": "portal-alpha",
        "HSAPI_NEUTRAL_TOKEN_PROFILES": "portal-alpha,portal-beta",
        "HSAPI_SECRET_LOOKUP_CMD": "/path/outside-package/hsapi/lookup-hsapi-secret"
      }
    }
  }
}
```

The lookup command must not read token values from the MCP server definitions being replaced. It should accept an env var name, write only the matching secret value to stdout, and avoid logging the value.

## Final OpenClaw Cutover

The final OpenClaw cutover runbook is `docs/OPENCLAW_MCP_CUTOVER.md`. It covers replacing two existing HubSpot MCP entries such as `hubspot-portal-alpha` and `hubspot-portal-beta`, validating candidate `openclaw mcp set <name> <JSON object>` payloads without applying live config, local and live MCP smoke tests, rollback, and the manual Gateway restart approval gate. The repo-safe cutover payload template is `examples/openclaw-cutover.mcp.sample.json`.

## Reversible Local Migration Runbook

This runbook prepares a local host for cutover without restarting Gateway or replacing live MCP server entries.

1. Record the current install state and save backups before editing local wrappers or private config:

```bash
mkdir -p $HOME/.local/state/hsapi
cp "$(command -v hsapi)" "$HOME/.local/state/hsapi/hsapi-wrapper.pre-neutral-token-source.$(date -u +%Y%m%dT%H%M%SZ)"
cp "$HSAPI_PORTALS_CONFIG" "$HSAPI_PORTALS_CONFIG.pre-neutral-token-source.$(date -u +%Y%m%dT%H%M%SZ)"
```

2. Copy `examples/portals.multi-portal.sample.json` to a private config path outside this package. Keep the `portal-alpha` and `portal-beta` profile names, fill in local portal metadata if desired, and keep only env var names in `auth.portalBearer.tokenEnv`.

3. Copy `examples/neutral-token-wrapper.sample.sh` to a private executable path outside this package. Point `HSAPI_SECRET_LOOKUP_CMD` at a local command that resolves `HUBSPOT_ACCESS_TOKEN_PORTAL_ALPHA` and `HUBSPOT_ACCESS_TOKEN_PORTAL_BETA` from the approved secret source. Do not print the token values while testing the lookup command.

4. Dry-run the wrapper so it proves which env vars it would load without asking for secret values:

```bash
HSAPI_PORTALS_CONFIG=$HOME/.config/hsapi/portals.multi-portal.json \
HSAPI_NEUTRAL_TOKEN_PROFILES=portal-alpha,portal-beta \
HSAPI_NEUTRAL_TOKEN_DRY_RUN=1 \
HSAPI_SECRET_LOOKUP_CMD=$HOME/.local/bin/lookup-hsapi-secret \
$HOME/.local/bin/hsapi-neutral-token-wrapper
```

5. Validate direct CLI behavior through the wrapper:

```bash
$HOME/.local/bin/hsapi-neutral-token-wrapper hsapi profiles list
$HOME/.local/bin/hsapi-neutral-token-wrapper hsapi account details --portal portal-alpha
$HOME/.local/bin/hsapi-neutral-token-wrapper hsapi account details --portal portal-beta
$HOME/.local/bin/hsapi-neutral-token-wrapper hsapi auth doctor --portal portal-alpha --require-env
$HOME/.local/bin/hsapi-neutral-token-wrapper hsapi auth doctor --portal portal-beta --require-env
```

6. Only after those checks pass, update local wrapper/MCP command references in an operator-approved change window. If anything fails, restore the backed-up wrapper and private portal config. Gateway restart or live MCP replacement is a separate cutover step and requires explicit operator approval.

## Local Checks

Run these checks before shipping MCP changes:

```bash
npm test
npm run release:gates
npm run pack:dry-run
```

`npm run release:gates` verifies that MCP server files and bin entries are packaged, MCP tool metadata and input schemas are sane, sample MCP config stays secret-free, and package dry-run output excludes local config or token-cache material.
