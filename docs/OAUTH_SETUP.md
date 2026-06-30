# HSAPI CLI — OAuth Setup Guide

## What this gives you

Once set up, every `hsapi` command and MCP tool call runs **as your HubSpot user identity** — scoped to your own permissions, no shared service-key required for day-to-day work. This means:

- A RevOps admin sees and can act on everything their HubSpot role allows.
- A limited user only reaches records their role permits.
- Actions in HubSpot records (e.g., `hs_object_source_user_id`) attribute to *you*, not a shared app account.

## Prerequisites

You need three pieces of information from whoever manages the team's developer app (currently Chad):

| What | Where to get it |
|------|----------------|
| `HSAPI_OAUTH_CLIENT_ID` | HubSpot developer app → Auth tab |
| `HSAPI_OAUTH_CLIENT_SECRET` | HubSpot developer app → Auth tab |
| Portal config entry for your portal | Add to `~/.config/hsapi/portals.json` (see below) |

## Step 1 — Add your portal to the portals config

The config file is at the path in your `HSAPI_PORTALS_CONFIG` environment variable (or `config/hubspot-portals.json` inside the package if that var is unset).

Add an entry like this, substituting your portal's ID and a cache path outside the package:

```json
{
  "portals": {
    "your-portal-name": {
      "label": "Your Portal Label",
      "portalId": "YOUR_PORTAL_ID",
      "baseUrl": "https://api.hubapi.com",
      "auth": {
        "oauth": {
          "clientIdEnv": "HSAPI_OAUTH_CLIENT_ID",
          "clientSecretEnv": "HSAPI_OAUTH_CLIENT_SECRET",
          "tokenCachePath": "~/.config/hsapi/oauth/your-portal-cache.json",
          "redirectUrl": "http://localhost:5123/callback",
          "scopes": [
            "oauth",
            "crm.objects.contacts.read",
            "crm.objects.companies.read",
            "crm.objects.deals.read"
          ],
          "optionalScopes": [
            "crm.objects.contacts.write",
            "crm.objects.companies.write",
            "crm.objects.deals.write",
            "crm.objects.tickets.read",
            "crm.objects.tickets.write",
            "crm.objects.tasks.read",
            "crm.objects.tasks.write",
            "crm.objects.notes.read",
            "crm.objects.notes.write",
            "crm.objects.calls.read",
            "crm.objects.calls.write",
            "crm.objects.meetings.read",
            "crm.objects.meetings.write",
            "crm.objects.emails.read",
            "crm.objects.emails.write"
          ]
        }
      }
    }
  }
}
```

> **Non-NA2 portals** omit `authorizeUrlBase` (it defaults to `https://app.hubspot.com`). NA2 portals need `"authorizeUrlBase": "https://app-na2.hubspot.com"`.

## Step 2 — Set environment variables

Set `HSAPI_OAUTH_CLIENT_ID` and `HSAPI_OAUTH_CLIENT_SECRET` in your shell profile (e.g., `~/.zshrc`, `~/.bash_profile`, or your terminal's env config). Do **not** paste the values into any file you commit.

```sh
export HSAPI_OAUTH_CLIENT_ID=<client-id-from-chad>
export HSAPI_OAUTH_CLIENT_SECRET=<client-secret-from-chad>
```

For PowerShell (add to your `$PROFILE`):
```powershell
$env:HSAPI_OAUTH_CLIENT_ID = "<client-id>"
$env:HSAPI_OAUTH_CLIENT_SECRET = "<client-secret>"
```

## Step 3 — Log in

```sh
hsapi auth login --portal your-portal-name
```

This opens a browser window to the HubSpot OAuth consent screen. **Make sure your browser is logged into the correct HubSpot account before approving.** Approve the requested scopes. The CLI prints `Login complete` and caches your tokens locally at the path you set in `tokenCachePath`.

The token cache holds your access token and refresh token — it stays on your machine, never in source control (the `config/` and `*.json` cache directories are gitignored).

## Step 4 — Verify

```sh
hsapi auth whoami --portal your-portal-name
```

You should see `"status": "usable"` in the `oauth` section.

```sh
hsapi crm list contacts --portal your-portal-name --limit 3
```

A 200 response confirms you're authenticated and data is flowing.

## Staying authenticated

The CLI auto-refreshes your access token using the cached refresh token — you typically only need to run `auth login` once. If the refresh token expires (rare, after ~6 months of inactivity), run `auth login` again.

To check status at any time:
```sh
hsapi auth doctor --portal your-portal-name
```

## What OAuth covers (and what still needs an admin token)

OAuth covers standard CRM objects: contacts, companies, deals, tickets, line items, products, quotes, invoices, subscriptions, orders, carts, and all activity types (calls, meetings, notes, tasks, emails).

Some operations require a non-user (`portalBearer` / private app) credential even with OAuth configured. These are platform-enforced limits:

- `crm archive` / `crm batch-archive` — HubSpot blocks DELETE for user-level tokens
- Owners and pipelines (`crm list owners`, `crm list pipelines`)
- Custom object schemas (`crm schemas`)
- Any custom object read/write (e.g., `crm list 2-XXXXX`)
- `auth introspect`, `auth revoke`

For admin-only operations, add a `portalBearer` block to your portal config pointing to a private-app token in an env var:

```json
"auth": {
  "oauth": { ... },
  "portalBearer": {
    "tokenEnv": "HUBSPOT_PRIVATE_APP_TOKEN",
    "kind": "private_app"
  }
}
```

When both are configured, `hsapi` automatically routes user-capable operations to OAuth and admin operations to the portal bearer token — no flags needed.

## Upgrading from portal-bearer-only

**Nothing changes for existing users.** If your portal config only has `auth.portalBearer`, all commands continue to route through that token exactly as before. OAuth is opt-in — add the `auth.oauth` block when you're ready, then run `auth login`. The routing layer only activates OAuth when it's configured.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Unknown portal "..."` | Check `HSAPI_PORTALS_CONFIG` points to the right file; verify the portal key matches exactly |
| `PKCE is required` | You're using a different app type. The team app is user-level and requires PKCE — ensure you're running the latest CLI version |
| Browser opened wrong account | Switch your browser session to the correct HubSpot account before approving consent |
| `Endpoint requires non-user (admin) token` | That operation needs `auth.portalBearer` — see admin-only list above |
| `EADDRINUSE port 5123` | A previous login process hung. Kill it: `Get-Process -Name node \| Stop-Process` (PowerShell) or `pkill node` (Unix), then retry |
