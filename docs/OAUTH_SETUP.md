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
| `hosted_broker` | Distributed CLI/MCP installs | HubSpot client secret stays in the broker; no OAuth client or broker secret is installed locally |
| `local` | App operators and local development | Client ID and secret are supplied to the local process through environment variables |

The hosted broker is the recommended team flow. Local mode remains supported
for development and recovery.

The shared broker accepts only the native localhost-completion protocol in
hsapi v0.5 and later. A v0.4.x hosted installation must update and replace its
old hosted profile with the current template before using the shared broker.

## Hosted broker setup

You need only:

- an external per-user token-cache path; and
- a HubSpot user who can authorize the app and choose the intended account.

The normal profile uses the broker bundled with `hsapi`:
`https://hsapi-oauth.groundworkrevops.com`. The URL is public configuration,
not a credential. The user does not supply a portal ID, HubSpot client ID,
HubSpot client secret, redirect URL, scope list, or broker admission
credential.

Package installs and upgrades never create, download, or overwrite the portal
profile or token cache. Keep both outside the package. An explicit
`auth.oauth.brokerUrl` is supported only for an approved private deployment;
because that endpoint receives authorization codes and token operations, treat
the override as a security trust anchor.

### Operator and teammate responsibilities

The bundled-broker operator:

- provisions the HubSpot app, callback, scopes, and Worker secrets;
- keeps the HubSpot client secret and broker signing key in the hosted secret
  store;
- publishes and validates the broker health and exact callback; and
- operates one app across the HubSpot accounts whose users authorize it.

The teammate:

- installs or updates `hsapi`;
- copies the portal-neutral profile to `~/.config/hsapi/portals.json` or points
  `HSAPI_PORTALS_CONFIG` at another external path;
- runs `auth doctor`, `auth login`, and `auth whoami`.

Add a profile to the file selected by `HSAPI_PORTALS_CONFIG`:

```json
{
  "portals": {
    "hubspot-oauth": {
      "label": "HubSpot OAuth",
      "baseUrl": "https://api.hubapi.com",
      "auth": {
        "defaultFamily": "oauth",
        "oauth": {
          "mode": "hosted_broker",
          "tokenCachePath": "~/.config/hsapi/oauth/hubspot-oauth-cache.json"
        }
      }
    }
  }
}
```

The first successful login to an unpinned profile binds the cache to the
numeric `hub_id` returned by HubSpot. Configure a numeric `portalId` only when
the profile must be pinned to one account before first login:

```json
{
  "portalId": "123456789"
}
```

When present, `portalId` is an expected-account constraint: a different
account selected in HubSpot is rejected and the profile is never silently
rebound. Without it, the existing cache binding serves the same role after the
first login. To move intentionally to another account, use a separate profile
and token-cache path or explicitly remove the old binding through the approved
logout/reconfiguration procedure.

For an approved private broker only, add:

```json
{
  "brokerUrl": "https://oauth.example.com"
}
```

The override must be HTTPS without URL credentials, a query string, or a
fragment. Hosted profiles do not use local client-credential, redirect, scope,
or broker admission fields; those app details remain server-side.

### Browser-to-CLI completion proof

At login, the CLI opens a short-lived listener on
`http://127.0.0.1:<ephemeral-port>/oauth/hsapi/callback`. It sends only that
strict loopback URL, a PKCE challenge, and a digest of a separate consume
secret when creating the broker session. HubSpot calls the broker's registered
HTTPS callback. The broker then redirects a fresh one-time completion grant to
the exact localhost listener. Token exchange succeeds only when the initiating
CLI presents that completion grant, its raw consume secret, and the PKCE
verifier.

This completion proof lets the normal session-creation route remain public
without letting a remote caller harvest a token after convincing another user
to approve consent. The listener binds only to `127.0.0.1`, accepts the
session's exact state, closes after completion or timeout, and is not the
HubSpot app's registered redirect URI.

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
hsapi auth doctor --portal hubspot-oauth
```

For the normal hosted profile, `auth doctor` needs no OAuth environment
variables. It verifies the bundled or overridden broker URL and confirms that
the token-cache path is outside the package.

Then authorize:

```sh
hsapi auth login --portal hubspot-oauth
```

HubSpot shows its account chooser. Confirm the intended account before
approving consent. Selecting **All** checks every selectable optional
permission; a disabled permission is not granted. Before writing the cache,
the CLI requires HubSpot's numeric `hub_id` and compares it with either the
optional profile `portalId` or the cache's existing account binding. A mismatch
fails closed rather than rebinding the profile.

Verify the cached identity and a harmless read:

```sh
hsapi auth whoami --portal hubspot-oauth
hsapi crm list contacts --portal hubspot-oauth --limit 3
```

`whoami` should report a usable OAuth cache and the selected account ID. Access
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
      "tokenCachePath": "~/.config/hsapi/oauth/your-portal-cache.json"
    },
    "portalBearer": {
      "tokenEnv": "HUBSPOT_PRIVATE_APP_TOKEN",
      "kind": "private_app"
    }
  }
}
```

Add the ServiceKey only after hosted OAuth has bound the profile to a HubSpot
account. An authorized operator must verify the private-app token's account
identity matches `hsapi auth whoami --portal <name>` before enabling the
combined profile. The credential stays in the named environment variable; it
is never copied into JSON. `hsapi` does not silently retry an OAuth failure
with the ServiceKey.

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
| Hosted profile rejects `portalId` | Omit it for account selection, or use the exact numeric HubSpot account ID when intentionally pinning the profile |
| Broker health reports `ready: false` | The operator must finish broker configuration or secret provisioning |
| Browser opened the wrong account | Cancel before consent, switch HubSpot accounts, and retry |
| Browser completes but the CLI is still waiting | Ensure localhost traffic to `127.0.0.1` is allowed and retry; the one-time completion grant must return to the initiating CLI |
| Optional permission is disabled | HubSpot will omit it even when **All** is selected |
| `portal_id_mismatch` or cache account mismatch | The selected account does not match the optional profile pin or existing cache binding; use the intended account or a separate profile/cache |
| `User level OAuth token is not allowed for this endpoint.` | The endpoint does not accept this token type; adding the visible scope will not fix it |
| `Endpoint requires non-user (admin) token` | Configure a scoped `portalBearer` credential if the operator is authorized to do so |
| Local mode reports `EADDRINUSE` | Free the configured loopback port and retry |
