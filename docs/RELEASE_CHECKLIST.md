# Release Checklist

This project is not ready for public release until these checks are complete.

## Source-Available Internal Beta Foundation

- Package source is the implementation source of truth.
- Workspace wrappers call the package source rather than duplicating it.
- Package dry-run includes only intended public files.
- No real portal config, tokens, memory, client notes, or local workspace files are packaged.
- Secret redaction gate passes: `npm run release:gates` verifies packaged files do not include token caches, local config paths, token-like values, or JSON secret values.
- Auth-family coverage gate passes: `npm run release:gates` verifies catalog auth metadata covers `portal_bearer`, `oauth`, `developer`, and intentional unauthenticated endpoints.
- MCP release gate passes: `npm run release:gates` verifies MCP server files, package bin entries, tool metadata and input schemas, sample MCP config safety, redaction coverage, and local-config exclusion.
- Portal onboarding gate passes: the package includes the canonical
  `portal-auth-setup` guide plus minimal ServiceKey, hosted OAuth, and combined
  templates; the ServiceKey template is copy-ready and no packaged file
  contains a concrete portal ID.
- Checkout neutrality gate passes: tracked Worker configuration contains only
  placeholders, deployment-specific account/app/callback values live in the
  ignored `wrangler.operator.jsonc`, and deploy scripts require that operator
  config explicitly.
- Profile validation gate passes for release fixtures: `hsapi auth doctor --portal <fixture> --require-env` reports no missing credential env vars and no token-cache paths inside the package.
- README, SECURITY, CONTRIBUTING, AGENTS, CLAUDE, issue templates, PR template, and CI workflow are present and current for the source-available internal beta.

## Before Package Beta

- Keep package use within the audience allowed by `LICENSE` unless an authorized operator explicitly approves broader distribution and updates the license.
- Keep `package.json` marked `private: true` unless an authorized operator explicitly approves npm publishing.
- Decide license before any public release.
- Add package lock only if dependencies are introduced.
- Run `npm test`.
- Run `npm run release:gates`.
- Run `npm pack --dry-run --json`.
- Run the installed-tarball smoke test from a temp prefix.
- Verify `hsapi-mcp` and `hsapi mcp serve` are packaged stdio MCP entry points and that `docs/MCP.md` plus `examples/mcp-server.sample.json` stay secret-free.
- Verify `docs/CMS_PROJECTS_AUTH_BOUNDARY.md` ships in the package and still says CMS REST APIs use `hsapi --portal <profile>` while HubSpot Projects use explicit official HubSpot CLI project tooling.
- Test installed tarball from outside this workspace.
- Add mock tests for every typed command path/body/query mapping.
- Add docs/context overlays for high-risk and obscure API families.
- Verify every new command appears in `hsapi catalog commands` with explicit auth-family metadata before release.

## Before Public Community Release

- Recheck npm and GitHub name availability.
- Run CI in GitHub.
- Run safe live read smoke tests in disposable HubSpot test portals.
- Run gated write tests only in disposable test portals.
- Verify expected 403s explain scope-or-tier ambiguity.
- Verify expected 401/403s are documented by auth family: `portal_bearer`, `oauth`, `developer/personal_access_key`, `developer/developer_api_key`, or `developer/client_credentials`.
- Publish release notes with current endpoint coverage and known gaps.
