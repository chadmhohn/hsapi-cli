# Forms

The Forms slice covers marketing form definitions, form submission reads, and unauthenticated form submission writes.

Form definitions affect public conversion paths. Form submissions can include personally identifiable information, consent selections, page URLs, uploaded-file references, and campaign context. Treat submission output and submit payloads as sensitive customer data.

## Common Commands

- `hsapi forms list --form-types hubspot --limit 20`
- `hsapi forms get <formId>`
- `hsapi forms create --name "Demo request" --field-groups '[...]' --configuration '{...}'`
- `hsapi forms patch <formId> --name "Updated demo request"`
- `hsapi forms update <formId> --body @form-definition.json`
- `hsapi forms archive <formId>`
- `hsapi forms submissions <formGuid> --limit 20`
- `hsapi forms submit <portalId> <formGuid> --fields '[{"name":"email","value":"ada@example.com"}]'`
- `hsapi forms secure-submit <portalId> <formGuid> --fields '[{"name":"email","value":"ada@example.com"}]'`

## Safety Notes

- Mutating commands require `--yes`.
- `forms archive` stops new submissions and HubSpot permanently deletes the definition after roughly three months.
- `forms create`, `forms patch`, and `forms update` can affect embedded forms, landing pages, workflows, lists, and consent capture. Preview the full request before using `--yes`.
- `forms submissions` returns submitted field values and page URLs. Avoid pasting outputs into shared channels.
- `forms submit` uses HubSpot's unauthenticated `api.hsforms.com` endpoint and sends no bearer token. This is intentional to preserve token-origin safety.
- `forms secure-submit` uses HubSpot's authenticated secure submission endpoint. HubSpot's reference says this endpoint requires authentication, but the published cURL example does not show the auth header; the CLI sends the selected portal bearer token only to this fixed secure form submission host/path.
- Secure form submissions require the selected portal token to be appropriate for that form submission use case. Use `--show-request` before `--yes`.
- HubSpot has a 2026-09 beta Forms URL scheme (`/marketing/forms/2026-09-beta`) that mirrors the stable v3 behavior. These typed commands target stable v3 until the beta path is explicitly adopted.
- Use `--body <json|@file>` for exact form definitions. The convenience flags cover common fields only.

## Official References

- Forms API guide: https://developers.hubspot.com/docs/api-reference/legacy/marketing/forms/guide
- Get forms: https://developers.hubspot.com/docs/api-reference/legacy/marketing/forms/get-forms
- Create form: https://developers.hubspot.com/docs/api-reference/legacy/marketing/forms/create-form
- Patch form: https://developers.hubspot.com/docs/api-reference/marketing-forms-v3/forms/patch-marketing-v3-forms-formId
- Replace form: https://developers.hubspot.com/docs/api-reference/marketing-forms-v3/forms/put-marketing-v3-forms-formId
- Archive form: https://developers.hubspot.com/docs/api-reference/marketing-forms-v3/forms/delete-marketing-v3-forms-formId
- 2026-09 beta Forms guide: https://developers.hubspot.com/docs/api-reference/2026-09-beta/marketing/forms/guide
- Get form submissions: https://developers.hubspot.com/docs/api-reference/legacy/marketing/forms/v1/get-form-integrations-v1-submissions-forms-form_guid
- Submit form data: https://developers.hubspot.com/docs/api-reference/legacy/marketing/forms/v3-legacy/submit-data-unauthenticated
- Secure submit form data: https://developers.hubspot.com/docs/api-reference/legacy/marketing/forms/v3-legacy/submit-data-authenticated
