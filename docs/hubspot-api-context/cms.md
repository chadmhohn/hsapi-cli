# CMS

The CMS slice covers HubSpot-hosted content operations: site pages, landing pages, blog posts, URL redirects, domains, and site search.

Auth boundary: CMS REST APIs are `hsapi --portal <profile>` account-scoped commands backed by the selected portal profile, usually `portal_bearer`. HubSpot Projects and local developer workflows remain official HubSpot CLI `hs project ... --account <account>` workflows unless `hsapi` grows an explicit bridge. Do not silently read `~/.hscli/config.yml` or HubSpot CLI personal access keys for CMS commands. See `docs/CMS_PROJECTS_AUTH_BOUNDARY.md`.

## Working Notes

- Pages and blog posts have draft/live flows. Use draft read/update/reset before `push-live` or `schedule`.
- Page and blog post create/update payloads can include large nested content objects such as `layoutSections`, `widgets`, and `widgetContainers`.
- URL redirects are mutable content-routing rules. Treat `create`, `update`, and `delete` as high-impact changes.
- Domains and site search are read-only in this slice.
- Search and indexed-data can surface published and unpublished content; treat results as content-sensitive.

## Common Commands

- `hsapi cms doctor --portal <profile>`
- `hsapi cms doctor --portal <profile> --content-id 123 --type SITE_PAGE`
- `hsapi cms site-pages list --state PUBLISHED_OR_SCHEDULED`
- `hsapi cms site-pages list --state PUBLISHED_OR_SCHEDULED --id-name-map --max-results 20`
- `hsapi cms site-pages create --name "New page" --template-path @hubspot/basic/templates/layouts/blank.html`
- `hsapi cms landing-pages schedule <pageId> --publish-date 2026-06-01T15:00:00Z`
- `hsapi cms blog-posts draft-update <postId> --post-body "<p>Updated draft</p>"`
- `hsapi cms redirects create --route-prefix /old --destination /new --redirect-style 301`
- `hsapi cms domains list`
- `hsapi cms search --q marketing --type BLOG_POST`
- `hsapi cms indexed-data <contentId> --type SITE_PAGE`

## Safety Notes

- Start with `hsapi cms doctor` when a CMS command fails due to a possible auth or capability mismatch. It runs read-only GET checks only and reports missing scopes/permissions, unavailable account features, and unexpected failures separately.
- Mutations require `--yes`.
- Use `--show-request` before publishing or deleting CMS content.
- Use `--ids-only`, `--names-only`, or `--id-name-map` for CMS discovery/list responses when you only need compact identifiers or page names.
- When creating pages, strip any leading slash from `templatePath` if you copied it from HubSpot's design manager.
