# Property Validations and Limits

Official docs:

- https://developers.hubspot.com/docs/api-reference/latest/crm/property-validations/guide
- https://developers.hubspot.com/docs/api-reference/latest/crm/limits-tracking/guide
- https://developers.hubspot.com/docs/api-reference/latest/crm/properties/guide

## What These APIs Are For

Property validations constrain values allowed on a CRM property. Limits tracking reports portal-level quotas for records, custom properties, calculated properties, association labels, pipelines, and custom object types.

Use validations to enforce data quality at the field level. Use limits before proposing architecture that adds a lot of custom fields, calculated fields, pipelines, association labels, or custom objects.

## When It Matters

- Checking whether a portal can support a proposed RevOps build before implementation.
- Enforcing required formats or non-empty values on critical fields.
- Auditing how close a portal is to custom-property, calculated-property, association-label, pipeline, or custom-object limits.
- Explaining 403 responses where both token scope and portal tier may be plausible blockers.

## When Not To Use It

- Do not use property validations as a substitute for workflow/business process design.
- Do not add validations to heavily used legacy properties without checking imports, integrations, forms, workflows, and syncs.
- Do not treat a limit endpoint response as permission to create objects. It reports capacity, not full implementation safety.
- Do not assume all limits endpoints are date-versioned; HubSpot currently exposes several under `/crm/v3/limits/...`.

## Access Notes

A 403 on calculated-property, association-label, or custom-object limits can mean the private app token is missing scope, or that the portal tier does not include the feature. Keep those separate in user-facing guidance.

Common tier-sensitive areas:

- Calculated property limits: generally Professional or Enterprise.
- Association-label limits: generally Professional or Enterprise.
- Custom-object type limits: generally Enterprise.

## Commands

Preview existing validation rules:

```bash
hsapi property-validations list 0-3 --show-request
```

Preview setting a validation rule:

```bash
hsapi property-validations set 0-3 dealname NON_EMPTY \
  --arguments '{"value":true}' \
  --show-request
```

Check capacity and tier-sensitive limits:

```bash
hsapi limits records --show-request
hsapi limits custom-properties --show-request
hsapi limits calculated-properties --show-request
hsapi limits association-labels 0-1 0-2 --show-request
hsapi limits pipelines --show-request
hsapi limits custom-object-types --show-request
```

## Gotchas

- Property validations use object type IDs in examples, such as `0-3` for deals; standard object names may not always be accepted by every validation endpoint.
- Validation writes require `--yes`; use `--show-request` first.
- A validation that looks harmless can break imports or integrations if existing upstream data violates the new rule.
- Association label limit checks need both `fromObjectTypeId` and `toObjectTypeId` to answer a specific pair.
- Custom object limits are separate from custom property limits.

## Example Starter Scenarios

- Before a client implementation, run `limits custom-properties` and `limits calculated-properties` to avoid designing fields the portal cannot support.
- Before custom association labels, check `limits association-labels <from> <to>` and then inspect existing labels.
- Before adding hard validations, audit recent imports and integration payloads for likely failures.
