# Test Portal Matrix

Phase 2.8 defines the portal fixtures needed before package beta and before any broad live-write testing.

The goal is not to store credentials in this repo. The goal is to define a repeatable contract for private portal config files that live outside the package and point to token environment variables.

Each fixture must declare its intended auth family explicitly. The sample matrix keeps the legacy top-level `tokenEnv` for the smoke-test harness and also declares `auth.defaultFamily: "portal_bearer"` plus `auth.portalBearer.tokenEnv` so agents can tell the fixture is exercising portal bearer auth.

## Fixture Roles

| Role | Purpose | Required? | Live writes? |
| --- | --- | --- | --- |
| `free_like` | Broad global API surface checks and no-plan assumptions. | Yes | No |
| `starter_like` | Standard CRM reads and Starter-style tier guidance. | Yes | No |
| `professional_like` | Professional tier checks such as calculated-property and association-label limits. | Yes | No |
| `enterprise_like` | Enterprise-only reads, custom objects, schemas, and Marketing Hub Enterprise batch preference checks. | Yes | No by default |
| `no_custom_objects` | Empty-schema guidance for portals that have no user-defined custom objects. | Yes | No |
| `disposable_write` | Gated mutation tests against disposable records, properties, stages, lists, and imports. | Before beta | Yes, only with explicit write-test env gates |

## Safety Contract

- Real portal config files must stay outside the package.
- Tokens must only appear in environment variables, never in JSON config.
- Fixture auth families must be explicit in the private matrix config. Portal-bearer fixtures use `auth.portalBearer.tokenEnv`; OAuth and developer fixtures must use the matching `auth.oauth` or `auth.developer` blocks.
- Portal Alpha and client production portals are read-only smoke-test targets.
- Live mutation tests must require both a disposable portal profile and an explicit write-test env gate.
- Test-created assets should use a stable prefix such as `hsapi_test_` so cleanup is deterministic.
- Expected 403s must be reported as possible scope-or-tier ambiguity when both explanations are plausible.
- `no_custom_objects` should assert `schemas list` returns HTTP 200 with zero custom-object schemas, not a 403. HubSpot developer test accounts can expose the schema endpoint even when no custom object schemas exist.

## Minimum Read Smoke Coverage

- `account details`
- `tiers portal`
- `properties list contacts`
- `pipelines list deals`
- `limits custom-properties`
- `limits calculated-properties`
- `limits association-labels 0-1 0-2`
- `limits custom-object-types`
- `schemas list` on an Enterprise-like portal and on a no-custom-objects portal, with the latter expected to return an empty result set

## Disposable Write Coverage

These must only run against `disposable_write`:

- create/update/archive a disposable CRM property
- create/archive a disposable property group
- create/update/delete a disposable pipeline stage
- create/restore/delete a disposable list
- create/update/archive disposable CRM records
- create/cancel a tiny disposable import where supported

## Example Config

Use `examples/portals.test-matrix.sample.json` as the public shape. Copy it outside the package, replace placeholder portal IDs, and set only the listed token environment variables.

Use `commandExpectations` when a live fixture should accept or warn on a specific HTTP status without turning the whole run red. The first real use case is HubSpot developer CLI personal-access-key auth: some endpoints return `403 User level OAuth token is not allowed for this endpoint.` even though adjacent read endpoints work. Those should be accepted as auth-mode limitations and tracked separately from transport or command failures.

Use `disposableWriteExpectations` when the disposable fixture is intentionally running with a limited token and a write endpoint should be reported as an expected scope/auth-mode block instead of a hard harness failure.

## Private Fixture Tracking

Keep concrete portal IDs, HubSpot CLI account names, private config paths, secret-manager item names, and local machine paths out of this package. Track those details in the private matrix config, a private runbook, or the secret manager, not in package docs.

Private fixture records should include:

- fixture role and profile name;
- intended auth family and subtype, if any;
- portal ID and plan label;
- token environment variable names only;
- latest live-read and disposable-write smoke results;
- accepted 401/403 expectations and the reason they are expected;
- cleanup notes for disposable write assets.

## Recording Live Matrix Results

When recording a live matrix run in repo docs, keep the entry generic and secret-free:

- command shape, such as `node scripts/live-read-smoke.js --json` or `node scripts/disposable-write-smoke.js --plan-only --json`;
- result status and summary counts;
- fixture roles affected;
- accepted 401/403 findings by auth family;
- any catalog, test-harness, or fixture-contract changes made.

Do not record local config paths, local usernames, concrete portal IDs, token values, secret-manager item names, or customer/client identifiers in package files.
