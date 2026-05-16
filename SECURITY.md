# Security

## Secrets

Do not put HubSpot private app tokens, OAuth tokens, client portal configs, local memory files, or customer data in this package.

Portal config files should only contain token environment variable names, never token values. Keep real configs outside the package directory and point to them with `HSAPI_PORTALS_CONFIG`.

## Safe Operation

- Prefer `--show-request` before using unfamiliar commands.
- Mutations require `--yes`; destructive schema operations may require an additional danger flag.
- Do not run live write tests against production portals.
- Use disposable HubSpot developer/test portals for write tests.

## Reporting Security Issues

While this repository remains private, report issues internally to the maintaining organization or in the private GitHub repository.

Before any public release, update this file with the repository's private security advisory or external disclosure process.
