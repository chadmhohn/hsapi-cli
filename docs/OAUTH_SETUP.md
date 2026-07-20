# HSAPI CLI — OAuth Setup Guide

For the portal-profile decision tree used by people and assistants, start with
`docs/hubspot-api-context/portal-auth-setup.md` (or
`hsapi_context_doc` name `portal-auth-setup` through MCP). This guide focuses
on OAuth broker setup and operations.

## What this gives you

Each teammate authorizes the shared HubSpot app in a browser. `hsapi` then acts
with that user's HubSpot identity and permissions. The normal hosted flow does
not require a teammate to receive the HubSpot client secret or a private-app
token.

OAuth is not an elevation path. HubSpot still applies the installing user's
permissions, the app's granted scopes, user-level-app endpoint restrictions,
and account product entitlements.

## Choose an OAuth mode

| Mode | Recommended use | Secret location |
|---|---|---|
| `hosted_broker` | Distributed CLI/MCP installs | HubSpot client secret stays in the broker; an independent session-start credential is injected locally |
| `local` | App operators and local development | Client ID and secret are supplied to the local process through environment variables |

The hosted broker is the recommended team flow. Local mode remains supported
for development and recovery.

## Hosted broker setup

You need:

- the exact HubSpot portal ID;
- the HTTPS base URL of the broker assigned to that app and portal;
- the environment-variable name holding the independently issued broker
  session-start credential;
- a per-user token-cache path outside the package.

Package installs and upgrades never create, download, or overwrite the portal
profile or token cache. This is intentional: `brokerUrl` is a security trust
anchor because the CLI sends its broker admission credential there.

### Operator and teammate responsibilities

The app operator:

- provisions the fixed HubSpot app/account, callback, scopes, and Worker
  secrets;
- distributes the external non-secret profile through an approved
  configuration channel;
- injects the independent broker session-start credential through an approved
  secret channel;
- validates the exact broker health and callback before enrollment.

The teammate:

- installs or updates `hsapi`;
- places the operator-issued profile at `~/.config/hsapi/portals.json` or points
  `HSAPI_PORTALS_CONFIG` at it;
- receives the broker credential in the environment named by
  `brokerStartKeyEnv`;
- runs `auth doctor`, `auth login`, and `auth whoami`.

A shared start key is limited to controlled internal beta enrollment.
Production/general distribution requires per-install enrollment or an
equivalent authenticated bootstrap.

Add a profile to the file selected by `HSAPI_PORTALS_CONFIG`:

```json
{
  "portals": {
    "your-portal-name": {
      "label": "Your Portal Label",
      "portalId": "YOUR_NUMERIC_PORTAL_ID",
      "baseUrl": "https://api.hubapi.com",
      "auth": {
        "defaultFamily": "oauth",
        "oauth": {
          "mode": "hosted_broker",
          "brokerUrl": "https://oauth.example.com",
          "brokerStartKeyEnv": "HSAPI_OAUTH_BROKER_START_KEY",
          "tokenCachePath": "~/.config/hsapi/oauth/your-portal-cache.json"
        }
      }
    }
  }
}
```

`portalId` is required and must match the broker's fixed HubSpot account. The
broker URL must be HTTPS without URL credentials, a query string, or a
fragment. `brokerStartKeyEnv` names a local environment variable containing an
enrollment credential issued by the broker operator:

```powershell
$env:HSAPI_OAUTH_BROKER_START_KEY = "<broker-session-start-credential>"
```

This value is not the HubSpot client secret and grants no HubSpot API access by
itself. It prevents unauthenticated callers from creating consent sessions and
must still be protected as a secret. Hosted profiles do not use `clientIdEnv`,
`clientSecretEnv`, `redirectUrl`, or a locally configured scope list; those
values are fixed server-side.

The Cloudflare implementation and deployment controls are documented in
[`cloudflare/hsapi-oauth-broker/README.md`](../cloudflare/hsapi-oauth-broker/README.md).

## Local mode setup

For app operators who intentionally perform the exchange locally:

```json
{
  "auth": {
    "defaultFamily": "oauth",
    "oauth": {
      "mode": "local",
      "clientIdEnv": "HSAPI_OAUTH_CLIENT_ID",
      "clientSecretEnv": "HSAPI_OAUTH_CLIENT_SECRET",
      "tokenCachePath": "~/.config/hsapi/oauth/your-portal-cache.json",
      "redirectUrl": "http://localhost:5123/callback",
      "scopes": [
        "oauth",
        "crm.objects.contacts.read"
      ],
      "optionalScopes": [
        "crm.objects.contacts.write"
      ]
    }
  }
}
```

Set the referenced values outside the repository:

```powershell
$env:HSAPI_OAUTH_CLIENT_ID = "<client-id>"
$env:HSAPI_OAUTH_CLIENT_SECRET = "<client-secret>"
```

Local-mode token caches store a SHA-256 fingerprint of the resolved client ID
so a cache cannot be reused silently with a different OAuth app. The
fingerprint is not a client secret and is not printed by diagnostics. A legacy
local cache without this binding, or a cache whose binding does not match,
fails closed and requires `hsapi auth login` again.

The redirect must exactly match one registered on the HubSpot app. Use
`authorizeUrlBase` only when the app operator needs a regional HubSpot login
origin.

## Log in and verify

Validate the profile before opening a browser:

```sh
hsapi auth doctor --portal your-portal-name --require-env
```

`--require-env` passes for a complete hosted profile when the broker
session-start environment variable is set; HubSpot app credentials remain
server-side.

Then authorize:

```sh
hsapi auth login --portal your-portal-name
```

Confirm the browser is on the intended HubSpot account. Selecting **All** checks
every selectable optional permission; a disabled permission is not granted.
The CLI verifies the returned hub ID against the profile's portal ID before it
writes the token cache.

Verify the cached identity and a harmless read:

```sh
hsapi auth whoami --portal your-portal-name
hsapi crm list contacts --portal your-portal-name --limit 3
```

`whoami` should report a usable OAuth cache and a matching portal. Access
tokens, refresh tokens, and broker credentials are redacted from command
output.

## Staying authenticated

The CLI refreshes an expired access token automatically. In hosted mode,
refresh and revoke operations go back through the same broker, which holds the
app secret. The local cache still contains the user's access token, refresh
token, and broker credential and must be protected as a secret.

Check status or sign out:

```sh
hsapi auth doctor --portal your-portal-name
hsapi auth logout --portal your-portal-name
```

Hosted-mode logout attempts server-side revocation through the broker and
removes the local cache even if that request fails. Local-mode logout currently
removes the local cache but does not make a server-side revocation request.

## Current user-level scope result

Build-time acceptance and runtime endpoint support are separate.

The July 18, 2026 live validation used an isolated developer test account, not
either configured customer portal. The app declared `oauth` plus 49 optional
scopes. Consent displayed all 49 optional permissions and **All** was selected.

HubSpot granted `oauth` plus 46 optional scopes. These three permissions were
disabled in consent and were not issued:

- `cpq.quotes.write`
- `crm.objects.marketing_events.write`
- `marketing.campaigns.revenue.lite.read`

Representative runtime results for the 13 granted warning-tier scopes were:

| Outcome | Scopes |
|---|---|
| `200`, isolated public read | `crm.objects.contracts.read` |
| `200`, strong evidence because the token lacked `crm.objects.users.read` | `mcp.users.read` through the Users CRM route |
| `200`, capability works but overlaps `crm.objects.quotes.read` | `cpq.quote_templates.read`, `cpq.quotes.read` |
| `403`, explicit `User level OAuth token is not allowed for this endpoint.` | the three CMS reads, Lists read, marketing-events read, campaigns read, campaign full-revenue read, and teams read |
| Granted, but no documented public REST probe | `crm.hubsql.execute` |

The eight explicit 403 categories are token-type restrictions on the isolated
test account, not ordinary product-entitlement responses. The three
consent-disabled permissions could still depend on portal features, user
permissions, or HubSpot's user-level consent policy; the current test cannot
attribute them more narrowly.

See
[`docs/hubspot-api-updates/2026-07-16-user-level-scope-validation.md`](hubspot-api-updates/2026-07-16-user-level-scope-validation.md)
for the full build and runtime evidence.

## Operations that still need a non-user token

Some endpoints reject a user-level token regardless of a visible/granted
scope. Configure `portalBearer` only for operators who need those operations:

```json
{
  "auth": {
    "defaultFamily": "oauth",
    "oauth": {
      "mode": "hosted_broker",
      "brokerUrl": "https://oauth.example.com",
      "brokerStartKeyEnv": "HSAPI_OAUTH_BROKER_START_KEY",
      "tokenCachePath": "~/.config/hsapi/oauth/your-portal-cache.json"
    },
    "portalBearer": {
      "tokenEnv": "HUBSPOT_PRIVATE_APP_TOKEN",
      "kind": "private_app"
    }
  }
}
```

Known boundaries include destructive CRM archives, several owner/pipeline and
schema surfaces, custom-object operations not accepted by the user-level app,
and the eight warning-tier routes with the explicit token-type 403 listed
above. `hsapi` does not silently retry a failed OAuth call with a stronger
credential. Use `--show-request` to inspect the cataloged token audience before
unfamiliar writes.

## Troubleshooting

| Symptom | Meaning or fix |
|---|---|
| `Unknown portal "..."` | Verify `HSAPI_PORTALS_CONFIG` and the profile name |
| Hosted profile rejects `portalId` | Use the exact numeric HubSpot account ID |
| Login reports missing broker session-start credential | Set the environment variable named by `auth.oauth.brokerStartKeyEnv` to the value issued by the broker operator |
| Broker health reports `ready: false` | The operator must finish broker configuration or secret provisioning |
| Browser opened the wrong account | Switch HubSpot accounts before approving consent and retry |
| Optional permission is disabled | HubSpot will omit it even when **All** is selected |
| `portal_id_mismatch` | The authorized account does not match the profile/broker account |
| `User level OAuth token is not allowed for this endpoint.` | The endpoint does not accept this token type; adding the visible scope will not fix it |
| `Endpoint requires non-user (admin) token` | Configure a scoped `portalBearer` credential if the operator is authorized to do so |
| Local mode reports `EADDRINUSE` | Free the configured loopback port and retry |
