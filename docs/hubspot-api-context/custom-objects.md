# Custom Objects and 403s

HubSpot custom object and schema endpoints are a frequent source of confusing 403s.

Two different things can block them:

- the private app token is missing the required API scope; or
- the portal subscription does not include custom objects / schemas at all.

Do not assume a 403 is only a scope problem. Check both:

1. the token scopes on the app;
2. the portal tier / subscription availability in the HubSpot tier matrix.

For an example Starter portal, do not treat Starter as having custom object schema access. That means a schema/custom-object-type 403 can be expected even if the app token is otherwise healthy.

Do not use the `Free` tab on HubSpot's APIs-by-tier page by itself as an entitlement check. That tab describes a broad/global API surface. Product-tier rows and live API checks are the relevant source for subscription-gated custom object/schema access.

When in doubt, use:

- `hsapi account subscription` for portal context;
- `hsapi tiers portal` for the tier-aware summary;
- `hsapi schemas list` for the actual failure surface.
