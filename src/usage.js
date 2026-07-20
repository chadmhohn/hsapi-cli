const { endpointDefinitions, commandLiteralPrefix } = require('./catalog');

// Lines for commands that exist outside the endpoint catalog: local tooling,
// virtual commands built on other endpoints, and bridge surfaces.
const STATIC_COMMAND_LINES = [
  'hsapi profiles list [--json]',
  'hsapi request <METHOD> <PATH_OR_URL> [--portal <name>] [--query k=v] [--body <json|@file>] [--yes] [--read-only] [--paginate]',
  'hsapi crm object-types [--family core|commerce|activity|optional|all] [--names-only]',
  'hsapi crm resolve-object <name|objectTypeId> [--custom-fallback]',
  'hsapi crm count <objectType> [--portal <name>] [--filter property:OP:value] [--search text]',
  'hsapi crm exists <objectType> [--portal <name>] --filter property:OP:value',
  'hsapi crm find-one <objectType> [--portal <name>] --filter property:OP:value [--properties a,b]',
  'hsapi properties names <objectType> [--portal <name>]',
  'hsapi tiers products',
  'hsapi tiers apis [--hub <hubId>] [--tier free|starter|pro|enterprise] [--include-global]',
  'hsapi tiers portal [--portal <name>]',
  'hsapi cms doctor [--portal <name>] [--content-id <id>] [--type <contentType>]',
  'hsapi project doctor --account <account>',
  'hsapi project list|info|list-builds|logs|validate|lint ... --account <account>',
  'hsapi project upload|deploy|delete|create|add|download|migrate|install-deps|update-deps ... --account <account> [--yes]',
  'hsapi auth doctor [--portal <name>] [--require-env]',
  'hsapi auth login [--portal <name>] [--timeout <milliseconds>]',
  'hsapi auth whoami [--portal <name>]',
  'hsapi auth logout [--portal <name>]',
  'hsapi auth authorize-url --redirect-uri <uri> --scopes a,b [--optional-scopes a,b] [--state s]',
  'hsapi mcp serve',
  'hsapi catalog coverage',
  'hsapi catalog commands',
  'hsapi history [--since 24h|7d|ISO] [--portal <name>] [--limit n]',
  'hsapi upgrade [--check]',
  'hsapi help <command words>     e.g. hsapi help crm search   (also: any typed command + --help)'
];

function typedCommandLines(filePath) {
  const groups = new Map();
  for (const definition of endpointDefinitions(filePath)) {
    if (definition.status !== 'typed' || !definition.command) continue;
    const literal = commandLiteralPrefix(definition.command);
    const tokens = literal.split(/\s+/);
    if (tokens.length < 3 || tokens[0] !== 'hsapi') continue;
    const action = tokens[tokens.length - 1];
    const area = tokens.slice(1, -1).join(' ');
    if (!groups.has(area)) {
      groups.set(area, { actions: [], mutation: false });
    }
    const group = groups.get(area);
    if (!group.actions.includes(action)) group.actions.push(action);
    if (definition.risk === 'mutation' || definition.risk === 'destructive') group.mutation = true;
  }
  const lines = [];
  const sortedAreas = [...groups.keys()].sort((left, right) => left.localeCompare(right));
  for (const area of sortedAreas) {
    const group = groups.get(area);
    const suffix = group.mutation ? ' ... [--portal <name>] [--yes]' : ' ... [--portal <name>]';
    lines.push(`hsapi ${area} ${group.actions.join('|')}${suffix}`);
  }
  return lines;
}

function buildUsage(defaultConfigPath, filePath) {
  const indent = (line) => `  ${line}`;
  return `hsapi - portal-aware HubSpot API CLI

Usage:
${STATIC_COMMAND_LINES.map(indent).join('\n')}

Typed commands (generated from the endpoint catalog; run "hsapi help <command>" or any command with --help for per-command arguments):
${typedCommandLines(filePath).map(indent).join('\n')}

Config:
  ${defaultConfigPath}

Output:
  --select <path>              Print one projected value, e.g. data.results[].id
  --pick <path,path>           Print a compact object keyed by selected paths
  --raw-value                  With --select, print scalar string/number/boolean/null without JSON quotes
  --ids-only                   Print { ok, portal, count, ids } from common result arrays
  --names-only                 Print { ok, portal, count, names } from common result arrays
  --id-name-map                Print { ok, portal, count, items: [{ id, name }] } from common result arrays
  --compact, --agent           Omit routine envelope metadata such as rateLimit, requestId, method, and url
  --max-results <n>            Trim obvious results arrays and mark output truncated
  --max-chars <n>              Fail when serialized output exceeds n chars
  --include-truncated          With --max-chars, emit a compact truncation summary instead of failing
  --format jsonl               With --paginate: stream one record per line page-by-page (flat memory, pipe-friendly). Not combinable with --select/--pick/--max-chars; --max-results still applies; summary goes to stderr

Notes:
  - hsapi upgrade fast-forwards a git-checkout install to origin/main (--check to inspect first); tarball installs get the gh release download flow printed. GitHub installs use your existing repository access. Restart hsapi-mcp consumers after upgrading.
  - Executed mutations append to a local audit log (~/.local/state/hsapi/history.jsonl, 0600; override with HSAPI_HISTORY_FILE, disable with HSAPI_HISTORY=0). Payload flag values are recorded as lengths only. Read it with: hsapi history --since 24h
  - --paginate follows page cursors (crm list query-param after; crm search body after, stopping at HubSpot's 10K search window) and applies a default 1000-result cap. Pass --max-results <n> to change it or --max-results 0 for unlimited.
  - Any @file argument also accepts @- to read from stdin (one @- per invocation). Batch --inputs accepts a JSON array, an object with an inputs array, or JSONL (one JSON object per line) - so JSONL pipelines can flow straight into batch-create/update/upsert.
  - CRM search filters: property:OP:value (EQ, NEQ, GT, GTE, LT, LTE, CONTAINS_TOKEN, ...), property:IN:a,b / property:NOT_IN:a,b, property:BETWEEN:low:high, property:HAS_PROPERTY / property:NOT_HAS_PROPERTY. Multiple --filter flags AND within one group; repeat --filter-group "expr;expr" for OR between groups; --search-body sends a full HubSpot search JSON body.
  - Tokens are read from env vars declared in the portal config; secrets are not stored in config.
  - Mutating requests require --yes. Use request/crm update without --yes to preview.
  - Some HubSpot read endpoints use POST. Generic --read-only is allowed only for catalog-marked read-only POST endpoints.
  - Add --show-request to inspect the exact request without sending it to HubSpot.`;
}

module.exports = {
  STATIC_COMMAND_LINES,
  buildUsage,
  typedCommandLines
};
