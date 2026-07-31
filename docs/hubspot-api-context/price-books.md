# Price books

Price Books is a Revenue Hub Professional public beta. HubSpot's documentation navigation now lives under `revenue/price-books`, while every API route remains under `/commerce/price-books/2026-09-beta/...`.

## Typed read support

HSAPI promotes the four GET operations and the non-mutating validation POST:

```bash
hsapi price-books list --limit 20 --show-request
hsapi price-books list --archived --paginate --show-request
hsapi price-books get 418966139535 --show-request
hsapi price-books items-list 418966139535 --limit 100 --show-request
hsapi price-books item-get 418966139535 418968256821 --show-request
hsapi price-books validate 418966139535 --show-request
```

`price-books validate` uses `POST`, but it only runs the activation checks and does not change the book's status. Its catalog entry is marked `readOnlyPost`, so the read-only MCP request executor can call it.

The `cpq.price_books.read` permission applies to a private-app bearer rather than a public-app OAuth grant. HSAPI therefore marks this family as admin audience: a dual-auth portal profile uses its local ServiceKey and never routes Price Books through user OAuth. The remote OAuth MCP does not expose these endpoints.

## Catalog-backed beta writes

All 16 published beta method/path pairs are cataloged, so generic CLI requests and MCP execution receive exact auth, scope, tier, and mutation-risk metadata. The 11 write operations remain catalog-only while the beta contract is changing:

| Capability | Method and suffix | Risk posture |
| --- | --- | --- |
| Create book | `POST /price-books` | Mutation; `--yes` required |
| Update or archive book | `PATCH /price-books/{priceBookId}` | Conservatively destructive; shared beta semantics |
| Delete book | `DELETE /price-books/{priceBookId}` | Destructive and experimental |
| Activate/deactivate | `POST /{priceBookId}/activate` or `/deactivate` | Mutation; documented idempotent no-op in target state |
| Add product | `POST /{priceBookId}/items` | Mutation; public operation page lists `cpq.price_books.write` |
| Update or archive/restore item | `PATCH /{priceBookId}/items/{priceBookItemId}` | Conservatively destructive; shared beta semantics |
| Delete item | `DELETE /{priceBookId}/items/{priceBookItemId}` | Destructive and experimental |
| Batch create/update/archive items | `POST /items/batch/{create|update|archive}` | Archive is destructive; batch size is 100 |

Preview a generic mutation before executing it:

```bash
hsapi request POST \
  /commerce/price-books/2026-09-beta/price-books/418966139535/activate \
  --show-request

hsapi request POST \
  /commerce/price-books/2026-09-beta/price-books/418966139535/activate \
  --yes
```

Writes use the private-app `cpq.price_books.write` access scope. The family guide also lists `crm.objects.products.read`, and generated OpenAPI attaches an internal product-library read alias to product-copy and item-update operations. HSAPI records that inconsistency instead of declaring the product-read scope as jointly required without live proof.

## Beta behavior and guardrails

The normal workflow is create inactive book, update metadata/currencies, add product snapshots, set item prices, validate, then activate. Active books cannot be edited. Deals can be associated to a price book through the Associations API; HubSpot then carries that association to quotes and approved contracts. Creating line items from price book items must happen in HubSpot, not through this API.

Do not promote the write operations to typed commands until a beta-enabled disposable portal resolves these current documentation conflicts:

- The guide says a book is irreversibly deleted by `PATCH` with `{"archived":true}`; the endpoint reference/OpenAPI also publishes a permanent `DELETE` route.
- The guide archives/restores an item through `PATCH` with a body containing only `archived`; restore also requires `?archived=true`. The endpoint reference/OpenAPI separately publishes `DELETE`. Archived items are documented as purged after 90 days.
- The guide says book creation requires `name` and `supportedCurrencies`; the generated schema also marks `customProperties` required.
- The guide says successful batch item creation returns `200`, while generated OpenAPI says `201`; partial failures return `207`.

These are public-beta endpoints and can change. Always start with `--show-request`, use a disposable beta-enabled portal for writes, and re-check the official operation page before encoding payloads into automation.

Official source: https://developers.hubspot.com/docs/api-reference/2026-09-beta/revenue/price-books/guide
