# CRM Pipelines API Context

Official docs: https://developers.hubspot.com/docs/api-reference/latest/crm/pipelines/guide

## What This API Is For

Pipelines define the lifecycle stages records move through for pipeline-backed CRM objects such as deals, tickets, leads, appointments, courses, listings, orders, services, and custom objects where available.

## When It Matters

- Auditing or documenting deal/ticket process architecture.
- Creating or modifying client sales/service processes.
- Checking pipeline IDs and stage IDs before imports, workflows, reports, or migrations.
- Tracking changes through pipeline and stage audit endpoints.

## When Not To Use It

- Do not delete or reorder stages casually. Records, reports, workflows, forecasting, routing, views, and integrations may depend on stage IDs.
- Do not create deal stages without `metadata.probability`; HubSpot requires probability for deal stages.
- Do not assume all portals can create multiple pipelines. Subscription tier and hub access matter.

## hsapi Commands

```bash
node scripts/hsapi.js pipelines list deals --portal portal-alpha
node scripts/hsapi.js pipelines list deals --portal portal-alpha --id-name-map
node scripts/hsapi.js pipelines get deals default --portal portal-alpha
node scripts/hsapi.js pipelines stages deals default --portal portal-alpha
node scripts/hsapi.js pipelines stage-create deals default --label "Contract signed" --display-order 4 --metadata '{"probability":"0.8"}' --portal portal-alpha --show-request
node scripts/hsapi.js pipelines stage-update deals default contractsigned --label "Contract signed updated" --portal portal-alpha --show-request
node scripts/hsapi.js pipelines stage-delete deals default contractsigned --portal portal-alpha --show-request
node scripts/hsapi.js pipelines stage-audit deals default contractsigned --portal portal-alpha
```

Add `--yes` only after reviewing `--show-request` output and checking downstream dependencies.

## Common Gotchas

- Pipeline and stage IDs are durable integration contracts. Label changes are safer than ID replacement.
- Use `--ids-only`, `--names-only`, or `--id-name-map` on pipeline and stage list responses when you only need compact IDs and labels.
- For deals, stage metadata must include a probability between `0.0` and `1.0`.
- For tickets, stage metadata can include ticket state values such as `OPEN` or `CLOSED`.
- HubSpot supports reference validation when deleting a pipeline, but stage deletes still require careful dependency review.
- Leads and custom objects have tier constraints; a 403 may mean missing scope, product access, or object availability.

## Example Starter Scenarios

- Audit a client pipeline before a CRM cleanup or migration.
- Preview proposed pipeline/stage changes with `--show-request` before executing.
- Use audit endpoints to understand who changed stages or pipeline configuration.
- Pair with limits endpoints before large-scale architecture changes.
