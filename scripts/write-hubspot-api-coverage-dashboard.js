#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  loadCatalogData,
  summarizeCatalogCoverage
} = require('../src/catalog');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT = path.join(PACKAGE_ROOT, 'docs', 'hubspot-api-updates', 'coverage-dashboard.md');

function parseArgs(argv) {
  const out = {
    output: DEFAULT_OUTPUT,
    json: false
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--output requires a value.');
      out.output = path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
      continue;
    }
    if (arg === '--json') {
      out.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  return out;
}

function usage() {
  return `Usage:
  node scripts/write-hubspot-api-coverage-dashboard.js [--output docs/hubspot-api-updates/coverage-dashboard.md] [--json]

Writes a markdown snapshot of the current catalog coverage, sorted by status,
risk, auth family, family, tier requirement, and non-HTTP surfaces.`;
}

function sortedEntries(map) {
  return Object.entries(map || {}).sort((a, b) => {
    const delta = Number(b[1]) - Number(a[1]);
    return delta !== 0 ? delta : String(a[0]).localeCompare(String(b[0]));
  });
}

function renderBulletSection(title, entries) {
  const lines = [`## ${title}`];
  for (const [label, value] of entries) {
    lines.push(`- ${label}: ${value}`);
  }
  if (!entries.length) lines.push('- none');
  return lines.join('\n');
}

function renderSurfaces(catalog) {
  const lines = ['## Non-HTTP Surfaces'];
  if (!catalog.surfaces.length) {
    lines.push('- none');
    return lines.join('\n');
  }

  for (const surface of catalog.surfaces) {
    lines.push(`- ${surface.id} (${surface.surfaceType}, ${surface.family})`);
    if (surface.docsUrl) lines.push(`  - Docs: ${surface.docsUrl}`);
    if (surface.contextUrl) lines.push(`  - Context: ${surface.contextUrl}`);
    if (surface.scopeNotes) lines.push(`  - Disposition: ${surface.scopeNotes}`);
  }
  return lines.join('\n');
}

function buildMarkdown(catalog, coverage) {
  // Use the catalog's own generation date so dashboard output is a pure function
  // of the catalog. Stamping the wall clock here made the CI drift check fail on
  // every PR opened after the last regeneration day (issue #37).
  const generatedAt = catalog.generatedAt || 'unknown';
  const catalogOnlyCount = coverage.byStatus?.['catalog-only'] || 0;
  const catalogOnlySurfaceCount = coverage.surfacesByStatus?.['catalog-only'] || 0;
  const lines = [
    '# HubSpot API Coverage Dashboard',
    '',
    `Generated: ${generatedAt}`,
    '',
    '## Snapshot',
    `- Typed commands: ${coverage.typedCommandCount}`,
    `- Catalog-only endpoints: ${catalogOnlyCount}`,
    `- Catalog-only non-HTTP surfaces: ${catalogOnlySurfaceCount}`,
    `- Endpoint count: ${coverage.endpointCount}`,
    `- Non-HTTP surface count: ${coverage.surfaceCount}`,
    `- Total catalog items: ${coverage.catalogItemCount}`,
    '',
    renderBulletSection('Coverage by implementation status', sortedEntries(coverage.byStatus)),
    '',
    renderBulletSection('Coverage by risk', sortedEntries(coverage.byRisk)),
    '',
    renderBulletSection('Coverage by auth family', sortedEntries(coverage.byAuthFamily)),
    '',
    renderBulletSection('Coverage by tier requirement', sortedEntries(coverage.byTierRequirement)),
    '',
    renderBulletSection('Coverage by family', sortedEntries(coverage.byFamily)),
    '',
    renderBulletSection('Coverage by surface family', sortedEntries(coverage.surfacesByFamily)),
    '',
    renderBulletSection('Coverage by surface type', sortedEntries(coverage.surfacesByType)),
    '',
    renderSurfaces(catalog)
  ];
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const catalog = loadCatalogData();
  const coverage = summarizeCatalogCoverage(catalog);
  const markdown = buildMarkdown(catalog, coverage);
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${markdown}\n`);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, output: args.output, coverage }, null, 2)}\n`);
  } else {
    process.stdout.write(`${args.output}\n`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
