# Communication Preferences and Subscriptions

Use these commands for email subscription status checks, opt-in/opt-out updates, opted-out-of-all handling, Enterprise batch subscription operations, and preference-center link generation.

## Common Commands

- `hsapi subscriptions definitions --include-translations true`
- `hsapi subscriptions status ada@example.com`
- `hsapi subscriptions unsubscribe-all-status ada@example.com --verbose true`
- `hsapi subscriptions set-status ada@example.com --subscription-id 123 --status SUBSCRIBED --legal-basis LEGITIMATE_INTEREST_OTHER --legal-basis-explanation "Requested resubscribe" --show-request`
- `hsapi subscriptions unsubscribe-all ada@example.com --show-request`
- `hsapi subscriptions batch-read --emails ada@example.com,grace@example.com`
- `hsapi subscriptions batch-unsubscribe-all-read --emails ada@example.com,grace@example.com`
- `hsapi subscriptions batch-write --inputs @subscription-updates.json --show-request`
- `hsapi subscriptions generate-links ada@example.com --subscription-id 123 --language en`

`hsapi communication-preferences ...` is an alias for the same command family.

## Safety Notes

Subscription status is consent data. Treat email addresses, status output, and generated preference links as sensitive.

Mutating commands require `--yes`:

- `set-status`
- `unsubscribe-all`
- `batch-unsubscribe-all`
- `batch-write`

Read-only POST commands do not require `--yes`, but can expose sensitive consent status:

- `batch-read`
- `batch-unsubscribe-all-read`
- `generate-links`

`generate-links` uses HubSpot's beta v4 preference-page URL API. The returned URLs are contact-specific preference-center links and should only be shared securely with the associated contact.

## Scope and Tier Notes

HubSpot's latest `2026-03` subscription endpoints use dedicated subscription scopes:

- `subscriptions-definition-read` for definition reads.
- `subscriptions-status-read` for single-contact status reads.
- `subscriptions-status-write` for single-contact status updates.
- `subscription-status-batch-read` for batch reads.
- `subscription-status-batch-write` for batch writes.

The batch subscription scopes require a Marketing Hub Enterprise subscription. A 403 on batch endpoints can mean missing app scopes or that the portal is not Enterprise-enabled for those scopes.

If privacy settings are enabled, status writes may require `legalBasis` and `legalBasisExplanation`.

## Brands

Some endpoints support `businessUnitId`, which HubSpot still uses in API fields and query parameters for Brands. The default account brand uses `businessUnitId=0`.

## Official References

- Communication preferences guide: https://developers.hubspot.com/docs/api-reference/latest/communication-preferences/guide
- Preference page URL generation: https://developers.hubspot.com/docs/api-reference/legacy/communication-preferences/generate-url-guide
