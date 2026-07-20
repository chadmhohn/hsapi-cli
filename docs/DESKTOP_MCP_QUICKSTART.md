# Desktop MCP Quickstart for Codex and Claude Desktop

This guide is for a person or AI agent setting up `hsapi-cli` from a checkout,
git install, or release tarball on a local desktop machine. It covers two MCP
clients:

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
git clone https://github.com/chadmhohn/hsapi-cli.git
cd hsapi-cli
npm install -g .
hsapi --help
command -v hsapi-mcp
```

On Windows PowerShell:

```powershell
git clone https://github.com/chadmhohn/hsapi-cli.git
cd hsapi-cli
npm install -g .
hsapi --help
where.exe hsapi-mcp
```

If a desktop MCP client cannot find `hsapi-mcp`, use the full path printed by `command -v hsapi-mcp` or `where.exe hsapi-mcp` in that client's MCP config.

A checked GitHub Release tarball can also be downloaded with `curl` and
installed globally; see `docs/INSTALL.md`. If the client intentionally uses an
ephemeral npm launch, pin a reviewed tag:

```bash
npx --yes --package=github:chadmhohn/hsapi-cli#v<released-version> hsapi-mcp
```

In Claude Desktop JSON, the equivalent process definition is:

```json
{
  "command": "npx",
  "args": [
    "--yes",
    "--package=github:chadmhohn/hsapi-cli#v<released-version>",
    "hsapi-mcp"
  ],
  "env": {
    "HSAPI_PORTALS_CONFIG": "/absolute/path/outside-package/hsapi/portals.json",
    "HSAPI_PORTAL": "service-key-example"
  }
}
```

On Windows, use `npx.cmd` if the desktop process cannot resolve `npx`. There is
no bare `npx hsapi-cli` command until this project has a registry release.
Global installation from a reviewed release tarball remains the recommended
long-running desktop setup.

## 2. Create a Private Portal Config

Read `docs/hubspot-api-context/portal-auth-setup.md`, then choose the smallest
template for the intended auth:

- ServiceKey/private-app only: `examples/portals.sample.json`
- Hosted OAuth only: `examples/portals.oauth-hosted.sample.json`
- Hosted OAuth plus an approved ServiceKey:
  `examples/portals.oauth-service-key.sample.json`

The commands below use the ServiceKey template. `ServiceKey` maps to
`auth.portalBearer` and is a HubSpot private-app access token.

Create a config directory outside the repo, then copy the selected sample. The
relative commands below are for a checkout. After a global install, run
`hsapi --help` and substitute the absolute installed template path it prints.

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
  "default": "service-key-example",
  "portals": {
    "service-key-example": {
      "label": "Example HubSpot Portal",
      "baseUrl": "https://api.hubapi.com",
      "auth": {
        "defaultFamily": "portal_bearer",
        "portalBearer": {
          "tokenEnv": "HUBSPOT_SERVICE_KEY_EXAMPLE",
          "kind": "private_app"
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
export HUBSPOT_SERVICE_KEY_EXAMPLE="<set-locally-from-your-secret-channel>"
```

Windows PowerShell user environment example:

```powershell
[Environment]::SetEnvironmentVariable('HSAPI_PORTALS_CONFIG', "$env:USERPROFILE\.config\hsapi\portals.json", 'User')
[Environment]::SetEnvironmentVariable('HUBSPOT_SERVICE_KEY_EXAMPLE', '<set-locally-from-your-secret-channel>', 'User')
```

Safer shared/operator path: use a wrapper or secret lookup command so MCP
config never stores real tokens or broker admission credentials. The supplied
wrapper loads both ServiceKey `tokenEnv` and hosted OAuth `brokerStartKeyEnv`
values declared by the selected profile. See
`examples/neutral-token-wrapper.sample.sh` and the neutral credential source
section in `docs/MCP.md`.

After changing user environment variables, restart terminals and fully restart Codex Desktop or Claude Desktop.

For hosted OAuth, copy `examples/portals.oauth-hosted.sample.json`, replace
every `REPLACE_...` value with the exact metadata issued by the app operator,
and inject only the broker start credential locally. Do not configure a local
HubSpot client ID or client secret. After the doctor check, run:

```bash
hsapi auth login --portal oauth-hosted-example
hsapi auth whoami --portal oauth-hosted-example
```

## 4. Verify the CLI Before MCP

Run these from a fresh terminal that can see the persistent environment variables.

macOS/Linux:

```bash
export HSAPI_PORTALS_CONFIG="$HOME/.config/hsapi/portals.json"
hsapi profiles list
hsapi auth doctor --portal service-key-example --require-env
hsapi account details --portal service-key-example --show-request
```

Windows PowerShell:

```powershell
$env:HSAPI_PORTALS_CONFIG = "$env:USERPROFILE\.config\hsapi\portals.json"
hsapi profiles list
hsapi auth doctor --portal service-key-example --require-env
hsapi account details --portal service-key-example --show-request
```

`--show-request` must show redacted credential source names, not token values.

## 5. Codex Desktop Quickstart

Codex reads MCP servers from its Codex MCP config. Use `codex mcp add` when the Codex CLI is available on the same machine as Codex Desktop.

macOS/Linux example:

```bash
codex mcp add hubspot-service-key-example \
  --env HSAPI_PORTALS_CONFIG="$HOME/.config/hsapi/portals.json" \
  --env HSAPI_PORTAL=service-key-example \
  -- hsapi-mcp

codex mcp list
```

Windows PowerShell example:

```powershell
codex mcp add hubspot-service-key-example `
  --env "HSAPI_PORTALS_CONFIG=$env:USERPROFILE\.config\hsapi\portals.json" `
  --env "HSAPI_PORTAL=service-key-example" `
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
Use the HubSpot MCP server only. Read portal-auth-setup, then run auth doctor for the service-key-example profile and summarize whether it is configured without printing secrets.
```

Expected tool groups use the normalized MCP server entry name, such as
`mcp__hubspot_service_key_example__...`.

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
    "hubspot-service-key-example": {
      "command": "hsapi-mcp",
      "env": {
        "HSAPI_PORTALS_CONFIG": "/Users/you/.config/hsapi/portals.json",
        "HSAPI_PORTAL": "service-key-example"
      }
    }
  }
}
```

Windows example:

```json
{
  "mcpServers": {
    "hubspot-service-key-example": {
      "command": "C:\\Users\\you\\AppData\\Roaming\\npm\\hsapi-mcp.cmd",
      "env": {
        "HSAPI_PORTALS_CONFIG": "C:\\Users\\you\\.config\\hsapi\\portals.json",
        "HSAPI_PORTAL": "service-key-example"
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

## 7. Desktop, Sandboxed, and Remote Agent Boundaries

The JSON examples in section 6 configure a local stdio MCP server in Claude
Desktop. The process runs on the user's machine and can read the approved local
environment and external portal config.

Do not assume that the same local server is available in every Claude surface.
Anthropic currently documents local `claude_desktop_config.json` servers as a
Claude Desktop-only mechanism; they are not available in Cowork or claude.ai.
Those surfaces require a separately hosted remote MCP server and remote
connector. This package does not currently deploy that remote transport:
https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp

Claude Desktop also supports installable desktop extensions. This package
currently documents the explicit local JSON process configuration so its
executable, profile path, and auth behavior remain inspectable; it does not yet
ship an `.mcpb` desktop-extension bundle.

For another sandboxed agent product, first verify whether its client can spawn
a host-side stdio MCP server. If it cannot, deploy an approved remote MCP
transport instead of copying the local JSON shape into the sandbox. Never make
the task sandbox itself the secret store.

### What the MCP subprocess test established (validated 2026-06-10)

A scripted eight-message MCP conversation with a fake token injected only via
child-process environment established the server's output and mutation
boundaries:

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
3. Their intended local profile names; for hosted OAuth, the exact portal ID
   and broker URL issued by the app operator.
4. The credential env var names they should place in their private `portals.json`.
5. Instructions for their approved secret source.

Do not send token values through GitHub, MCP config, chat transcripts, screenshots, or committed files.
