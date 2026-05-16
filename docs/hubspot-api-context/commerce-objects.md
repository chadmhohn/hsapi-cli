# Commerce objects

The generic CRM record commands cover HubSpot commerce objects through their object type names. Use `hsapi crm object-types --family commerce` to list the current known names and docs URLs before building a request.

Commerce object types currently tracked by the CLI:

- `products`
- `line_items`
- `quotes`
- `invoices`
- `commerce_payments`
- `subscriptions`
- `orders`
- `carts`
- `fees`
- `discounts`
- `taxes`

Examples:

```bash
hsapi crm object-types --family commerce
hsapi crm search products --filter name:CONTAINS_TOKEN:implementation --properties name,price --show-request
hsapi crm create products --properties '{"name":"Implementation Package","price":"2500"}' --show-request
hsapi crm create line_items --properties '{"name":"Implementation Package","quantity":"1","price":"2500"}' --show-request
hsapi crm search commerce_payments --filter hs_createdate:GTE:1704067200000 --properties hs_amount,hs_status --show-request
hsapi crm search subscriptions --filter hs_status:EQ:active --properties hs_name,hs_currency_code --show-request
```

Operational guardrails:

- Commerce object availability can depend on HubSpot payments, Stripe payment processing, Commerce Hub setup, and object-specific scopes.
- Do not test commerce writes in production or customer/client portals. Use the disposable test portal matrix first.
- `subscriptions` here means commerce subscription records. It is separate from marketing communication preferences, which use the top-level `hsapi subscriptions ...` commands.
- Line items are commonly associated with deals, quotes, invoices, or subscriptions after creation. Use `hsapi associations ...` helpers to inspect or create those links.
