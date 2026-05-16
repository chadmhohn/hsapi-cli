# HubDB

This slice covers the HubSpot HubDB table and row APIs. HubDB is a CMS data store for rows, columns, and cells, and it can back dynamic pages and programmable emails.

## Working Notes

- HubDB tables have draft and published versions.
- Published tables and rows can be public when table access allows it and `portalId` is supplied.
- `GET` requests may be usable through CORS when the table is public.
- Table naming and row shape matter for dynamic pages, so table creation is a content-design task, not just a data write.

## Typed Commands

- `hsapi cms hubdb tables list|get|create`
- `hsapi cms hubdb rows list|create`

## Safety Notes

- Treat table metadata, row data, and draft/published changes as CMS content.
- Creating tables or rows can affect dynamic pages and programmable email rendering.
- Use `--show-request` before any write and keep `--yes` gated.

## Official References

- HubDB guide: https://developers.hubspot.com/docs/api-reference/latest/cms/hubdb/guide
- Get all tables: https://developers.hubspot.com/docs/api-reference/latest/cms/hubdb/tables/get-tables
- Get table: https://developers.hubspot.com/docs/api-reference/latest/cms/hubdb/tables/get-table
- Create table: https://developers.hubspot.com/docs/api-reference/latest/cms/hubdb/tables/create-table
- Get rows: https://developers.hubspot.com/docs/api-reference/latest/cms/hubdb/rows/get-rows
- Add row: https://developers.hubspot.com/docs/api-reference/latest/cms/hubdb/rows/create-row
