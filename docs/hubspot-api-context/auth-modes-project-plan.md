# Auth Modes Project Plan

Last updated: 2026-05-14

## Goal

Make `hsapi` support every HubSpot auth family it needs without pretending every endpoint can use the same bearer token.

The CLI should make auth requirements explicit, safe, and agent-readable:

- portal bearer auth for normal account-scoped HubSpot API work;
- OAuth installed-app auth for multi-account and refresh-token flows;
- developer auth for developer-platform endpoints that require a personal access key, developer API key, or client-credentials token.

A command must never silently fall back from one auth family to another. If a profile lacks the required credential, `hsapi` should fail with a clear message that names the required auth family and the missing profile field or environment variable.

## Auth Families

### 1. Portal bearer auth

Primary use: CRM, CMS, forms, automation, files, properties, associations, and other account-scoped endpoints that accept `Authorization: Bearer ...`.

Supported credential sources:

- private app access token;
- static app access token for single-account app installs;
- existing portal profile token environment variable, e.g. `HUBSPOT_ACCESS_TOKEN_PORTAL_ALPHA`.

Design notes:

- This is the existing default, but it should become an explicit profile auth family instead of an implicit assumption.
- `--show-request` should continue to show the token environment variable name, not the token value.
- Absolute URL origin guards remain mandatory before sending a portal bearer token.

### 2. OAuth installed-app auth

Primary use: public/private app installs across one or more accounts where access tokens expire and refresh tokens must be managed.

Supported credential sources:

- OAuth client ID;
- OAuth client secret;
- refresh token;
- short-lived access token cache generated from the refresh token.

Design notes:

- Existing `hsapi auth authorize-url|token|refresh|introspect|revoke` commands are the foundation.
- Request execution should be able to resolve an OAuth-backed portal profile, refresh when needed, and then send `Authorization: Bearer ...`.
- Tokens and secrets must remain redacted by default; reveal only through explicit `--show-secrets` where a command already supports it.
- Revocation remains guarded by both `--danger-revoke-token` and `--yes`.

### 3. Developer auth

Primary use: developer-platform and app-management surfaces that do not use the normal account bearer token.

Credential variants:

- personal access key for HubSpot CLI/local developer tooling workflows;
- developer API key for endpoints documented with `hapikey` and often `appId` query parameters;
- client-credentials token for app-global feature management such as webhook journal cases that require app-level OAuth client credentials.

Design notes:

- Treat this as a distinct auth family with subtypes, not as portal bearer auth.
- Developer API key query params must be injected only for endpoints explicitly marked as requiring them.
- Client-credentials tokens should have a short-lived cache and refresh path separate from installed-app OAuth refresh tokens.
- Personal access key support should be conservative: document exactly which command surfaces need it and avoid using it for general HubSpot API calls unless official HubSpot tooling requires that shape.

## Config Shape Proposal

Existing portal profiles should remain backward compatible. New fields can be optional and additive.

```json
{
  "profiles": {
    "example": {
      "portalId": "<portal-id>",
      "baseUrl": "https://api.hubapi.com",
      "tokenEnv": "HUBSPOT_ACCESS_TOKEN_EXAMPLE",
      "auth": {
        "defaultFamily": "portal_bearer",
        "portalBearer": {
          "tokenEnv": "HUBSPOT_ACCESS_TOKEN_EXAMPLE",
          "kind": "private_app"
        },
        "oauth": {
          "clientIdEnv": "HUBSPOT_CLIENT_ID_EXAMPLE",
          "clientSecretEnv": "HUBSPOT_CLIENT_SECRET_EXAMPLE",
          "refreshTokenEnv": "HUBSPOT_REFRESH_TOKEN_EXAMPLE",
          "tokenCachePath": "~/.config/hsapi/oauth/example-token-cache.json"
        },
        "developer": {
          "personalAccessKeyEnv": "HUBSPOT_PERSONAL_ACCESS_KEY_EXAMPLE",
          "developerApiKeyEnv": "HUBSPOT_DEVELOPER_API_KEY_EXAMPLE",
          "appIdEnv": "HUBSPOT_APP_ID_EXAMPLE",
          "clientIdEnv": "HUBSPOT_DEVELOPER_CLIENT_ID_EXAMPLE",
          "clientSecretEnv": "HUBSPOT_DEVELOPER_CLIENT_SECRET_EXAMPLE",
          "tokenCachePath": "~/.config/hsapi/developer/example-token-cache.json"
        }
      }
    }
  }
}
```

Compatibility rule: if `auth.portalBearer` is absent but `tokenEnv` exists, treat the profile as a legacy portal-bearer profile and emit no warning in normal use. Documentation should encourage the explicit `auth` block for new profiles.

## Endpoint Catalog Proposal

Each typed command or catalog endpoint should be able to declare auth requirements.

Suggested metadata:

```json
{
  "auth": {
    "family": "portal_bearer",
    "subtype": "private_app_or_static_app",
    "fallback": "none",
    "queryParams": [],
    "scopes": ["crm.objects.contacts.read"]
  }
}
```

Developer API key example:

```json
{
  "auth": {
    "family": "developer",
    "subtype": "developer_api_key",
    "fallback": "none",
    "queryParams": ["hapikey", "appId"]
  }
}
```

Client credentials example:

```json
{
  "auth": {
    "family": "developer",
    "subtype": "client_credentials",
    "fallback": "none",
    "scopes": ["developer.webhooks_journal.read"]
  }
}
```

## Implementation Phases

### Phase 0 — Auth contract and inventory

Deliverables:

- Add shared auth-family vocabulary: `portal_bearer`, `oauth`, and `developer`.
- Inventory existing typed commands and catalog endpoints by required auth family.
- Add tests proving the resolver refuses unknown or missing auth families.
- Add docs that explain the no-silent-fallback rule.

Acceptance criteria:

- `--show-request` includes the resolved auth family and credential source name without leaking secret values.
- Commands with missing auth config fail before any HTTP request is made.
- Existing profiles with only `tokenEnv` continue to work as portal-bearer profiles.

### Phase 1 — Harden portal bearer auth

Deliverables:

- Refactor existing token resolution into a dedicated portal-bearer resolver.
- Add explicit `auth.portalBearer` profile support while preserving legacy `tokenEnv`.
- Add endpoint/catalog metadata defaults for existing account-scoped commands.
- Add tests for origin guards, redaction, mutation previews, and legacy profile compatibility.

Acceptance criteria:

- Current portal-alpha and portal-beta profiles keep working without config churn.
- `hsapi account details --show-request` clearly reports `authFamily: portal_bearer`.
- No command sends a bearer token to a non-HubSpot or mismatched absolute URL.

### Phase 2 — OAuth-backed request execution

Deliverables:

- Add OAuth credential resolver that can refresh access tokens from a configured refresh token.
- Add a redacted token cache contract with expiry metadata.
- Extend request execution so commands marked `auth.family = oauth` use OAuth access tokens.
- Expand `auth refresh` tests to cover runtime resolver behavior, not only direct helper commands.

Acceptance criteria:

- OAuth profiles can run `--show-request` without requiring a live token refresh.
- Live execution refreshes only when needed and redacts access/refresh tokens in output.
- Failed refreshes produce actionable errors naming the missing env var or HubSpot response class.

### Phase 3 — Developer API key and personal access key support

Deliverables:

- Add developer auth resolver with explicit subtypes:
  - `personal_access_key`;
  - `developer_api_key`;
  - `client_credentials`.
- Inject `hapikey`/`appId` only for endpoints marked `developer_api_key`.
- Document which HubSpot developer surfaces use personal access keys versus developer API keys.
- Add tests proving developer credentials are never used for portal-bearer endpoints.

Acceptance criteria:

- A developer-key command shows `authFamily: developer`, `authSubtype: developer_api_key`, and redacted query credential source in `--show-request`.
- Missing `appId` or developer key fails before request execution.
- Personal access key usage is limited to documented CLI/developer-tooling surfaces.

### Phase 4 — Developer client-credentials support

Deliverables:

- Add client-credentials token generation/cache for developer auth subtypes that require app-level OAuth.
- Keep this cache separate from installed-app OAuth access-token caches.
- Add catalog metadata for the developer endpoints that require client-credentials scopes.
- Add tests for expiry, refresh, redaction, and missing-scope messaging.

Acceptance criteria:

- Client-credentials endpoints can acquire and reuse short-lived tokens safely.
- `--show-request` reports the intended grant type and scopes without printing secrets.
- Installed-app OAuth and developer client-credentials caches cannot be confused.

### Phase 5 — Agent UX, docs, and release gate

Deliverables:

- Update `README.md`, `docs/INSTALL.md`, `examples/portals.sample.json`, and test-matrix docs.
- Add troubleshooting copy for 401/403 cases by auth family.
- Add `hsapi auth doctor` or equivalent profile validation if the command surface warrants it.
- Add release checklist gates for secret redaction and auth-family coverage.

Acceptance criteria:

- A new agent can tell which auth family a command requires before running it.
- Package tests, pack-install smoke, and catalog coverage checks pass.
- No package file contains real credentials, portal secrets, token caches, or local machine config.

## GitHub Issue Seed List

Create one GitHub issue per phase so the work can be delegated safely:

1. `Auth modes Phase 0: contract, vocabulary, and endpoint inventory`
2. `Auth modes Phase 1: explicit portal bearer resolver`
3. `Auth modes Phase 2: OAuth-backed request execution`
4. `Auth modes Phase 3: developer API key and personal access key resolver`
5. `Auth modes Phase 4: developer client-credentials resolver`
6. `Auth modes Phase 5: docs, auth doctor, and release gates`

Recommended labels:

- `auth`
- `safety`
- `agent-ux`
- `developer-platform`

Each issue should include:

- the phase deliverables;
- acceptance criteria;
- required docs/tests;
- explicit note: no silent auth fallback.

## Open Questions

- Should personal access key support be limited to wrapping official HubSpot CLI/developer-tooling behaviors, or should `hsapi` expose direct API calls where HubSpot documents PAK usage?
- Should developer auth live under the same portal profile, under a separate `developerProfiles` map, or both?
- Should token caches be opt-in by config path, or should `hsapi` choose a default path under `~/.config/hsapi/` when env credentials are present?
- Should `hsapi auth doctor` be a new command now, or wait until OAuth and developer auth resolvers are both implemented?
