# CRM Batch Object Operations

Use CRM object batch operations when an agent needs to read or modify many records of one object type without making one API call per record.

## Commands

- `hsapi crm batch-read <objectType> --ids <id,id|@file> [--properties a,b] [--properties-with-history a,b] [--id-property name]`
- `hsapi crm batch-create <objectType> --inputs <json|@file> [--yes]`
- `hsapi crm batch-update <objectType> --inputs <json|@file> [--id-property name] [--yes]`
- `hsapi crm batch-upsert <objectType> --inputs <json|@file> [--id-property name] [--yes]`
- `hsapi crm batch-archive <objectType> --ids <id,id|@file> [--yes]`

`--inputs` accepts either a JSON array or a JSON object with an `inputs` array. `--body` can be used instead when the exact HubSpot request body should be controlled directly.

## What They Are For

- Batch read: retrieve a specific known set of records by internal ID or by a unique property. This is better than looping over `crm get`.
- Batch create: create many records with properties and optional associations in one request.
- Batch update: update existing records by internal ID or unique property value.
- Batch upsert: create or update by a unique property value. This is the safest choice for sync jobs when the external system has a stable unique key.
- Batch archive: archive many records by internal ID. Treat this as destructive.

## Unique Property Matching

HubSpot supports `idProperty` for unique-property reads and writes. For update/upsert commands, this CLI convenience flag adds `idProperty` to each input object unless that input already sets it.

Example:

```bash
hsapi crm batch-upsert contacts \
  --id-property email \
  --inputs '[{"id":"ada@example.com","properties":{"firstname":"Ada"}}]' \
  --show-request
```

## Access and 403 Notes

A 403 on batch object endpoints usually means one of:

- the private app token is missing the selected object's read or write scope;
- the object type is not available in that portal;
- the portal subscription does not include the object family, especially for custom objects;
- the app can read the object but not write/archive it.

For the example Starter portal, custom object schema access is not expected. Standard objects such as contacts, companies, deals, tickets, line items, and products should be evaluated by token scope first.

## Official References

- Batch read: https://developers.hubspot.com/docs/api-reference/latest/crm/objects/objects/batch/get-objects
- Batch create: https://developers.hubspot.com/docs/api-reference/latest/crm/objects/objects/batch/create-objects
- Batch update: https://developers.hubspot.com/docs/api-reference/latest/crm/objects/objects/batch/update-objects
- Batch upsert: https://developers.hubspot.com/docs/api-reference/latest/crm/objects/objects/batch/upsert-objects
- Batch archive: https://developers.hubspot.com/docs/api-reference/latest/crm/objects/objects/batch/delete-objects
