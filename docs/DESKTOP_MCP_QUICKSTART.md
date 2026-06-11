# Desktop MCP Quickstart for Codex and Claude Desktop

This guide is for a person or AI agent setting up `hsapi-cli` from a shared GitHub checkout on a local desktop machine. It covers two MCP clients:

- Codex Desktop / Codex CLI MCP config
- Claude Desktop MCP config

The same installed package provides both surfaces:

- CLI: `hsapi ...`
- MCP server: `hsapi-mcp` or `hsapi mcp serve`

## Security Model

Do not put HubSpot tokens, OAuth refresh tokens, client secrets, developer API keys, personal access keys, token caches, or real customer data in this repo or in committed config files.

Use this shape instead:

1. Copy a sample portal config to a private path outside the repo.
2. Store only environment variable names in that private portal config.
3. Provide actual credential values through the local user environment, a password manager, a local secret lookup wrapper, or another private secret manager.
4. Register one MCP server entry per portal profile and pass `HSAPI_PORTAL` for that entry.

Desktop apps often do not inherit the terminal environment that installed the package. After changing persistent environment variables or MCP config, fully quit and restart the desktop app.

## 1. Install From GitHub

From a checkout:

```bash
git clone git@github.com:your-org/hsapi-cli.git
cd hsapi-cli
npm install -g .
hsapi --help
command -v hsapi-mcp
```

On Windows PowerShell:

```powershell
git clone git@github.com:your-org/hsapi-cli.git
cd hsapi-cli
npm install -g .
hsapi --help
where.exe hsapi-mcp
```

If a desktop MCP client cannot find `hsapi-mcp`, use the full path printed by `command -v hsapi-mcp` or `where.exe hsapi-mcp` in that client's MCP config.

## 2. Create a Private Portal Config

Create a config directory outside the repo, then copy a sample.

macOS/Linux:

```bash
mkdir -p "$HOME/.config/hsapi"
cp examples/portals.sample.json "$HOME/.config/hsapi/portals.json"
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\hsapi" | Out-Null
Copy-Item examples\portals.sample.json "$env:USERPROFILE\.config\hsapi\portals.json"
```

Edit the private `portals.json`. Keep credential values out of the file. The important fields are the profile name and credential env var name:

```json
{
  "default": "example",
  "portals": {
    "example": {
      "label": "Example HubSpot Portal",
      "portalId": "<example-portal-id>",
      "baseUrl": "https://api.hubapi.com",
      "auth": {
        "defaultFamily": "portal_bearer",
        "portalBearer": {
          "tokenEnv": "HUBSPOT_ACCESS_TOKEN_EXAMPLE"
        }
      }
    }
  }
}
```

For multiple portals, use separate profile names such as `portal-alpha`, `portal-beta`, or a client slug. `examples/portals.multi-portal.sample.json` shows the multi-portal pattern.

## 3. Provide Credentials Locally

Quick private-machine path: set a persistent local user environment variable matching the `tokenEnv` from the portal config.

macOS/Linux shell profile example:

```bash
export HSAPI_PORTALS_CONFIG="$HOME/.config/hsapi/portals.json"
export HUBSPOT_ACCESS_TOKEN_EXAMPLE="<your-private-app-token>"
```

Windows PowerShell user environment example:

```powershell
[Environment]::SetEnvironmentVariable('HSAPI_PORTALS_CONFIG', "$env:USERPROFILE\.config\hsapi\portals.json", 'User')
[Environment]::SetEnvironmentVariable('HUBSPOT_ACCESS_TOKEN_EXAMPLE', '<your-private-app-token>', 'User')
```

Safer shared/operator path: use a wrapper or secret lookup command so MCP config never stores real tokens. See `examples/neutral-token-wrapper.sample.sh` and the neutral token source section in `docs/MCP.md`.

After changing user environment variables, restart terminals and fully restart Codex Desktop or Claude Desktop.

## 4. Verify the CLI Before MCP

Run these from a fresh terminal that can see the persistent environment variables.

macOS/Linux:

```bash
export HSAPI_PORTALS_CONFIG="$HOME/.config/hsapi/portals.json"
hsapi profiles list
hsapi auth doctor --portal example --require-env
hsapi account details --portal example --show-request
```

Windows PowerShell:

```powershell
$env:HSAPI_PORTALS_CONFIG = "$env:USERPROFILE\.config\hsapi\portals.json"
hsapi profiles list
hsapi auth doctor --portal example --require-env
hsapi account details --portal example --show-request
```

`--show-request` must show redacted credential source names, not token values.

## 5. Codex Desktop Quickstart

Codex reads MCP servers from its Codex MCP config. Use `codex mcp add` when the Codex CLI is available on the same machine as Codex Desktop.

macOS/Linux example:

```bash
codex mcp add hubspot-example \
  --env HSAPI_PORTALS_CONFIG="$HOME/.config/hsapi/portals.json" \
  --env HSAPI_PORTAL=example \
  -- hsapi-mcp

codex mcp list
```

Windows PowerShell example:

```powershell
codex mcp add hubspot-example `
  --env "HSAPI_PORTALS_CONFIG=$env:USERPROFILE\.config\hsapi\portals.json" `
  --env "HSAPI_PORTAL=example" `
  -- hsapi-mcp

codex mcp list
```

If `hsapi-mcp` is not on the desktop app's PATH, use the full executable path after `--`. On Windows this is often an npm shim path ending in `hsapi-mcp.cmd`.

For two portals, register two server entries with different names and `HSAPI_PORTAL` values:

```bash
codex mcp add hubspot-portal-alpha --env HSAPI_PORTALS_CONFIG="$HOME/.config/hsapi/portals.json" --env HSAPI_PORTAL=portal-alpha -- hsapi-mcp
codex mcp add hubspot-portal-beta --env HSAPI_PORTALS_CONFIG="$HOME/.config/hsapi/portals.json" --env HSAPI_PORTAL=portal-beta -- hsapi-mcp
```

Fully restart Codex Desktop after adding or changing MCP servers. Then ask Codex to use the HubSpot MCP tool surface, for example:

```text
Use the HubSpot MCP server only. Run auth doctor for the example portal and summarize whether it is configured without printing secrets.
```

Expected tool groups are named like `mcp__hubspot_example__...` or, for custom entry names, the normalized server name.

## 6. Claude Desktop Quickstart

Open Claude Desktop's MCP config from the app settings when available, or edit the config file directly.

Common config paths:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Use full paths if Claude Desktop cannot resolve `hsapi-mcp` from PATH.

macOS/Linux-style example:

```json
{
  "mcpServers": {
    "hubspot-example": {
      "command": "hsapi-mcp",
      "env": {
        "HSAPI_PORTALS_CONFIG": "/Users/you/.config/hsapi/portals.json",
        "HSAPI_PORTAL": "example"
      }
    }
  }
}
```

Windows example:

```json
{
  "mcpServers": {
    "hubspot-example": {
      "command": "C:\\Users\\you\\AppData\\Roaming\\npm\\hsapi-mcp.cmd",
      "env": {
        "HSAPI_PORTALS_CONFIG": "C:\\Users\\you\\.config\\hsapi\\portals.json",
        "HSAPI_PORTAL": "example"
      }
    }
  }
}
```

Multi-portal Claude Desktop example:

```json
{
  "mcpServers": {
    "hubspot-portal-alpha": {
      "command": "hsapi-mcp",
      "env": {
        "HSAPI_PORTALS_CONFIG": "/Users/you/.config/hsapi/portals.json",
        "HSAPI_PORTAL": "portal-alpha"
      }
    },
    "hubspot-portal-beta": {
      "command": "hsapi-mcp",
      "env": {
        "HSAPI_PORTALS_CONFIG": "/Users/you/.config/hsapi/portals.json",
        "HSAPI_PORTAL": "portal-beta"
      }
    }
  }
}
```

Fully quit and restart Claude Desktop after editing the file. Then ask Claude to run `hsapi_auth_doctor` through the HubSpot MCP server and summarize only status fields.

## 7. Sandboxed Agent Runtimes (Claude Cowork, Codex Cloud)

Agent products that run tasks inside an isolated sandbox still use the same pattern, with one nuance: the MCP server is spawned by the *client* (host side), not inside the task sandbox.

- **Claude Cowork:** configure `hsapi-mcp` as a custom connector in the Claude desktop app config (same JSON shape as Claude Desktop in section 6). The server process runs host-side where the configured `env` applies; the agent's Linux sandbox only sees tool calls and tool results, never the environment. Scheduled/automated Cowork tasks therefore also reach HubSpot through the connector, even though the sandbox itself has no credentials.
- **Codex (cloud sandbox):** same `mcpServers` shape in the Codex config. If the runtime cannot inject env securely, point `command` at the neutral-token wrapper (`examples/neutral-token-wrapper.sample.sh`) so token values come from a local secret lookup command instead of config.

### What this isolation guarantees (validated 2026-06-10)

A scripted validation run inside a Cowork Linux sandbox (results on issue #29) drove an 8-message MCP conversation with a fake token injected only via child-process env:

- zero occurrences of the token value in any stdout/stderr; only env var *names* and `Bearer $ENV_NAME` placeholders appear in previews
- `tokenPresent: true` confirms the env was seen without exposing it
- mutations without `confirmMutation` return blocked previews; `--show-secrets` smuggled inside argv is rejected; absolute URLs on non-portal origins are refused before any credential attaches
- with no token set, failures are structured and name only the env var
- the full test suite runs green with no HubSpot credentials at all (mock-server fixtures), so agents can develop against this repo with no secret present anywhere

The takeaway for repo work: tokens live only in client-side env injection or a wrapper-backed secret lookup. The repo, the portals config, MCP client config committed nowhere, and every tool output stay token-free.

## 8. Troubleshooting

- No MCP tools appear: restart the desktop app, then confirm the MCP server entry exists in the client config and `hsapi-mcp` can be resolved by full path.
- MCP server starts but auth fails: run `hsapi auth doctor --portal <name> --require-env` in a fresh terminal. The desktop app may not inherit your shell-only env vars.
- Wrong portal is used: check `HSAPI_PORTAL` in that MCP server entry and the `default` profile in `HSAPI_PORTALS_CONFIG`.
- Token value appears in output: stop and rotate the token. File an issue with the command and redacted reproduction steps.
- Codex/OpenClaw-style clients time out on MCP startup: make sure the installed package includes newline-delimited MCP stdio support. `npm test` includes a regression for this.

## 9. Sharing Checklist

When sharing the repo with another user or agent, give them:

1. GitHub repo access.
2. This quickstart.
3. Their portal names and portal IDs.
4. The credential env var names they should place in their private `portals.json`.
5. Instructions for their approved secret source.

Do not send token values through GitHub, MCP config, chat transcripts, screenshots, or committed files.
