# App Management APIs

The catalog tracks app uninstall and public-app feature flags as app-management surfaces. They are intentionally catalog-only: use the generic `hsapi request` command, inspect `--show-request`, and confirm every mutation with `--yes`.

## App Uninstall

`DELETE /appinstalls/2026-03/external-install` uses the installed account's OAuth access token and requires the `oauth` scope. It uninstalls the app from the account, returns `204`, and causes HubSpot to notify the account's administrators. Confirm the selected portal identity before executing it and treat integration access as terminated afterward.

```bash
hsapi request DELETE /appinstalls/2026-03/external-install --portal <profile> --show-request
hsapi request DELETE /appinstalls/2026-03/external-install --portal <profile> --yes
```

Do not substitute a private-app token or developer API key for the installed app's OAuth identity.

## Feature Flags

Feature flags apply to legacy public apps migrating features such as CRM cards into HubSpot's developer-project framework. The current guide shows a developer account API key supplied as `hapikey`; accordingly, these catalog entries require `developer/developer_api_key` and never fall back to portal bearer or installed-app OAuth credentials.

The generated OpenAPI contract also labels reads with `developers-read` and writes with `developers-write`. Both requirements are recorded in catalog metadata because HubSpot's guide and generated authorization labels currently describe the same surface differently. Re-check the official guide before promoting these operations to typed commands.

Example preview:

```bash
hsapi request GET /feature-flags/2026-03/<appId>/flags/all --portal <developer-profile> --show-request
```

Feature-flag writes affect customer rollout state. Use a developer test account first, preview the exact app, flag, and portal IDs, and supply request bodies through `--body <json|@file>`.

## Official References

- App uninstall: https://developers.hubspot.com/docs/api-reference/latest/app-management/app-uninstalls/guide
- Feature flags: https://developers.hubspot.com/docs/api-reference/latest/app-management/feature-flags/guide
