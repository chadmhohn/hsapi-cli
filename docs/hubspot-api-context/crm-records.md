# CRM record operations

Use CRM record commands for direct record-level work after checking object scopes and portal safety. Standard object names such as `contacts`, `companies`, `deals`, and `tickets` are supported, and object type IDs can be used when HubSpot's docs require them.

Use `hsapi crm object-types --family commerce` or `--family activity` when you need the exact object type spelling for broader CRM objects.

Create and update commands accept a JSON `properties` object. Create also accepts HubSpot association specs:

```bash
hsapi crm search deals \
  --filter dealstage:EQ:closedwon \
  --properties dealname,amount \
  --search renewal \
  --sort createdate:DESC \
  --show-request

hsapi crm get contacts 101 \
  --properties email \
  --properties-with-history lifecyclestage,hs_lead_status \
  --show-request

hsapi crm search contacts \
  --filter email:EQ:ada@example.com \
  --properties email \
  --properties-with-history lifecyclestage \
  --show-request

hsapi crm search companies --filter hs_object_id:GT:0 --count-only
hsapi crm list contacts --properties email --ids-only
hsapi crm search companies --filter hs_object_id:GT:0 --properties name --id-name-map
hsapi crm count contacts --filter lifecyclestage:EQ:customer
hsapi crm exists contacts --filter email:EQ:ada@example.com
hsapi crm find-one contacts --filter email:EQ:ada@example.com --properties email,firstname

hsapi crm create contacts \
  --properties '{"email":"ada@example.com","firstname":"Ada"}' \
  --show-request

hsapi crm create deals \
  --properties '{"dealname":"Test deal","pipeline":"default","dealstage":"appointmentscheduled"}' \
  --associations '[{"to":{"id":"123"},"types":[{"associationCategory":"HUBSPOT_DEFINED","associationTypeId":5}]}]' \
  --show-request
```

Archive moves records to HubSpot's recycling bin. Merge keeps the primary record and merges another record into it; it requires `--danger-merge`. GDPR delete is permanent and requires `--danger-gdpr-delete`, and should only be used when the compliance workflow explicitly requires it.

```bash
hsapi crm archive contacts 101 --show-request
hsapi crm merge contacts 101 202 --danger-merge --show-request
hsapi crm gdpr-delete contacts ada@example.com --id-property email --danger-gdpr-delete --show-request
```

Operational guardrails:

- Use `--show-request` first for every mutation or destructive command.
- Use `--count-only`, `crm count`, `crm exists`, or `crm find-one` for simple answer workflows so record arrays are not returned unnecessarily.
- Use `--ids-only`, `--names-only`, or `--id-name-map` when record discovery only needs identifiers or labels. These helpers return compact JSON and can be paired with `--max-results`; do not combine them with `--select`, `--pick`, or `--raw-value`.
- Use `--properties-with-history` only when a workflow needs property version history. It can return substantially larger payloads than current-value `--properties`; keep the property list narrow and prefer `--ids-only`, `--id-name-map`, `--select`, `--pick`, `--compact`, or `--max-results` in token-sensitive runs.
- `crm search --count-only` intentionally omits both `properties` and `propertiesWithHistory` from the HubSpot request body.
- Treat `countType` as part of the answer: `exact` counts can be cited directly; `page-limited` counts prove only the returned page size and whether another page exists.
- Never run create/archive/merge/GDPR-delete against customer/client or other production portals as a test.
- Prefer disposable test records with an `hsapi_test_` prefix when validating write paths.
- GDPR delete can remove data permanently or blocklist an email identifier. Treat it as a compliance action, not cleanup.
