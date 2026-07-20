# HubSpot Agent CLI Bridge

HSAPI exposes HubSpot's first-party saved-report and saved-view capabilities
without copying or reverse-engineering the Agent CLI. The `hubspot` binary is
an optional, separately installed runtime dependency and remains owned and
updated by HubSpot.

Current delegated command families:

- `hsapi reports list|get|fetch-dataset|insights`
- `hsapi reports create|clone|favorite|unfavorite|delete`
- `hsapi views list|get`
- `hsapi views create|update|replace-field|delete`

Run `hsapi agent-cli doctor --portal <profile>` before first use. HSAPI requires
HubSpot Agent CLI `0.10.0` or newer for these families and sets
`HUBSPOT_NO_AUTO_UPGRADE=1` in delegated child processes so a background MCP
call cannot silently change the reviewed binary.

## Provider boundary

The public HubSpot API catalog remains the normal HSAPI provider. Only saved
reports and saved CRM index-page views delegate to the first-party Agent CLI,
because HubSpot does not currently publish equivalent public app endpoints.
Every result identifies `provider: "hubspot_agent_cli"` and
`delegatedTo: "official_hubspot_agent_cli"`. HSAPI does not expose an
arbitrary Agent CLI pass-through.

The binary is not bundled, repackaged, patched, or auto-installed by HSAPI.
Install it from HubSpot's current Agent CLI guide, verify its version, and
upgrade it separately during an operator-approved maintenance window.

## OAuth and multi-portal safety

HubSpot Agent CLI OAuth uses its own fixed, single-account cache at
`~/.config/hubspot/auth.json`. It currently has no account/profile selector.
HSAPI therefore treats Agent CLI OAuth as an external identity, not as another
HSAPI auth family:

1. `--portal` selects the intended HSAPI profile.
2. HSAPI resolves the expected account ID from the profile `portalId` or a
   usable HSAPI OAuth cache `hubId` binding.
3. Before every delegated command, HSAPI runs `hubspot whoami` and compares
   its account ID with the expected account.
4. A mismatch or missing expected binding blocks execution before the report
   or view command runs.

This preserves cross-portal safety, but it does not make the Agent CLI OAuth
cache concurrently multi-portal. To switch its OAuth account, authenticate the
Agent CLI again and rerun doctor. Do not copy or swap Agent CLI token-cache
files between profiles.

HSAPI blocks OAuth-mode delegation when `HUBSPOT_ACCESS_TOKEN` exists in the
process environment or in a documented Agent CLI `.env` location. This avoids
letting an unrelated admin token silently override the intended user OAuth
identity. Remove the override or select `--agent-auth service-key` explicitly.

## Profile default

Each HSAPI portal can optionally choose its delegated Agent CLI identity:

```json
{
  "agentCli": {
    "authMode": "oauth"
  }
}
```

Supported values are `oauth` and `service-key`. CLI `--agent-auth` and MCP
`authMode` are explicit per-call overrides. If the profile omits `agentCli`,
HSAPI defaults to OAuth for backward compatibility. This setting selects an
auth strategy only; it does not turn the Agent CLI's one OAuth cache into a
multi-portal store.

## Explicit ServiceKey mode

Use `--agent-auth service-key` only when the selected HSAPI profile deliberately
declares `auth.portalBearer` and the endpoint needs account-level or unattended
access. HSAPI passes that selected profile token only to the delegated child
process as `HUBSPOT_ACCESS_TOKEN`; it never prints the value or puts it in argv.

ServiceKey mode remains profile-specific and can therefore support multiple
portal profiles without sharing the Agent CLI OAuth cache. It is never an
automatic fallback from failed OAuth. Verify that combined OAuth and
ServiceKey credentials belong to the same account before configuring them.

## Output budgets

When the Agent CLI returns JSON, HSAPI keeps the parsed payload and omits the
duplicate raw stdout. Normal report/view results carry only a compact preflight
identity summary; `agent-cli doctor` remains the place to inspect full scopes
and detailed checks.

`--max-results` trims Agent CLI `data`/`results` list shapes as well as normal
HubSpot API results. Dedicated MCP tools default to 10 list items and 60,000
serialized characters, returning a truncation summary when a response still
exceeds the character budget. Direct CLI callers can request their own
`--max-results` and `--max-chars` budgets.

## Mutation gates

HSAPI applies its own preview-first `--yes` gate before invoking any Agent CLI
report/view mutation. The Agent CLI's native safeguards remain in force:

- `--show-request` previews delegated argv without running the binary.
- MCP write tools return a blocked preview until `confirmMutation: true`.
- Agent CLI `--dry-run` remains available for view changes and report/view
  deletion.
- Report/view deletion still requires the Agent CLI digest and exact-name
  confirmation returned by its dry run.
- Executed mutations append a redacted entry to HSAPI's normal local history;
  CRM SQL, names, filters, and other delegated arguments are not copied into
  that audit record.

Use the read-only MCP tools for reads:

- `hsapi_reports_read`
- `hsapi_views_read`
- `hsapi_agent_cli_doctor`

Use `hsapi_reports_write` or `hsapi_views_write` only for mutations.

Official reference:
https://developers.hubspot.com/docs/developer-tooling/local-development/agent-cli/guide
