# OpenClaw MCP Cutover Runbook

This runbook prepares the final OpenClaw cutover from the current HubSpot MCP servers to the CLI-backed hsapi-cli MCP server.

The only OpenClaw MCP server entries in scope are:

- hubspot-portal-alpha
- hubspot-portal-beta

HubSpot developer, CMS, project, content, and CLI accounts are out of scope. Do not edit them while following this runbook.

## Source And Boundary

This runbook uses the current official OpenClaw MCP CLI docs at https://docs.openclaw.ai/cli/mcp.md. The relevant client-registry commands are:

~~~bash
openclaw mcp list
openclaw mcp show [name]
openclaw mcp set <name> <JSON object>
openclaw mcp unset <name>
~~~

openclaw mcp set stores one named MCP server definition and expects one JSON object argument. The docs do not define an openclaw mcp set --dry-run mode, so preparation validates generated JSON and reads current registry state without applying live changes.

Do not run live openclaw mcp set, openclaw mcp unset, or any Gateway restart/reload until an authorized operator explicitly approves the cutover in the current conversation or change window.

## Prerequisites

Complete the neutral token-source preparation before this runbook. The replacement MCP entries must not depend on the old HubSpot MCP server entries for token lookup.

Required local state:

- hsapi and hsapi-mcp are installed and resolve to the intended package version.
- A private HSAPI_PORTALS_CONFIG exists outside this package and preserves the portal-alpha and portal-beta profile names.
- The private portal config stores token environment variable names only, not token values.
- A repo-external neutral wrapper can resolve HUBSPOT_ACCESS_TOKEN_PORTAL_ALPHA and HUBSPOT_ACCESS_TOKEN_PORTAL_BETA through an approved secret source.
- examples/openclaw-cutover.mcp.sample.json has been copied to a private operator path and adjusted only for local wrapper/config/lookup paths.

The sample file is intentionally secret-free. Do not add raw HubSpot tokens, OAuth refresh tokens, client secrets, developer API keys, personal access keys, token caches, or local OpenClaw secret-store contents to it.

## Read-Only OpenClaw Discovery

Create a private operator directory for backup output. Keep it outside the repository.

~~~bash
export HSAPI_CUTOVER_STATE="$HOME/.local/state/hsapi-openclaw-cutover/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$HSAPI_CUTOVER_STATE"
~~~

Record the current OpenClaw version and MCP registry names:

~~~bash
openclaw --version > "$HSAPI_CUTOVER_STATE/openclaw-version.txt"
openclaw mcp list > "$HSAPI_CUTOVER_STATE/openclaw-mcp-list.pre-cutover.txt"
~~~

Back up only the two in-scope MCP entries. These files may contain local SecretRefs or private paths, so keep them private and never commit them.

~~~bash
openclaw mcp show hubspot-portal-alpha --json > "$HSAPI_CUTOVER_STATE/hubspot-portal-alpha.pre-cutover.json"
openclaw mcp show hubspot-portal-beta --json > "$HSAPI_CUTOVER_STATE/hubspot-portal-beta.pre-cutover.json"
~~~

Validate current OpenClaw config without changing it:

~~~bash
openclaw config validate
~~~

Stop if either in-scope entry is missing, if the registry contains unexpected duplicate HubSpot entries that would change the cutover scope, or if config validation fails.

## Candidate Config Validation

Use the repo-safe sample as the candidate source. The sample replaces the existing server names only, while pointing both entries at the neutral token wrapper and separate HSAPI_PORTAL values.

~~~bash
export HSAPI_CUTOVER_SAMPLE=examples/openclaw-cutover.mcp.sample.json
~~~

Validate JSON shape without applying it:

~~~bash
jq -e '.servers["hubspot-portal-alpha"] | type == "object"' "$HSAPI_CUTOVER_SAMPLE"
jq -e '.servers["hubspot-portal-beta"] | type == "object"' "$HSAPI_CUTOVER_SAMPLE"
jq -e '.servers["hubspot-portal-alpha"].env.HSAPI_PORTAL == "portal-alpha"' "$HSAPI_CUTOVER_SAMPLE"
jq -e '.servers["hubspot-portal-beta"].env.HSAPI_PORTAL == "portal-beta"' "$HSAPI_CUTOVER_SAMPLE"
~~~

Render the exact JSON object payloads that openclaw mcp set would receive. This is validation only; it does not modify OpenClaw config.

~~~bash
jq -c '.servers["hubspot-portal-alpha"]' "$HSAPI_CUTOVER_SAMPLE" > "$HSAPI_CUTOVER_STATE/hubspot-portal-alpha.candidate.json"
jq -c '.servers["hubspot-portal-beta"]' "$HSAPI_CUTOVER_SAMPLE" > "$HSAPI_CUTOVER_STATE/hubspot-portal-beta.candidate.json"
~~~

Review those candidate files for placeholder paths before approval. They must contain wrapper/config/lookup paths only, never token values.

## Local MCP Smoke Tests Before Live Change

Run these checks before any live OpenClaw MCP replacement.

1. Package and repo gates:

~~~bash
npm test
npm run pack:dry-run
git diff --check
~~~

2. Neutral wrapper dry run. This proves which env names would be loaded without reading or printing secret values:

~~~bash
HSAPI_PORTALS_CONFIG=/path/outside-package/hsapi/portals.multi-portal.json \
HSAPI_NEUTRAL_TOKEN_PROFILES=portal-alpha,portal-beta \
HSAPI_NEUTRAL_TOKEN_DRY_RUN=1 \
HSAPI_SECRET_LOOKUP_CMD=/path/outside-package/hsapi/lookup-hsapi-secret \
/path/outside-package/hsapi/neutral-token-wrapper
~~~

Expected dry-run stderr contains only:

- would_load_env=HUBSPOT_ACCESS_TOKEN_PORTAL_ALPHA
- would_load_env=HUBSPOT_ACCESS_TOKEN_PORTAL_BETA

3. Direct CLI through the neutral wrapper:

~~~bash
/path/outside-package/hsapi/neutral-token-wrapper hsapi profiles list
/path/outside-package/hsapi/neutral-token-wrapper hsapi auth doctor --portal portal-alpha --require-env
/path/outside-package/hsapi/neutral-token-wrapper hsapi auth doctor --portal portal-beta --require-env
/path/outside-package/hsapi/neutral-token-wrapper hsapi account details --portal portal-alpha
/path/outside-package/hsapi/neutral-token-wrapper hsapi account details --portal portal-beta
~~~

Expected results:

- Both profiles are present.
- Auth doctor passes for both profiles.
- Account detail reads return the expected portal labels/IDs for the selected profile.
- No raw token value appears in output.

4. Local MCP stdio smoke without OpenClaw config changes:

~~~bash
HSAPI_PORTALS_CONFIG=/path/outside-package/hsapi/portals.multi-portal.json \
HSAPI_PORTAL=portal-alpha \
HSAPI_NEUTRAL_TOKEN_PROFILES=portal-alpha,portal-beta \
HSAPI_SECRET_LOOKUP_CMD=/path/outside-package/hsapi/lookup-hsapi-secret \
/path/outside-package/hsapi/neutral-token-wrapper hsapi-mcp
~~~

Use a local MCP client or the package test harness to call:

- hsapi_profiles_list with {}
- hsapi_auth_doctor with {"portal":"portal-alpha","requireEnv":true}
- hsapi_auth_doctor with {"portal":"portal-beta","requireEnv":true}
- hsapi_command_execute with {"portal":"portal-alpha","argv":["account","details"],"compact":true}
- hsapi_command_execute with {"portal":"portal-beta","argv":["account","details"],"compact":true}

Expected results:

- The MCP server initializes over stdio.
- Both portal auth checks pass.
- Both account detail reads succeed.
- Tool responses are bounded and redacted.
- No mutation executes during smoke testing.

## Approval Gate For Live Cutover

Stop after local smoke tests and get explicit approval before applying live config. Approval must cover both parts separately:

- replacing the two named MCP entries with openclaw mcp set
- restarting or reloading Gateway, if a restart is needed for live runtimes to pick up the changed registry

Do not treat a general plan acknowledgement as restart approval. Use the exact current operator instruction.

## Live Config Application

Only run this section after explicit approval for the config replacement.

~~~bash
openclaw mcp set hubspot-portal-alpha "$(cat "$HSAPI_CUTOVER_STATE/hubspot-portal-alpha.candidate.json")"
openclaw mcp set hubspot-portal-beta "$(cat "$HSAPI_CUTOVER_STATE/hubspot-portal-beta.candidate.json")"
openclaw config validate
openclaw mcp show hubspot-portal-alpha --json
openclaw mcp show hubspot-portal-beta --json
~~~

Confirm the stored entries use the neutral wrapper, args: ["hsapi-mcp"], and the expected HSAPI_PORTAL value for each server. Do not print or inspect secret-store contents while confirming.

Gateway restart or reload is intentionally not included here. If a restart is required, stop and request explicit approval for that operational step.

## Live Smoke Tests After Cutover

After the approved live config change and any separately approved Gateway restart/reload, test both portals through OpenClaw's MCP client surface.

For hubspot-portal-alpha, call:

- hsapi_profiles_list with {}
- hsapi_auth_doctor with {"portal":"portal-alpha","requireEnv":true}
- hsapi_command_execute with {"portal":"portal-alpha","argv":["account","details"],"compact":true,"maxChars":20000}
- one bounded read such as hsapi_command_execute with {"portal":"portal-alpha","argv":["crm","list","companies","--properties","name,domain"],"compact":true,"maxResults":1}

For hubspot-portal-beta, call:

- hsapi_profiles_list with {}
- hsapi_auth_doctor with {"portal":"portal-beta","requireEnv":true}
- hsapi_command_execute with {"portal":"portal-beta","argv":["account","details"],"compact":true,"maxChars":20000}
- one bounded read such as hsapi_command_execute with {"portal":"portal-beta","argv":["crm","list","companies","--properties","name,domain"],"compact":true,"maxResults":1}

Expected results:

- Each MCP entry starts the CLI-backed server.
- Portal Alpha requests resolve the portal-alpha profile only.
- Portal Beta requests resolve the portal-beta profile only.
- Reads succeed with bounded output.
- Results do not contain raw token values.
- Mutation attempts remain blocked unless confirmMutation and the underlying hsapi danger gates are explicitly supplied.

## Rollback

Rollback uses the private pre-cutover backup files captured earlier. Only run it after operator approval if the live smoke tests fail or the cutover needs to be reversed.

~~~bash
openclaw mcp set hubspot-portal-alpha "$(cat "$HSAPI_CUTOVER_STATE/hubspot-portal-alpha.pre-cutover.json")"
openclaw mcp set hubspot-portal-beta "$(cat "$HSAPI_CUTOVER_STATE/hubspot-portal-beta.pre-cutover.json")"
openclaw config validate
openclaw mcp show hubspot-portal-alpha --json
openclaw mcp show hubspot-portal-beta --json
~~~

If Gateway was restarted for cutover and needs another restart to pick up rollback, get explicit approval before restarting or reloading it.

After rollback, rerun the pre-cutover read-only discovery and confirm the original HubSpot MCP entries are active again.
