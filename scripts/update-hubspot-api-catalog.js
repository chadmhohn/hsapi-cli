#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  loadCatalogData,
  summarizeCatalogCoverage
} = require('../src/catalog');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const CATALOG_FILE = path.join(PACKAGE_ROOT, 'data', 'hubspot-api-catalog.json');
const REPORT_DIR = path.join(PACKAGE_ROOT, 'docs', 'hubspot-api-updates');

function repoRelativePath(filePath) {
  return path.relative(PACKAGE_ROOT, filePath).split(path.sep).join('/');
}

const SOURCE_DOCS = [
  {
    id: 'llms',
    url: 'https://developers.hubspot.com/docs/llms.txt',
    required: false,
    note: 'Preferred docs index when publicly accessible.'
  },
  {
    id: 'api-reference',
    url: 'https://developers.hubspot.com/docs/reference/api?locale=en',
    required: true
  },
  {
    id: 'legacy-overview',
    url: 'https://developers.hubspot.com/docs/api-reference/legacy/overview',
    required: true
  },
  {
    id: 'apis-by-tier',
    url: 'https://developers.hubspot.com/docs/developer-tooling/platform/apis-by-tier',
    required: true
  },
  {
    id: 'deprecated-apis',
    url: 'https://developers.hubspot.com/docs/reference/api/deprecated',
    required: true
  },
  {
    id: 'developer-changelog',
    url: 'https://developers.hubspot.com/changelog',
    required: true
  }
];

function usage() {
  return `update-hubspot-api-catalog

Checks the local HubSpot endpoint catalog against official HubSpot docs sources.
This updater is intentionally non-mutating: it reports likely changes, catalog
hygiene issues, and optional reviewable catalog diff proposals.

Usage:
  node scripts/update-hubspot-api-catalog.js [--offline] [--write-report] [--propose-diff] [--date YYYY-MM-DD]

Flags:
  --offline       Skip network fetches and only validate the local catalog.
  --write-report  Write docs/hubspot-api-updates/YYYY-MM-DD.md.
  --propose-diff  Fetch uncataloged docs and include non-mutating catalog proposals.
  --write-proposals
                 Write docs/hubspot-api-updates/YYYY-MM-DD.proposals.json.
  --candidate-url  Add a docs URL to inspect for proposals. Repeatable.
  --candidate-file Add a local HTML/text/Markdown file to inspect for proposals. Repeatable.
  --proposal-limit Limit network candidate docs fetched for proposal mode. Default: 12.
  --max-proposals  Limit emitted endpoint proposals. Default: 200. Use 0 for no cap.
  --date          Override the report date.
  --json          Print JSON only.
  --help          Show this help.`;
}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) fail(`Unknown positional argument: ${arg}`);
    const key = arg.slice(2);
    if (['offline', 'write-report', 'write-proposals', 'propose-diff', 'json', 'help'].includes(key)) {
      flags[key] = true;
      continue;
    }
    if (['date', 'proposal-limit', 'max-proposals', 'candidate-url', 'candidate-file'].includes(key)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`--${key} requires a value.`);
      if (['candidate-url', 'candidate-file'].includes(key)) {
        flags[key] = values(flags[key]);
        flags[key].push(value);
      } else {
        flags[key] = value;
      }
      index += 1;
      continue;
    }
    fail(`Unknown flag: --${key}`);
  }
  return flags;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function values(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function uniqueBy(values, keyFn) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function endpointName(endpoint) {
  return endpoint.id || endpoint.name;
}

function surfaceName(surface) {
  return surface.id || surface.name;
}

function endpointPath(endpoint) {
  return endpoint.pathTemplate || endpoint.path;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, 'https://developers.hubspot.com');
    url.hash = '';
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch (_error) {
    return null;
  }
}

function extractHubSpotDocLinks(text) {
  const links = [];
  const hrefPattern = /href=["']([^"']+)["']/gi;
  const markdownPattern = /https:\/\/developers\.hubspot\.com\/[^\s)"'<>]+/gi;
  for (const pattern of [hrefPattern, markdownPattern]) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[1] || match[0];
      const normalized = normalizeUrl(raw);
      if (!normalized) continue;
      const url = new URL(normalized);
      if (url.hostname !== 'developers.hubspot.com') continue;
      if (!url.pathname.startsWith('/docs/') && !url.pathname.startsWith('/changelog')) continue;
      links.push(normalized);
    }
  }
  return unique(links);
}

function normalizeApiPath(rawPath) {
  if (!rawPath || !rawPath.startsWith('/')) return null;
  const pathOnly = rawPath.split(/[?#]/)[0];
  const API_PATH_PREFIXES = [
    '/crm/', '/account-info/', '/automation/', '/cms/', '/communication-preferences/',
    '/conversations/', '/events/', '/files/', '/marketing/', '/webhooks/', '/oauth/',
    // added for issue #66: families the catalog now covers but the extractor was blind to
    '/settings/', '/business-units/', '/sandboxes/', '/email/', '/engagements/',
    '/analytics/', '/scheduler/', '/visitor-identification/', '/form-integrations/',
    '/submissions/', '/webhooks-journal/', '/crm-object-schemas/'
  ];
  if (!API_PATH_PREFIXES.some((prefix) => pathOnly.startsWith(prefix))) {
    return null;
  }
  return pathOnly.replace(/\/+$/, '') || '/';
}

function extractEndpointReferences(text) {
  const endpoints = [];
  const patterns = [
    /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_./{}:-]+(?:\?[^\s<`"']+)?)/gi,
    /\b(GET|POST|PUT|PATCH|DELETE)\s+https:\/\/api\.hubapi\.com(\/[A-Za-z0-9_./{}:-]+(?:\?[^\s<`"']+)?)/gi,
    /"method"\s*:\s*"(GET|POST|PUT|PATCH|DELETE)"[\s\S]{0,240}?"path"\s*:\s*"(\/[^"]+)"/gi,
    /"path"\s*:\s*"(\/[^"]+)"[\s\S]{0,240}?"method"\s*:\s*"(GET|POST|PUT|PATCH|DELETE)"/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const method = match[1].startsWith('/') ? match[2] : match[1];
      const rawPath = match[1].startsWith('/') ? match[1] : match[2];
      const pathName = normalizeApiPath(rawPath);
      if (!pathName) continue;
      endpoints.push({ method: method.toUpperCase(), path: pathName });
    }
  }
  return uniqueBy(endpoints, (endpoint) => `${endpoint.method} ${endpoint.path}`)
    .sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

function catalogHealth(catalog) {
  const endpoints = catalog.endpoints || [];
  const surfaces = catalog.surfaces || [];
  const coverage = summarizeCatalogCoverage(catalog);
  const duplicateNames = duplicates([
    ...endpoints.map(endpointName),
    ...surfaces.map(surfaceName)
  ]);
  const duplicateMethodPaths = duplicates(endpoints.map((endpoint) => `${endpoint.method} ${endpointPath(endpoint)}`));
  const typedWithoutCommand = endpoints
    .filter((endpoint) => endpoint.status === 'typed' && !endpoint.command)
    .map(endpointName)
    .sort();
  const missingDocs = [
    ...endpoints.filter((endpoint) => !endpoint.docsUrl).map(endpointName),
    ...surfaces.filter((surface) => !surface.docsUrl).map(surfaceName)
  ]
    .sort();
  const missingRisk = endpoints
    .filter((endpoint) => !endpoint.risk)
    .map(endpointName)
    .sort();
  const contextFiles = unique([
    ...endpoints.map((endpoint) => endpoint.contextUrl),
    ...surfaces.map((surface) => surface.contextUrl)
  ]);
  const missingContextFiles = contextFiles
    .filter((contextUrl) => !fs.existsSync(path.join(PACKAGE_ROOT, contextUrl)))
    .sort();
  const docsUrls = unique([
    ...(catalog.sourceDocs || []),
    ...endpoints.map((endpoint) => endpoint.docsUrl),
    ...surfaces.map((surface) => surface.docsUrl)
  ]);

  return {
    ...coverage,
    catalogOnlyCount: endpoints.filter((endpoint) => endpoint.status !== 'typed').length,
    catalogOnlySurfaceCount: surfaces.filter((surface) => surface.status !== 'typed').length,
    readOnlyPostCount: endpoints.filter((endpoint) => endpoint.method === 'POST' && endpoint.readOnlyPost).length,
    duplicateNames,
    duplicateMethodPaths,
    typedWithoutCommand,
    missingDocs,
    missingRisk,
    missingContextFiles,
    docsUrls
  };
}

function pushCountSection(lines, title, counts, emptyLabel = 'none') {
  lines.push(`## ${title}`);
  lines.push('');
  const entries = Object.entries(counts || {})
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (!entries.length) {
    lines.push(`- ${emptyLabel}`);
  } else {
    for (const [label, count] of entries) lines.push(`- ${label}: ${count}`);
  }
  lines.push('');
}

function duplicates(values) {
  const seen = new Set();
  const dupes = new Set();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes].sort();
}

async function fetchSource(source) {
  const startedAt = Date.now();
  try {
    const response = await fetch(source.url, {
      redirect: 'follow',
      headers: {
        accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.8',
        'user-agent': 'hsapi-cli-catalog-updater/0.0'
      }
    });
    const finalUrl = response.url || source.url;
    const text = await response.text();
    const loginRedirect = finalUrl.includes('/docs/login') || /\/docs\/login\?redirect=/.test(text);
    return {
      id: source.id,
      url: source.url,
      finalUrl,
      ok: response.ok && !loginRedirect,
      status: response.status,
      required: source.required,
      note: loginRedirect ? 'HubSpot returned the docs login page; use fallback source docs.' : source.note,
      bytes: text.length,
      durationMs: Date.now() - startedAt,
      discoveredLinks: loginRedirect ? [] : extractHubSpotDocLinks(text)
    };
  } catch (error) {
    return {
      id: source.id,
      url: source.url,
      finalUrl: null,
      ok: false,
      status: null,
      required: source.required,
      note: error.message,
      bytes: 0,
      durationMs: Date.now() - startedAt,
      discoveredLinks: []
    };
  }
}

async function fetchCandidateDoc(url) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.8',
        'user-agent': 'hsapi-cli-catalog-diff-assistant/0.0'
      }
    });
    const finalUrl = response.url || url;
    const text = await response.text();
    const loginRedirect = finalUrl.includes('/docs/login') || /\/docs\/login\?redirect=/.test(text);
    return {
      sourceType: 'url',
      url,
      finalUrl,
      ok: response.ok && !loginRedirect,
      status: response.status,
      note: loginRedirect ? 'HubSpot returned the docs login page; no endpoint references extracted.' : null,
      bytes: text.length,
      durationMs: Date.now() - startedAt,
      endpointReferences: loginRedirect ? [] : extractEndpointReferences(text)
    };
  } catch (error) {
    return {
      sourceType: 'url',
      url,
      finalUrl: null,
      ok: false,
      status: null,
      note: error.message,
      bytes: 0,
      durationMs: Date.now() - startedAt,
      endpointReferences: []
    };
  }
}

function readCandidateFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const text = fs.readFileSync(absolutePath, 'utf8');
  return {
    sourceType: 'file',
    path: filePath,
    finalPath: absolutePath,
    ok: true,
    status: null,
    note: null,
    bytes: text.length,
    durationMs: 0,
    endpointReferences: extractEndpointReferences(text)
  };
}

function compareDocs(health, fetchedSources) {
  const catalogDocs = new Set(health.docsUrls.map(normalizeUrl));
  const discovered = unique(fetchedSources.flatMap((source) => source.discoveredLinks));
  const discoveredApiDocs = discovered.filter((url) => {
    const pathname = new URL(url).pathname;
    return pathname.includes('/api-reference/')
      || pathname.includes('/reference/api')
      || pathname.includes('/developer-tooling/platform/apis-by-tier')
      || pathname.includes('/developer-tooling/platform/usage-guidelines');
  });
  const uncatalogedOfficialDocs = discoveredApiDocs
    .filter((url) => !catalogDocs.has(url))
    .slice(0, 50);
  const failedRequiredSources = fetchedSources
    .filter((source) => source.required && !source.ok)
    .map((source) => source.id);
  return {
    discoveredLinkCount: discovered.length,
    discoveredApiDocCount: discoveredApiDocs.length,
    uncatalogedOfficialDocs,
    failedRequiredSources
  };
}

function inferFamily(rawUrl, apiPath) {
  const text = `${rawUrl || ''} ${apiPath || ''}`.toLowerCase();
  if (text.includes('/account')) return 'account';
  if (text.includes('/associations')) return 'crm.associations';
  if (text.includes('/properties') || text.includes('/property-validations')) return 'crm.properties';
  if (text.includes('/objects') || text.includes('/schemas') || text.includes('/crm/')) return 'crm.objects';
  if (text.includes('/lists')) return 'crm.lists';
  if (text.includes('/imports')) return 'crm.imports';
  if (text.includes('/exports')) return 'crm.exports';
  if (text.includes('/files')) return 'files';
  if (text.includes('/webhooks')) return 'webhooks';
  if (text.includes('/communication-preferences')) return 'communication_preferences';
  if (text.includes('/conversations')) return 'conversations';
  if (text.includes('/events')) return 'events';
  if (text.includes('/oauth') || text.includes('/authentication')) return 'auth';
  return 'unclassified';
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/https?:\/\/developers\.hubspot\.com\/docs\/api-reference\/(latest|legacy)\//, '')
    .replace(/\{[^}]+\}/g, 'by_id')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.{2,}/g, '.')
    .slice(0, 80) || 'candidate';
}

function inferRisk(endpoint) {
  const pathName = endpointPath(endpoint);
  if (endpoint.method === 'GET' || endpoint.method === 'HEAD' || endpoint.method === 'OPTIONS') return 'read';
  if (endpoint.method === 'POST' && (/\/search$/.test(pathName) || /\/batch\/read$/.test(pathName))) return 'read';
  if (endpoint.method === 'DELETE' || /\/archive$|\/purge$|\/delete$/.test(pathName)) return 'destructive';
  return 'mutation';
}

function proposedName(family, endpoint) {
  const methodSuffix = endpoint.method.toLowerCase();
  const pathSuffix = slug(endpointPath(endpoint).replace(/^\/+/, ''));
  return `${family}.${pathSuffix}.${methodSuffix}`.replace(/\.{2,}/g, '.');
}

function buildDocProposal(url) {
  const family = inferFamily(url, '');
  return {
    kind: 'doc-triage',
    family,
    docsUrl: url,
    suggestedName: `${family}.${slug(url)}`,
    reason: 'Official docs page is not currently referenced by catalog sourceDocs or endpoint docsUrl fields.'
  };
}

function buildEndpointProposal(reference, docsUrl) {
  const family = inferFamily(docsUrl, reference.path);
  const risk = inferRisk(reference);
  const proposal = {
    kind: 'endpoint',
    family,
    name: proposedName(family, reference),
    method: reference.method,
    path: reference.path,
    versionMode: reference.path.includes('/2026-03/') ? 'latest' : 'legacy',
    risk,
    status: 'proposed',
    auth: {
      family: 'portal_bearer',
      subtype: 'private_app_or_static_app',
      fallback: 'none'
    },
    docsUrl,
    command: null,
    notes: [
      'Generated by catalog diff assistant. Review HubSpot docs before adding to data/hubspot-api-catalog.json.',
      'Choose a stable command name, required scopes, contextUrl, and mutation guard behavior before marking typed.'
    ]
  };
  if (reference.method === 'POST' && risk === 'read') proposal.readOnlyPost = true;
  return proposal;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function templateMatchesPath(template, pathName) {
  if (template === pathName) return true;
  const pattern = `^${escapeRegex(template).replace(/\\\{[^}]+\\\}/g, '[^/]+')}$`;
  return new RegExp(pattern).test(pathName);
}

function endpointExists(catalog, candidate) {
  return (catalog.endpoints || []).some((endpoint) => (
    endpoint.method === candidate.method
    && templateMatchesPath(endpointPath(endpoint), candidate.path)
  ));
}

const VERSION_SEGMENT = /^(v\d+|\d{4}-\d{2}(-beta)?)$/;

// Position-insensitive version-neutral form: HubSpot moved the version segment
// between conventions (/crm/v3/objects vs /crm/objects/2026-03), so the segment
// is dropped entirely and template placeholders normalize to {}.
function versionNeutralSegments(pathName) {
  return String(pathName)
    .split('/')
    .filter(Boolean)
    .filter((segment) => !VERSION_SEGMENT.test(segment))
    .map((segment) => (/^\{[^}]+\}$/.test(segment) ? '{}' : segment));
}

function versionNeutralMatchers(catalog) {
  const matchers = [];
  for (const endpoint of catalog.endpoints || []) {
    const segments = versionNeutralSegments(endpointPath(endpoint));
    const pattern = `^${segments.map((segment) => (segment === '{}' ? '[^/]+' : escapeRegex(segment))).join('/')}$`;
    matchers.push({
      method: endpoint.method,
      regex: new RegExp(pattern),
      path: endpointPath(endpoint)
    });
  }
  return matchers;
}

function versionDuplicateOf(matchers, candidate) {
  const neutral = versionNeutralSegments(candidate.path).map((segment) => (segment === '{}' ? '__ANY__' : segment));
  const probe = neutral.map((segment) => (segment === '__ANY__' ? 'x' : segment)).join('/');
  for (const matcher of matchers) {
    if (matcher.method !== candidate.method) continue;
    if (matcher.regex.test(probe)) return matcher.path;
  }
  return null;
}

async function buildDiffProposals(catalog, comparison, flags) {
  const explicitUrls = values(flags['candidate-url']).map(normalizeUrl).filter(Boolean);
  const uncatalogedUrls = comparison.uncatalogedOfficialDocs || [];
  const proposalLimit = flags['proposal-limit'] === undefined ? 12 : Number(flags['proposal-limit']);
  if (!Number.isInteger(proposalLimit) || proposalLimit < 0) fail('--proposal-limit must be a non-negative integer.');
  const maxProposals = flags['max-proposals'] === undefined ? 200 : Number(flags['max-proposals']);
  if (!Number.isInteger(maxProposals) || maxProposals < 0) fail('--max-proposals must be a non-negative integer.');

  const candidateUrls = unique([...explicitUrls, ...uncatalogedUrls]).slice(0, proposalLimit);
  const candidateFiles = values(flags['candidate-file']);
  const docs = [
    ...candidateFiles.map(readCandidateFile),
    ...(flags.offline ? [] : await Promise.all(candidateUrls.map(fetchCandidateDoc)))
  ];

  const existingDocs = new Set(unique([
    ...(catalog.sourceDocs || []),
    ...(catalog.endpoints || []).map((endpoint) => endpoint.docsUrl)
  ]).map(normalizeUrl));
  const endpointProposals = [];
  const docOnlyProposals = [];

  for (const doc of docs) {
    const docsUrl = doc.sourceType === 'file' ? doc.path : normalizeUrl(doc.finalUrl || doc.url || '');
    const newReferences = doc.endpointReferences.filter((endpoint) => !endpointExists(catalog, endpoint));
    for (const reference of newReferences) {
      endpointProposals.push(buildEndpointProposal(reference, docsUrl || doc.url || doc.path));
    }
    if (!newReferences.length && docsUrl && !existingDocs.has(docsUrl)) {
      docOnlyProposals.push(buildDocProposal(docsUrl));
    }
  }

  const dedupedProposals = uniqueBy(endpointProposals, (proposal) => `${proposal.method} ${proposal.path}`)
    .sort((a, b) => `${a.family} ${a.method} ${a.path}`.localeCompare(`${b.family} ${b.method} ${b.path}`));
  const neutralMatchers = versionNeutralMatchers(catalog);
  const novelProposals = [];
  const versionDuplicates = [];
  for (const proposal of dedupedProposals) {
    const duplicateOf = versionDuplicateOf(neutralMatchers, proposal);
    if (duplicateOf) {
      versionDuplicates.push({ method: proposal.method, path: proposal.path, duplicateOf });
    } else {
      novelProposals.push(proposal);
    }
  }
  const allCatalogAdditions = novelProposals;
  const catalogAdditions = maxProposals === 0 ? allCatalogAdditions : allCatalogAdditions.slice(0, maxProposals);
  const truncatedEndpointProposalCount = allCatalogAdditions.length - catalogAdditions.length;

  return {
    generatedAt: new Date().toISOString(),
    mode: flags.offline ? 'offline' : 'network',
    candidateUrlCount: candidateUrls.length,
    candidateFileCount: candidateFiles.length,
    maxProposals,
    totalEndpointProposalCount: allCatalogAdditions.length,
    truncatedEndpointProposalCount,
    inspected: docs.map((doc) => ({
      sourceType: doc.sourceType,
      source: doc.url || doc.path,
      final: doc.finalUrl || doc.finalPath || null,
      ok: doc.ok,
      status: doc.status,
      bytes: doc.bytes,
      endpointReferenceCount: doc.endpointReferences.length,
      note: doc.note
    })),
    catalogAdditions,
    versionDuplicateCount: versionDuplicates.length,
    versionDuplicates,
    docTriage: uniqueBy(docOnlyProposals, (proposal) => proposal.docsUrl),
    warnings: [
      'Non-mutating proposal output only. Do not paste proposals blindly into the catalog.',
      'Endpoint paths extracted from docs pages may include examples, deprecated paths, or incomplete template variables.',
      'Every proposal needs command ergonomics, scope/tier notes, tests, and mutation safety review before implementation.'
    ]
  };
}

function renderReport(result) {
  const lines = [];
  lines.push(`# HubSpot API Catalog Update - ${result.date}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Mode: ${result.mode}`);
  lines.push(`- Endpoints: ${result.health.endpointCount}`);
  lines.push(`- Non-HTTP surfaces: ${result.health.surfaceCount}`);
  lines.push(`- Typed commands: ${result.health.typedCommandCount}`);
  lines.push(`- Catalog-only endpoints: ${result.health.catalogOnlyCount}`);
  lines.push(`- Catalog-only non-HTTP surfaces: ${result.health.catalogOnlySurfaceCount}`);
  lines.push(`- Read-only POST endpoints: ${result.health.readOnlyPostCount}`);
  lines.push(`- Endpoints without required scope metadata: ${result.health.unscopedCount}`);
  lines.push(`- Endpoints with scope notes: ${result.health.scopeNoteCount}`);
  lines.push(`- Discovered official doc links: ${result.comparison.discoveredLinkCount}`);
  lines.push(`- Discovered API-ish doc links: ${result.comparison.discoveredApiDocCount}`);
  lines.push('');
  lines.push('## Source Checks');
  lines.push('');
  for (const source of result.sources) {
    const status = source.ok ? 'ok' : 'attention';
    lines.push(`- ${source.id}: ${status}; status=${source.status || 'n/a'}; final=${source.finalUrl || 'n/a'}; links=${source.discoveredLinks.length}${source.note ? `; note=${source.note}` : ''}`);
  }
  lines.push('');
  lines.push('## Catalog Health');
  lines.push('');
  lines.push('Duplicate method/path pairs can be legitimate when multiple typed commands expose the same underlying endpoint with different semantics.');
  lines.push('');
  for (const [label, values] of [
    ['Duplicate endpoint names', result.health.duplicateNames],
    ['Duplicate method/path pairs', result.health.duplicateMethodPaths],
    ['Typed endpoints without commands', result.health.typedWithoutCommand],
    ['Endpoints missing docs URLs', result.health.missingDocs],
    ['Endpoints missing risk', result.health.missingRisk],
    ['Missing context files', result.health.missingContextFiles]
  ]) {
    lines.push(`- ${label}: ${values.length ? values.join(', ') : 'none'}`);
  }
  lines.push('');
  pushCountSection(lines, 'Coverage By Implementation Status', result.health.byStatus);
  pushCountSection(lines, 'Coverage By Risk', result.health.byRisk);
  pushCountSection(lines, 'Coverage By Auth Family', result.health.byAuthFamily);
  pushCountSection(lines, 'Coverage By Tier Requirement', result.health.byTierRequirement);
  pushCountSection(lines, 'Coverage By Scope', result.health.scopeCounts, 'No endpoint-level scopes recorded.');
  pushCountSection(lines, 'Coverage By Family', result.health.byFamily);
  pushCountSection(lines, 'Non-HTTP Surfaces By Type', result.health.surfacesByType);
  pushCountSection(lines, 'Non-HTTP Surfaces By Family', result.health.surfacesByFamily);
  lines.push('## New Docs To Triage');
  lines.push('');
  if (!result.comparison.uncatalogedOfficialDocs.length) {
    lines.push('- None found by this pass.');
  } else {
    for (const url of result.comparison.uncatalogedOfficialDocs) lines.push(`- ${url}`);
  }
  lines.push('');
  if (result.proposals) {
    lines.push('## Catalog Diff Proposals');
    lines.push('');
    lines.push(`- Inspected docs/files: ${result.proposals.inspected.length}`);
    lines.push(`- Proposed endpoint additions: ${result.proposals.catalogAdditions.length}`);
    lines.push(`- Version duplicates of cataloged surfaces (excluded from proposals): ${result.proposals.versionDuplicateCount || 0}`);
    if (result.proposals.truncatedEndpointProposalCount > 0) {
      lines.push(`- Additional endpoint candidates not emitted: ${result.proposals.truncatedEndpointProposalCount}`);
    }
    lines.push(`- Doc-only triage items: ${result.proposals.docTriage.length}`);
    if (result.proposalsPath) lines.push(`- Proposal JSON: ${result.proposalsPath}`);
    lines.push('');
    for (const proposal of result.proposals.catalogAdditions.slice(0, 20)) {
      lines.push(`- ${proposal.method} ${proposal.path} -> ${proposal.name} (${proposal.risk})`);
    }
    if (result.proposals.catalogAdditions.length > 20) {
      lines.push(`- ...${result.proposals.catalogAdditions.length - 20} more proposals in JSON output.`);
    }
    if (!result.proposals.catalogAdditions.length && !result.proposals.docTriage.length) {
      lines.push('- No additions proposed by this pass.');
    }
    lines.push('');
  }
  lines.push('## Notes');
  lines.push('');
  lines.push('- This script does not mutate `data/hubspot-api-catalog.json`.');
  lines.push('- Treat uncataloged docs as triage candidates; source pages often link navigation, not only endpoint guides.');
  lines.push('- Review proposal JSON before implementing endpoint commands, tests, scopes, and mutation guards.');
  lines.push('- Keep live smoke tests read-only and portal-scoped when this becomes a scheduled updater.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  const date = flags.date || todayIso();
  const catalog = loadCatalogData(CATALOG_FILE);
  const health = catalogHealth(catalog);
  const sources = flags.offline ? [] : await Promise.all(SOURCE_DOCS.map(fetchSource));
  const comparison = compareDocs(health, sources);
  const proposals = (flags['propose-diff'] || flags['write-proposals'])
    ? await buildDiffProposals(catalog, comparison, flags)
    : null;
  const result = {
    ok: health.duplicateNames.length === 0
      && health.typedWithoutCommand.length === 0
      && health.missingDocs.length === 0
      && health.missingRisk.length === 0
      && health.missingContextFiles.length === 0
      && comparison.failedRequiredSources.length === 0,
    date,
    mode: flags.offline ? 'offline' : 'network',
    catalog: repoRelativePath(CATALOG_FILE),
    health,
    sources,
    comparison,
    proposals
  };

  if (flags['write-proposals']) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const proposalsPath = path.join(REPORT_DIR, `${date}.proposals.json`);
    result.proposalsPath = repoRelativePath(proposalsPath);
    fs.writeFileSync(proposalsPath, `${JSON.stringify(proposals, null, 2)}\n`);
  }

  if (flags['write-report']) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const reportPath = path.join(REPORT_DIR, `${date}.md`);
    fs.writeFileSync(reportPath, renderReport(result));
    result.report = repoRelativePath(reportPath);
  }

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderReport(result));
    if (result.report) console.log(`Report written: ${result.report}`);
  }

  if (!result.ok) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
