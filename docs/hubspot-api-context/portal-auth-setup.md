# Portal Profile Setup for Users and AI Assistants

This is the canonical, portal-neutral onboarding guide for `hsapi`. It applies
to direct CLI use and to assistants connected through `hsapi-mcp`.

The package contains templates, instructions, and the public default hosted
broker location only. It contains no real portal profile, portal ID, token,
client secret, or customer data. Real profiles and token caches stay outside
the installed package.

## How an assistant finds this guide

- Downloaded checkout: start with `AGENTS.md`, `CLAUDE.md`, or `README.md`.
- Global git/tarball install: run `hsapi --help`; it prints absolute installed
  paths for this guide and the minimal templates.
- Claude Desktop or Codex Desktop: follow
  `docs/DESKTOP_MCP_QUICKSTART.md`.
- MCP-only connection: call `hsapi_context_doc` with
  `name: "portal-auth-setup"`.
- Pinned `npx`/`npm exec` launch: the same guide is packaged and available
  through the MCP context tool. Pin a reviewed tag or commit.

Supported checkout, git-ref, curl/tarball, and pinned npm-exec installation
shapes are documented in `docs/INSTALL.md`. A bare package-name `npx` flow is
not available until a registry release exists.

## Terms and auth choices

| Team or HubSpot term | HSAPI profile | Use it for |
| --- | --- | --- |
| ServiceKey, private-app access token, static app token | `auth.portalBearer` | A scoped non-user credential for one HubSpot account |
| Hosted user OAuth | `auth.oauth.mode: "hosted_broker"` | The normal team browser-login flow; the HubSpot client secret stays server-side |
| Local OAuth | `auth.oauth.mode: "local"` | App operators, development, and recovery only |
| Developer credentials | `auth.developer` | Explicit HubSpot developer/app-management endpoints, not normal portal API calls |

`ServiceKey` is a team-facing name for a HubSpot private-app access token. In
HSAPI it always maps to `auth.portalBearer.tokenEnv`. The environment variable
name is arbitrary; the supplied template uses `HUBSPOT_SERVICE_KEY_EXAMPLE`.
The secret value never belongs in `portals.json`.

HSAPI selects the credential family declared by each endpoint. It never retries
an OAuth failure with a stronger ServiceKey and never treats a developer
credential as a portal token.

## Assistant safety rules

An assistant helping with setup must:

1. Ask which supported auth path the operator intends: ServiceKey, hosted
   OAuth, or a deliberately combined profile.
2. Gather only non-secret metadata in chat: a local profile name, a label, and
   the environment-variable names that will hold explicitly configured
   credentials. Normal hosted OAuth needs no credential environment variable,
   portal ID, or broker URL from the user.
3. Never ask the user to paste a token, client secret, authorization code, or
   token-cache contents into chat.
4. Tell the user to inject secret values locally through their environment,
   password manager, SecretRef, wrapper, or other approved secret channel.
5. Create or edit only the external user config. Never put a real profile in
   the package or repository.
6. Run `auth doctor` before live calls and use `--show-request` before an
   unfamiliar operation.
7. For hosted OAuth, let HubSpot present the account chooser. Verify the
   returned `hub_id` with `auth whoami`; do not infer an account from an email
   domain, browser session, profile label, or previous setup.
8. Treat `portalId` only as an optional expected-account pin and `brokerUrl`
   only as an optional trusted private-broker override. Never invent either.
9. Before combining a ServiceKey with OAuth, verify independently that the
   ServiceKey account identity matches the OAuth `hub_id`.

For MCP-only assistants, call `hsapi_context_doc` with
`name: "portal-auth-setup"` whenever a profile is missing or authentication
onboarding is requested.

## Choose one template

| Intended setup | Template |
| --- | --- |
| ServiceKey/private-app only | `examples/portals.sample.json` |
| Hosted user OAuth only | `examples/portals.oauth-hosted.sample.json` |
| Hosted OAuth plus an explicitly authorized ServiceKey | `examples/portals.oauth-service-key.sample.json` |

Do not combine every auth family by default. A profile should declare only the
credentials the operator has intentionally provisioned.

## External config location

The normal per-user config is:

- macOS/Linux: `~/.config/hsapi/portals.json`
- Windows: `%USERPROFILE%\.config\hsapi\portals.json`

`HSAPI_PORTALS_CONFIG` can point to another private external path and always
takes precedence. Installs and upgrades never create, download, or overwrite
the config. Copying a template creates only an unbound local profile; hosted
OAuth binds the HubSpot-selected account in the external token cache after a
successful login.

From a checkout, copy the chosen relative template. The commands below show
the ServiceKey filename; substitute the hosted or combined filename when that
is the selected auth path:

```bash
mkdir -p "$HOME/.config/hsapi"
cp examples/portals.sample.json "$HOME/.config/hsapi/portals.json"
export HSAPI_PORTALS_CONFIG="$HOME/.config/hsapi/portals.json"
```

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\hsapi" | Out-Null
Copy-Item examples\portals.sample.json "$env:USERPROFILE\.config\hsapi\portals.json"
$env:HSAPI_PORTALS_CONFIG = "$env:USERPROFILE\.config\hsapi\portals.json"
```

The absolute installed guide and template paths are printed by `hsapi --help`
and by the missing-config error. After a global git or tarball install, copy
one of those printed absolute template paths instead of assuming the current
directory contains `examples/`.

## ServiceKey/private-app setup

Use `examples/portals.sample.json`. It is intentionally minimal:

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

Rename the profile and environment variable if desired. Then inject the token
value locally:

```bash
export HUBSPOT_SERVICE_KEY_EXAMPLE="<set-locally-from-your-secret-channel>"
```

```powershell
$env:HUBSPOT_SERVICE_KEY_EXAMPLE = "<set-locally-from-your-secret-channel>"
```

If the operator does not already have a ServiceKey, an authorized HubSpot
administrator must create or open a private app, choose the least-privilege
scopes required by the intended commands, and deliver its access token through
an approved secret channel. HubSpot's current private-app guidance is:
https://developers.hubspot.com/docs/apps/legacy-apps/private-apps/build-with-projects/create-private-apps-with-projects

Validate without sending a live request:

```bash
hsapi profiles list
hsapi auth doctor --portal service-key-example --require-env
hsapi account details --portal service-key-example --show-request
```

After reviewing the redacted preview, verify the live identity with the
read-only account-details call:

```bash
hsapi account details --portal service-key-example
```

Confirm the returned account is the intended portal before other work.

## Hosted OAuth setup

Use `examples/portals.oauth-hosted.sample.json`. Normal hosted OAuth needs only:

- `mode: "hosted_broker"`;
- a unique per-user token-cache path outside the package.

The CLI uses its bundled default broker. Do not add a broker credential, local
HubSpot client ID, client secret, redirect URL, scope list, or portal ID. The
browser sends the user to HubSpot's account chooser, and the returned `hub_id`
binds an unpinned token cache.

The shared broker accepts only the native localhost-completion protocol used by
hsapi v0.5 and later. If the installed CLI is v0.4.x, update it and replace the
old hosted profile with this current template before browser login.

Two optional restrictions are available:

- Add a top-level numeric `portalId` only when the operator intentionally wants
  to pin the profile to an expected HubSpot account before login.
- Add `auth.oauth.brokerUrl` only to override the bundled broker with a trusted
  HTTPS private deployment.

Never invent or scrape an optional pin or broker override.

For an MCP-only assistant that cannot read other package files, this is the
complete hosted template:

```json
{
  "default": "oauth-hosted-example",
  "portals": {
    "oauth-hosted-example": {
      "label": "Example HubSpot Portal with Hosted OAuth",
      "baseUrl": "https://api.hubapi.com",
      "auth": {
        "defaultFamily": "oauth",
        "oauth": {
          "mode": "hosted_broker",
          "tokenCachePath": "~/.config/hsapi/oauth/oauth-hosted-example-token-cache.json"
        }
      }
    }
  }
}
```

Validate and authorize:

```bash
hsapi profiles list
hsapi auth doctor --portal oauth-hosted-example
hsapi auth login --portal oauth-hosted-example
hsapi auth whoami --portal oauth-hosted-example
```

During `auth login`, the CLI opens HubSpot's account chooser and starts a
short-lived listener on `127.0.0.1`. The broker redirects the browser to that
listener with a single-use completion proof tied to the login state; the CLI
does not exchange tokens until it validates that localhost handoff.

The first successful unpinned login records the returned `hub_id` as the cache
binding. Later login, refresh, and cache use reject a different HubSpot account.
If the optional profile `portalId` is present, the first login must match it
too. `auth whoami` reports whether the account ID came from the profile pin or
the OAuth token cache.

HubSpot still applies the installing user's permissions, app scopes, endpoint
token-type restrictions, and product entitlements. Current OAuth token
management reference:
https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens

## Combined OAuth and ServiceKey setup

Use `examples/portals.oauth-service-key.sample.json` only when the operator has
approved both credentials. OAuth remains the default user identity.
`portalBearer` is available only for cataloged operations that require a
non-user/admin token. The ServiceKey must be provisioned explicitly; hosted
OAuth never creates, requests, or silently substitutes one.

For an MCP-only assistant, this is the complete combined template:

```json
{
  "default": "oauth-and-service-key-example",
  "portals": {
    "oauth-and-service-key-example": {
      "label": "Example HubSpot Portal",
      "baseUrl": "https://api.hubapi.com",
      "auth": {
        "defaultFamily": "oauth",
        "oauth": {
          "mode": "hosted_broker",
          "tokenCachePath": "~/.config/hsapi/oauth/oauth-and-service-key-example-token-cache.json"
        },
        "portalBearer": {
          "tokenEnv": "HUBSPOT_SERVICE_KEY_EXAMPLE",
          "kind": "private_app"
        }
      }
    }
  }
}
```

Inject only the ServiceKey through its declared environment variable. Never
use the HubSpot app client secret as a ServiceKey.

Before adding the ServiceKey to a combined profile, verify it independently
with a temporary ServiceKey-only profile and the read-only `account details`
call. Its returned portal ID must equal the OAuth `hub_id` reported by
`auth whoami`. Do not infer identity from the environment-variable name, and
do not combine credentials that resolve to different accounts.

Validate every configured family:

```bash
hsapi auth doctor --portal oauth-and-service-key-example --require-env
hsapi auth login --portal oauth-and-service-key-example
hsapi auth whoami --portal oauth-and-service-key-example
hsapi account details --portal oauth-and-service-key-example --show-request
```

Use `hsapi catalog commands --pick
commands[].command,commands[].auth.family,commands[].auth.subtype` or the MCP
catalog tool to inspect which credential family an operation requires.

## MCP configuration

The MCP client should pass:

- `HSAPI_PORTALS_CONFIG`: the private external config path;
- `HSAPI_PORTAL`: the default profile for that MCP server entry;
- access to the approved local secret-injection mechanism when the selected
  profile explicitly declares a ServiceKey, local OAuth, or developer
  credential.

Do not put secret values or token caches in MCP client JSON. Desktop apps often
need a full restart after environment or MCP configuration changes.

Saved-report and CRM saved-view tools are an optional first-party bridge, not
another HSAPI auth family. Read `agent-cli-bridge` through `hsapi_context_doc`,
then run `hsapi_agent_cli_doctor` for the selected portal. HubSpot Agent CLI
OAuth has a separate single-account cache; HSAPI verifies that account against
the profile or HSAPI OAuth-cache binding before delegation. An optional
`agentCli.authMode` profile field can select `oauth` or `service-key`; an MCP
`authMode` or CLI `--agent-auth` value overrides it. Select ServiceKey mode
explicitly in one of those places—never configure or use it as an automatic
OAuth fallback.

Start with these read-only MCP tools:

1. `hsapi_context_doc` with `name: "portal-auth-setup"`;
2. `hsapi_profiles_list`;
3. `hsapi_auth_doctor` (`requireEnv: false` for hosted OAuth; `true` when the
   profile declares a ServiceKey or other local credential);
4. after the user completes browser login, `hsapi_command_execute_read` for a
   bounded identity check.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| No config found | Read the absolute guide/template paths in the error, copy one template externally, and set `HSAPI_PORTALS_CONFIG` if not using the default |
| ServiceKey env missing | Set the environment variable named by `auth.portalBearer.tokenEnv`; do not put the value in JSON |
| Optional hosted `portalId` rejected | Remove it for account-chooser login, or replace it with the exact numeric expected account ID |
| Private `brokerUrl` rejected | Remove it to use the bundled broker, or use the exact trusted HTTPS override supplied by the private-broker operator |
| Browser cannot complete login | Ensure the local process can listen on `127.0.0.1`, keep the CLI running, and retry so a fresh completion proof is issued |
| Browser selects the wrong account on first login | Run `auth logout`, select the intended account, and log in again |
| Selected account differs from an existing binding | Use the already-bound account or create a separate profile and token-cache path; HSAPI will not silently rebind the cache |
| ServiceKey and OAuth identities differ | Do not combine them; provision a ServiceKey from the OAuth-bound HubSpot account |
| OAuth endpoint rejects user tokens | Do not add scopes blindly or silently fall back; inspect the endpoint auth metadata and use an approved combined profile only if required |
| MCP still sees old values | Fully restart the desktop/client process after updating its environment |
