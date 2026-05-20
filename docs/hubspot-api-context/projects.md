# HubSpot Projects Bridge

`hsapi project ...` is an explicit bridge to the official HubSpot CLI project workflow. It does not use `hsapi` portal bearer auth, and it does not treat `~/.hscli/config.yml` as an `hsapi` credential source.

## Commands

- `hsapi project doctor --account <account>` checks the `hs` binary, the selected HubSpot CLI account, and project-list readiness.
- `hsapi project list --account <account>` delegates to `hs project list --account <account>`.
- `hsapi project info|list-builds|logs|validate|lint ... --account <account>` delegates read-only or local-validation commands to `hs project ...`.
- `hsapi project upload|deploy|delete|create|add|download|migrate|install-deps|update-deps ... --account <account> --yes` delegates mutating, deploy-style, or local-write commands after explicit confirmation.

Interactive, browser-opening, deprecated, or long-running project commands such as `dev`, `watch`, `open`, and `profile` are intentionally not bridged. Run those directly with the official HubSpot CLI when an operator is present.

## Safety Contract

- `--account <account>` is required; the bridge refuses to rely on the HubSpot CLI default account.
- `--show-request` previews the delegated `hs project ...` command without executing it.
- Mutating, deploy-style, and local-write project commands are blocked unless `--yes` is present.
- Output reports `delegatedTo: "official_hubspot_cli"` and the exact delegated argv.
- Output redacts token-like values from captured stdout and stderr.
- Tests use a mocked `hs` binary and do not require real HubSpot CLI credentials.

## Auth Boundary

Use `hsapi --portal <profile>` for CMS REST APIs. Use `hsapi project ... --account <account>` only when you intentionally want to delegate to the official `hs project ...` workflow and its HubSpot CLI account auth.

If `hsapi cms doctor --portal <profile>` passes but `hsapi project doctor --account <account>` fails, fix the official HubSpot CLI account/auth setup. If the project doctor passes but CMS REST commands fail, fix the `hsapi` portal token, scopes, or portal feature access.
