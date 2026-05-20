# CMS and Projects Auth Boundary

`hsapi` deliberately keeps HubSpot CMS REST API access separate from HubSpot Projects and local developer tooling.

## CMS REST APIs

Use `hsapi --portal <profile>` for account-scoped CMS REST APIs such as site pages, landing pages, blog posts, URL redirects, domains, site search, indexed data, and source-code API reads or writes.

Those commands use the selected `hsapi` portal profile and its explicit auth family. In ordinary portal profiles, that means `portal_bearer` through `auth.portalBearer.tokenEnv` or the legacy top-level `tokenEnv`. `hsapi auth doctor --portal <profile>` and `--show-request` report the credential source name and auth family without printing token values.

## HubSpot Projects and Local Developer Tooling

Use the official HubSpot CLI directly, or use the explicit `hsapi project ...` bridge when you want `hsapi` to delegate to that CLI with visible provenance:

```bash
hs project list --account <account>
hs project upload --account <account>
hs project dev --account <account>
```

HubSpot Projects are local developer-tooling workflows, not ordinary portal-bearer CMS REST calls. Their auth is owned by the official `hs` CLI and its account or personal-access-key setup. `hsapi project doctor --account <account>` verifies that bridge without mutating anything.

## Non-Negotiable Safety Rules

- `hsapi` must not silently consume `~/.hscli/config.yml` as if it were an `hsapi` portal credential.
- `hsapi` must not silently borrow a HubSpot CLI personal access key for CMS REST API commands.
- A pasted PAK or token from chat is not a safe credential handoff. Use a secret manager, OpenClaw SecretRef, CI secret, or an interactive HubSpot CLI auth flow.
- `hsapi project ...` must make delegation to `hs project ...` obvious, report auth/account provenance without secrets, and keep mutating or deploy-style commands behind an explicit safety gate.

## Troubleshooting Split Access

It is normal for these checks to disagree:

```bash
hsapi cms domains list --portal <profile>
hs project list --account <account>
```

If `hsapi` CMS commands work but `hs project ...` fails, fix the official HubSpot CLI account or PAK setup. If `hs project ...` works but `hsapi` CMS commands fail, fix the `hsapi` portal profile token, scopes, or portal feature access. Do not repair either failure by copying secrets between config files.

Use this order when diagnosing:

1. `hsapi auth doctor --portal <profile>`
2. `hsapi <cms command> --show-request`
3. `hs accounts info <account>`
4. `hsapi project doctor --account <account>`

Keep real account names, portal IDs, token env values, PAKs, and local machine paths out of issue bodies and package docs.
