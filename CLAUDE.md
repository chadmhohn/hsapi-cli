# hsapi-cli

`AGENTS.md` is the canonical repo guide. This file mirrors the same operational rules for Claude-aware tools.

Read first:

- `README.md`
- `docs/INSTALL.md`
- `SECURITY.md`
- `CONTRIBUTING.md`

Install:

```bash
npm install -g .
npm install -g git+ssh://git@github.com/your-org/hsapi-cli.git#<tag-or-branch>
npm install -g ./hsapi-cli-<version>.tgz
```

Update:

- Reinstall from the newer git ref or tarball.
- Once a registry release exists, `npm update -g hsapi-cli` becomes the normal update path.

Rules:

- Never store tokens, portal configs, customer data, or local memory files in the package.
- Keep real portal config outside the package and point to it with `HSAPI_PORTALS_CONFIG`.
- Use `--show-request` before live HubSpot calls.
- Mutations require `--yes`; dangerous schema operations may require an additional danger flag.
