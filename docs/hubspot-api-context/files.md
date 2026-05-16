# Files and Folders

The Files API manages assets in HubSpot's file manager: images, documents, branding files, form uploads, and files that may later be attached to CRM records through notes.

Use `--show-request` before every write. File outputs can include public URLs, signed URLs, folder paths, and private asset names.

## Common Commands

- `hsapi files search --name logo --limit 20`
- `hsapi files search --name logo --id-name-map --max-results 20`
- `hsapi files get <fileId> --properties name,url,access`
- `hsapi files signed-url <fileId>`
- `hsapi files upload --file ./logo.png --folder-path /library/brand --access PRIVATE`
- `hsapi files replace <fileId> --file ./updated-logo.png --access PRIVATE`
- `hsapi files update <fileId> --name updated-logo --access PUBLIC_NOT_INDEXABLE`
- `hsapi files import-url --url https://example.com/file.pdf --folder-path /library/imports --access PRIVATE`
- `hsapi files import-status <taskId>`
- `hsapi files folder-search --path /library --limit 20`
- `hsapi files folder-create --name brand --parent-folder-path /library`
- `hsapi files folder-update <folderId> --name brand-assets`
- `hsapi files folder-update-async <folderId> --parent-folder-id <newParentFolderId>`
- `hsapi files folder-update-status <taskId>`

## Safety Notes

- Mutating commands require `--yes`.
- `files gdpr-delete` additionally requires `--danger-gdpr-delete`; it permanently deletes file content and metadata within HubSpot's GDPR-delete window.
- Upload and replace commands are multipart requests. The CLI preview shows file path, filename, and size, not file bytes.
- Uploads and URL imports require an explicit access level. Prefer `PRIVATE` unless a public hosting URL is intended.
- `PUBLIC_INDEXABLE` can expose files to search engines. `PUBLIC_NOT_INDEXABLE` is public but sends a noindex signal. `PRIVATE` requires a signed URL for display.
- Search does not return hidden or archived files. Fetching hidden files by ID may require `files.ui_hidden.read`.
- Use `--ids-only`, `--names-only`, or `--id-name-map` on file and folder search when you only need compact discovery output.
- Signed URLs can expose private content. Treat signed URL output like a secret until its lifetime is known.
- Folder moves and renames can change paths for child files. Use folder update previews and small test folders first.

## Official References

- Files API guide: https://developers.hubspot.com/docs/api-reference/latest/files/guide
- Search files: https://developers.hubspot.com/docs/api-reference/latest/files/files/search-files
- Import file from URL: https://developers.hubspot.com/docs/api-reference/latest/files/files/import-from-url
- Search folders: https://developers.hubspot.com/docs/api-reference/latest/files/folders/search-folders
- Async folder update: https://developers.hubspot.com/docs/api-reference/latest/files/folders/update-folder
