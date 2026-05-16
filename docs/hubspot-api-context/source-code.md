# Source Code

This slice covers HubSpot's CMS Source Code API, which works with the files stored in the HubSpot Developer File System.

## Working Notes

- The key identifiers are `environment` and `path`.
- The API can upload, validate, download, delete, and inspect CMS assets such as templates, modules, CSS, JS, and theme files.
- Validate files before publishing them so HubL and CMS syntax issues show up before live content changes.
- Upload and validate requests use `multipart/form-data` with the binary file in a field named `file`.

## Typed Commands

- `hsapi cms source-code upload <environment> <path> --file <localPath>`
- `hsapi cms source-code validate <environment> <path> --file <localPath>`
- `hsapi cms source-code delete <environment> <path>`

## Safety Notes

- Treat source files as live CMS assets. A bad upload or delete can affect production pages immediately.
- Validate before upload when you can, especially for templates and modules.
- Use `--show-request` before any mutation and keep `--yes` gated.

## Official References

- Source Code guide: https://developers.hubspot.com/docs/api-reference/latest/cms/source-code/guide
- Create or update a file: https://developers.hubspot.com/docs/api-reference/latest/cms/source-code/update-source-code-file
- Download a file: https://developers.hubspot.com/docs/api-reference/latest/cms/source-code/get-source-code-file
- Validate a file: https://developers.hubspot.com/docs/api-reference/latest/cms/source-code/validate-source-code-file
- Delete a file: https://developers.hubspot.com/docs/api-reference/latest/cms/source-code/delete-source-code-file
