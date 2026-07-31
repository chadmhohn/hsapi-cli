# 2026-07-30 User-Level OAuth Scope Recheck

## Result

The 2026.03 `HSAPI Remote MCP` user-level public app still rejected all 23
scopes that the 2025.2 app rejected on July 18. Each candidate project build
succeeded, but deployment failed with:

```text
The scope <scope> could not be recognized. Check your scope and try again.
```

Probe builds 2 through 24 tested one candidate at a time. Build 25 restored and
successfully deployed the known-good 49-optional-scope baseline. Failed probe
builds never replaced the deployed app.

This proves that changing the project platform version to 2026.03 and accepting
the app acceptable-use policy did not, by themselves, make these scopes
deployable for this user-level app.

## Rejected scopes

- `crm.objects.appointments.read`
- `crm.objects.appointments.write`
- `crm.objects.carts.write`
- `crm.objects.commercepayments.read`
- `crm.objects.courses.read`
- `crm.objects.courses.write`
- `crm.objects.custom.read`
- `crm.objects.custom.write`
- `crm.objects.feedback_submissions.read`
- `crm.objects.leads.read`
- `crm.objects.leads.write`
- `crm.objects.listings.read`
- `crm.objects.listings.write`
- `crm.objects.quotes.write`
- `crm.objects.services.read`
- `crm.objects.services.write`
- `crm.objects.users.read`
- `crm.objects.users.write`
- `crm.schemas.custom.read`
- `crm.schemas.custom.write`
- `crm.schemas.quotes.read`
- `crm.schemas.quotes.write`
- `dashboard.external.read`

## Documentation mismatch

HubSpot's public-app scope guide now contains 20 of those 23 names. It also
uses `crm.objects.custom.read` as the example of an Enterprise-only optional
scope. The three names absent from that general scope page at recheck time were:

- `crm.objects.feedback_submissions.read`
- `crm.schemas.custom.write`
- `dashboard.external.read`

The current custom record and schema API guides separately document custom
record/schema read and write scope families. Documentation presence therefore
means a scope is intended or documented; it does not yet prove that the
user-level project deployment registry accepts it.

Official references:

- <https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/scopes>
- <https://developers.hubspot.com/docs/api-reference/latest/crm/objects/custom-objects/guide>
- <https://developers.hubspot.com/docs/api-reference/latest/crm/objects/schemas/guide>

## Repository policy

- Keep the active local and remote app manifests on the known-good 49-scope
  optional profile.
- Keep the 19-scope read profile as the remote read boundary. The later
  production write rollout adds only the separate reviewed 12-scope write
  profile and does not change this rejected-scope evidence.
- Keep strict custom record/schema read planning and tests staged behind actual
  granted-scope checks.
- Keep the four custom record/schema scope names in
  `scopeRecheckCandidates.customObjects` rather than active app configuration.
- Re-run isolated app deployment probes before enabling any formerly rejected
  scope. Do not infer acceptance from documentation or platform version alone.
