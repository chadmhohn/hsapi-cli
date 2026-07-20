# HubSpot API Coverage Dashboard

Generated: 2026-05-10

## Snapshot
- Typed commands: 315
- Catalog-only endpoints: 322
- Catalog-only non-HTTP surfaces: 3
- Endpoint count: 637
- Non-HTTP surface count: 5
- Total catalog items: 642

## Coverage by implementation status
- catalog-only: 322
- typed: 315

## Coverage by risk
- mutation: 278
- read: 220
- destructive: 82
- sensitive-read: 57

## Coverage by auth family
- portal_bearer: 579
- developer: 53
- oauth: 4

## Coverage by tier requirement
- none: 621
- Enterprise: 5
- Marketing Hub Enterprise: 4
- Marketing Hub Professional: 4
- Professional or Enterprise: 2
- Business Units add-on: 1

## Coverage by family
- cms.pages: 47
- marketing.marketing_events: 34
- cms.hubdb: 29
- cms.blogs.meta: 28
- crm.lists: 27
- marketing.campaigns: 24
- webhooks.journal: 19
- conversations: 18
- marketing.emails: 18
- automation.actions: 17
- cms.blogs: 15
- settings.currencies: 15
- crm.pipelines: 14
- conversations.custom_channels: 13
- crm.extensions: 13
- crm.objects: 13
- crm.timeline: 12
- communication_preferences: 10
- crm.associations.records: 10
- files: 10
- cms.blog_settings: 9
- cms.blogs.posts: 9
- cms.pages.landing: 9
- cms.pages.site: 9
- crm.extensions.calling: 9
- crm.limits: 9
- crm.properties: 9
- automation.flows: 8
- cms.source_code: 8
- crm.associations.schema: 8
- engagements.v1: 8
- events.definitions: 8
- automation.workflows: 7
- files.folders: 7
- account: 6
- marketing.forms: 6
- webhooks: 6
- cms.url_redirects: 5
- crm.imports: 5
- crm.schemas: 5
- email.events: 5
- marketing.transactional: 5
- settings.users: 5
- auth.oauth: 4
- automation.sequences: 4
- crm.property_groups: 4
- crm.property_validations: 4
- email.subscriptions_v1: 4
- scheduler.meetings: 4
- crm.associations: 3
- crm.exports: 3
- crm.extensions.videoconferencing: 3
- crm.quotes: 3
- email.smtp: 3
- marketing.forms.submissions: 3
- webhooks.subscriptions: 3
- analytics: 2
- cms.audit_logs: 2
- cms.domains: 2
- cms.site_search: 2
- crm.deal_splits: 2
- crm.object_library: 2
- crm.owners: 2
- events: 2
- events.events: 2
- events.send: 2
- oauth.refresh_tokens: 2
- automation.action_types: 1
- automation.performance: 1
- automation.workflow_id_mappings: 1
- business_units: 1
- business_units.public: 1
- communication_preferences.status: 1
- communication_preferences.subscribe: 1
- communication_preferences.unsubscribe: 1
- conversations.visitor_identification: 1
- crm_object_schemas.schemas: 1
- email.transactional_v1: 1
- files.files: 1
- form_integrations.uploaded_files: 1
- marketing.email: 1
- marketing.transactional_emails: 1
- oauth.access_tokens: 1
- scheduler.calendar: 1
- settings.roles: 1
- settings.teams: 1

## Coverage by surface family
- automation.sequences: 1
- automation.workflows: 1
- first_party.reports: 1
- first_party.views: 1
- marketing.ctas: 1

## Coverage by surface type
- docs-only: 2
- external-cli-bridge: 2
- javascript-sdk: 1

## Non-HTTP Surfaces
- first_party.reports.agent_cli_bridge (external-cli-bridge, first_party.reports)
  - Docs: https://developers.hubspot.com/docs/developer-tooling/local-development/agent-cli/guide
  - Context: docs/hubspot-api-context/agent-cli-bridge.md
  - Disposition: Saved-report reads and writes delegate to the separately installed HubSpot Agent CLI because no equivalent public app endpoint is documented. HSAPI preserves portal identity checks and mutation gates.
- first_party.views.agent_cli_bridge (external-cli-bridge, first_party.views)
  - Docs: https://developers.hubspot.com/docs/developer-tooling/local-development/agent-cli/guide
  - Context: docs/hubspot-api-context/agent-cli-bridge.md
  - Disposition: CRM saved-view reads and writes delegate to the separately installed HubSpot Agent CLI because no equivalent public app endpoint is documented. HSAPI preserves portal identity checks and mutation gates.
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
