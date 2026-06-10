# HubSpot API Coverage Dashboard

Generated: 2026-05-10

## Snapshot
- Typed commands: 276
- Catalog-only endpoints: 0
- Catalog-only non-HTTP surfaces: 3
- Endpoint count: 276
- Non-HTTP surface count: 3
- Total catalog items: 279

## Coverage by implementation status
- typed: 276

## Coverage by risk
- mutation: 102
- read: 82
- sensitive-read: 52
- destructive: 40

## Coverage by auth family
- portal_bearer: 246
- developer: 25
- oauth: 4

## Coverage by tier requirement
- none: 261
- Enterprise: 5
- Marketing Hub Enterprise: 4
- Marketing Hub Professional: 4
- Professional or Enterprise: 2

## Coverage by family
- webhooks.journal: 19
- conversations: 18
- crm.objects: 13
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
- files.folders: 6
- marketing.forms: 6
- webhooks: 6
- cms.hubdb: 5
- cms.url_redirects: 5
- crm.imports: 5
- crm.properties: 5
- crm.schemas: 5
- auth.oauth: 4
- automation.sequences: 4
- automation.workflows: 4
- crm.property_groups: 4
- scheduler.meetings: 4
- account: 3
- cms.source_code: 3
- crm.exports: 3
- marketing.campaigns: 3
- marketing.emails: 3
- marketing.forms.submissions: 3
- marketing.marketing_events: 3
- cms.domains: 2
- cms.site_search: 2
- crm.extensions.videoconferencing: 2
- crm.object_library: 2
- crm.owners: 2
- crm.property_validations: 2
- events: 2
- events.send: 2
- conversations.visitor_identification: 1
- marketing.transactional_emails: 1
- scheduler.calendar: 1

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
