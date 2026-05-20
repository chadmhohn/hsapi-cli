# Install and Update

`hsapi-cli` is meant to be installed like a product build, not executed only from a raw source tree.

## Install

From a checkout:

```bash
npm install -g .
```

From a git ref:

```bash
npm install -g git+ssh://git@github.com/your-org/hsapi-cli.git#<tag-or-branch>
```

From a release tarball:

```bash
npm install -g ./hsapi-cli-<version>.tgz
```

## Update

Update by reinstalling the newer tag, branch, or tarball. That keeps the same command surface while replacing the package contents.

Once the package is distributed through a registry, standard npm updates can be used:

```bash
npm update -g hsapi-cli
```

## Verify

After install or update:

```bash
hsapi --help
hsapi profiles list
hsapi auth doctor --portal example
hsapi account details --portal example --show-request
command -v hsapi-mcp
```

## Configure Auth Families

Copy `examples/portals.sample.json` to a private path outside the package, then set `HSAPI_PORTALS_CONFIG` to that private file. Keep only environment variable names in JSON; put credential values in your shell, secret manager, or CI secret store.

`hsapi` uses explicit auth families:

| Auth family | Profile fields | Typical commands |
| --- | --- | --- |
| `portal_bearer` | `auth.portalBearer.tokenEnv` or legacy `tokenEnv` | CRM, CMS, files, properties, associations, account details, most account-scoped typed commands |
| `oauth` | `auth.oauth.clientIdEnv`, `auth.oauth.clientSecretEnv`, `auth.oauth.refreshTokenEnv`, `auth.oauth.tokenCachePath` | OAuth-installed-app endpoints and `hsapi auth token|refresh|introspect|revoke` helpers |
| `developer/personal_access_key` | `auth.developer.personalAccessKeyEnv` | Developer-tooling surfaces that explicitly require a personal access key |
| `developer/developer_api_key` | `auth.developer.developerApiKeyEnv`, sometimes `auth.developer.appIdEnv` | Classic app webhooks and app-management endpoints documented with `hapikey` |
| `developer/client_credentials` | `auth.developer.clientIdEnv`, `auth.developer.clientSecretEnv`, `auth.developer.tokenCachePath` | App-level developer APIs such as Webhooks Journal |

Run `hsapi auth doctor --portal <name>` after editing a profile. It validates profile fields, reports missing credential environment variables, and checks that OAuth/developer token-cache paths live outside the package without printing secret values or making HubSpot calls. Add `--require-env` when the command should fail if configured credential env vars are not set.

Before running an unfamiliar command, inspect its auth requirement:

```bash
hsapi catalog commands --pick commands[].command,commands[].auth.family,commands[].auth.subtype
hsapi <command> --show-request
```

`--show-request` prints `authFamily`, `authSubtype`, scopes, and redacted credential source names before any request is sent.

## CMS vs HubSpot Projects Auth

CMS REST API commands use `hsapi --portal <profile>` and the selected portal profile auth, usually `portal_bearer`. HubSpot Projects and local developer workflows remain official HubSpot CLI workflows:

```bash
hs project list --account <account>
```

`hsapi` must not silently consume `~/.hscli/config.yml`, HubSpot CLI personal access keys, or pasted secrets as portal credentials. If CMS commands work in `hsapi` but project commands fail in `hs`, fix the HubSpot CLI account/auth setup. If `hs project ...` works but `hsapi` CMS commands fail, fix the `hsapi` portal token, scopes, or portal feature access. Use `docs/CMS_PROJECTS_AUTH_BOUNDARY.md` as the operational boundary.

For CMS capability mismatches, run `hsapi cms doctor --portal <profile>` first. The diagnostic is read-only and reports representative CMS REST surfaces, redacted auth provenance, and whether failures look like missing scopes/permissions, unavailable account features, or unexpected API failures.

## MCP Server Mode

Direct CLI mode is the default operator surface: run `hsapi ...` directly from a shell, script, or agent runtime that is allowed to execute commands. MCP server mode is for OpenClaw or another MCP client: the client starts `hsapi-mcp` or `hsapi mcp serve` over stdio and calls the exposed tools.

Both modes share the same portal config and safety model. Keep `HSAPI_PORTALS_CONFIG` pointed at a private file outside the package. Use `HSAPI_PORTAL` when a specific MCP server entry should default to one portal profile, such as separate `portal-alpha` and `portal-beta` entries.

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

Do not embed HubSpot tokens or token-cache files in MCP config. Use environment injection, OpenClaw-supported SecretRefs, a wrapper command, or another secret manager. See `docs/MCP.md` and `examples/mcp-server.sample.json` for the full OpenClaw and generic MCP client examples.

For multi-portal cutover prep, `docs/MCP.md` also includes a neutral token-source runbook. That flow preserves the `portal-alpha` and `portal-beta` profile names while moving token lookup into a repo-external secret lookup command instead of depending on older HubSpot MCP entries.

For local Codex Desktop or Claude Desktop setup from a GitHub checkout, use `docs/DESKTOP_MCP_QUICKSTART.md`. It includes Windows, macOS/Linux, multi-portal, and secret-handling examples.

## Agent Entry Points

Automated agents should also read `AGENTS.md` and `CLAUDE.md`.
