# HubSpot API Coverage Dashboard

Generated: 2026-05-10

## Snapshot
- Typed commands: 308
- Catalog-only endpoints: 21
- Catalog-only non-HTTP surfaces: 3
- Endpoint count: 329
- Non-HTTP surface count: 3
- Total catalog items: 332

## Coverage by implementation status
- typed: 308
- catalog-only: 21

## Coverage by risk
- mutation: 117
- read: 111
- sensitive-read: 56
- destructive: 45

## Coverage by auth family
- portal_bearer: 292
- developer: 32
- oauth: 4

## Coverage by tier requirement
- none: 313
- Enterprise: 5
- Marketing Hub Enterprise: 4
- Marketing Hub Professional: 4
- Professional or Enterprise: 2
- Business Units add-on: 1

## Coverage by family
- webhooks.journal: 19
- conversations: 18
- crm.objects: 13
- crm.timeline: 12
- conversations.custom_channels: 11
- crm.lists: 11
- communication_preferences: 10
- crm.associations.records: 10
- crm.pipelines: 10
- files: 10
- cms.blogs.posts: 9
- cms.pages.landing: 9
- cms.pages.site: 9
- crm.extensions.calling: 9
- crm.limits: 9
- crm.associations.schema: 8
- events.definitions: 8
- automation.flows: 7
- engagements.v1: 7
- marketing.campaigns: 7
- account: 6
- files.folders: 6
- marketing.forms: 6
- webhooks: 6
- cms.hubdb: 5
- cms.url_redirects: 5
- crm.imports: 5
- crm.properties: 5
- crm.schemas: 5
- marketing.emails: 5
- settings.users: 5
- auth.oauth: 4
- automation.sequences: 4
- automation.workflows: 4
- crm.property_groups: 4
- scheduler.meetings: 4
- cms.source_code: 3
- crm.exports: 3
- crm.extensions.videoconferencing: 3
- crm.quotes: 3
- marketing.forms.submissions: 3
- marketing.marketing_events: 3
- analytics: 2
- cms.audit_logs: 2
- cms.domains: 2
- cms.site_search: 2
- crm.object_library: 2
- crm.owners: 2
- crm.property_validations: 2
- events: 2
- events.send: 2
- settings.currencies: 2
- business_units: 1
- conversations.visitor_identification: 1
- marketing.transactional_emails: 1
- scheduler.calendar: 1
- settings.roles: 1
- settings.teams: 1

## Coverage by surface family
- automation.sequences: 1
- automation.workflows: 1
- marketing.ctas: 1

## Coverage by surface type
- docs-only: 2
- javascript-sdk: 1

## Non-HTTP Surfaces
- marketing.ctas.javascript_sdk (javascript-sdk, marketing.ctas)
  - Docs: https://developers.hubspot.com/docs/api-reference/latest/marketing/ctas-sdk/guide
  - Context: docs/hubspot-api-context/marketing-surfaces.md
  - Disposition: HubSpot documents CTAs as a catalog-only browser JavaScript SDK surface under window.HubSpotCallsToActions, not as a bearer-token REST endpoint. Do not model this as an hsapi command or HubSpot API request.
- automation.workflows.docs (docs-only, automation.workflows)
  - Docs: https://developers.hubspot.com/docs/guides/api/automation/create-manage-workflows
  - Context: docs/hubspot-api-context/automation-surfaces.md
  - Disposition: Workflows are documented here because HubSpot's workflow and custom-action model spans several older and newer guides.
- automation.sequences.docs (docs-only, automation.sequences)
  - Docs: https://developers.hubspot.com/docs/api-reference/automation-sequences-v4/guide
  - Context: docs/hubspot-api-context/automation-surfaces.md
  - Disposition: Sequences keep this guide as a docs-only surface; the REST list/get/enroll/status paths are tracked as endpoint rows.
