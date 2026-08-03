# 2026-08-03 Public API Scope Validation

## Live user-level app probe

Each candidate scope was added alone to the known-good 49-scope baseline of the
2026.03 `HSAPI Remote MCP` app in the isolated `hsapi-cli` test account. Failed
builds did not deploy. After all probes, build 36 restored and deployed the
exact baseline successfully.

Accepted with HubSpot's user-level support warning:

- `automation.sequences.read`
- `automation.sequences.enrollments.write`

Rejected as unrecognized:

- `crm.objects.commercepayments.read`
- `crm.objects.custom.read`
- `crm.objects.custom.write`
- `crm.schemas.custom.read`
- `crm.schemas.custom.write`
- `sales-templates-public-read`
- `sales-templates-public-write`
- `settings.users.teams.write`

## Repository policy

- Activate the two accepted Sequences scopes in the app ceiling and remote MCP
  request profiles. Existing grants must reauthorize before those capabilities
  become available.
- Keep Commerce Payments, custom objects/schemas, sales templates, and team
  writes on local ServiceKey/private-app access until HubSpot accepts their
  documented scopes for this user-level app type.
- Keep team reads OAuth-capable through the already accepted
  `settings.users.teams.read` scope.
- Catalog public-beta endpoints even when their OAuth scope is unavailable, so
  local generic CLI/MCP requests still receive exact method, path, scope, risk,
  and mutation metadata.
