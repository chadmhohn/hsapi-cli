# Association Record Operations

Use association record operations when an agent needs to inspect, create, label, or remove relationships between existing CRM records.

## Commands

- `hsapi associations types <fromType> <toType>`
- `hsapi associations list <fromType> <fromId> <toType>`
- `hsapi associations create-default <fromType> <fromId> <toType> <toId> [--yes]`
- `hsapi associations create <fromType> <fromId> <toType> <toId> --category <category> --type-id <id> [--yes]`
- `hsapi associations delete <fromType> <fromId> <toType> <toId> [--yes]`
- `hsapi associations batch-read <fromType> <toType> --ids <id,id|@file>`
- `hsapi associations batch-create-default <fromType> <toType> --inputs <json|@file> [--yes]`
- `hsapi associations batch-create <fromType> <toType> --inputs <json|@file> [--yes]`
- `hsapi associations batch-archive <fromType> <toType> --inputs <json|@file> [--yes]`
- `hsapi associations batch-labels-archive <fromType> <toType> --inputs <json|@file> [--yes]`

## What They Are For

- `types` returns available association labels/type IDs for a directional object pair.
- `list` and `batch-read` retrieve associated records. Batch read is the right choice for migration audits and avoiding one request per source record.
- `create-default` and `batch-create-default` create unlabeled/default associations.
- `create` and `batch-create` create labeled associations by `associationCategory` and `associationTypeId`.
- `delete` and `batch-archive` remove all associations between the specified record pairs.
- `batch-labels-archive` removes only specific labels from an association while leaving other labels or the unlabeled association intact when present.

## Direction Matters

Association type IDs are directional. A contact-to-company type ID is not necessarily the same as company-to-contact. Always run `hsapi associations types <fromType> <toType>` for the same direction you plan to write.

Example:

```bash
hsapi associations types contacts companies --show-request
hsapi associations create contacts 101 companies 9001 \
  --category HUBSPOT_DEFINED \
  --type-id 279 \
  --show-request
```

## Access and 403 Notes

A 403 on association record endpoints can mean:

- the private app token is missing read/write scope for one of the involved object types;
- the object family is unavailable in the portal;
- the selected custom object or custom label is subscription-gated;
- the association type ID is for the opposite direction or the wrong object pair.

For Starter portals, standard-object associations are usually a scope/config issue first. Custom-object associations should also be checked against portal subscription access.

## Official Reference

- https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/guide
