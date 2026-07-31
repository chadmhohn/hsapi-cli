# Contracts

HubSpot's current date-versioned Contracts API is a read surface. HSAPI already reaches it through the generic CRM commands, so a duplicate `contracts` command family is unnecessary.

## Current support

| Operation | HSAPI command | Authority |
| --- | --- | --- |
| List contracts | `hsapi crm list contracts` | Current Contracts guide |
| Get one contract | `hsapi crm get contracts <contractId>` | Current Contracts guide |
| Batch read contracts | `hsapi crm batch-read contracts --ids ...` | Current 2026-03 Contracts OpenAPI |
| Search contracts | `hsapi crm search contracts ...` | Generic CRM search route; validate against the target portal before depending on it |

Examples:

```bash
hsapi crm list contracts \
  --properties hs_name,hs_contract_effective_date \
  --show-request

hsapi crm get contracts 398334119041 \
  --properties hs_name,hs_contract_effective_date \
  --show-request

hsapi crm batch-read contracts \
  --ids 398334119041,399027563070 \
  --properties hs_name,hs_contract_effective_date \
  --show-request
```

The current guide requires Revenue Hub Professional or higher and OAuth scope `crm.objects.contracts.read`. On a dual-auth profile, contract reads are user-audience operations and route through the selected profile's OAuth identity. A prior live validation confirmed the current and legacy list routes with the isolated contract-read scope; entitlement still varies by portal.

The current guide explicitly documents only:

- `GET /crm/objects/2026-03/contracts`
- `GET /crm/objects/2026-03/contracts/{contractId}`

The current Contracts OpenAPI also publishes `POST /crm/objects/2026-03/contracts/batch/read` as a read-only operation. The generated contract-search page uses the generic object search template, but contract search is absent from both the product guide and the dedicated current OpenAPI. The local and remote generic executors therefore permit it with `crm.objects.contracts.read`, while actual support remains a HubSpot runtime/product-tier decision rather than part of the narrow contract-specific promise.

## Write boundary

The current `2026-03` Contracts guide and dedicated OpenAPI do not publish contract writes. Generic commands such as `hsapi crm create contracts` can construct a normal CRM-object request and will still show the usual mutation preview, but request construction is not evidence that the date-versioned Contracts endpoint accepts that write. Do not advertise or automate those requests as supported contract writes.

Legacy v3 contract write pages exist, but they do not establish the contract for the forthcoming public beta. An unannounced generated `2026-09` specification also is not sufficient authority: it is not listed in the public beta overview, does not use a `2026-09-beta` path, and lacks a confirmed auth contract.

## Contract write beta intake plan

When HubSpot grants or publishes the contract-write beta, land it as a separate, evidence-backed tranche:

1. Capture the official beta guide, changelog entry, exact versioned paths, beta terms, and supported product tier.
2. Confirm the public scope name and token type. `crm.objects.contracts.write` is a legacy precedent, not a current-beta assumption.
3. Record create/update/archive bodies, required associations, lifecycle transitions, response codes, idempotency behavior, batch limits, and partial-error semantics.
4. Add exact catalog entries with user/admin token-audience metadata. Keep every mutation `--yes` gated and add an additional danger flag if HubSpot exposes an irreversible delete.
5. Add request-preview, MCP mutation-gate, auth-routing, and disposable-portal tests before marking any write typed.
6. Live-verify account identity, tier access, and a disposable contract lifecycle; do not test writes in a customer or production portal.

Official source: https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contracts/guide
