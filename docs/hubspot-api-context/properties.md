# CRM Properties API Context

Official docs: https://developers.hubspot.com/docs/api-reference/latest/crm/properties/guide

## What This API Is For

CRM properties define the fields available on HubSpot CRM objects. Use this API to inspect, create, update, or archive property definitions for objects such as contacts, companies, deals, tickets, and supported custom or newer object type IDs.

## When It Matters

- Auditing portal data architecture.
- Creating fields needed for client implementations.
- Updating labels, descriptions, groups, options, or field behavior.
- Checking whether a property exists before a workflow, import, integration, or report depends on it.
- Comparing client portals without assuming the same fields exist everywhere.

## When Not To Use It

- Do not use it to set values on records. Use CRM object record APIs for that.
- Do not casually modify calculated properties, rollups, or HubSpot-created properties.
- Do not archive properties without checking workflows, reports, forms, lists, imports, integrations, and views.
- Do not use property updates to edit UI-created rollups unless we have confirmed the API preserves the rollup type.

## Important Access Notes

Property writes require the relevant CRM schema/property write access for the object family. If a write returns 403, check both token scopes and product access before assuming the endpoint is broken.

Some property types and behaviors are product- or object-dependent. For example, calculated property limits and custom object schema access may depend on the portal tier.

## hsapi Commands

```bash
node scripts/hsapi.js properties list deals --portal portal-alpha
node scripts/hsapi.js properties names deals --portal portal-alpha
node scripts/hsapi.js properties get deals dealname --portal portal-alpha
node scripts/hsapi.js properties create deals --portal portal-alpha --body @property.json --show-request
node scripts/hsapi.js properties update deals custom_property --portal portal-alpha --label "New Label" --show-request
node scripts/hsapi.js properties archive deals custom_property --portal portal-alpha --show-request
```

Add `--yes` only after reviewing the `--show-request` output.

## Common Gotchas

- `groupName`, not group label, is used when assigning a property to a group.
- Enumeration options should be passed as a JSON array.
- Internal property names are effectively part of the data contract; changing labels is safer than trying to replace names.
- Archiving a property can break workflows, lists, reports, forms, integrations, and imports.
- HubSpot may reject edits to built-in properties or properties used by system features.
- Previous HubSpot work found that updating UI-created rollup properties through API/MCP can downgrade them to plain number fields. Treat rollups as UI-edit-only unless proven safe.

## Example Starter Scenarios

- Create implementation fields after first checking whether they already exist.
- Generate a portal architecture audit with `properties list`, or use `properties names` when only internal names are needed.
- Safely inspect a proposed property write with `--show-request` before adding `--yes`.
- Diagnose a 403 by checking both app scopes and tier-gated feature access.
