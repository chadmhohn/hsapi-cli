// hsapi upgrade / history / catalog: local maintenance and introspection.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  fail,
} = require('../runtime');
const {
  boolFlag,
  configString,
  readJsonFile,
} = require('../flags');
const {
  printJson,
} = require('../output');
const {
  historyEnabled,
  historyFilePath,
  parseHistorySince,
} = require('../history');
const {
  endpointDefinitions,
  loadCatalogData,
  summarizeCatalogCoverage,
} = require('../catalog');
const {
  CATALOG_FILE,
  PACKAGE_ROOT,
} = require('../config-paths');

function upgradeRootPath() {
  const explicit = configString(process.env.HSAPI_UPGRADE_ROOT);
  return explicit ? path.resolve(explicit) : PACKAGE_ROOT;
}

function runUpgradeGit(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: result.error ? result.error.message : null
  };
}

function repoSlugFromPackage(pkg) {
  return String(pkg && pkg.repository && pkg.repository.url || '')
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/^git@github\.com:/, '');
}

async function runUpgrade(flags) {
  const root = upgradeRootPath();
  const checkOnly = boolFlag(flags, 'check');
  const restartNote = 'Restart any running hsapi-mcp consumers (for example: hermes gateway restart from a terminal, or restart the desktop MCP client) so they load the new build.';

  if (fs.existsSync(path.join(root, '.git'))) {
    const fetched = runUpgradeGit(root, ['fetch', 'origin', 'main']);
    if (fetched.status !== 0) {
      fail(`hsapi upgrade: git fetch failed: ${fetched.stderr || fetched.error || 'unknown error'}`);
    }
    const local = runUpgradeGit(root, ['rev-parse', '--short', 'HEAD']).stdout;
    const remote = runUpgradeGit(root, ['rev-parse', '--short', 'origin/main']).stdout;
    const behind = Number(runUpgradeGit(root, ['rev-list', '--count', 'HEAD..origin/main']).stdout || '0');
    const dirty = runUpgradeGit(root, ['status', '--porcelain']).stdout !== '';

    if (checkOnly || behind === 0) {
      printJson({
        ok: true,
        mode: 'git-checkout',
        root,
        local,
        remote,
        behind,
        upToDate: behind === 0,
        dirty,
        action: behind === 0 ? null : `Run hsapi upgrade (without --check) to fast-forward. ${restartNote}`
      });
      return;
    }

    if (dirty) {
      fail('hsapi upgrade: checkout has uncommitted changes. Commit or stash them, then re-run hsapi upgrade.');
    }
    const merged = runUpgradeGit(root, ['merge', '--ff-only', 'origin/main']);
    if (merged.status !== 0) {
      fail(`hsapi upgrade: fast-forward to origin/main failed: ${merged.stderr || merged.error || 'unknown error'}`);
    }
    printJson({
      ok: true,
      mode: 'git-checkout',
      root,
      from: local,
      to: remote,
      updatedCommitCount: behind,
      note: restartNote
    });
    return;
  }

  const pkg = readJsonFile(path.join(root, 'package.json'));
  const repoSlug = repoSlugFromPackage(pkg) || 'chadmhohn/hsapi-cli';
  printJson({
    ok: true,
    mode: 'installed-package',
    root,
    version: pkg.version || null,
    repo: repoSlug,
    note: 'This install is not a git checkout, so hsapi cannot fast-forward it. Update from the latest GitHub Release tarball (works on the private repo with your gh auth), then restart MCP consumers.',
    commands: [
      `gh release download --repo ${repoSlug} --pattern "hsapi-cli-*.tgz" --dir .`,
      'npm install -g ./hsapi-cli-<version>.tgz'
    ]
  });
}

function runHistory(flags) {
  const filePath = historyFilePath();
  const sinceMs = parseHistorySince(flags.since);
  const portalFilter = flags.portal ? String(flags.portal) : null;
  const limit = flags.limit === undefined ? 50 : Number(flags.limit);
  if (!Number.isInteger(limit) || limit < 1) fail('--limit must be a positive integer.');

  let entries = [];
  if (filePath && fs.existsSync(filePath)) {
    entries = fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean);
  }
  if (portalFilter) entries = entries.filter((entry) => entry.portal === portalFilter);
  if (sinceMs !== null) entries = entries.filter((entry) => Date.parse(entry.ts) >= sinceMs);
  const totalCount = entries.length;
  entries = entries.slice(-limit);

  printJson({
    ok: true,
    file: filePath,
    enabled: historyEnabled(),
    totalCount,
    returnedCount: entries.length,
    entries
  });
}


// Issue #21: --paginate --format jsonl streams one record per line page-by-page
// (flat memory, pipe-friendly). Records bypass processOutput, so projection and
// character budgets cannot combine with it; --max-results still applies.

async function runCatalog(action) {
  if (action === 'commands') {
    const definitions = endpointDefinitions()
      .filter((definition) => definition.command)
      .sort((left, right) => left.command.localeCompare(right.command));
    printJson({
      ok: true,
      catalog: CATALOG_FILE,
      commandCount: definitions.length,
      commands: definitions
    });
    return;
  }

  if (action !== 'coverage') fail(`Unknown catalog action: ${action}`);
  const catalog = loadCatalogData(CATALOG_FILE);
  const coverage = summarizeCatalogCoverage(catalog);
  printJson({
    ok: true,
    catalog: CATALOG_FILE,
    generatedAt: catalog.generatedAt || null,
    ...coverage
  });
}

module.exports = {
  repoSlugFromPackage,
  runCatalog,
  runHistory,
  runUpgrade,
  runUpgradeGit,
  upgradeRootPath,
};
