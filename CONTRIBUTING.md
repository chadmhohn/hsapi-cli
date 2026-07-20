# Contributing

This source-available repository accepts review and contributions, but the
package remains an internal-use beta under the repository license. Registry
publication and broader use require a separate release and licensing decision.

## Local Checks

Run from this directory:

```bash
npm test
npm run pack:dry-run
npm run test:pack-install
```

Run from the workspace root only when validating the workspace shim against the package implementation:

```bash
npm run test:hsapi
```

## Contribution Rules

- Add or update endpoint catalog metadata with every typed command.
- Add `--show-request` coverage before adding live behavior.
- Include scope, tier, and 403 ambiguity notes for gated HubSpot APIs.
- Keep mutations guarded by `--yes`.
- Keep real portal configs, tokens, client notes, and memory files out of the package.
- Prefer official HubSpot docs as source material.

## Test Portal Rules

Live write tests must use disposable test portals and disposable records/properties/stages with a clear test prefix. Production and customer/client portals are read-only smoke-test targets unless an authorized operator explicitly approves a specific mutation.
