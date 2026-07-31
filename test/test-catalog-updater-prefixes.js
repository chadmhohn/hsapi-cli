#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const CATALOG_UPDATER = path.join(WORKSPACE_ROOT, 'scripts', 'update-hubspot-api-catalog.js');
const {
  canonicalMarkdownUrl,
  inferFamily,
  inferVersionMode,
  isHubSpotDocsLoginRedirect,
  selectRepresentativeDocUrls,
} = require(CATALOG_UPDATER);

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsapi-updater-prefixes-'));
const candidateFile = path.join(fixtureDir, 'candidate.html');

try {
  fs.writeFileSync(candidateFile, [
    '<html><body>',
    '<main>',
    '<code>GET /feature-flags/2026-03/{appId}/flags/all</code>',
    '<code>DELETE /appinstalls/2026-03/external-install</code>',
    '<code>GET /meta/network-origins/2026-03/ip-ranges</code>',
    '<code>GET /media-bridge/2026-03/objects/{mediaType}</code>',
    '<code>GET /commerce/2026-09-beta/payment-links</code>',
    '<code>GET /commerce/price-books/2026-09-beta/price-books</code>',
    '<code>POST /data-studio/2026-09-beta/imports/validate</code>',
    '<code>GET /forecast-settings/2026-09-beta/types</code>',
    '<code>GET /unsupported/2026-03/example</code>',
    '</main>',
    '<script id="__NEXT_DATA__">GET /account-info/2026-03/global-payload-only</script>',
    '</body></html>'
  ].join('\n'));

  const result = spawnSync(process.execPath, [
    CATALOG_UPDATER,
    '--offline',
    '--propose-diff',
    '--candidate-file',
    candidateFile,
    '--json'
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8'
  });

  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.proposals.candidateFileCount, 1);
  assert.strictEqual(output.proposals.inspected.length, 1);
  assert.strictEqual(
    output.proposals.inspected[0].endpointReferenceCount,
    8,
    'the updater should recognize stable and beta family prefixes and ignore unsupported paths'
  );

  const proposalsByPath = new Map(output.proposals.catalogAdditions.map((proposal) => [proposal.path, proposal]));
  for (const proposalPath of [
    '/commerce/2026-09-beta/payment-links',
    '/data-studio/2026-09-beta/imports/validate',
    '/forecast-settings/2026-09-beta/types'
  ]) {
    assert.strictEqual(proposalsByPath.get(proposalPath).versionMode, 'beta');
  }
  const validationProposal = proposalsByPath.get('/data-studio/2026-09-beta/imports/validate');
  assert.strictEqual(validationProposal.risk, 'read');
  assert.strictEqual(validationProposal.readOnlyPost, true);

  const unrelatedAccountDocs = 'https://developers.hubspot.com/docs/api-reference/2026-09-beta/account/ip-ranges/guide';
  for (const [apiPath, expectedFamily] of [
    ['/feature-flags/2026-03/{appId}/flags/all', 'app_management.feature_flags'],
    ['/appinstalls/2026-03/external-install', 'app_management.uninstalls'],
    ['/meta/network-origins/2026-09-beta/ip-ranges', 'meta.network_origins'],
    ['/media-bridge/2026-03/objects/{mediaType}', 'media_bridge'],
    ['/commerce/payment-links/2026-09-beta/payment-links', 'commerce.payment_links'],
    ['/commerce/price-books/2026-09-beta/price-books', 'commerce.price_books'],
    ['/data-studio/data-source/2026-09-beta', 'data_studio.file_ingestion'],
    ['/forecast-settings/2026-09-beta/forecast-types', 'forecast_settings'],
    ['/marketing/aeo/2026-09-beta/prompts', 'marketing.aeo'],
    ['/marketing/forms/2026-09-beta', 'marketing.forms'],
    ['/automation/2026-09-beta/flows', 'automation.flows'],
  ]) {
    assert.strictEqual(
      inferFamily(unrelatedAccountDocs, apiPath),
      expectedFamily,
      `${apiPath} should derive its family from the API path, not an unrelated page URL`
    );
  }

  assert.strictEqual(
    inferVersionMode('/crm/v3/objects/widgets', unrelatedAccountDocs),
    'v3',
    'an explicit stable v3 path must not inherit beta from its docs page'
  );
  assert.strictEqual(inferVersionMode('/automation/2026-03/flows', unrelatedAccountDocs), 'latest');
  assert.strictEqual(inferVersionMode('/automation/v4/flows', unrelatedAccountDocs), 'v4');
  assert.strictEqual(inferVersionMode('/oauth/v1/token', unrelatedAccountDocs), 'legacy');
  assert.strictEqual(inferVersionMode('/undated/example', unrelatedAccountDocs), 'beta');

  const automationDocs = Array.from({ length: 20 }, (_value, index) => (
    `https://developers.hubspot.com/docs/api-reference/2026-09-beta/automation/workflows/operation-${String(index).padStart(2, '0')}`
  ));
  const dataStudioGuide = 'https://developers.hubspot.com/docs/api-reference/2026-09-beta/data-studio/file-ingestion/guide';
  const priceBooksGuide = 'https://developers.hubspot.com/docs/api-reference/2026-09-beta/revenue/price-books/guide';
  const representativeDocs = selectRepresentativeDocUrls(
    [...automationDocs, dataStudioGuide, priceBooksGuide],
    12
  );
  assert(representativeDocs.includes(dataStudioGuide), 'a sitemap family beyond the first 12 sorted links should be selected');
  assert(representativeDocs.includes(priceBooksGuide), 'candidate selection should represent distinct beta families');
  assert.strictEqual(canonicalMarkdownUrl(dataStudioGuide), `${dataStudioGuide}.md`);
  assert.strictEqual(inferFamily(priceBooksGuide, ''), 'commerce.price_books');
  assert.strictEqual(
    isHubSpotDocsLoginRedirect('https://app.hubspot.com/myaccounts?next=developerdocs&redirect=%2Fdocs%2Fexample', ''),
    true,
    'HubSpot account-picker redirects must not be treated as successful documentation pages'
  );
  assert.strictEqual(
    isHubSpotDocsLoginRedirect(priceBooksGuide, '<html>Price books</html>'),
    false
  );

  console.log('catalog updater prefix regression test passed');
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}
