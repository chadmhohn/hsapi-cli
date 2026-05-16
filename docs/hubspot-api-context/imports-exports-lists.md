# Imports, Exports, and Lists

These APIs are high-impact operational surfaces. Use `--show-request` first, keep files and export URLs private, and run mutations only with `--yes`.

## Lists

Lists are now managed through the latest ILS list APIs under `/crm/lists/2026-03`. Older v1 list IDs and behaviors are different; do not assume old list IDs or legacy list APIs match these commands.

Common commands:

- `hsapi lists search --search "Renewals" --count 20`
- `hsapi lists search --search "Renewals" --id-name-map --max-results 20`
- `hsapi lists get <listId>`
- `hsapi lists get-by-name <objectTypeId> <listName>`
- `hsapi lists create --name <name> --object-type-id <objectTypeId> --processing-type MANUAL`
- `hsapi lists membership-update <listId> --add 101,102 --remove 103 --yes`
- `hsapi lists memberships-clear <listId> --yes`

Manual and snapshot lists can have memberships updated directly. Dynamic lists are filter-driven; update the list filter body rather than trying to add/remove members manually.

Use `--ids-only`, `--names-only`, or `--id-name-map` for list discovery when full list definitions are unnecessary. These helpers are compact and can be paired with `--max-results`.

## Exports

Exports can expose large amounts of CRM data and completed export responses may include temporary download URLs. Treat all export output as sensitive.

Common commands:

- `hsapi exports start --export-name "Contact export" --object-type contacts --properties email,firstname --format CSV`
- `hsapi exports status <taskId>`
- `hsapi exports get <exportId>`

Use `--body <json|@file>` for advanced export options.

## Imports

Imports are multipart requests. The CLI uses `--import-request <json|@file>` plus one or more `--file <path>` flags.

Example:

```bash
hsapi imports start \
  --import-request @import-request.json \
  --file ./contacts.csv \
  --show-request
```

Imports can create/update many records, create lists, and change marketing contact status depending on the import request. Use disposable test portals and small files before running broad client imports.

## Access and 403 Notes

A 403 can mean:

- missing object read/write scopes;
- missing list, import, or export scopes for the app;
- a portal subscription or product feature does not include the selected operation;
- attempting to update memberships for a dynamic list;
- trying to import into or export from an object family that is unavailable in that portal.

## Official References

- Lists: https://developers.hubspot.com/docs/api-reference/latest/crm/lists/guide
- Imports: https://developers.hubspot.com/docs/api-reference/latest/crm/imports/guide
- Exports: https://developers.hubspot.com/docs/api-reference/latest/crm/exports/guide
