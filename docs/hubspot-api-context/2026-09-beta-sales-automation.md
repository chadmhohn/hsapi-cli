# 2026-09 Beta Sales and Team APIs

This slice tracks three public-beta surfaces published in HubSpot's
`2026-09-beta` reference: sales email templates, team management, and expanded
sequence management. Their documentation is public, but their OAuth scopes do
not all have the same user-level app availability.

## Sales email templates

The email templates API publishes five operations under
`/automation/email-templates/2026-09-beta`: create, list, get, update, and list
folders. HubSpot documents `sales-templates-public-read` and
`sales-templates-public-write`.

Both scope names were rejected as unrecognized by a live 2026.03 user-level app
build on 2026-08-03. HSAPI therefore catalogs these beta endpoints for guarded
local ServiceKey/private-app use, but does not expose them through the remote
OAuth MCP.

## Teams

The beta Teams API publishes create/list/get/update/delete plus list/add/batch
add/remove member operations under `/settings/teams/2026-09-beta`. Reads use
`settings.users.teams.read`, which is already accepted by the HSAPI user-level
app. The documented `settings.users.teams.write` scope was rejected as
unrecognized on 2026-08-03, so only team reads are remote-OAuth capable.

The stable typed `hsapi users teams` command uses the current
`GET /settings/users/2026-03/teams` route. The separate beta management family
remains catalog-only while its contract and write-scope availability settle.

## Sequences

The beta Sequences guide adds full sequence create/list/get/update/delete under
`/automation/sequences/2026-09-beta/serviceaccounts/sequences`, while retaining
enrollment and enrollment-status operations. HubSpot documents
`automation.sequences.read` for all operations and
`automation.sequences.enrollments.write` for modifications.

Both scopes were accepted by a live 2026.03 user-level app build on 2026-08-03,
with HubSpot's warning that they are not fully supported for user-level apps and
public API calls may fail. HSAPI includes them in the hosted OAuth ceiling and
remote MCP policy, but keeps the new beta endpoints catalog-only and requires
the normal mutation preview/confirmation flow.

## Other requested surfaces

- Contracts remain covered by the typed generic CRM read commands at
  `/crm/objects/2026-03/contracts`; the current official API guide documents
  list and get only.
- Commerce Payments already use the typed generic CRM CRUD/search surface at
  `/crm/objects/2026-03/commerce_payments`. The documented
  `crm.objects.commercepayments.read` scope was still rejected by the
  user-level app registry on 2026-08-03, so OAuth routing remains disabled.
- HubSpot's OAuth scope and custom-object guides document custom record and
  schema scopes, but all four remained unrecognized in the same live app probe.
  Custom-object OAuth stays grant-gated rather than being inferred from docs.

## Official references

- Contracts: https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contracts/guide
- Commerce Payments: https://developers.hubspot.com/docs/api-reference/latest/crm/objects/commerce-payments/guide
- Sales email templates: https://developers.hubspot.com/docs/api-reference/2026-09-beta/sales/templates/guide
- Teams: https://developers.hubspot.com/docs/api-reference/2026-09-beta/account/settings/teams/guide
- Sequences: https://developers.hubspot.com/docs/api-reference/2026-09-beta/automation/sequences/guide
- App scopes: https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/scopes
- Custom objects: https://developers.hubspot.com/docs/api-reference/latest/crm/objects/custom-objects/guide
- Custom schemas: https://developers.hubspot.com/docs/api-reference/latest/crm/objects/schemas/guide
