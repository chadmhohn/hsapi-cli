# MCP Adapter Project Plan

Last updated: 2026-05-15

## Goal

Make hsapi-cli usable in two modes without splitting the HubSpot logic:

- direct CLI mode for humans, scripts, cron jobs, and agent shell work through hsapi;
- stdio MCP server mode for OpenClaw and other MCP clients.

The MCP server should be a thin adapter over the same portal config, endpoint catalog, auth resolvers, request builder, redaction rules, and safety gates that the CLI uses. It should not become a second HubSpot implementation, and it should not shell out to hsapi blindly for every operation if a reusable internal execution path is available.

## Non-goals

- Do not replace the HubSpot developer, CMS, or project CLIs in this phase stack.
- Do not make Gateway restarts part of package implementation issues.
- Do not store raw HubSpot tokens, client secrets, token caches, or local OpenClaw config in the package.
- Do not loosen mutation, destructive, origin-guard, or redaction behavior just because a request enters through MCP instead of the CLI.

## Mode Contract

### Direct CLI mode

Direct CLI mode remains the primary operator surface:

- hsapi profiles list
- hsapi auth doctor --portal example
- hsapi account details --portal example --show-request
- hsapi crm search companies --filter hs_object_id:GT:0 --count-only
- hsapi request GET /crm/v3/owners --portal example --query limit=10

Compatibility rule: existing CLI commands, output envelopes, exit codes, and confirmation behavior should remain stable unless a later issue explicitly changes them.

### MCP server mode

MCP mode should be exposed as a stdio server entry point. The preferred command is hsapi mcp serve. A secondary package binary such as hsapi-mcp is acceptable if it improves client configuration, but it should still call the same internal server module.

The initial MCP server should expose low-risk tools first:

- profile discovery;
- catalog coverage and catalog command discovery;
- auth doctor diagnostics;
- request preview or show-request style metadata.

Execution tools should arrive later, after the reusable command core exists and the server can enforce the same safety model as the CLI.

## Shared Core Requirement

The package should move toward this shape:

portal config + catalog + auth resolvers + request/safety/redaction core -> hsapi CLI commands and hsapi MCP stdio tools.

Shared behavior must include:

- portal selection and profile loading;
- auth-family and auth-subtype resolution;
- absolute URL origin guards;
- show-request previews;
- OAuth and developer token cache redaction;
- dry-run and mutation confirmation gates;
- read-only POST allowlisting;
- output bounding and agent-friendly structured output;
- consistent error envelopes.

## MCP Tool Surface Direction

The MCP tool surface should stay small and explicit.

Suggested phases:

1. Discovery and diagnostics: hsapi_profiles_list, hsapi_catalog_coverage, hsapi_catalog_commands, and hsapi_auth_doctor.
2. Safe previews: preview a catalog command or generic request without sending it; return auth family, auth subtype, credential source names, method, URL, query, headers, body metadata, and risk classification without secrets.
3. Read execution: run catalog-backed read commands; run generic requests only when risk and read-only policy allow it.
4. Guarded mutation support: require explicit tool arguments equivalent to CLI --yes; keep destructive operations behind stronger named flags; return blocked-operation errors by default when the call is ambiguous.

MCP clients should receive JSON-compatible results. Large HubSpot responses should honor the existing compact, select, pick, max-results, and max-chars behavior instead of dumping unbounded payloads into an agent context.

## OpenClaw Cutover Boundary

The current local /usr/bin/hsapi wrapper reads portal-alpha and portal-beta portal tokens from the existing OpenClaw HubSpot MCP entries:

- hubspot-portal-alpha;
- hubspot-portal-beta.

That means the official HubSpot MCP entries cannot be replaced safely until token sourcing is moved to a neutral path, such as a SecretRef-backed wrapper or another private local credential bridge that does not depend on those same MCP config entries.

The package work can prepare the MCP server and runbook. The live OpenClaw cutover is an operator step with a manual approval gate because it may require replacing configured MCP server definitions and restarting Gateway or active agent sessions.

Cutover must be limited to the two portal MCP entries above. HubSpot developer, CMS, and project CLIs should remain in place until there is a separate reason to change them.

## Implementation Phases

### Phase 0 - Roadmap and architecture contract

Deliverables:

- Add this roadmap/design document.
- Define direct CLI mode, MCP mode, shared-core expectations, safety model, and cutover boundary.
- Create one GitHub issue per subsequent phase.

Acceptance criteria:

- The repo documents the dual-mode target and sequential phase stack.
- The document explicitly states that existing hsapi CLI behavior must remain compatible.
- The document calls out token sourcing as a prerequisite before replacing old HubSpot MCP entries.

### Phase 1 - Reusable CLI execution core

Deliverables:

- Extract the smallest reusable execution layer from the current CLI.
- Preserve direct CLI behavior.
- Add tests that can call execution helpers without spawning a shell.

Acceptance criteria:

- CLI commands still work through bin/hsapi.js.
- Programmatic execution can reuse portal config, auth, request construction, redaction, and safety gates.
- Existing auth-mode tests continue to pass.

### Phase 2 - Stdio server and discovery tools

Deliverables:

- Add hsapi mcp serve and/or a package bin such as hsapi-mcp.
- Implement MCP stdio startup and basic tool registration.
- Expose discovery and diagnostic tools first.
- Add local MCP smoke tests that do not require live HubSpot writes.

Acceptance criteria:

- The MCP server initializes over stdio and returns structured, redacted results for discovery tools.
- Direct CLI usage remains unchanged.

### Phase 3 - Portal-aware MCP execution tools

Deliverables:

- Add MCP execution tools for catalog-backed commands and/or generic requests.
- Support portal selection.
- Enforce CLI-equivalent read, mutation, destructive, and redaction policy.

Acceptance criteria:

- Representative read-only operations work through MCP.
- Mutation and destructive operations are blocked unless explicit safe flags are supplied.
- Tests cover allowed reads, blocked mutations, and structured errors.

### Phase 4 - Docs, package, and release gates

Deliverables:

- Document CLI mode versus MCP server mode.
- Add OpenClaw and generic MCP client config examples.
- Extend release gates for MCP files, redaction, and package safety.

Acceptance criteria:

- Package dry-run includes intended MCP files and excludes local config or secret material.
- Release checks fail on missing MCP server files or obvious local credential leakage.

### Phase 5 - Neutral token sourcing for cutover

Deliverables:

- Move or document token sourcing so local hsapi no longer depends on the old HubSpot MCP entries.
- Preserve portal-alpha and portal-beta profiles.
- Provide a reversible local migration/runbook.
- Add repo-safe neutral token-source samples for the portal config and wrapper command.

Acceptance criteria:

- hsapi profiles list, hsapi account details --portal portal-alpha, hsapi account details --portal portal-beta, and hsapi auth doctor can be validated after migration.
- No raw token values are committed or printed.
- No Gateway restart happens inside the package issue.

### Phase 6 - OpenClaw cutover runbook and smoke tests

Deliverables:

- Add the final cutover runbook for replacing only the portal-alpha and portal-beta HubSpot MCP entries with the CLI-backed MCP server.
- Include config dry-run, validation, rollback, and smoke-test steps.
- Document the explicit restart approval requirement.

Acceptance criteria:

- The runbook is sufficient for an operator to perform the swap safely.
- Live Gateway restart or config replacement remains outside the issue until an authorized operator explicitly approves it in the current conversation.

## Verification Gates

Every phase should run:

- npm test
- npm run pack:dry-run
- git diff --check

Phases that touch MCP behavior should also include a local MCP smoke test. Phases that touch local OpenClaw config guidance should use OpenClaw config dry-run or validation commands where possible, without printing raw credential values.

## GitHub Issue Stack

- #30 - MCP adapter Phase 0: roadmap and architecture contract
- #31 - MCP adapter Phase 1: reusable CLI execution core
- #32 - MCP adapter Phase 2: stdio server and discovery tools
- #33 - MCP adapter Phase 3: portal-aware MCP execution tools
- #34 - MCP adapter Phase 4: docs, package, and release gates
- #35 - MCP adapter Phase 5: neutral token sourcing for cutover
- #36 - MCP adapter Phase 6: OpenClaw cutover runbook and smoke tests

Only the current phase should have agent-ready. Later phases should stay blocked-sequential until the previous phase merges.
