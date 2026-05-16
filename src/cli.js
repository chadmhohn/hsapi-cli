#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  AUTH_FAMILIES,
  DEVELOPER_AUTH_SUBTYPES,
  endpointAuthRequirement
} = require('./auth');
const {
  endpointDefinitionById,
  endpointDefinitions,
  findEndpointDefinition,
  loadCatalogData,
  pathTemplateToRegex,
  summarizeCatalogCoverage
} = require('./catalog');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = process.env.HSAPI_WORKSPACE_ROOT
  ? path.resolve(process.env.HSAPI_WORKSPACE_ROOT)
  : PACKAGE_ROOT;
const DEFAULT_CONFIG = path.join(WORKSPACE_ROOT, 'config', 'hubspot-portals.json');
const CATALOG_FILE = process.env.HSAPI_CATALOG_FILE || path.join(PACKAGE_ROOT, 'data', 'hubspot-api-catalog.json');
const TIERS_FILE = process.env.HSAPI_TIERS_FILE || path.join(PACKAGE_ROOT, 'data', 'hubspot-api-tiers.json');
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const RATE_LIMIT_HEADERS = [
  'x-hubspot-ratelimit-daily',
  'x-hubspot-ratelimit-daily-remaining',
  'x-hubspot-ratelimit-interval-milliseconds',
  'x-hubspot-ratelimit-max',
  'x-hubspot-ratelimit-remaining',
  'retry-after'
];
const OAUTH_TOKEN_CACHE_SCHEMA = 'hsapi.oauthTokenCache.v1';
const DEVELOPER_CLIENT_CREDENTIALS_TOKEN_CACHE_SCHEMA = 'hsapi.developerClientCredentialsTokenCache.v1';
const OAUTH_TOKEN_REFRESH_SKEW_MS = 60 * 1000;
let currentOutputFlags = {};
const DEFAULT_RUNTIME = {
  stdout: process.stdout,
  stderr: process.stderr,
  exit(code) {
    process.exit(code);
  }
};
let currentRuntime = DEFAULT_RUNTIME;

class CliExitError extends Error {
  constructor(code = 0) {
    super(`CLI exited with status ${code}`);
    this.name = 'CliExitError';
    this.code = code;
  }
}

function streamWrite(stream, text) {
  if (stream && typeof stream.write === 'function') {
    stream.write(`${text}\n`);
    return;
  }
  throw new Error('CLI runtime stream is missing a write method.');
}

function writeStdout(text) {
  streamWrite(currentRuntime.stdout, text);
}

function writeStderr(text) {
  streamWrite(currentRuntime.stderr, text);
}

function exitCli(code = 0) {
  return currentRuntime.exit(code);
}

function memoryStream(chunks) {
  return {
    write(chunk) {
      chunks.push(String(chunk));
    }
  };
}

function applyEnvOverrides(env) {
  if (!env || typeof env !== 'object') return () => {};
  const previous = new Map();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

async function runCli(argv = [], options = {}) {
  const previousRuntime = currentRuntime;
  const previousOutputFlags = currentOutputFlags;
  const stdoutChunks = [];
  const stderrChunks = [];
  const capture = options.capture !== false && !options.stdout && !options.stderr;
  const runtime = {
    stdout: options.stdout || (capture ? memoryStream(stdoutChunks) : process.stdout),
    stderr: options.stderr || (capture ? memoryStream(stderrChunks) : process.stderr),
    exit(code = 0) {
      throw new CliExitError(code);
    }
  };
  const restoreEnv = applyEnvOverrides(options.env);
  currentRuntime = runtime;
  currentOutputFlags = {};
  try {
    await main(argv);
    return {
      ok: true,
      status: 0,
      stdout: stdoutChunks.join(''),
      stderr: stderrChunks.join('')
    };
  } catch (error) {
    if (error instanceof CliExitError) {
      return {
        ok: error.code === 0,
        status: error.code,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join('')
      };
    }
    if (options.throwErrors) throw error;
    printJson({ ok: false, error: error.message, stack: process.env.HSAPI_DEBUG ? error.stack : undefined });
    return {
      ok: false,
      status: 1,
      stdout: stdoutChunks.join(''),
      stderr: stderrChunks.join('')
    };
  } finally {
    currentRuntime = previousRuntime;
    currentOutputFlags = previousOutputFlags;
    restoreEnv();
  }
}
const CRM_OBJECT_TYPE_CATALOG = [
  {
    family: 'core',
    objectType: 'contacts',
    label: 'Contacts',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts/guide'
  },
  {
    family: 'core',
    objectType: 'companies',
    label: 'Companies',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/companies/guide'
  },
  {
    family: 'core',
    objectType: 'deals',
    label: 'Deals',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/deals/guide'
  },
  {
    family: 'core',
    objectType: 'tickets',
    label: 'Tickets',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/tickets/guide'
  },
  {
    family: 'commerce',
    objectType: 'products',
    label: 'Products',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/products/guide',
    notes: 'Common product library object. Frequently associated to line items.'
  },
  {
    family: 'commerce',
    objectType: 'line_items',
    label: 'Line items',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/line-items/guide',
    notes: 'Line items usually need name, quantity, and price, then associations to deals, quotes, invoices, or subscriptions.'
  },
  {
    family: 'commerce',
    objectType: 'quotes',
    label: 'Quotes',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/quotes/guide',
    notes: 'Quote records usually sit in a commerce workflow with deals and line items.'
  },
  {
    family: 'commerce',
    objectType: 'invoices',
    label: 'Invoices',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/invoices/guide',
    notes: 'Invoice records depend on commerce/payment setup and should be tested in disposable portals first.'
  },
  {
    family: 'commerce',
    objectType: 'commerce_payments',
    label: 'Commerce payments',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/commerce-payments/guide',
    notes: 'Payment records are tied to HubSpot payments or Stripe payment processing setup.'
  },
  {
    family: 'commerce',
    objectType: 'subscriptions',
    label: 'Commerce subscriptions',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/commerce-subscriptions/guide',
    notes: 'Commerce subscriptions use the subscriptions object type, distinct from marketing communication preferences.'
  },
  {
    family: 'commerce',
    objectType: 'orders',
    label: 'Orders',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/orders/guide'
  },
  {
    family: 'commerce',
    objectType: 'carts',
    label: 'Carts',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/carts/guide'
  },
  {
    family: 'commerce',
    objectType: 'fees',
    label: 'Fees',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/fees/guide'
  },
  {
    family: 'commerce',
    objectType: 'discounts',
    label: 'Discounts',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/discounts/guide'
  },
  {
    family: 'commerce',
    objectType: 'taxes',
    label: 'Taxes',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/taxes/guide'
  },
  {
    family: 'activity',
    objectType: 'calls',
    label: 'Calls',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/calls/guide'
  },
  {
    family: 'activity',
    objectType: 'meetings',
    label: 'Meetings',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/meetings/guide'
  },
  {
    family: 'activity',
    objectType: 'notes',
    label: 'Notes',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/notes/guide'
  },
  {
    family: 'activity',
    objectType: 'emails',
    label: 'Emails',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/emails/guide'
  },
  {
    family: 'activity',
    objectType: 'tasks',
    label: 'Tasks',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/tasks/guide'
  },
  {
    family: 'activity',
    objectType: 'communications',
    label: 'Communications',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/communications/guide'
  },
  {
    family: 'activity',
    objectType: 'postal_mail',
    label: 'Postal mail',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/postal-mail/guide'
  },
  {
    family: 'activity',
    objectType: 'projects',
    label: 'Projects',
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/projects/guide'
  }
];

function usage() {
  return `hsapi - portal-aware HubSpot API CLI

Usage:
  hsapi profiles list [--json]
  hsapi request <METHOD> <PATH_OR_URL> [--portal <name>] [--query k=v] [--body <json|@file>] [--yes] [--read-only] [--paginate]
  hsapi crm object-types [--family core|commerce|activity|all] [--names-only]
  hsapi crm list <objectType> [--portal <name>] [--properties a,b] [--limit n] [--archived] [--count-only]
  hsapi crm get <objectType> <id> [--portal <name>] [--properties a,b] [--properties-with-history a,b] [--id-property name]
  hsapi crm search <objectType> [--portal <name>] --filter property:OP:value [--properties a,b] [--properties-with-history a,b] [--search text] [--sort property[:ASC|DESC]] [--after token] [--limit n] [--count-only]
  hsapi crm count <objectType> [--portal <name>] [--filter property:OP:value] [--search text]
  hsapi crm exists <objectType> [--portal <name>] --filter property:OP:value
  hsapi crm find-one <objectType> [--portal <name>] --filter property:OP:value [--properties a,b]
  hsapi crm create <objectType> [--portal <name>] --properties <json|@file> [--associations <json|@file>] [--yes]
  hsapi crm update <objectType> <id> [--portal <name>] --properties <json|@file> [--yes]
  hsapi crm archive <objectType> <id> [--portal <name>] [--yes]
  hsapi crm merge <objectType> <primaryId> <objectIdToMerge> [--portal <name>] --danger-merge [--yes]
  hsapi crm gdpr-delete <objectType> <id> [--portal <name>] [--id-property name] --danger-gdpr-delete [--yes]
  hsapi crm batch-read <objectType> --ids <id,id|@file> [--properties a,b] [--properties-with-history a,b] [--id-property name]
  hsapi crm batch-create <objectType> --inputs <json|@file> [--yes]
  hsapi crm batch-update <objectType> --inputs <json|@file> [--yes]
  hsapi crm batch-upsert <objectType> --inputs <json|@file> [--yes]
  hsapi crm batch-archive <objectType> --ids <id,id|@file> [--yes]
  hsapi properties list <objectType> [--portal <name>] [--names-only]
  hsapi properties names <objectType> [--portal <name>]
  hsapi properties get <objectType> <propertyName> [--portal <name>]
  hsapi properties create <objectType> [--portal <name>] --body <json|@file> [--yes]
  hsapi properties update <objectType> <propertyName> [--portal <name>] --body <json|@file> [--yes]
  hsapi properties archive <objectType> <propertyName> [--portal <name>] [--yes]
  hsapi associations types <fromType> <toType> [--portal <name>]
  hsapi associations list <fromType> <fromId> <toType> [--portal <name>] [--limit n]
  hsapi associations create-default <fromType> <fromId> <toType> <toId> [--portal <name>] [--yes]
  hsapi associations create <fromType> <fromId> <toType> <toId> --category <category> --type-id <id> [--yes]
  hsapi associations delete <fromType> <fromId> <toType> <toId> [--portal <name>] [--yes]
  hsapi associations batch-read <fromType> <toType> --ids <id,id|@file>
  hsapi associations batch-create-default <fromType> <toType> --inputs <json|@file> [--yes]
  hsapi associations batch-create <fromType> <toType> --inputs <json|@file> [--yes]
  hsapi associations batch-archive <fromType> <toType> --inputs <json|@file> [--yes]
  hsapi associations batch-labels-archive <fromType> <toType> --inputs <json|@file> [--yes]
  hsapi account details [--portal <name>]
  hsapi account usage [--portal <name>]
  hsapi account subscription [--portal <name>]
  hsapi tiers products
  hsapi tiers apis [--hub <hubId>] [--tier free|starter|pro|enterprise] [--include-global]
  hsapi tiers portal [--portal <name>]
  hsapi property-groups list <objectType> [--portal <name>]
  hsapi property-groups create <objectType> --name <name> --label <label> [--display-order n] [--yes]
  hsapi property-groups update <objectType> <groupName> [--label <label>] [--display-order n] [--yes]
  hsapi property-groups archive <objectType> <groupName> [--yes]
  hsapi property-validations list <objectType> [--portal <name>]
  hsapi property-validations set <objectType> <propertyName> <ruleType> --arguments <json|@file> [--normalize] [--yes]
  hsapi schemas list|get|create|update|delete ... [--portal <name>] [--yes]
  hsapi object-library status [--portal <name>]
  hsapi association-labels list|create|update|delete ... [--portal <name>] [--yes]
  hsapi association-limits list|create|update|delete ... [--portal <name>] [--yes]
  hsapi pipelines list|get|create|update|delete|stages|stage-create|stage-update|stage-delete|stage-audit ... [--portal <name>] [--yes]
  hsapi lists search|get|get-by-name|create|update-name|delete|restore|memberships|membership-update|memberships-clear|record-memberships ... [--portal <name>] [--yes]
  hsapi exports start|get|status ... [--portal <name>] [--yes]
  hsapi imports list|get|errors|cancel|start ... [--portal <name>] [--yes]
  hsapi subscriptions definitions|status|set-status|unsubscribe-all-status|unsubscribe-all|batch-read|batch-unsubscribe-all-read|batch-unsubscribe-all|batch-write|generate-links ... [--portal <name>] [--yes]
  hsapi files search|get|signed-url|upload|replace|update|import-url|import-status|delete|gdpr-delete|folder-search|folder-get|folder-create|folder-update|folder-update-async|folder-update-status ... [--portal <name>] [--yes]
  hsapi mcp serve
  hsapi events types|occurrences|definitions|definition-get|definition-create|definition-update|definition-delete|property-create|property-update|property-delete|send|send-batch ... [--portal <name>] [--yes]
  hsapi webhooks settings|settings-update|settings-delete|subscription-create|subscription-update|subscription-batch-update ... [--portal <name>] [--yes]
  hsapi webhook-journal journal-earliest|journal-status|journal-batch-read|local-earliest|local-latest|local-next|local-status|local-batch-earliest|local-batch-latest|local-batch-read|snapshot-crm|subscription-list|subscription-create|subscription-delete|subscription-delete-portal|filter-create|filter-list|filter-get|filter-delete ... [--portal <name>] [--yes]
  hsapi conversations threads|thread-get|thread-update|thread-delete|assignee-update|assignee-delete|messages|message-get|message-original|message-create|actors-get|actors-batch-read|channels|channel-get|channel-accounts|channel-account-get|inboxes|inbox-get|custom-channels|custom-channel-get|custom-channel-create|custom-channel-update|custom-channel-delete|custom-channel-accounts|custom-channel-account-get|custom-channel-account-create|custom-message-create|custom-message-get|custom-message-update|visitor-token ... [--portal <name>] [--yes]
  hsapi forms list|get|create|patch|update|archive|submissions|submit ... [--portal <name>] [--yes]
  hsapi forms secure-submit <portalId> <formGuid> --fields <json|@file> [--portal <name>] [--yes]
  hsapi marketing emails create|update|delete ... [--portal <name>] [--yes]
  hsapi marketing campaigns create|get|delete ... [--portal <name>] [--yes]
  hsapi marketing events list|create|upsert ... [--portal <name>] [--yes]
  hsapi marketing transactional send --email-id <id> --to <email> ... [--portal <name>] [--yes]
  hsapi automation workflows list|get|current-enrollment|enroll ... [--portal <name>] [--yes]
  hsapi automation sequences list|get|enroll|status ... [--portal <name>] [--user-id <id>] [--yes]
  hsapi extensions calling settings|recording-settings|channel-connection|recordings|transcripts ... [--portal <name>] [--yes]
  hsapi extensions videoconferencing settings get|delete <appId> [--portal <name>] [--yes]
  hsapi cms site-pages list|get|create|draft-get|draft-update|draft-reset|push-live|schedule|delete ... [--portal <name>] [--yes]
  hsapi cms landing-pages list|get|create|draft-get|draft-update|draft-reset|push-live|schedule|delete ... [--portal <name>] [--yes]
  hsapi cms blog-posts list|get|create|draft-get|draft-update|draft-reset|push-live|schedule|delete ... [--portal <name>] [--yes]
  hsapi cms redirects list|get|create|update|delete ... [--portal <name>] [--yes]
  hsapi cms hubdb tables list|get|create ... [--portal <name>] [--yes]
  hsapi cms hubdb rows list|create <tableIdOrName> ... [--portal <name>] [--yes]
  hsapi cms source-code upload|validate|delete <environment> <path> ... [--portal <name>] [--yes]
  hsapi cms domains list|get ... [--portal <name>]
  hsapi cms search --q <term> ... [--portal <name>]
  hsapi cms indexed-data <contentId> [--portal <name>] [--type <contentType>]
  hsapi scheduler links|booking-info|availability|book|calendar-create ... [--portal <name>] [--yes]
  hsapi auth doctor [--portal <name>] [--require-env]
  hsapi auth authorize-url|token|refresh|introspect|revoke ... [--show-request] [--show-secrets] [--yes]
  hsapi limits records|associations|custom-properties|calculated-properties|association-labels|pipelines|custom-object-types [--portal <name>]
  hsapi catalog coverage
  hsapi catalog commands

Config:
  ${DEFAULT_CONFIG}

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

Notes:
  - Tokens are read from env vars declared in the portal config; secrets are not stored in config.
  - Mutating requests require --yes. Use request/crm update without --yes to preview.
  - Some HubSpot read endpoints use POST. Generic --read-only is allowed only for catalog-marked read-only POST endpoints.
  - Add --show-request to inspect the exact request without sending it to HubSpot.`;
}

function fail(message, code = 1) {
  writeStderr(message);
  exitCli(code);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`Failed to read JSON from ${filePath}: ${error.message}`);
  }
}

function loadConfig() {
  const configPath = process.env.HSAPI_PORTALS_CONFIG || DEFAULT_CONFIG;
  const config = readJsonFile(configPath);
  if (!config.portals || typeof config.portals !== 'object') {
    fail(`Portal config missing "portals" object: ${configPath}`);
  }
  return { configPath, config };
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);
    if (inlineValue !== null) {
      addFlag(flags, key, inlineValue);
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      addFlag(flags, key, true);
    } else {
      addFlag(flags, key, next);
      index += 1;
    }
  }
  return { positionals, flags };
}

function addFlag(flags, key, value) {
  if (flags[key] === undefined) {
    flags[key] = value;
  } else if (Array.isArray(flags[key])) {
    flags[key].push(value);
  } else {
    flags[key] = [flags[key], value];
  }
}

function values(flag) {
  if (flag === undefined) return [];
  return Array.isArray(flag) ? flag : [flag];
}

function boolFlag(flags, name) {
  return flags[name] === true || flags[name] === 'true';
}

function configString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function assertConfigObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value;
}

function expandUserPath(rawPath) {
  const value = String(rawPath);
  if (value === '~') {
    const home = process.env.HOME;
    if (!home) fail('Cannot expand "~" because HOME is not set.');
    return home;
  }
  if (value.startsWith('~/')) {
    const home = process.env.HOME;
    if (!home) fail(`Cannot expand "${value}" because HOME is not set.`);
    return path.join(home, value.slice(2));
  }
  return path.resolve(value);
}

function maybeResolvePortalBearerProfile(portal, portalName) {
  if (portal.auth !== undefined) assertConfigObject(portal.auth, `Portal "${portalName}" auth`);
  const explicitPortalBearer = portal.auth
    && Object.prototype.hasOwnProperty.call(portal.auth, 'portalBearer')
    ? portal.auth.portalBearer
    : undefined;

  if (explicitPortalBearer !== undefined) {
    const portalBearer = assertConfigObject(explicitPortalBearer, `Portal "${portalName}" auth.portalBearer`);
    const tokenEnv = configString(portalBearer.tokenEnv);
    if (!tokenEnv) {
      fail(`Portal "${portalName}" auth.portalBearer.tokenEnv must be a non-empty environment variable name.`);
    }
    return {
      family: AUTH_FAMILIES.PORTAL_BEARER,
      tokenEnv,
      profileField: 'auth.portalBearer.tokenEnv',
      provenance: 'explicit_profile',
      kind: configString(portalBearer.kind)
    };
  }

  const tokenEnv = configString(portal.tokenEnv);
  if (tokenEnv) {
    return {
      family: AUTH_FAMILIES.PORTAL_BEARER,
      tokenEnv,
      profileField: 'tokenEnv',
      provenance: 'legacy_profile',
      kind: null
    };
  }

  return null;
}

function resolvePortalBearerProfile(portal, portalName) {
  const portalBearer = maybeResolvePortalBearerProfile(portal, portalName);
  if (portalBearer) return portalBearer;
  fail(`Portal "${portalName}" is missing auth.portalBearer.tokenEnv or legacy tokenEnv. Named profiles must declare a profile-specific portal bearer token env var.`);
}

function resolveOAuthProfile(portal, portalName) {
  if (portal.auth !== undefined) assertConfigObject(portal.auth, `Portal "${portalName}" auth`);
  const rawOAuth = portal.auth
    && Object.prototype.hasOwnProperty.call(portal.auth, 'oauth')
    ? portal.auth.oauth
    : undefined;
  if (rawOAuth === undefined) return null;

  const oauth = assertConfigObject(rawOAuth, `Portal "${portalName}" auth.oauth`);
  const clientIdEnv = configString(oauth.clientIdEnv);
  const clientSecretEnv = configString(oauth.clientSecretEnv);
  const refreshTokenEnv = configString(oauth.refreshTokenEnv);
  const tokenCachePath = configString(oauth.tokenCachePath);
  if (!clientIdEnv) fail(`Portal "${portalName}" auth.oauth.clientIdEnv must be a non-empty environment variable name.`);
  if (!clientSecretEnv) fail(`Portal "${portalName}" auth.oauth.clientSecretEnv must be a non-empty environment variable name.`);
  if (!refreshTokenEnv) fail(`Portal "${portalName}" auth.oauth.refreshTokenEnv must be a non-empty environment variable name.`);
  if (!tokenCachePath) fail(`Portal "${portalName}" auth.oauth.tokenCachePath must be a non-empty cache path outside the package.`);

  return {
    family: AUTH_FAMILIES.OAUTH,
    clientIdEnv,
    clientSecretEnv,
    refreshTokenEnv,
    tokenCachePath: expandUserPath(tokenCachePath),
    tokenCachePathDisplay: tokenCachePath,
    tokenUrlPath: configString(oauth.tokenUrlPath) || '/oauth/2026-03/token',
    profileField: 'auth.oauth',
    provenance: 'explicit_profile'
  };
}

function optionalProfileEnv(config, key, label) {
  if (!Object.prototype.hasOwnProperty.call(config, key)) return null;
  const envName = configString(config[key]);
  if (!envName) fail(`${label}.${key} must be a non-empty environment variable name when present.`);
  return envName;
}

function resolveDeveloperProfile(portal, portalName) {
  if (portal.auth !== undefined) assertConfigObject(portal.auth, `Portal "${portalName}" auth`);
  const rawDeveloper = portal.auth
    && Object.prototype.hasOwnProperty.call(portal.auth, 'developer')
    ? portal.auth.developer
    : undefined;
  if (rawDeveloper === undefined) return null;

  const label = `Portal "${portalName}" auth.developer`;
  const developer = assertConfigObject(rawDeveloper, label);
  const tokenCachePath = configString(developer.tokenCachePath);
  return {
    family: AUTH_FAMILIES.DEVELOPER,
    personalAccessKeyEnv: optionalProfileEnv(developer, 'personalAccessKeyEnv', label),
    developerApiKeyEnv: optionalProfileEnv(developer, 'developerApiKeyEnv', label),
    appIdEnv: optionalProfileEnv(developer, 'appIdEnv', label),
    clientIdEnv: optionalProfileEnv(developer, 'clientIdEnv', label),
    clientSecretEnv: optionalProfileEnv(developer, 'clientSecretEnv', label),
    tokenCachePath: tokenCachePath ? expandUserPath(tokenCachePath) : null,
    tokenCachePathDisplay: tokenCachePath || null,
    tokenUrlPath: configString(developer.tokenUrlPath) || '/oauth/2026-03/token',
    profileField: 'auth.developer',
    provenance: 'explicit_profile'
  };
}

function resolveProfileDefaultFamily(portal, portalName) {
  if (!portal.auth || portal.auth.defaultFamily === undefined) return null;
  const family = configString(portal.auth.defaultFamily);
  if (!family || !Object.values(AUTH_FAMILIES).includes(family)) {
    fail(`Portal "${portalName}" auth.defaultFamily must be one of ${Object.values(AUTH_FAMILIES).join(', ')}.`);
  }
  return family;
}

function portalTokenEnv(portal, portalName) {
  return resolvePortalBearerProfile(portal, portalName).tokenEnv;
}

function resolvePortal(config, flags) {
  const portalName = flags.portal || process.env.HSAPI_PORTAL || config.default;
  if (!portalName) {
    fail('No portal selected and config has no default portal.');
  }
  const portal = config.portals[portalName];
  if (!portal) {
    fail(`Unknown portal "${portalName}". Run: hsapi profiles list`);
  }
  const portalBearer = maybeResolvePortalBearerProfile(portal, portalName);
  const oauth = resolveOAuthProfile(portal, portalName);
  const developer = resolveDeveloperProfile(portal, portalName);
  if (!portalBearer && !oauth && !developer) {
    fail(`Portal "${portalName}" is missing auth.portalBearer.tokenEnv, auth.oauth, auth.developer, or legacy tokenEnv. Named profiles must declare at least one explicit credential family.`);
  }
  const tokenEnv = portalBearer ? portalBearer.tokenEnv : null;
  const token = tokenEnv ? process.env[tokenEnv] : null;
  return {
    name: portalName,
    label: portal.label || portalName,
    portalId: portal.portalId || null,
    baseUrl: portal.baseUrl || 'https://api.hubapi.com',
    tokenEnv,
    token,
    portalBearer,
    oauth,
    developer,
    authDefaultFamily: resolveProfileDefaultFamily(portal, portalName),
    knownPlanLabel: portal.knownPlanLabel || null,
    knownPlanSource: portal.knownPlanSource || null,
    subscriptions: Array.isArray(portal.subscriptions) ? portal.subscriptions : []
  };
}

function isInsidePath(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function doctorCheck(checks, status, id, message, extra = {}) {
  checks.push({
    id,
    status,
    message,
    ...extra
  });
}

function doctorEnvCheck(checks, envName, label, options, extra = {}) {
  const present = Boolean(envName && process.env[envName]);
  const status = present ? 'pass' : (options.requireEnv ? 'fail' : 'warn');
  doctorCheck(
    checks,
    status,
    extra.id || `${label}.env`,
    present
      ? `${label} environment variable ${envName} is set.`
      : `${label} environment variable ${envName} is not set.`,
    {
      env: envName,
      present,
      ...extra
    }
  );
}

function doctorCachePathCheck(checks, cachePath, label, field) {
  if (!cachePath) return;
  const insidePackage = isInsidePath(PACKAGE_ROOT, cachePath);
  doctorCheck(
    checks,
    insidePackage ? 'fail' : 'pass',
    `${field}.outside_package`,
    insidePackage
      ? `${field} points inside the package. Token caches must live outside the package.`
      : `${field} points outside the package.`,
    {
      field,
      path: label || cachePath
    }
  );
}

function profileDoctor(name, rawPortal, options) {
  const checks = [];
  const portalBearer = maybeResolvePortalBearerProfile(rawPortal, name);
  const oauth = resolveOAuthProfile(rawPortal, name);
  const developer = resolveDeveloperProfile(rawPortal, name);
  const authDefaultFamily = resolveProfileDefaultFamily(rawPortal, name);
  const authFamilies = [];

  if (portalBearer) authFamilies.push(AUTH_FAMILIES.PORTAL_BEARER);
  if (oauth) authFamilies.push(AUTH_FAMILIES.OAUTH);
  if (developer) authFamilies.push(AUTH_FAMILIES.DEVELOPER);

  doctorCheck(
    checks,
    authFamilies.length ? 'pass' : 'fail',
    'profile.auth_family.configured',
    authFamilies.length
      ? `Profile "${name}" declares auth families: ${authFamilies.join(', ')}.`
      : `Profile "${name}" does not declare auth.portalBearer, auth.oauth, auth.developer, or legacy tokenEnv.`
  );

  if (authDefaultFamily) {
    doctorCheck(
      checks,
      authFamilies.includes(authDefaultFamily) ? 'pass' : 'fail',
      'profile.default_family.configured',
      authFamilies.includes(authDefaultFamily)
        ? `auth.defaultFamily ${authDefaultFamily} is configured on this profile.`
        : `auth.defaultFamily ${authDefaultFamily} is not backed by a configured auth family on this profile.`,
      {
        authDefaultFamily
      }
    );
  }

  if (portalBearer) {
    doctorCheck(checks, 'pass', 'portal_bearer.profile', 'portal_bearer profile metadata is configured.', {
      profileField: portalBearer.profileField,
      provenance: portalBearer.provenance,
      kind: portalBearer.kind || null
    });
    doctorEnvCheck(checks, portalBearer.tokenEnv, 'portal_bearer token', options, {
      id: 'portal_bearer.env',
      family: AUTH_FAMILIES.PORTAL_BEARER,
      profileField: portalBearer.profileField
    });
  }

  if (oauth) {
    doctorCheck(checks, 'pass', 'oauth.profile', 'oauth profile metadata is configured.', {
      profileField: oauth.profileField,
      tokenUrlPath: oauth.tokenUrlPath
    });
    doctorEnvCheck(checks, oauth.clientIdEnv, 'oauth client ID', options, {
      id: 'oauth.client_id_env',
      family: AUTH_FAMILIES.OAUTH,
      profileField: 'auth.oauth.clientIdEnv'
    });
    doctorEnvCheck(checks, oauth.clientSecretEnv, 'oauth client secret', options, {
      id: 'oauth.client_secret_env',
      family: AUTH_FAMILIES.OAUTH,
      profileField: 'auth.oauth.clientSecretEnv'
    });
    doctorEnvCheck(checks, oauth.refreshTokenEnv, 'oauth refresh token', options, {
      id: 'oauth.refresh_token_env',
      family: AUTH_FAMILIES.OAUTH,
      profileField: 'auth.oauth.refreshTokenEnv'
    });
    doctorCachePathCheck(checks, oauth.tokenCachePath, oauth.tokenCachePathDisplay, 'auth.oauth.tokenCachePath');
  }

  if (developer) {
    const developerSubtypes = [];
    doctorCheck(checks, 'pass', 'developer.profile', 'developer profile metadata is configured.', {
      profileField: developer.profileField,
      tokenUrlPath: developer.tokenUrlPath
    });

    if (developer.personalAccessKeyEnv) {
      developerSubtypes.push(DEVELOPER_AUTH_SUBTYPES.PERSONAL_ACCESS_KEY);
      doctorEnvCheck(checks, developer.personalAccessKeyEnv, 'developer personal access key', options, {
        id: 'developer.personal_access_key_env',
        family: AUTH_FAMILIES.DEVELOPER,
        subtype: DEVELOPER_AUTH_SUBTYPES.PERSONAL_ACCESS_KEY,
        profileField: 'auth.developer.personalAccessKeyEnv'
      });
    }

    if (developer.developerApiKeyEnv) {
      developerSubtypes.push(DEVELOPER_AUTH_SUBTYPES.DEVELOPER_API_KEY);
      doctorEnvCheck(checks, developer.developerApiKeyEnv, 'developer API key', options, {
        id: 'developer.developer_api_key_env',
        family: AUTH_FAMILIES.DEVELOPER,
        subtype: DEVELOPER_AUTH_SUBTYPES.DEVELOPER_API_KEY,
        profileField: 'auth.developer.developerApiKeyEnv'
      });
    }

    if (developer.appIdEnv) {
      doctorEnvCheck(checks, developer.appIdEnv, 'developer app ID', options, {
        id: 'developer.app_id_env',
        family: AUTH_FAMILIES.DEVELOPER,
        subtype: DEVELOPER_AUTH_SUBTYPES.DEVELOPER_API_KEY,
        profileField: 'auth.developer.appIdEnv'
      });
    }

    const hasClientCredentialsField = Boolean(developer.clientIdEnv || developer.clientSecretEnv || developer.tokenCachePath);
    if (hasClientCredentialsField) {
      developerSubtypes.push(DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS);
      for (const [field, value] of [
        ['auth.developer.clientIdEnv', developer.clientIdEnv],
        ['auth.developer.clientSecretEnv', developer.clientSecretEnv],
        ['auth.developer.tokenCachePath', developer.tokenCachePathDisplay]
      ]) {
        doctorCheck(
          checks,
          value ? 'pass' : 'fail',
          `${field}.configured`,
          value
            ? `${field} is configured for developer/client_credentials.`
            : `${field} is required when any developer client-credentials field is configured.`,
          { field }
        );
      }
      if (developer.clientIdEnv) {
        doctorEnvCheck(checks, developer.clientIdEnv, 'developer client-credentials client ID', options, {
          id: 'developer.client_credentials.client_id_env',
          family: AUTH_FAMILIES.DEVELOPER,
          subtype: DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS,
          profileField: 'auth.developer.clientIdEnv'
        });
      }
      if (developer.clientSecretEnv) {
        doctorEnvCheck(checks, developer.clientSecretEnv, 'developer client-credentials client secret', options, {
          id: 'developer.client_credentials.client_secret_env',
          family: AUTH_FAMILIES.DEVELOPER,
          subtype: DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS,
          profileField: 'auth.developer.clientSecretEnv'
        });
      }
      doctorCachePathCheck(checks, developer.tokenCachePath, developer.tokenCachePathDisplay, 'auth.developer.tokenCachePath');
    }

    doctorCheck(
      checks,
      developerSubtypes.length ? 'pass' : 'fail',
      'developer.subtype.configured',
      developerSubtypes.length
        ? `Developer auth subtypes configured: ${developerSubtypes.join(', ')}.`
        : 'auth.developer is present but no developer credential subtype fields are configured.',
      {
        subtypes: developerSubtypes
      }
    );
  }

  if (oauth && developer && oauth.tokenCachePath && developer.tokenCachePath) {
    doctorCheck(
      checks,
      oauth.tokenCachePath === developer.tokenCachePath ? 'fail' : 'pass',
      'token_cache.paths.separate',
      oauth.tokenCachePath === developer.tokenCachePath
        ? 'auth.oauth.tokenCachePath and auth.developer.tokenCachePath must be separate.'
        : 'OAuth and developer client-credentials token caches are separate.',
      {
        oauthTokenCachePath: oauth.tokenCachePathDisplay || oauth.tokenCachePath,
        developerTokenCachePath: developer.tokenCachePathDisplay || developer.tokenCachePath
      }
    );
  }

  const summary = checks.reduce((counts, check) => {
    counts[check.status] = (counts[check.status] || 0) + 1;
    return counts;
  }, {});

  return {
    name,
    label: rawPortal.label || name,
    portalId: rawPortal.portalId || null,
    baseUrl: rawPortal.baseUrl || 'https://api.hubapi.com',
    authFamilies,
    authDefaultFamily,
    ready: !summary.fail && !summary.warn,
    checks,
    summary
  };
}

function runAuthDoctor(flags) {
  const { configPath, config } = loadConfig();
  const requireEnv = boolFlag(flags, 'require-env');
  const selectedPortal = flags.portal || null;
  const names = selectedPortal ? [selectedPortal] : Object.keys(config.portals);
  if (selectedPortal && !config.portals[selectedPortal]) {
    fail(`Unknown portal "${selectedPortal}". Run: hsapi profiles list`);
  }

  const profiles = names.map((name) => profileDoctor(name, config.portals[name], { requireEnv }));
  const summary = profiles.reduce((counts, profile) => {
    for (const [status, count] of Object.entries(profile.summary)) {
      counts[status] = (counts[status] || 0) + count;
    }
    return counts;
  }, {});
  const ok = !summary.fail;
  const output = {
    ok,
    ready: ok && !summary.warn,
    configPath,
    requireEnv,
    profileCount: profiles.length,
    summary,
    authFamilies: Object.values(AUTH_FAMILIES),
    developerAuthSubtypes: Object.values(DEVELOPER_AUTH_SUBTYPES),
    profiles,
    commandAuthDiscovery: {
      catalogCommands: 'hsapi catalog commands',
      preview: 'Add --show-request to a command to see authFamily, authSubtype, and redacted credential sources before any request is sent.'
    }
  };
  printJson(output);
  if (!ok) exitCli(1);
}

function parseBody(raw) {
  if (raw === undefined) return undefined;
  const text = String(raw).startsWith('@')
    ? fs.readFileSync(path.resolve(String(raw).slice(1)), 'utf8')
    : String(raw);
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`Body/properties must be valid JSON: ${error.message}`);
  }
}

function parseMaybeJson(raw, fallback = raw) {
  if (raw === undefined) return undefined;
  if (String(raw).startsWith('@')) return parseBody(raw);
  try {
    return JSON.parse(String(raw));
  } catch (_error) {
    return fallback;
  }
}

function parsePropertiesList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readArgumentText(raw, label) {
  if (raw === undefined || raw === true || raw === '') fail(`Missing required --${label}.`);
  return String(raw).startsWith('@')
    ? fs.readFileSync(path.resolve(String(raw).slice(1)), 'utf8')
    : String(raw);
}

function parseIdInputs(raw, label = 'ids') {
  const text = readArgumentText(raw, label).trim();
  if (!text) fail(`--${label} must not be empty.`);

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(normalizeBatchIdInput);
    if (parsed && Array.isArray(parsed.inputs)) return parsed.inputs.map(normalizeBatchIdInput);
  } catch (_error) {
    // Fall through to CSV/newline parsing.
  }

  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(normalizeBatchIdInput);
}

function parseStringList(raw, label) {
  if (raw === undefined) return [];
  const text = readArgumentText(raw, label).trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item));
  } catch (_error) {
    // Fall through to CSV/newline parsing.
  }

  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => String(item));
}

function normalizeBatchIdInput(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  return { id: String(input) };
}

function assertBatchInputsBody(body, commandName) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.inputs)) {
    fail(`${commandName} requires a JSON array or object with an inputs array.`);
  }
  return body;
}

function applyInputIdProperty(body, idProperty) {
  if (!idProperty) return body;
  body.inputs = body.inputs.map((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    return input.idProperty === undefined ? { ...input, idProperty: String(idProperty) } : input;
  });
  return body;
}

function batchReadBodyFromFlags(flags) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return assertBatchInputsBody(explicitBody, 'crm batch-read');

  const body = { inputs: parseIdInputs(flags.ids, 'ids') };
  const properties = parsePropertiesList(flags.properties);
  if (properties.length) body.properties = properties;
  const propertiesWithHistory = parsePropertiesList(flags['properties-with-history']);
  if (propertiesWithHistory.length) body.propertiesWithHistory = propertiesWithHistory;
  if (flags['id-property']) body.idProperty = String(flags['id-property']);
  return body;
}

function recordCreateBodyFromFlags(flags) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return assertObjectBody(explicitBody, 'crm create --body');

  const properties = assertObjectBody(parseBody(requireFlag(flags, 'properties')), 'crm create --properties');
  const body = { properties };
  if (flags.associations !== undefined) {
    body.associations = parseBody(flags.associations);
  }
  return body;
}

function mergeBodyFromFlags(flags, primaryId, objectIdToMerge) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return assertObjectBody(explicitBody, 'crm merge --body');
  if (!primaryId || !objectIdToMerge) fail('crm merge requires <objectType> <primaryId> <objectIdToMerge>.');
  return {
    primaryObjectId: String(primaryId),
    objectIdToMerge: String(objectIdToMerge)
  };
}

function gdprDeleteBodyFromFlags(flags, objectId) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return assertObjectBody(explicitBody, 'crm gdpr-delete --body');
  if (!objectId) fail('crm gdpr-delete requires object id.');
  const body = { objectId: String(objectId) };
  if (flags['id-property']) body.idProperty = String(flags['id-property']);
  return body;
}

function batchWriteBodyFromFlags(flags, commandName, options = {}) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return assertBatchInputsBody(explicitBody, commandName);

  const rawInputs = requireFlag(flags, 'inputs');
  const parsed = parseBody(rawInputs);
  const body = Array.isArray(parsed) ? { inputs: parsed } : parsed;
  assertBatchInputsBody(body, commandName);
  return options.allowIdProperty ? applyInputIdProperty(body, flags['id-property']) : body;
}

function batchArchiveBodyFromFlags(flags) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return assertBatchInputsBody(explicitBody, 'crm batch-archive');
  return { inputs: parseIdInputs(flags.ids, 'ids') };
}

function associationTypesBodyFromFlags(flags) {
  const rawBody = flags.body || flags.types;
  if (rawBody !== undefined) {
    const parsed = parseBody(rawBody);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.types)) return parsed.types;
    fail('associations create requires a JSON array of association type specs, or an object with a types array.');
  }

  if (flags.category === undefined || flags['type-id'] === undefined) {
    fail('associations create requires --body/--types or --category <category> --type-id <id>.');
  }
  return [{
    associationCategory: String(flags.category),
    associationTypeId: optionalNumber(flags['type-id'])
  }];
}

function associationBatchBodyFromFlags(flags, commandName) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return assertBatchInputsBody(explicitBody, commandName);
  const rawInputs = requireFlag(flags, 'inputs');
  const parsed = parseBody(rawInputs);
  const body = Array.isArray(parsed) ? { inputs: parsed } : parsed;
  return assertBatchInputsBody(body, commandName);
}

function listSearchBodyFromFlags(flags) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return explicitBody;

  const body = {};
  const additionalProperties = parseStringList(flags['additional-properties'], 'additional-properties');
  if (additionalProperties.length) body.additionalProperties = additionalProperties;
  const listIds = parseStringList(flags['list-ids'], 'list-ids');
  if (listIds.length) body.listIds = listIds;
  const processingTypes = parseStringList(flags['processing-types'], 'processing-types');
  if (processingTypes.length) body.processingTypes = processingTypes;
  if (flags.offset !== undefined) body.offset = optionalNumber(flags.offset);
  if (flags.count !== undefined || flags.limit !== undefined) body.count = optionalNumber(flags.count || flags.limit);
  if (flags['object-type-id'] !== undefined) body.objectTypeId = String(flags['object-type-id']);
  if (flags.search !== undefined) body.query = String(flags.search);
  if (flags.sort !== undefined) body.sort = String(flags.sort);
  if (Object.keys(body).length === 0) body.count = 20;
  return body;
}

function listCreateBodyFromFlags(flags) {
  const explicitBody = parseBody(flags.body || flags.list);
  if (explicitBody !== undefined) return explicitBody;

  const body = {};
  for (const [flagName, bodyName] of Object.entries({
    name: 'name',
    'object-type-id': 'objectTypeId',
    'processing-type': 'processingType'
  })) {
    if (flags[flagName] !== undefined) body[bodyName] = String(flags[flagName]);
  }
  if (flags['list-folder-id'] !== undefined) body.listFolderId = optionalNumber(flags['list-folder-id']);
  if (flags['custom-properties'] !== undefined) body.customProperties = parseBody(flags['custom-properties']);
  if (flags['filter-branch'] !== undefined) body.filterBranch = parseBody(flags['filter-branch']);
  if (flags['list-permissions'] !== undefined) body.listPermissions = parseBody(flags['list-permissions']);
  if (flags['membership-settings'] !== undefined) body.membershipSettings = parseBody(flags['membership-settings']);

  for (const required of ['name', 'objectTypeId', 'processingType']) {
    if (body[required] === undefined || body[required] === '') {
      fail(`lists create requires --body or --${required.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}.`);
    }
  }
  return body;
}

function listMembershipBodyFromFlags(flags) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return explicitBody;
  return {
    recordIdsToAdd: parseStringList(flags.add, 'add'),
    recordIdsToRemove: parseStringList(flags.remove, 'remove')
  };
}

function exportStartBodyFromFlags(flags) {
  const explicitBody = parseBody(flags.body || flags.export);
  if (explicitBody !== undefined) return explicitBody;

  const body = {
    exportType: flags['export-type'] ? String(flags['export-type']) : 'VIEW',
    format: flags.format ? String(flags.format) : 'CSV',
    exportName: flags['export-name'] ? String(flags['export-name']) : undefined,
    objectType: flags['object-type'] ? String(flags['object-type']) : undefined,
    objectProperties: parseStringList(flags.properties, 'properties'),
    associatedObjectType: [],
    includeLabeledAssociations: false,
    includePrimaryDisplayPropertyForAssociatedObjects: false,
    language: flags.language ? String(flags.language) : 'EN',
    exportInternalValuesOptions: ['NAMES'],
    overrideAssociatedObjectsPerDefinitionPerRowLimit: false
  };

  const associatedObjectType = parseStringList(flags['associated-object-type'], 'associated-object-type');
  if (associatedObjectType.length) body.associatedObjectType = associatedObjectType;
  const internalValues = parseStringList(flags['export-internal-values-options'], 'export-internal-values-options');
  if (internalValues.length) body.exportInternalValuesOptions = internalValues;
  for (const flagName of [
    'include-labeled-associations',
    'include-primary-display-property-for-associated-objects',
    'override-associated-objects-per-definition-per-row-limit'
  ]) {
    const value = optionalBoolean(flags[flagName], flagName);
    if (value !== undefined) {
      body[flagName.replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
    }
  }

  for (const required of ['exportName', 'objectType']) {
    if (body[required] === undefined || body[required] === '') {
      fail(`exports start requires --body or --${required.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}.`);
    }
  }
  if (!body.objectProperties.length) fail('exports start requires --body or --properties <property,property>.');
  return body;
}

function importMultipartFromFlags(flags) {
  const importRequest = parseBody(flags['import-request'] || flags.body);
  if (importRequest === undefined) fail('imports start requires --import-request <json|@file>.');

  const files = values(flags.file || flags.files).map((rawPath) => {
    const filePath = path.resolve(String(rawPath));
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) fail(`Import file is not a file: ${filePath}`);
    return {
      path: filePath,
      filename: path.basename(filePath),
      size: stat.size,
      buffer: fs.readFileSync(filePath)
    };
  });
  if (!files.length) fail('imports start requires at least one --file <path>.');

  if (typeof FormData === 'undefined' || typeof Blob === 'undefined') {
    fail('This Node runtime does not provide FormData/Blob globals needed for multipart import upload.');
  }

  const form = new FormData();
  form.append('importRequest', JSON.stringify(importRequest));
  for (const file of files) {
    form.append('files', new Blob([file.buffer], { type: 'application/octet-stream' }), file.filename);
  }

  return {
    form,
    previewBody: {
      importRequest,
      files: files.map((file) => ({
        field: 'files',
        path: file.path,
        filename: file.filename,
        size: file.size
      }))
    }
  };
}

function assertObjectBody(body, label) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail(`${label} must be a JSON object.`);
  }
  return body;
}

function requireOneFolderTarget(flags, commandName) {
  const hasFolderId = flags['folder-id'] !== undefined;
  const hasFolderPath = flags['folder-path'] !== undefined;
  if (hasFolderId && hasFolderPath) fail(`${commandName} accepts --folder-id or --folder-path, not both.`);
  if (!hasFolderId && !hasFolderPath) fail(`${commandName} requires --folder-id or --folder-path.`);
}

function requireOneParentFolderTarget(flags, commandName) {
  const hasParentFolderId = flags['parent-folder-id'] !== undefined;
  const hasParentFolderPath = flags['parent-folder-path'] !== undefined;
  if (hasParentFolderId && hasParentFolderPath) {
    fail(`${commandName} accepts --parent-folder-id or --parent-folder-path, not both.`);
  }
}

function fileOptionsFromFlags(flags, commandName, options = {}) {
  const explicitOptions = parseBody(flags.options);
  const body = explicitOptions === undefined ? {} : assertObjectBody(explicitOptions, `${commandName} --options`);
  for (const [flagName, bodyName] of Object.entries({
    access: 'access',
    ttl: 'ttl',
    'expires-at': 'expiresAt',
    'duplicate-validation-scope': 'duplicateValidationScope',
    'duplicate-validation-strategy': 'duplicateValidationStrategy'
  })) {
    if (flags[flagName] !== undefined) body[bodyName] = String(flags[flagName]);
  }
  if (options.defaultDuplicateValidation) {
    if (body.duplicateValidationScope === undefined) body.duplicateValidationScope = 'ENTIRE_PORTAL';
    if (body.duplicateValidationStrategy === undefined) body.duplicateValidationStrategy = 'NONE';
  }
  if (flags.overwrite !== undefined) body.overwrite = optionalBoolean(flags.overwrite, 'overwrite');
  if (options.defaultOverwrite !== undefined && body.overwrite === undefined) body.overwrite = options.defaultOverwrite;
  if (options.requireAccess && !body.access) fail(`${commandName} requires --access <PRIVATE|PUBLIC_INDEXABLE|PUBLIC_NOT_INDEXABLE> or --options with access.`);
  return body;
}

function fileMultipartFromFlags(flags, commandName, options = {}) {
  const filePath = path.resolve(String(requireFlag(flags, 'file')));
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) fail(`File is not a file: ${filePath}`);

  if (typeof FormData === 'undefined' || typeof Blob === 'undefined') {
    fail('This Node runtime does not provide FormData/Blob globals needed for multipart file upload.');
  }

  if (options.requireFolder) requireOneFolderTarget(flags, commandName);
  const optionBody = fileOptionsFromFlags(flags, commandName, { requireAccess: true });
  const filename = flags['file-name'] ? String(flags['file-name']) : path.basename(filePath);
  const buffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/octet-stream' }), filename);
  form.append('options', JSON.stringify(optionBody));
  if (flags['folder-id'] !== undefined) form.append('folderId', String(flags['folder-id']));
  if (flags['folder-path'] !== undefined) form.append('folderPath', String(flags['folder-path']));
  if (flags['file-name'] !== undefined) form.append('fileName', String(flags['file-name']));
  if (flags['charset-hunch'] !== undefined) form.append('charsetHunch', String(flags['charset-hunch']));

  const previewBody = {
    file: {
      field: 'file',
      path: filePath,
      filename,
      size: stat.size
    },
    options: optionBody
  };
  if (flags['folder-id'] !== undefined) previewBody.folderId = String(flags['folder-id']);
  if (flags['folder-path'] !== undefined) previewBody.folderPath = String(flags['folder-path']);
  if (flags['file-name'] !== undefined) previewBody.fileName = String(flags['file-name']);
  if (flags['charset-hunch'] !== undefined) previewBody.charsetHunch = String(flags['charset-hunch']);

  return { form, previewBody };
}

function appendQueryValue(queryFlags, queryName, value) {
  if (value === undefined) return;
  queryFlags.query.push(`${queryName}=${value}`);
}

function appendQueryList(queryFlags, queryName, raw, label) {
  for (const value of parseStringList(raw, label)) {
    queryFlags.query.push(`${queryName}=${value}`);
  }
}

function appendMappedSearchQuery(flags, fieldMap, listMap = {}) {
  const queryFlags = { ...flags, query: values(flags.query) };
  for (const [flagName, queryName] of Object.entries(fieldMap)) {
    appendQueryValue(queryFlags, queryName, flags[flagName]);
  }
  for (const [flagName, queryName] of Object.entries(listMap)) {
    appendQueryList(queryFlags, queryName, flags[flagName], flagName);
  }
  return queryFlags;
}

function fileSearchQueryFlags(flags) {
  return appendMappedSearchQuery(flags, {
    after: 'after',
    before: 'before',
    'allows-anonymous-access': 'allowsAnonymousAccess',
    'created-at': 'createdAt',
    'created-at-gte': 'createdAtGte',
    'created-at-lte': 'createdAtLte',
    encoding: 'encoding',
    'expires-at': 'expiresAt',
    'expires-at-gte': 'expiresAtGte',
    'expires-at-lte': 'expiresAtLte',
    extension: 'extension',
    'file-md5': 'fileMd5',
    height: 'height',
    'height-gte': 'heightGte',
    'height-lte': 'heightLte',
    'id-gte': 'idGte',
    'id-lte': 'idLte',
    'is-usable-in-content': 'isUsableInContent',
    limit: 'limit',
    name: 'name',
    path: 'path',
    size: 'size',
    'size-gte': 'sizeGte',
    'size-lte': 'sizeLte',
    type: 'type',
    'updated-at': 'updatedAt',
    'updated-at-gte': 'updatedAtGte',
    'updated-at-lte': 'updatedAtLte',
    url: 'url',
    width: 'width',
    'width-gte': 'widthGte',
    'width-lte': 'widthLte'
  }, {
    ids: 'ids',
    'parent-folder-ids': 'parentFolderIds',
    properties: 'properties',
    sort: 'sort'
  });
}

function folderSearchQueryFlags(flags) {
  return appendMappedSearchQuery(flags, {
    after: 'after',
    before: 'before',
    'created-at': 'createdAt',
    'created-at-gte': 'createdAtGte',
    'created-at-lte': 'createdAtLte',
    'id-gte': 'idGte',
    'id-lte': 'idLte',
    limit: 'limit',
    name: 'name',
    path: 'path',
    'updated-at': 'updatedAt',
    'updated-at-gte': 'updatedAtGte',
    'updated-at-lte': 'updatedAtLte'
  }, {
    ids: 'ids',
    'parent-folder-ids': 'parentFolderIds',
    properties: 'properties',
    sort: 'sort'
  });
}

function propertiesQueryFlags(flags, queryName = 'properties') {
  const queryFlags = { ...flags, query: values(flags.query) };
  appendQueryList(queryFlags, queryName, flags.properties || flags.property, 'properties');
  return queryFlags;
}

function fileImportUrlBodyFromFlags(flags) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return assertObjectBody(explicitBody, 'files import-url --body');
  requireOneFolderTarget(flags, 'files import-url');
  const body = fileOptionsFromFlags(flags, 'files import-url', {
    defaultDuplicateValidation: true,
    defaultOverwrite: false,
    requireAccess: true
  });
  body.url = String(requireFlag(flags, 'url'));
  if (flags['folder-id'] !== undefined) body.folderId = String(flags['folder-id']);
  if (flags['folder-path'] !== undefined) body.folderPath = String(flags['folder-path']);
  if (flags.name !== undefined) body.name = String(flags.name);
  if (flags['file-name'] !== undefined && body.name === undefined) body.name = String(flags['file-name']);
  return body;
}

function fileUpdateBodyFromFlags(flags) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return assertObjectBody(explicitBody, 'files update --body');
  requireOneParentFolderTarget(flags, 'files update');
  const body = {};
  for (const [flagName, bodyName] of Object.entries({
    access: 'access',
    'expires-at': 'expiresAt',
    name: 'name',
    'parent-folder-id': 'parentFolderId',
    'parent-folder-path': 'parentFolderPath'
  })) {
    if (flags[flagName] !== undefined) body[bodyName] = String(flags[flagName]);
  }
  const clearExpires = optionalBoolean(flags['clear-expires'], 'clear-expires');
  if (clearExpires !== undefined) body.clearExpires = clearExpires;
  const isUsableInContent = optionalBoolean(flags['is-usable-in-content'], 'is-usable-in-content');
  if (isUsableInContent !== undefined) body.isUsableInContent = isUsableInContent;
  if (!Object.keys(body).length) fail('files update requires --body or at least one update flag.');
  return body;
}

function folderBodyFromFlags(flags, commandName, options = {}) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return assertObjectBody(explicitBody, `${commandName} --body`);
  requireOneParentFolderTarget(flags, commandName);
  const body = {};
  if (options.folderId !== undefined) body.id = String(options.folderId);
  if (flags.name !== undefined) body.name = String(flags.name);
  if (flags['parent-folder-id'] !== undefined) body.parentFolderId = String(flags['parent-folder-id']);
  if (flags['parent-folder-path'] !== undefined) body.parentFolderPath = String(flags['parent-folder-path']);
  if (options.requireName && !body.name) fail(`${commandName} requires --name or --body.`);
  if (!Object.keys(body).length || (options.folderId !== undefined && Object.keys(body).length === 1)) {
    fail(`${commandName} requires --body or at least one folder property flag.`);
  }
  return body;
}

function sourceCodeMultipartFromFlags(flags, commandName) {
  const filePath = path.resolve(String(requireFlag(flags, 'file')));
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) fail(`File is not a file: ${filePath}`);

  if (typeof FormData === 'undefined' || typeof Blob === 'undefined') {
    fail('This Node runtime does not provide FormData/Blob globals needed for multipart file upload.');
  }

  const filename = flags['file-name'] ? String(flags['file-name']) : path.basename(filePath);
  const buffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/octet-stream' }), filename);

  return {
    form,
    previewBody: {
      file: {
        field: 'file',
        path: filePath,
        filename,
        size: stat.size
      }
    }
  };
}

function coerceFlagValue(raw, type, flagName) {
  if (type === 'number') return optionalNumber(raw);
  if (type === 'boolean') return optionalBoolean(raw, flagName);
  if (type === 'json') return parseMaybeJson(raw);
  if (type === 'string-list') return parseStringList(raw, flagName);
  return String(raw);
}

function mappedBodyFromFlags(flags, commandName, mapping = {}, options = {}) {
  const explicitBody = parseBody(flags.body || flags[options.alias]);
  if (explicitBody !== undefined) return assertObjectBody(explicitBody, `${commandName} --body`);
  const body = {};
  for (const [flagName, config] of Object.entries(mapping)) {
    if (flags[flagName] === undefined) continue;
    const bodyName = typeof config === 'string' ? config : config.name;
    const type = typeof config === 'string' ? 'string' : (config.type || 'string');
    body[bodyName] = coerceFlagValue(flags[flagName], type, flagName);
  }
  if (options.requireAny !== false && !Object.keys(body).length) {
    fail(`${commandName} requires --body or at least one body flag.`);
  }
  for (const flagName of options.requiredFlags || []) {
    const config = mapping[flagName];
    const bodyName = typeof config === 'string' ? config : config.name;
    if (body[bodyName] === undefined || body[bodyName] === '') fail(`${commandName} requires --${flagName} or --body.`);
  }
  return body;
}

function inputsBodyFromFlags(flags, commandName, inputFlag = 'ids') {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return assertBatchInputsBody(explicitBody, commandName);
  const inputs = parseIdInputs(requireFlag(flags, inputFlag), inputFlag);
  if (!inputs.length) fail(`${commandName} requires at least one value in --${inputFlag}.`);
  return { inputs };
}

function objectFromJsonFlag(raw, label) {
  return assertObjectBody(parseBody(raw), label);
}

function hubDbTableBodyFromFlags(flags, commandName) {
  const explicitBody = parseBody(flags.body || flags.table);
  if (explicitBody !== undefined) return assertObjectBody(explicitBody, `${commandName} --body`);
  const body = mappedBodyFromFlags(flags, commandName, {
    name: 'name',
    label: 'label',
    columns: { name: 'columns', type: 'json' },
    'allow-child-tables': { name: 'allowChildTables', type: 'boolean' },
    'allow-public-api-access': { name: 'allowPublicApiAccess', type: 'boolean' },
    'dynamic-meta-tags': { name: 'dynamicMetaTags', type: 'json' },
    'enable-child-table-pages': { name: 'enableChildTablePages', type: 'boolean' },
    'use-for-pages': { name: 'useForPages', type: 'boolean' }
  }, {
    requiredFlags: ['name', 'label', 'columns']
  });
  if (!Array.isArray(body.columns)) fail(`${commandName} --columns must be a JSON array.`);
  return body;
}

function hubDbRowBodyFromFlags(flags, commandName) {
  const explicitBody = parseBody(flags.body || flags.row);
  if (explicitBody !== undefined) return assertObjectBody(explicitBody, `${commandName} --body`);
  const body = mappedBodyFromFlags(flags, commandName, {
    values: { name: 'values', type: 'json' },
    name: 'name',
    path: 'path',
    'child-table-id': { name: 'childTableId', type: 'number' },
    'display-index': { name: 'displayIndex', type: 'number' }
  }, {
    requiredFlags: ['values']
  });
  return body;
}

function campaignBodyFromFlags(flags, commandName) {
  const explicitBody = parseBody(flags.body || flags.campaign);
  if (explicitBody !== undefined) return assertObjectBody(explicitBody, `${commandName} --body`);
  return {
    properties: objectFromJsonFlag(requireFlag(flags, 'properties'), `${commandName} --properties`)
  };
}

function marketingEmailBodyFromFlags(flags, commandName) {
  return mappedBodyFromFlags(flags, commandName, {
    'active-domain': 'activeDomain',
    archived: { name: 'archived', type: 'boolean' },
    'business-unit-id': { name: 'businessUnitId', type: 'number' },
    campaign: 'campaign',
    content: { name: 'content', type: 'json' },
    'feedback-survey-id': 'feedbackSurveyId',
    'folder-id-v2': { name: 'folderIdV2', type: 'number' },
    from: { name: 'from', type: 'json' },
    language: 'language',
    name: 'name',
    'publish-date': 'publishDate',
    'send-on-publish': { name: 'sendOnPublish', type: 'boolean' },
    state: 'state',
    subcategory: 'subcategory',
    subject: 'subject',
    'subscription-details': { name: 'subscriptionDetails', type: 'json' },
    to: { name: 'to', type: 'json' },
    webversion: { name: 'webversion', type: 'json' }
  });
}

function marketingEventInputFromFlags(flags, commandName) {
  const input = mappedBodyFromFlags(flags, commandName, {
    'external-account-id': 'externalAccountId',
    'external-event-id': 'externalEventId',
    'event-name': 'eventName',
    'event-organizer': 'eventOrganizer',
    'event-cancelled': { name: 'eventCancelled', type: 'boolean' },
    'event-completed': { name: 'eventCompleted', type: 'boolean' },
    'event-url': 'eventUrl',
    'event-description': 'eventDescription',
    'start-date-time': 'startDateTime',
    'end-date-time': 'endDateTime',
    'custom-properties': { name: 'customProperties', type: 'json' }
  }, {
    requiredFlags: ['external-account-id', 'external-event-id', 'event-name', 'event-organizer']
  });
  return input;
}

function marketingEventBodyFromFlags(flags, commandName, options = {}) {
  const explicitBody = parseBody(flags.body || flags.event);
  if (explicitBody !== undefined) return assertObjectBody(explicitBody, `${commandName} --body`);
  if (options.wrapInputs && flags.inputs !== undefined) {
    const parsed = parseBody(flags.inputs);
    const body = Array.isArray(parsed) ? { inputs: parsed } : parsed;
    return assertBatchInputsBody(body, commandName);
  }
  const input = marketingEventInputFromFlags(flags, commandName);
  return options.wrapInputs ? { inputs: [input] } : input;
}

function transactionalEmailBodyFromFlags(flags, commandName) {
  const explicitBody = parseBody(flags.body || flags.email);
  if (explicitBody !== undefined) return assertObjectBody(explicitBody, `${commandName} --body`);

  const message = {};
  for (const [flagName, bodyName] of Object.entries({
    to: 'to',
    from: 'from',
    'send-id': 'sendId'
  })) {
    if (flags[flagName] !== undefined) message[bodyName] = String(flags[flagName]);
  }
  for (const flagName of ['reply-to', 'cc', 'bcc']) {
    const valuesForFlag = parseStringList(flags[flagName], flagName);
    if (valuesForFlag.length) message[flagName.replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = valuesForFlag;
  }
  if (!message.to) fail(`${commandName} requires --to or --body.`);

  const body = {
    emailId: optionalNumber(requireFlag(flags, 'email-id')),
    message
  };
  if (flags['contact-properties'] !== undefined) {
    body.contactProperties = objectFromJsonFlag(flags['contact-properties'], `${commandName} --contact-properties`);
  }
  if (flags['custom-properties'] !== undefined) {
    body.customProperties = objectFromJsonFlag(flags['custom-properties'], `${commandName} --custom-properties`);
  }
  return body;
}

function hasQueryParameter(flags, queryName) {
  return values(flags.query).some((item) => String(item).split('=')[0] === queryName);
}

function sequenceQueryFlags(flags, commandName, options = {}) {
  const queryFlags = { ...flags, query: values(flags.query) };
  if (options.list === true) {
    appendQueryValue(queryFlags, 'after', flags.after);
    appendQueryValue(queryFlags, 'limit', flags.limit);
    appendQueryValue(queryFlags, 'name', flags.name);
  }

  if (flags['user-id'] !== undefined) {
    const userId = requireFlag(flags, 'user-id');
    queryFlags.query.push(`userId=${userId}`);
  }

  if (options.requireUser === true && !flags['user-id'] && !hasQueryParameter(queryFlags, 'userId')) {
    fail(`${commandName} requires --user-id <id> or --query userId=<id>.`);
  }

  return queryFlags;
}

function sequenceEnrollmentBodyFromFlags(flags) {
  const explicitBody = parseBody(flags.body || flags.enrollment);
  if (explicitBody !== undefined) return assertObjectBody(explicitBody, 'automation sequences enroll --body');
  return mappedBodyFromFlags(flags, 'automation sequences enroll', {
    'contact-id': 'contactId',
    'sequence-id': 'sequenceId',
    'sender-email': 'senderEmail',
    'sender-alias-address': 'senderAliasAddress'
  }, {
    requiredFlags: ['contact-id', 'sequence-id', 'sender-email']
  });
}

function callingRecordingSettingsBodyFromFlags(flags, commandName) {
  const explicitBody = parseBody(flags.body || flags.settings);
  if (explicitBody !== undefined) return assertObjectBody(explicitBody, `${commandName} --body`);
  const url = flags.url || flags['recording-url'] || flags['url-to-retrieve-authed-recording'];
  if (url === undefined || url === true || url === '') fail(`${commandName} requires --url, --recording-url, or --body.`);
  return { urlToRetrieveAuthedRecording: String(url) };
}

function callingRecordingReadyBodyFromFlags(flags) {
  const explicitBody = parseBody(flags.body || flags.ready);
  if (explicitBody !== undefined) return assertObjectBody(explicitBody, 'extensions calling recordings ready --body');
  return { engagementId: optionalNumber(requireFlag(flags, 'engagement-id')) };
}

function callingTranscriptCreateBodyFromFlags(flags) {
  const explicitBody = parseBody(flags.body || flags.transcript);
  if (explicitBody !== undefined) return assertObjectBody(explicitBody, 'extensions calling transcripts create --body');
  const utterances = parseBody(requireFlag(flags, 'utterances'));
  if (!Array.isArray(utterances)) fail('extensions calling transcripts create --utterances must be a JSON array.');
  return {
    engagementId: optionalNumber(requireFlag(flags, 'engagement-id')),
    transcriptCreateUtterances: utterances
  };
}

function workflowGetQueryFlags(flags) {
  const queryFlags = { ...flags, query: values(flags.query) };
  for (const flagName of ['errors', 'stats']) {
    const value = optionalBoolean(flags[flagName], flagName);
    if (value !== undefined) queryFlags.query.push(`${flagName}=${value}`);
  }
  return queryFlags;
}

function offsetsBodyFromFlags(flags, commandName) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return explicitBody;
  const offsets = parseStringList(requireFlag(flags, 'offsets'), 'offsets')
    .map((offset) => optionalNumber(offset));
  if (!offsets.length) fail(`${commandName} requires at least one offset in --offsets.`);
  return { offsets };
}

function eventOccurrencesQueryFlags(flags) {
  return appendMappedSearchQuery(flags, {
    after: 'after',
    before: 'before',
    id: 'id',
    limit: 'limit',
    'event-type': 'eventType',
    'object-type': 'objectType',
    'object-id': 'objectId',
    'occurred-after': 'occurredAfter',
    'occurred-before': 'occurredBefore'
  }, {
    properties: 'properties'
  });
}

function genericListQueryFlags(flags) {
  return appendMappedSearchQuery(flags, {
    after: 'after',
    before: 'before',
    limit: 'limit',
    offset: 'offset',
    archived: 'archived',
    status: 'status',
    'inbox-id': 'inboxId',
    'channel-id': 'channelId',
    'channel-account-id': 'channelAccountId',
    'thread-id': 'threadId',
    'associated-contact-id': 'associatedContactId',
    'created-after': 'createdAfter',
    'created-before': 'createdBefore',
    'updated-after': 'updatedAfter',
    'updated-before': 'updatedBefore'
  }, {
    sort: 'sort',
    properties: 'properties'
  });
}

function eventDefinitionBodyFromFlags(flags, commandName) {
  return mappedBodyFromFlags(flags, commandName, {
    name: 'name',
    label: 'label',
    description: 'description',
    'object-type': 'objectType',
    'primary-object-type': 'primaryObjectType'
  });
}

function eventPropertyBodyFromFlags(flags, commandName) {
  return mappedBodyFromFlags(flags, commandName, {
    name: 'name',
    label: 'label',
    description: 'description',
    type: 'type',
    'field-type': 'fieldType',
    options: { name: 'options', type: 'json' }
  });
}

function eventSendBodyFromFlags(flags, commandName) {
  return mappedBodyFromFlags(flags, commandName, {
    'event-name': 'eventName',
    email: 'email',
    'object-id': 'objectId',
    'object-type': 'objectType',
    'occurred-at': 'occurredAt',
    properties: { name: 'properties', type: 'json' },
    inputs: { name: 'inputs', type: 'json' }
  });
}

function webhookSettingsBodyFromFlags(flags) {
  return mappedBodyFromFlags(flags, 'webhooks settings-update', {
    'target-url': 'targetUrl',
    throttling: { name: 'throttling', type: 'json' },
    'max-concurrent-requests': { name: 'maxConcurrentRequests', type: 'number' }
  });
}

function webhookSubscriptionBodyFromFlags(flags, commandName) {
  return mappedBodyFromFlags(flags, commandName, {
    'subscription-type': 'subscriptionType',
    'property-name': 'propertyName',
    active: { name: 'active', type: 'boolean' },
    inputs: { name: 'inputs', type: 'json' }
  });
}

function webhookJournalSubscriptionBodyFromFlags(flags, commandName) {
  return mappedBodyFromFlags(flags, commandName, {
    'portal-id': 'portalId',
    'callback-url': 'callbackUrl',
    name: 'name',
    active: { name: 'active', type: 'boolean' },
    filters: { name: 'filters', type: 'json' }
  });
}

function conversationBodyFromFlags(flags, commandName) {
  return mappedBodyFromFlags(flags, commandName, {
    text: 'text',
    subject: 'subject',
    status: 'status',
    archived: { name: 'archived', type: 'boolean' },
    'actor-id': 'actorId',
    'assignee-id': 'assigneeId',
    'channel-id': 'channelId',
    'channel-account-id': 'channelAccountId',
    'inbox-id': 'inboxId',
    name: 'name',
    label: 'label',
    url: 'url',
    email: 'email',
    'first-name': 'firstName',
    'last-name': 'lastName',
    'object-id': 'objectId',
    'object-type': 'objectType',
    metadata: { name: 'metadata', type: 'json' },
    content: { name: 'content', type: 'json' },
    recipients: { name: 'recipients', type: 'json' },
    senders: { name: 'senders', type: 'json' },
    properties: { name: 'properties', type: 'json' }
  });
}

function formListQueryFlags(flags) {
  const queryFlags = appendMappedSearchQuery(flags, {
    after: 'after',
    limit: 'limit',
    archived: 'archived',
    'form-type': 'formTypes'
  }, {
    'form-types': 'formTypes'
  });
  return queryFlags;
}

function formDefinitionBodyFromFlags(flags, commandName, options = {}) {
  const body = mappedBodyFromFlags(flags, commandName, {
    name: 'name',
    'form-type': 'formType',
    archived: { name: 'archived', type: 'boolean' },
    'field-groups': { name: 'fieldGroups', type: 'json' },
    configuration: { name: 'configuration', type: 'json' },
    'display-options': { name: 'displayOptions', type: 'json' },
    'legal-consent-options': { name: 'legalConsentOptions', type: 'json' }
  });
  if (options.defaultFormType && body.formType === undefined) body.formType = 'hubspot';
  return body;
}

function formSubmissionBodyFromFlags(flags, commandName) {
  const body = mappedBodyFromFlags(flags, commandName, {
    fields: { name: 'fields', type: 'json' },
    'submitted-at': 'submittedAt',
    context: { name: 'context', type: 'json' },
    'legal-consent-options': { name: 'legalConsentOptions', type: 'json' },
    'skip-validation': { name: 'skipValidation', type: 'boolean' }
  });
  if (!Array.isArray(body.fields)) fail(`${commandName} requires --fields <json-array> or --body with fields.`);
  return body;
}

function cmsListQueryFlags(flags, fieldMap, listMap = {}) {
  return appendMappedSearchQuery(flags, fieldMap, listMap);
}

function cmsPageListQueryFlags(flags) {
  return cmsListQueryFlags(flags, {
    after: 'after',
    archived: 'archived',
    limit: 'limit',
    sort: 'sort',
    state: 'state__in',
    slug: 'slug__eq',
    name: 'name__icontains',
    domain: 'domain__eq',
    language: 'language__in',
    'publish-date-gt': 'publishDate__gt',
    'publish-date-lt': 'publishDate__lt',
    'created-after': 'createdAt__gt',
    'created-before': 'createdAt__lt',
    'updated-after': 'updatedAt__gt',
    'updated-before': 'updatedAt__lt',
    'template-path': 'templatePath__contains',
    'folder-id': 'folderId__eq'
  });
}

function cmsBlogPostListQueryFlags(flags) {
  return cmsListQueryFlags(flags, {
    after: 'after',
    archived: 'archived',
    limit: 'limit',
    sort: 'sort',
    state: 'state',
    slug: 'slug__eq',
    name: 'name__icontains',
    'content-group-id': 'contentGroupId__eq',
    'blog-author-id': 'blogAuthorId__eq',
    'tag-id': 'tagId__eq',
    'publish-date-gt': 'publishDate__gt',
    'publish-date-lt': 'publishDate__lt',
    'created-after': 'createdAt__gt',
    'created-before': 'createdAt__lt',
    'updated-after': 'updatedAt__gt',
    'updated-before': 'updatedAt__lt'
  });
}

function cmsPageBodyFromFlags(flags, commandName, options = {}) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return assertObjectBody(explicitBody, `${commandName} --body`);

  const body = mappedBodyFromFlags(flags, commandName, {
    name: 'name',
    'html-title': 'htmlTitle',
    slug: 'slug',
    domain: 'domain',
    state: 'state',
    'publish-date': 'publishDate',
    'template-path': 'templatePath',
    'featured-image': 'featuredImage',
    'featured-image-alt-text': 'featuredImageAltText',
    'use-featured-image': { name: 'useFeaturedImage', type: 'boolean' },
    language: 'language',
    'translated-from-id': 'translatedFromId',
    'folder-id': 'folderId',
    'content-type-category': { name: 'contentTypeCategory', type: 'number' },
    'archived-in-dashboard': { name: 'archivedInDashboard', type: 'boolean' },
    'page-redirected': { name: 'pageRedirected', type: 'boolean' },
    'public-access-rules-enabled': { name: 'publicAccessRulesEnabled', type: 'boolean' },
    'public-access-rules': { name: 'publicAccessRules', type: 'json' },
    'layout-sections': { name: 'layoutSections', type: 'json' },
    'widget-containers': { name: 'widgetContainers', type: 'json' },
    widgets: { name: 'widgets', type: 'json' }
  }, {
    requireAny: false
  });

  if (body.templatePath !== undefined) {
    body.templatePath = String(body.templatePath).replace(/^\/+/, '');
  }
  if (body.featuredImage !== undefined && body.useFeaturedImage === undefined) {
    body.useFeaturedImage = true;
  }
  if (options.requireName && !body.name) fail(`${commandName} requires --name or --body.`);
  if (options.requireTemplatePath && !body.templatePath) fail(`${commandName} requires --template-path or --body.`);
  if (!Object.keys(body).length) fail(`${commandName} requires --body or at least one page field flag.`);
  return body;
}

function cmsBlogPostBodyFromFlags(flags, commandName, options = {}) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return assertObjectBody(explicitBody, `${commandName} --body`);

  const body = mappedBodyFromFlags(flags, commandName, {
    name: 'name',
    'content-group-id': 'contentGroupId',
    slug: 'slug',
    'blog-author-id': 'blogAuthorId',
    'meta-description': 'metaDescription',
    'use-featured-image': { name: 'useFeaturedImage', type: 'boolean' },
    'featured-image': 'featuredImage',
    'featured-image-alt-text': 'featuredImageAltText',
    'post-body': 'postBody',
    'post-summary': 'postSummary',
    'html-title': 'htmlTitle',
    'tag-ids': { name: 'tagIds', type: 'string-list' },
    language: 'language',
    state: 'state',
    'publish-date': 'publishDate',
    'archived-in-dashboard': { name: 'archivedInDashboard', type: 'boolean' },
    'translated-from-id': 'translatedFromId',
    'dynamic-page-hubdb-table-id': 'dynamicPageHubDbTableId',
    'folder-id': 'folderId',
    widgets: { name: 'widgets', type: 'json' },
    'widget-containers': { name: 'widgetContainers', type: 'json' },
    translations: { name: 'translations', type: 'json' }
  }, {
    requireAny: false
  });

  if (body.featuredImage !== undefined && body.useFeaturedImage === undefined) {
    body.useFeaturedImage = true;
  }
  if (options.requireName && !body.name) fail(`${commandName} requires --name or --body.`);
  if (options.requireContentGroupId && !body.contentGroupId) fail(`${commandName} requires --content-group-id or --body.`);
  if (!Object.keys(body).length) fail(`${commandName} requires --body or at least one blog post field flag.`);
  return body;
}

function cmsRedirectBodyFromFlags(flags, commandName, options = {}) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return assertObjectBody(explicitBody, `${commandName} --body`);

  const body = mappedBodyFromFlags(flags, commandName, {
    'route-prefix': 'routePrefix',
    destination: 'destination',
    'redirect-style': { name: 'redirectStyle', type: 'number' },
    'is-only-after-not-found': { name: 'isOnlyAfterNotFound', type: 'boolean' },
    'is-match-full-url': { name: 'isMatchFullUrl', type: 'boolean' },
    'is-match-query-string': { name: 'isMatchQueryString', type: 'boolean' },
    'is-pattern': { name: 'isPattern', type: 'boolean' },
    'is-protocol-agnostic': { name: 'isProtocolAgnostic', type: 'boolean' },
    'is-trailing-slash-optional': { name: 'isTrailingSlashOptional', type: 'boolean' },
    precedence: { name: 'precedence', type: 'number' }
  }, {
    requireAny: false
  });

  if (options.requireRoutePrefix && !body.routePrefix && flags['route-prefix'] === undefined) {
    fail(`${commandName} requires --route-prefix or --body.`);
  }
  if (options.requireDestination && !body.destination && flags.destination === undefined) {
    fail(`${commandName} requires --destination or --body.`);
  }
  if (!Object.keys(body).length) fail(`${commandName} requires --body or at least one redirect field flag.`);
  return body;
}

function cmsScheduleBodyFromFlags(flags, commandName, id) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) {
    const body = assertObjectBody(explicitBody, `${commandName} --body`);
    if (body.id === undefined || body.publishDate === undefined) {
      fail(`${commandName} --body must include id and publishDate.`);
    }
    return body;
  }

  const body = mappedBodyFromFlags(flags, commandName, {
    'publish-date': 'publishDate'
  }, {
    requireAny: false
  });
  if (id !== undefined) body.id = String(id);
  if (body.publishDate === undefined) fail(`${commandName} requires --publish-date or --body.`);
  if (!body.id) fail(`${commandName} requires an id.`);
  return body;
}

function cmsSearchQueryFlags(flags) {
  return appendMappedSearchQuery(flags, {
    q: 'q',
    search: 'q',
    type: 'type',
    'path-prefix': 'pathPrefix',
    'match-prefix': 'matchPrefix',
    language: 'language',
    'table-id': 'tableId',
    'hubdb-query': 'hubdbQuery',
    property: 'property',
    length: 'length',
    limit: 'limit',
    offset: 'offset',
    analytics: 'analytics',
    autocomplete: 'autocomplete',
    'boost-limit': 'boostLimit',
    'boost-recent': 'boostRecent',
    'popularity-boost': 'popularityBoost'
  }, {
    domain: 'domain',
    'group-id': 'groupId'
  });
}

function cmsIndexedDataQueryFlags(flags) {
  return appendMappedSearchQuery(flags, {
    type: 'type'
  });
}

function authClientId(flags) {
  return secretValue(flags, 'client-id', 'HUBSPOT_CLIENT_ID');
}

function authClientSecret(flags) {
  return secretValue(flags, 'client-secret', 'HUBSPOT_CLIENT_SECRET');
}

function optionalAuthToken(flags) {
  if (flags.token !== undefined) return String(flags.token);
  if (flags['access-token'] !== undefined) return String(flags['access-token']);
  if (flags['refresh-token'] !== undefined) return String(flags['refresh-token']);
  if (flags['token-env'] !== undefined) return secretFromNamedEnv(flags['token-env'], 'token-env');
  if (process.env.HUBSPOT_OAUTH_TOKEN) return process.env.HUBSPOT_OAUTH_TOKEN;
  if (process.env.HUBSPOT_ACCESS_TOKEN) return process.env.HUBSPOT_ACCESS_TOKEN;
  if (process.env.HUBSPOT_REFRESH_TOKEN) return process.env.HUBSPOT_REFRESH_TOKEN;
  return null;
}

function authTokenTypeHint(flags) {
  if (flags['token-type-hint'] !== undefined) return String(flags['token-type-hint']);
  if (flags['refresh-token'] !== undefined) return 'refresh_token';
  if (flags['access-token'] !== undefined) return 'access_token';
  if (process.env.HUBSPOT_OAUTH_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN) return 'access_token';
  if (process.env.HUBSPOT_REFRESH_TOKEN) return 'refresh_token';
  return 'access_token';
}

function secretFromNamedEnv(envName, label) {
  if (!envName || envName === true) fail(`--${label} requires an environment variable name.`);
  const value = process.env[String(envName)];
  if (!value) fail(`Environment variable ${envName} is not set.`);
  return value;
}

function secretValue(flags, flagName, defaultEnvName) {
  const envFlag = `${flagName}-env`;
  if (flags[envFlag] !== undefined) return secretFromNamedEnv(flags[envFlag], envFlag);
  if (flags[flagName] !== undefined && flags[flagName] !== true) return String(flags[flagName]);
  if (process.env[defaultEnvName]) return process.env[defaultEnvName];
  fail(`Missing --${flagName}, --${envFlag}, or ${defaultEnvName}.`);
}

function authBasePortal(flags = {}) {
  return {
    name: 'auth',
    label: 'HubSpot OAuth',
    portalId: null,
    baseUrl: flags['base-url'] || 'https://api.hubapi.com',
    tokenEnv: null,
    token: null,
    oauthCommandCredentials: true
  };
}

function authUrlFromFlags(flags) {
  const url = new URL('/oauth/authorize', flags['app-base-url'] || 'https://app.hubspot.com');
  url.searchParams.set('client_id', authClientId(flags));
  url.searchParams.set('redirect_uri', String(requireFlag(flags, 'redirect-uri')));
  const scopes = [
    ...parseStringList(flags.scopes, 'scopes'),
    ...parseStringList(flags.scope, 'scope')
  ];
  if (!scopes.length) fail('auth authorize-url requires --scopes <scope,scope>.');
  url.searchParams.set('scope', scopes.join(' '));
  const optionalScopes = parseStringList(flags['optional-scopes'], 'optional-scopes');
  if (optionalScopes.length) url.searchParams.set('optional_scopes', optionalScopes.join(' '));
  if (flags.state !== undefined) url.searchParams.set('state', String(flags.state));
  return url;
}

function authTokenExchangeBodyFromFlags(flags) {
  return {
    grant_type: 'authorization_code',
    client_id: authClientId(flags),
    client_secret: authClientSecret(flags),
    code: secretValue(flags, 'code', 'HUBSPOT_OAUTH_CODE'),
    redirect_uri: String(requireFlag(flags, 'redirect-uri'))
  };
}

function authRefreshBodyFromFlags(flags) {
  return {
    grant_type: 'refresh_token',
    client_id: authClientId(flags),
    client_secret: authClientSecret(flags),
    refresh_token: secretValue(flags, 'refresh-token', 'HUBSPOT_REFRESH_TOKEN')
  };
}

function authIntrospectBodyFromFlags(flags) {
  const token = optionalAuthToken(flags);
  if (!token) fail('auth introspect requires --token, --access-token, --refresh-token, --token-env, HUBSPOT_OAUTH_TOKEN, HUBSPOT_ACCESS_TOKEN, or HUBSPOT_REFRESH_TOKEN.');
  return {
    client_id: authClientId(flags),
    client_secret: authClientSecret(flags),
    token_type_hint: authTokenTypeHint(flags),
    token
  };
}

function authRevokeBodyFromFlags(flags) {
  const token = optionalAuthToken(flags);
  if (!token) fail('auth revoke requires --token, --refresh-token, --token-env, HUBSPOT_OAUTH_TOKEN, or HUBSPOT_REFRESH_TOKEN.');
  return {
    client_id: authClientId(flags),
    client_secret: authClientSecret(flags),
    token_type_hint: authTokenTypeHint(flags),
    token
  };
}

function schedulerLinksQueryFlags(flags) {
  return appendMappedSearchQuery(flags, {
    after: 'after',
    limit: 'limit',
    name: 'name',
    'organizer-user-id': 'organizerUserId',
    type: 'type'
  });
}

function schedulerBookingQueryFlags(flags) {
  return appendMappedSearchQuery(flags, {
    timezone: 'timezone',
    'month-offset': 'monthOffset'
  });
}

function schedulerBookBodyFromFlags(slug, flags) {
  const body = mappedBodyFromFlags(flags, 'scheduler book', {
    slug: 'slug',
    duration: { name: 'duration', type: 'number' },
    email: 'email',
    'first-name': 'firstName',
    'last-name': 'lastName',
    'start-time': 'startTime',
    locale: 'locale',
    timezone: 'timezone',
    'form-fields': { name: 'formFields', type: 'json' },
    'legal-consent-responses': { name: 'legalConsentResponses', type: 'json' },
    'likely-available-user-ids': { name: 'likelyAvailableUserIds', type: 'string-list' },
    'guest-emails': { name: 'guestEmails', type: 'string-list' }
  });
  if (slug && body.slug === undefined) body.slug = String(slug);
  if (!body.slug) fail('scheduler book requires <slug>, --slug, or --body.');
  return body;
}

function schedulerCalendarBodyFromFlags(flags) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return assertObjectBody(explicitBody, 'scheduler calendar-create --body');

  const body = {};
  const properties = {};
  if (flags.properties !== undefined) {
    body.properties = assertObjectBody(parseMaybeJson(flags.properties), 'scheduler calendar-create --properties');
  }
  for (const [flagName, propertyName] of Object.entries({
    title: 'hs_meeting_title',
    'start-time': 'hs_meeting_start_time',
    'end-time': 'hs_meeting_end_time',
    timestamp: 'hs_timestamp',
    'owner-id': 'hubspot_owner_id',
    outcome: 'hs_meeting_outcome',
    'activity-type': 'hs_activity_type',
    location: 'hs_meeting_location',
    'location-type': 'hs_meeting_location_type',
    'meeting-body': 'hs_meeting_body',
    'internal-notes': 'hs_internal_meeting_notes'
  })) {
    if (flags[flagName] !== undefined) properties[propertyName] = String(flags[flagName]);
  }
  if (Object.keys(properties).length) {
    body.properties = body.properties
      ? { ...body.properties, ...properties }
      : properties;
  }
  if (flags.associations !== undefined) body.associations = parseMaybeJson(flags.associations);
  if (flags['email-reminder-schedule'] !== undefined) body.emailReminderSchedule = parseMaybeJson(flags['email-reminder-schedule']);
  if (flags.timezone !== undefined) body.timezone = String(flags.timezone);
  if (!Object.keys(body).length) fail('scheduler calendar-create requires --body or calendar event flags.');
  if (!body.properties) fail('scheduler calendar-create requires --properties, meeting property flags, or --body.');
  return body;
}

function subscriptionQueryFlags(flags, options = {}) {
  const queryFlags = { ...flags, query: values(flags.query) };
  if (options.defaultChannel) {
    queryFlags.query.push(`channel=${flags.channel || options.defaultChannel}`);
  } else if (flags.channel !== undefined) {
    queryFlags.query.push(`channel=${flags.channel}`);
  }
  if (flags['business-unit-id'] !== undefined) queryFlags.query.push(`businessUnitId=${flags['business-unit-id']}`);
  const verbose = optionalBoolean(flags.verbose, 'verbose');
  if (verbose !== undefined) queryFlags.query.push(`verbose=${verbose}`);
  const includeTranslations = optionalBoolean(flags['include-translations'], 'include-translations');
  if (includeTranslations !== undefined) queryFlags.query.push(`includeTranslations=${includeTranslations}`);
  return queryFlags;
}

function subscriptionStatusBodyFromFlags(flags) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return explicitBody;

  const body = {
    subscriptionId: optionalNumber(requireFlag(flags, 'subscription-id')),
    statusState: String(flags.status || flags['status-state'] || ''),
    channel: String(flags.channel || 'EMAIL')
  };
  if (!body.statusState) fail('subscriptions set-status requires --status <SUBSCRIBED|UNSUBSCRIBED|NOT_SPECIFIED>.');
  if (flags['legal-basis'] !== undefined) body.legalBasis = String(flags['legal-basis']);
  if (flags['legal-basis-explanation'] !== undefined) body.legalBasisExplanation = String(flags['legal-basis-explanation']);
  return body;
}

function subscriptionBatchEmailsBodyFromFlags(flags, commandName) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return assertBatchInputsBody(explicitBody, commandName);
  const inputs = parseStringList(requireFlag(flags, 'emails'), 'emails');
  if (!inputs.length) fail(`${commandName} requires at least one email in --emails.`);
  return { inputs };
}

function subscriptionGenerateLinksBodyFromFlags(subscriberIdString, flags) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return explicitBody;

  const email = subscriberIdString || flags.email || flags['subscriber-id-string'];
  if (!email) fail('subscriptions generate-links requires <email> or --body.');
  const body = { subscriberIdString: String(email) };
  if (flags.language !== undefined) body.language = String(flags.language);
  if (flags['subscription-id'] !== undefined) body.subscriptionId = optionalNumber(flags['subscription-id']);
  return body;
}

function appendQuery(url, flags) {
  for (const item of values(flags.query)) {
    const [key, ...rest] = String(item).split('=');
    if (!key || rest.length === 0) fail(`Invalid --query value "${item}". Expected k=v.`);
    url.searchParams.append(key, rest.join('='));
  }
}

function buildUrl(portal, inputPath, flags) {
  const raw = String(inputPath || '');
  const url = raw.startsWith('http://') || raw.startsWith('https://')
    ? new URL(raw)
    : new URL(raw.startsWith('/') ? raw : `/${raw}`, portal.baseUrl);
  assertAllowedHubSpotUrl(portal, url);
  appendQuery(url, flags);
  return url;
}

function assertAllowedHubSpotUrl(portal, url) {
  const allowedOrigin = new URL(portal.baseUrl).origin;
  if (url.origin !== allowedOrigin) {
    fail(`Refusing to send HubSpot token to non-HubSpot/API origin: ${url.origin}. Expected ${allowedOrigin}.`);
  }
}

function printJson(value) {
  const output = processOutput(value, currentOutputFlags);
  if (output.raw) {
    writeStdout(output.text);
    return;
  }
  writeStdout(output.text);
}

// All command JSON flows through this small output layer so generic requests
// and typed helpers share projection, compact mode, and agent-safe budgets.
function processOutput(value, flags = {}) {
  const options = outputOptionsFromFlags(flags);
  let output = applyMaxResultsBudget(value, options.maxResults);
  if (options.discoveryHelper) output = discoveryHelperOutput(output, options.discoveryHelper);
  if (options.compact) output = compactOutput(output);
  if (options.selectPath) {
    output = selectOutputPath(output, options.selectPath);
  } else if (options.pickPaths.length) {
    const picked = {};
    for (const pickPath of options.pickPaths) {
      picked[pickPath] = selectOutputPath(output, pickPath);
    }
    output = picked;
  }

  if (options.rawValue) {
    if (!isRawScalar(output)) {
      fail('--raw-value requires --select <path> to resolve to a string, number, boolean, or null.');
    }
    const rawText = output === null ? 'null' : String(output);
    const maybeTruncated = enforceMaxChars(rawText, options, output, { raw: true });
    if (maybeTruncated) return { raw: false, text: JSON.stringify(maybeTruncated, null, 2) };
    return { raw: true, text: rawText };
  }

  const serialized = JSON.stringify(output, null, 2);
  const text = serialized === undefined ? 'undefined' : serialized;
  const maybeTruncated = enforceMaxChars(text, options, output);
  if (maybeTruncated) return { raw: false, text: JSON.stringify(maybeTruncated, null, 2) };
  return { raw: false, text };
}

function outputOptionsFromFlags(flags = {}) {
  const selectValues = values(flags.select).map((item) => parseOutputPathValue(item, 'select'));
  if (selectValues.length > 1) fail('--select accepts one path.');

  const pickPaths = [];
  for (const rawPick of values(flags.pick)) {
    const pickText = parseOutputPathValue(rawPick, 'pick');
    for (const item of pickText.split(',')) {
      const trimmed = item.trim();
      if (trimmed) pickPaths.push(trimmed);
    }
  }
  if (values(flags.pick).length && pickPaths.length === 0) fail('--pick requires at least one path.');
  if (selectValues.length && pickPaths.length) fail('--select and --pick cannot be used together.');

  const rawValue = boolFlag(flags, 'raw-value');
  if (rawValue && !selectValues.length) {
    fail('--raw-value requires --select <path> that resolves to a scalar value.');
  }

  const discoveryHelpers = ['ids-only', 'names-only', 'id-name-map'].filter((name) => boolFlag(flags, name));
  if (discoveryHelpers.length > 1) fail('--ids-only, --names-only, and --id-name-map cannot be used together.');
  if (discoveryHelpers.length && (selectValues.length || pickPaths.length || rawValue)) {
    fail('--ids-only, --names-only, and --id-name-map cannot be used with --select, --pick, or --raw-value.');
  }

  return {
    selectPath: selectValues[0] || null,
    pickPaths,
    rawValue,
    discoveryHelper: discoveryHelpers[0] || null,
    compact: boolFlag(flags, 'compact') || boolFlag(flags, 'agent'),
    maxResults: parseNonNegativeIntegerFlag(flags['max-results'], 'max-results'),
    maxChars: parseNonNegativeIntegerFlag(flags['max-chars'], 'max-chars'),
    includeTruncated: boolFlag(flags, 'include-truncated')
  };
}

function parseOutputPathValue(raw, flagName) {
  if (raw === undefined || raw === true || String(raw).trim() === '') {
    fail(`--${flagName} requires a dot path.`);
  }
  const value = String(raw).trim();
  if (value.split('.').some((segment) => segment === '')) {
    fail(`Invalid --${flagName} path "${value}".`);
  }
  return value;
}

function parseNonNegativeIntegerFlag(raw, flagName) {
  if (raw === undefined) return undefined;
  if (raw === true || raw === '') fail(`--${flagName} requires a non-negative integer.`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    fail(`--${flagName} requires a non-negative integer, got "${raw}".`);
  }
  return value;
}

function selectOutputPath(value, pathExpression) {
  const segments = pathExpression.split('.');
  return selectPathSegments(value, segments, pathExpression, []);
}

function selectPathSegments(value, segments, pathExpression, trail) {
  if (segments.length === 0) return value;

  const [segment, ...rest] = segments;
  const mapsArray = segment.endsWith('[]');
  const key = mapsArray ? segment.slice(0, -2) : segment;
  const current = key ? selectPathProperty(value, key, pathExpression, trail) : value;

  if (!mapsArray) {
    return selectPathSegments(current, rest, pathExpression, trail.concat(key));
  }
  if (!Array.isArray(current)) {
    const location = trail.concat(key || '[]').filter(Boolean).join('.') || '<root>';
    fail(`Projection path "${pathExpression}" expected an array at "${location}".`);
  }
  return current.map((item, index) => (
    selectPathSegments(item, rest, pathExpression, trail.concat(`${key || ''}[${index}]`))
  ));
}

function selectPathProperty(value, key, pathExpression, trail) {
  const location = trail.concat(key).join('.');
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`Projection path "${pathExpression}" not found at "${location}".`);
  }
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    fail(`Projection path "${pathExpression}" not found at "${location}".`);
  }
  return value[key];
}

function isRawScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

const DISCOVERY_ID_PATHS = [
  ['id'],
  ['objectId'],
  ['recordId'],
  ['listId'],
  ['pipelineId'],
  ['folderId'],
  ['fileId'],
  ['contentId'],
  ['pageId'],
  ['postId'],
  ['domainId'],
  ['redirectId'],
  ['properties', 'hs_object_id']
];

const DISCOVERY_NAME_PATHS = [
  ['name'],
  ['label'],
  ['title'],
  ['displayName'],
  ['path'],
  ['url'],
  ['email'],
  ['properties', 'name'],
  ['properties', 'hs_name'],
  ['properties', 'dealname'],
  ['properties', 'email']
];

function discoveryHelperOutput(value, helperName) {
  if (value && typeof value === 'object' && !Array.isArray(value) && (value.showRequest || value.dryRun)) return value;
  if (helperName === 'names-only' && isExistingNamesOnlyOutput(value)) return value;

  const records = discoveryRecords(value);
  const output = { ok: discoveryOk(value) };
  const portal = discoveryPortal(value);
  if (portal !== undefined) output.portal = portal;
  copyDiscoveryTruncation(value, output);

  if (helperName === 'ids-only') {
    const ids = records.map(discoveryId).filter((item) => item !== null);
    output.count = ids.length;
    output.ids = ids;
    return output;
  }

  if (helperName === 'names-only') {
    const names = records.map(discoveryName).filter((item) => item !== null);
    output.count = names.length;
    output.names = names;
    return output;
  }

  const items = [];
  for (const record of records) {
    const item = {};
    const id = discoveryId(record);
    const name = discoveryName(record);
    if (id !== null) item.id = id;
    if (name !== null) item.name = name;
    if (Object.keys(item).length) items.push(item);
  }
  output.count = items.length;
  output.items = items;
  return output;
}

function isExistingNamesOnlyOutput(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Array.isArray(value.names)
    && Object.prototype.hasOwnProperty.call(value, 'count')
    && !Object.prototype.hasOwnProperty.call(value, 'data')
    && !Object.prototype.hasOwnProperty.call(value, 'results');
}

function discoveryRecords(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value.results)) return value.results;
  if (value.data && typeof value.data === 'object') {
    if (Array.isArray(value.data)) return value.data;
    if (Array.isArray(value.data.results)) return value.data.results;
    if (Array.isArray(value.data.objects)) return value.data.objects;
    if (Array.isArray(value.data.items)) return value.data.items;
    if (Array.isArray(value.data.lists)) return value.data.lists;
  }
  return [];
}

function discoveryOk(value) {
  return value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'ok') ? Boolean(value.ok) : true;
}

function discoveryPortal(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.portal !== undefined ? value.portal : undefined;
}

function copyDiscoveryTruncation(input, output) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  if (input.truncated !== undefined) output.truncated = Boolean(input.truncated);
  if (input.truncation && typeof input.truncation === 'object') output.truncation = input.truncation;
  if (input.totalResultCount !== undefined) output.totalResultCount = input.totalResultCount;
}

function discoveryId(record) {
  return discoveryScalar(record, DISCOVERY_ID_PATHS);
}

function discoveryName(record) {
  const name = discoveryScalar(record, DISCOVERY_NAME_PATHS);
  if (name !== null) return name;

  if (record && typeof record === 'object' && record.properties && typeof record.properties === 'object') {
    const first = record.properties.firstname;
    const last = record.properties.lastname;
    const fullName = [first, last].filter((item) => item !== undefined && item !== null && String(item).trim() !== '').join(' ').trim();
    if (fullName) return fullName;
  }
  return null;
}

function discoveryScalar(record, paths) {
  for (const pathParts of paths) {
    const value = nestedRecordValue(record, pathParts);
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return null;
}

function nestedRecordValue(record, pathParts) {
  let current = record;
  for (const part of pathParts) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function compactOutput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (value.showRequest || value.dryRun) return value;

  const compacted = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === 'rateLimit' || key === 'requestId' || key === 'method' || key === 'url') continue;
    if (key === 'status' && value.ok === true) continue;
    compacted[key] = nestedValue;
  }
  return compacted;
}

function applyMaxResultsBudget(value, maxResults) {
  if (maxResults === undefined || !value || typeof value !== 'object' || Array.isArray(value)) return value;

  let output = value;
  const ensureClone = () => {
    if (output === value) output = cloneJsonValue(value);
    return output;
  };

  if (Array.isArray(value.results) && value.results.length > maxResults) {
    const target = ensureClone();
    trimTopLevelResults(target, maxResults, 'results');
  }

  if (value.data && typeof value.data === 'object' && Array.isArray(value.data.results) && value.data.results.length > maxResults) {
    const target = ensureClone();
    trimNestedDataResults(target, maxResults);
  }

  return output;
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function trimTopLevelResults(target, maxResults, pathName) {
  const originalResultCount = target.results.length;
  target.results = target.results.slice(0, maxResults);
  markResultTruncated(target, {
    path: pathName,
    maxResults,
    originalResultCount,
    returnedResultCount: target.results.length
  });
}

function trimNestedDataResults(target, maxResults) {
  const originalResultCount = target.data.results.length;
  target.data.results = target.data.results.slice(0, maxResults);
  markResultTruncated(target, {
    path: 'data.results',
    maxResults,
    originalResultCount,
    returnedResultCount: target.data.results.length,
    nextAfter: target.data.paging && target.data.paging.next ? target.data.paging.next.after || null : null
  });
}

function markResultTruncated(target, detail) {
  target.truncated = true;
  target.truncation = {
    ...(target.truncation || {}),
    reason: 'max-results',
    ...detail
  };
  if (Object.prototype.hasOwnProperty.call(target, 'resultCount')) {
    const original = Number(target.resultCount);
    target.totalResultCount = Number.isFinite(original) ? original : detail.originalResultCount;
    target.resultCount = detail.returnedResultCount;
  }
}

function enforceMaxChars(text, options, output, extra = {}) {
  if (options.maxChars === undefined || text.length <= options.maxChars) return null;
  if (!options.includeTruncated) {
    fail(`Output is ${text.length} chars, exceeding --max-chars ${options.maxChars}. Add --include-truncated for a compact truncation summary, or reduce output with --select, --pick, --max-results, or --compact.`);
  }
  return truncationSummary(output, text.length, options.maxChars, extra);
}

function truncationSummary(output, serializedChars, maxChars, extra = {}) {
  const summary = {
    ok: output && typeof output === 'object' && Object.prototype.hasOwnProperty.call(output, 'ok') ? output.ok : true,
    truncated: true,
    truncation: {
      reason: 'max-chars',
      maxChars,
      serializedChars,
      message: 'Full output omitted because it exceeded --max-chars.'
    }
  };
  if (extra.raw) summary.truncation.rawValue = true;
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    for (const key of ['portal', 'status', 'pageCount', 'resultCount', 'totalResultCount']) {
      if (Object.prototype.hasOwnProperty.call(output, key)) summary[key] = output[key];
    }
    if (output.truncated && output.truncation) summary.sourceTruncation = output.truncation;
  }
  return summary;
}

function responseMeta(response) {
  const headers = {};
  for (const header of RATE_LIMIT_HEADERS) {
    const value = response.headers.get(header);
    if (value !== null) headers[header] = value;
  }
  return {
    rateLimit: Object.keys(headers).length ? headers : undefined,
    requestId: response.headers.get('x-hubspot-correlation-id') || undefined
  };
}

function safeRetryLimit() {
  const raw = process.env.HSAPI_SAFE_RETRIES;
  if (raw === undefined || raw === '') return 1;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return 1;
  return Math.min(value, 3);
}

function retryDelayMs(response) {
  const retryAfter = response.headers.get('retry-after');
  if (!retryAfter) return 0;
  const seconds = Number(retryAfter);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(seconds * 1000, 3000);
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyCredentialToRequest(url, headers, credential) {
  if (!credential) return;
  if (credential.placement === 'query') {
    for (const [key, value] of Object.entries(credential.query || {})) {
      url.searchParams.set(key, value);
    }
    return;
  }
  headers.Authorization = `Bearer ${credential.token}`;
}

function shouldRetryResponse(method, response, attempt, limit) {
  return attempt < limit
    && SAFE_METHODS.has(method)
    && (response.status === 429 || response.status >= 500);
}

async function hubspotFetchResponse(url, options, method) {
  const limit = safeRetryLimit();
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, options);
    if (!shouldRetryResponse(method, response, attempt, limit)) return response;
    await sleep(retryDelayMs(response));
  }
}

async function hubspotFetch(portal, method, inputPath, flags, body, endpointOverride = null) {
  const url = buildUrl(portal, inputPath, flags);
  const endpoint = endpointOverride || findEndpointDefinition(method, url.pathname);
  const auth = requestAuthMetadata(portal, endpoint);
  if (boolFlag(flags, 'show-request')) {
    showRequestPreview(portal, method, url, body, endpoint, { auth });
  }

  const credential = await resolveRequestCredential(portal, auth);

  const headers = {
    Accept: 'application/json'
  };
  applyCredentialToRequest(url, headers, credential);

  const options = {
    method,
    headers
  };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await hubspotFetchResponse(url, options, method);
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = text;
    }
  }

  if (!response.ok) {
    const urlString = redactTokenUrl(url.toString());
    const error = {
      ok: false,
      status: response.status,
      statusText: response.statusText,
      ...responseMeta(response),
      portal: portal.name,
      method,
      url: urlString,
      response: redactSensitiveValue(payload)
    };
    const accessNote = accessNoteForError(urlString, response.status);
    if (accessNote) error.note = accessNote;
    printJson(error);
    exitCli(1);
  }

  return {
    ok: true,
    status: response.status,
    ...responseMeta(response),
    portal: portal.name,
    method,
    url: redactTokenUrl(url.toString()),
    data: payload
  };
}

async function hubspotMultipartFetch(portal, method, inputPath, flags, formBody, previewBody, endpointOverride = null) {
  const url = buildUrl(portal, inputPath, flags);
  const endpoint = endpointOverride || findEndpointDefinition(method, url.pathname);
  const auth = requestAuthMetadata(portal, endpoint);
  if (boolFlag(flags, 'show-request')) {
    showRequestPreview(portal, method, url, previewBody, endpoint, {
      auth,
      contentType: 'multipart/form-data'
    });
  }

  const credential = await resolveRequestCredential(portal, auth);
  const headers = {
    Accept: 'application/json'
  };
  applyCredentialToRequest(url, headers, credential);

  const response = await fetch(url, {
    method,
    headers,
    body: formBody
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = text;
    }
  }

  if (!response.ok) {
    const urlString = redactTokenUrl(url.toString());
    const error = {
      ok: false,
      status: response.status,
      statusText: response.statusText,
      ...responseMeta(response),
      portal: portal.name,
      method,
      url: urlString,
      response: redactSensitiveValue(payload)
    };
    const accessNote = accessNoteForError(urlString, response.status);
    if (accessNote) error.note = accessNote;
    printJson(error);
    exitCli(1);
  }

  return {
    ok: true,
    status: response.status,
    ...responseMeta(response),
    portal: portal.name,
    method,
    url: redactTokenUrl(url.toString()),
    data: payload
  };
}

function redactTokenUrl(url) {
  return url
    .replace(/([?&]hapikey=)[^&]+/g, '$1REDACTED')
    .replace(/([?&]access_token=)[^&]+/g, '$1REDACTED')
    .replace(/([?&]token=)[^&]+/g, '$1REDACTED');
}

function readOAuthTokenCache(tokenCachePath) {
  if (!tokenCachePath || !fs.existsSync(tokenCachePath)) {
    return { status: 'missing', cache: null, error: null };
  }
  try {
    const cache = JSON.parse(fs.readFileSync(tokenCachePath, 'utf8'));
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
      return { status: 'invalid', cache: null, error: 'Cache file must contain a JSON object.' };
    }
    return { status: 'read', cache, error: null };
  } catch (error) {
    return { status: 'invalid', cache: null, error: error.message };
  }
}

function oauthCacheAccessToken(cache) {
  if (!cache || typeof cache !== 'object') return null;
  return configString(cache.accessToken) || configString(cache.access_token);
}

function oauthCacheExpiresAt(cache) {
  if (!cache || typeof cache !== 'object') return null;
  return configString(cache.expiresAt) || configString(cache.expires_at);
}

function oauthCacheRefreshedAt(cache) {
  if (!cache || typeof cache !== 'object') return null;
  return configString(cache.refreshedAt) || configString(cache.refreshed_at);
}

function oauthCacheTokenType(cache) {
  if (!cache || typeof cache !== 'object') return null;
  return configString(cache.tokenType) || configString(cache.token_type);
}

function oauthCacheHasExpectedSchema(cache) {
  if (!cache || typeof cache !== 'object') return false;
  if (cache.schema !== OAUTH_TOKEN_CACHE_SCHEMA) return false;
  return cache.family === undefined || cache.family === AUTH_FAMILIES.OAUTH;
}

function oauthCacheStatus(cacheRead, nowMs = Date.now()) {
  if (!cacheRead || cacheRead.status === 'missing') return 'missing';
  if (cacheRead.status === 'invalid') return 'invalid';
  const cache = cacheRead.cache;
  if (!oauthCacheHasExpectedSchema(cache)) return 'invalid';
  if (!oauthCacheAccessToken(cache)) return 'invalid';
  const expiresAt = oauthCacheExpiresAt(cache);
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(expiresAtMs)) return 'invalid';
  return expiresAtMs > nowMs + OAUTH_TOKEN_REFRESH_SKEW_MS ? 'usable' : 'expired';
}

function redactedOAuthTokenCacheContract(source, cacheRead = readOAuthTokenCache(source.tokenCachePath), nowMs = Date.now()) {
  const cache = cacheRead.cache;
  const expiresAt = oauthCacheExpiresAt(cache);
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;
  const contract = {
    schema: OAUTH_TOKEN_CACHE_SCHEMA,
    path: source.tokenCachePathDisplay || source.tokenCachePath,
    present: cacheRead.status !== 'missing',
    status: oauthCacheStatus(cacheRead, nowMs),
    redacted: true,
    accessToken: oauthCacheAccessToken(cache) ? 'REDACTED' : null,
    tokenType: oauthCacheTokenType(cache),
    expiresAt,
    expiresInSeconds: Number.isFinite(expiresAtMs) ? Math.max(Math.floor((expiresAtMs - nowMs) / 1000), 0) : null,
    refreshedAt: oauthCacheRefreshedAt(cache)
  };
  if (cacheRead.error) contract.error = cacheRead.error;
  return contract;
}

function usableOAuthCacheToken(cacheRead) {
  return oauthCacheStatus(cacheRead) === 'usable' ? oauthCacheAccessToken(cacheRead.cache) : null;
}

function readDeveloperClientCredentialsTokenCache(tokenCachePath) {
  if (!tokenCachePath || !fs.existsSync(tokenCachePath)) {
    return { status: 'missing', cache: null, error: null };
  }
  try {
    const cache = JSON.parse(fs.readFileSync(tokenCachePath, 'utf8'));
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
      return { status: 'invalid', cache: null, error: 'Cache file must contain a JSON object.' };
    }
    return { status: 'read', cache, error: null };
  } catch (error) {
    return { status: 'invalid', cache: null, error: error.message };
  }
}

function developerClientCredentialsCacheSubtype(cache) {
  if (!cache || typeof cache !== 'object') return null;
  return configString(cache.subtype) || configString(cache.authSubtype);
}

function developerClientCredentialsCacheScopes(cache) {
  if (!cache || typeof cache !== 'object') return [];
  const source = cache.source && typeof cache.source === 'object' ? cache.source : {};
  const credentialSource = cache.credentialSource && typeof cache.credentialSource === 'object'
    ? cache.credentialSource
    : {};
  const scopes = source.scopes || credentialSource.scopes || cache.scopes;
  return Array.isArray(scopes) ? scopes.filter((scope) => typeof scope === 'string' && scope.trim()).map((scope) => scope.trim()) : [];
}

function stringArraysEqual(left, right) {
  const leftValues = Array.isArray(left) ? left : [];
  const rightValues = Array.isArray(right) ? right : [];
  return leftValues.length === rightValues.length
    && leftValues.every((value, index) => value === rightValues[index]);
}

function developerClientCredentialsCacheMatchesSource(cache, source, portal) {
  if (!cache || typeof cache !== 'object') return false;
  if (cache.schema !== DEVELOPER_CLIENT_CREDENTIALS_TOKEN_CACHE_SCHEMA) return false;
  if (cache.family !== AUTH_FAMILIES.DEVELOPER) return false;
  if (developerClientCredentialsCacheSubtype(cache) !== DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS) return false;
  if (cache.grantType !== 'client_credentials') return false;

  const cachePortal = cache.portal && typeof cache.portal === 'object' ? cache.portal : {};
  if (cachePortal.baseUrl && cachePortal.baseUrl !== portal.baseUrl) return false;

  const cacheSource = cache.source && typeof cache.source === 'object'
    ? cache.source
    : (cache.credentialSource && typeof cache.credentialSource === 'object' ? cache.credentialSource : {});
  const cachedTokenUrlPath = configString(cacheSource.tokenUrlPath);
  const cachedTokenEndpoint = configString(cacheSource.tokenEndpoint);
  const expectedTokenEndpoint = new URL(source.tokenUrlPath, portal.baseUrl).toString();
  if (cachedTokenUrlPath && cachedTokenUrlPath !== source.tokenUrlPath) return false;
  if (!cachedTokenUrlPath && cachedTokenEndpoint && cachedTokenEndpoint !== expectedTokenEndpoint) return false;
  return cacheSource.clientIdEnv === source.clientIdEnv
    && cacheSource.clientSecretEnv === source.clientSecretEnv
    && stringArraysEqual(developerClientCredentialsCacheScopes(cache), source.scopes);
}

function developerClientCredentialsCacheStatus(source, portal, cacheRead, nowMs = Date.now()) {
  if (!cacheRead || cacheRead.status === 'missing') return 'missing';
  if (cacheRead.status === 'invalid') return 'invalid';
  const cache = cacheRead.cache;
  if (!developerClientCredentialsCacheMatchesSource(cache, source, portal)) return 'mismatched';
  if (!oauthCacheAccessToken(cache)) return 'invalid';
  const expiresAt = oauthCacheExpiresAt(cache);
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(expiresAtMs)) return 'invalid';
  return expiresAtMs > nowMs + OAUTH_TOKEN_REFRESH_SKEW_MS ? 'usable' : 'expired';
}

function redactedDeveloperClientCredentialsTokenCacheContract(source, portal, cacheRead = readDeveloperClientCredentialsTokenCache(source.tokenCachePath), nowMs = Date.now()) {
  const cache = cacheRead.cache;
  const expiresAt = oauthCacheExpiresAt(cache);
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;
  const contract = {
    schema: DEVELOPER_CLIENT_CREDENTIALS_TOKEN_CACHE_SCHEMA,
    path: source.tokenCachePathDisplay || source.tokenCachePath,
    present: cacheRead.status !== 'missing',
    status: developerClientCredentialsCacheStatus(source, portal, cacheRead, nowMs),
    redacted: true,
    accessToken: oauthCacheAccessToken(cache) ? 'REDACTED' : null,
    tokenType: oauthCacheTokenType(cache),
    expiresAt,
    expiresInSeconds: Number.isFinite(expiresAtMs) ? Math.max(Math.floor((expiresAtMs - nowMs) / 1000), 0) : null,
    refreshedAt: oauthCacheRefreshedAt(cache)
  };
  if (cacheRead.error) contract.error = cacheRead.error;
  return contract;
}

function usableDeveloperClientCredentialsCacheToken(source, portal, cacheRead) {
  return developerClientCredentialsCacheStatus(source, portal, cacheRead) === 'usable'
    ? oauthCacheAccessToken(cacheRead.cache)
    : null;
}

function oauthEnvValues(source, portalName) {
  const missing = [];
  const clientId = process.env[source.clientIdEnv];
  const clientSecret = process.env[source.clientSecretEnv];
  const refreshToken = process.env[source.refreshTokenEnv];
  if (!clientId) missing.push(source.clientIdEnv);
  if (!clientSecret) missing.push(source.clientSecretEnv);
  if (!refreshToken) missing.push(source.refreshTokenEnv);
  if (missing.length) {
    fail(`Missing OAuth refresh environment variable${missing.length === 1 ? '' : 's'} for portal "${portalName}": ${missing.join(', ')}.`);
  }
  return { clientId, clientSecret, refreshToken };
}

function hubSpotResponseClass(status) {
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  if (status >= 300 && status < 400) return '3xx';
  return `${Math.floor(status / 100)}xx`;
}

function hubSpotResponseCategory(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return configString(payload.category)
    || configString(payload.error)
    || configString(payload.errorType)
    || configString(payload.status);
}

function oauthTokenCacheFromRefreshPayload(payload, source, refreshedAtMs = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('OAuth refresh failed: HubSpot token response was not a JSON object.');
  }
  const accessToken = configString(payload.access_token) || configString(payload.accessToken);
  if (!accessToken) {
    fail('OAuth refresh failed: HubSpot token response did not include access_token.');
  }
  const rawExpiresIn = payload.expires_in === undefined ? payload.expiresIn : payload.expires_in;
  const expiresIn = Number(rawExpiresIn);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    fail('OAuth refresh failed: HubSpot token response did not include a positive expires_in value.');
  }
  return {
    schema: OAUTH_TOKEN_CACHE_SCHEMA,
    family: AUTH_FAMILIES.OAUTH,
    tokenType: configString(payload.token_type) || configString(payload.tokenType) || 'bearer',
    accessToken,
    expiresIn,
    expiresAt: new Date(refreshedAtMs + expiresIn * 1000).toISOString(),
    refreshedAt: new Date(refreshedAtMs).toISOString(),
    source: {
      clientIdEnv: source.clientIdEnv,
      refreshTokenEnv: source.refreshTokenEnv
    }
  };
}

function writeOAuthTokenCache(tokenCachePath, cache) {
  const dir = path.dirname(tokenCachePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(dir, `.${path.basename(tokenCachePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, tokenCachePath);
  try {
    fs.chmodSync(tokenCachePath, 0o600);
  } catch (_error) {
    // Best-effort only; some filesystems do not support chmod.
  }
}

function writeDeveloperClientCredentialsTokenCache(tokenCachePath, cache) {
  const dir = path.dirname(tokenCachePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(dir, `.${path.basename(tokenCachePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, tokenCachePath);
  try {
    fs.chmodSync(tokenCachePath, 0o600);
  } catch (_error) {
    // Best-effort only; some filesystems do not support chmod.
  }
}

async function refreshOAuthCredential(portal, source) {
  const env = oauthEnvValues(source, portal.name);
  const tokenUrl = new URL(source.tokenUrlPath, portal.baseUrl);
  let response;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: env.clientId,
        client_secret: env.clientSecret,
        refresh_token: env.refreshToken
      })
    });
  } catch (error) {
    fail(`OAuth refresh failed for portal "${portal.name}": network_error ${error.message}`);
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = text;
    }
  }

  if (!response.ok) {
    const responseClass = hubSpotResponseClass(response.status);
    const category = hubSpotResponseCategory(payload);
    const categoryText = category ? ` category ${category}` : '';
    fail(`OAuth refresh failed for portal "${portal.name}": HubSpot ${responseClass} response${categoryText} (${response.status} ${response.statusText || 'HTTP error'}).`);
  }

  const cache = oauthTokenCacheFromRefreshPayload(payload, source);
  writeOAuthTokenCache(source.tokenCachePath, cache);
  return {
    token: cache.accessToken,
    source,
    tokenCache: redactedOAuthTokenCacheContract(source, { status: 'read', cache, error: null }),
    cacheStatus: 'refreshed'
  };
}

async function resolveOAuthCredential(portal, auth) {
  if (auth.required === false) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} does not require auth; refusing to send OAuth credentials.`);
  }
  if (auth.family !== AUTH_FAMILIES.OAUTH) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${auth.family || '<none>'}; OAuth credentials can only satisfy ${AUTH_FAMILIES.OAUTH} endpoints.`);
  }
  if (!portal.oauth) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${AUTH_FAMILIES.OAUTH}; portal "${portal.name}" is missing auth.oauth clientIdEnv, clientSecretEnv, refreshTokenEnv, and tokenCachePath.`);
  }

  const cacheRead = readOAuthTokenCache(portal.oauth.tokenCachePath);
  const cachedToken = usableOAuthCacheToken(cacheRead);
  if (cachedToken) {
    return {
      token: cachedToken,
      source: portal.oauth,
      tokenCache: redactedOAuthTokenCacheContract(portal.oauth, cacheRead),
      cacheStatus: 'cache_hit'
    };
  }
  return refreshOAuthCredential(portal, portal.oauth);
}

function developerAuthLabel(auth) {
  return `${AUTH_FAMILIES.DEVELOPER}/${auth.subtype || '<missing-subtype>'}`;
}

function requireDeveloperProfile(portal, auth) {
  if (!portal.developer) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth ${developerAuthLabel(auth)}; portal "${portal.name}" is missing auth.developer.`);
  }
  return portal.developer;
}

function requireDeveloperSourceEnv(portal, auth, key, profileField) {
  const developer = requireDeveloperProfile(portal, auth);
  const envName = developer[key];
  if (!envName) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth ${developerAuthLabel(auth)}; portal "${portal.name}" is missing ${profileField}.`);
  }
  return envName;
}

function requireDeveloperEnvValue(portal, auth, key, profileField, label) {
  const envName = requireDeveloperSourceEnv(portal, auth, key, profileField);
  const value = process.env[envName];
  if (!value) {
    fail(`Missing ${label}. Set ${envName} for portal "${portal.name}".`);
  }
  return { envName, value };
}

function authQueryParams(auth) {
  return Array.isArray(auth.queryParams) ? auth.queryParams : [];
}

function requireDeveloperApiKeyQueryMetadata(auth) {
  if (!authQueryParams(auth).includes('hapikey')) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth ${developerAuthLabel(auth)} but its auth.queryParams metadata does not include hapikey.`);
  }
}

function requireDeveloperClientCredentialsScopes(auth) {
  const scopes = Array.isArray(auth.scopes)
    ? auth.scopes.filter((scope) => typeof scope === 'string' && scope.trim()).map((scope) => scope.trim())
    : [];
  if (!scopes.length) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth ${developerAuthLabel(auth)} but its catalog metadata must declare auth.scopes or requiredScopes for the client-credentials token request.`);
  }
  return scopes;
}

function requireDeveloperClientCredentialsSource(portal, auth) {
  const developer = requireDeveloperProfile(portal, auth);
  const scopes = requireDeveloperClientCredentialsScopes(auth);
  if (!developer.clientIdEnv) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth ${developerAuthLabel(auth)}; portal "${portal.name}" is missing auth.developer.clientIdEnv.`);
  }
  if (!developer.clientSecretEnv) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth ${developerAuthLabel(auth)}; portal "${portal.name}" is missing auth.developer.clientSecretEnv.`);
  }
  if (!developer.tokenCachePath) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth ${developerAuthLabel(auth)}; portal "${portal.name}" is missing auth.developer.tokenCachePath.`);
  }
  if (portal.oauth && portal.oauth.tokenCachePath === developer.tokenCachePath) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth ${developerAuthLabel(auth)}; portal "${portal.name}" auth.developer.tokenCachePath must be separate from auth.oauth.tokenCachePath.`);
  }
  return {
    type: DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS,
    name: 'developer_client_credentials',
    profileField: 'auth.developer',
    provenance: developer.provenance,
    grantType: 'client_credentials',
    clientIdEnv: developer.clientIdEnv,
    clientSecretEnv: developer.clientSecretEnv,
    tokenCachePath: developer.tokenCachePath,
    tokenCachePathDisplay: developer.tokenCachePathDisplay,
    tokenUrlPath: developer.tokenUrlPath,
    scopes,
    redacted: true
  };
}

function developerCredentialSourceForAuth(portal, auth) {
  if (auth.subtype === DEVELOPER_AUTH_SUBTYPES.DEVELOPER_API_KEY) {
    requireDeveloperApiKeyQueryMetadata(auth);
    const developerApiKeyEnv = requireDeveloperSourceEnv(
      portal,
      auth,
      'developerApiKeyEnv',
      'auth.developer.developerApiKeyEnv'
    );
    const source = {
      type: DEVELOPER_AUTH_SUBTYPES.DEVELOPER_API_KEY,
      name: developerApiKeyEnv,
      profileField: 'auth.developer.developerApiKeyEnv',
      provenance: portal.developer.provenance,
      queryParams: {
        hapikey: {
          type: 'env',
          name: developerApiKeyEnv,
          redacted: true
        }
      },
      redacted: true
    };
    if (authQueryParams(auth).includes('appId')) {
      const appIdEnv = requireDeveloperSourceEnv(portal, auth, 'appIdEnv', 'auth.developer.appIdEnv');
      source.appIdEnv = appIdEnv;
      source.queryParams.appId = {
        type: 'env',
        name: appIdEnv,
        redacted: true
      };
    }
    return source;
  }

  if (auth.subtype === DEVELOPER_AUTH_SUBTYPES.PERSONAL_ACCESS_KEY) {
    const personalAccessKeyEnv = requireDeveloperSourceEnv(
      portal,
      auth,
      'personalAccessKeyEnv',
      'auth.developer.personalAccessKeyEnv'
    );
    return {
      type: DEVELOPER_AUTH_SUBTYPES.PERSONAL_ACCESS_KEY,
      name: personalAccessKeyEnv,
      profileField: 'auth.developer.personalAccessKeyEnv',
      provenance: portal.developer.provenance,
      redacted: true
    };
  }

  if (auth.subtype === DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS) {
    const source = requireDeveloperClientCredentialsSource(portal, auth);
    return {
      type: source.type,
      name: source.name,
      profileField: source.profileField,
      provenance: source.provenance,
      grantType: source.grantType,
      clientIdEnv: source.clientIdEnv,
      clientSecretEnv: source.clientSecretEnv,
      tokenCachePath: source.tokenCachePathDisplay || source.tokenCachePath,
      tokenUrlPath: source.tokenUrlPath,
      scopes: [...source.scopes],
      tokenCache: redactedDeveloperClientCredentialsTokenCacheContract(source, portal),
      redacted: true
    };
  }

  fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${AUTH_FAMILIES.DEVELOPER}; auth.subtype "${auth.subtype || '<missing>'}" is not supported.`);
}

function developerClientCredentialsEnvValues(source, portalName) {
  const missing = [];
  const clientId = process.env[source.clientIdEnv];
  const clientSecret = process.env[source.clientSecretEnv];
  if (!clientId) missing.push(source.clientIdEnv);
  if (!clientSecret) missing.push(source.clientSecretEnv);
  if (missing.length) {
    fail(`Missing developer client-credentials environment variable${missing.length === 1 ? '' : 's'} for portal "${portalName}": ${missing.join(', ')}.`);
  }
  return { clientId, clientSecret };
}

function developerClientCredentialsTokenCacheFromPayload(payload, source, portal, refreshedAtMs = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('Developer client-credentials refresh failed: HubSpot token response was not a JSON object.');
  }
  const accessToken = configString(payload.access_token) || configString(payload.accessToken);
  if (!accessToken) {
    fail('Developer client-credentials refresh failed: HubSpot token response did not include access_token.');
  }
  const rawExpiresIn = payload.expires_in === undefined ? payload.expiresIn : payload.expires_in;
  const expiresIn = Number(rawExpiresIn);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    fail('Developer client-credentials refresh failed: HubSpot token response did not include a positive expires_in value.');
  }
  return {
    schema: DEVELOPER_CLIENT_CREDENTIALS_TOKEN_CACHE_SCHEMA,
    family: AUTH_FAMILIES.DEVELOPER,
    subtype: DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS,
    grantType: 'client_credentials',
    tokenType: configString(payload.token_type) || configString(payload.tokenType) || 'bearer',
    accessToken,
    expiresIn,
    expiresAt: new Date(refreshedAtMs + expiresIn * 1000).toISOString(),
    refreshedAt: new Date(refreshedAtMs).toISOString(),
    portal: {
      name: portal.name,
      portalId: portal.portalId,
      baseUrl: portal.baseUrl
    },
    source: {
      clientIdEnv: source.clientIdEnv,
      clientSecretEnv: source.clientSecretEnv,
      tokenUrlPath: source.tokenUrlPath,
      scopes: [...source.scopes]
    }
  };
}

function developerClientCredentialsFailureMessage(source) {
  return `Developer client-credentials refresh failed for required scopes: ${source.scopes.join(', ')}.`;
}

async function refreshDeveloperClientCredentialsCredential(portal, source) {
  const env = developerClientCredentialsEnvValues(source, portal.name);
  const tokenUrl = new URL(source.tokenUrlPath, portal.baseUrl);
  const body = {
    grant_type: 'client_credentials',
    client_id: env.clientId,
    client_secret: env.clientSecret,
    scope: source.scopes.join(' ')
  };
  let response;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(body)
    });
  } catch (error) {
    fail(`Developer client-credentials refresh failed for portal "${portal.name}": network_error ${error.message}`);
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = text;
    }
  }

  if (!response.ok) {
    const responseClass = hubSpotResponseClass(response.status);
    const category = hubSpotResponseCategory(payload);
    const categoryText = category ? ` category ${category}` : '';
    fail(`${developerClientCredentialsFailureMessage(source)} HubSpot ${responseClass} response${categoryText} (${response.status} ${response.statusText || 'HTTP error'}).`);
  }

  const cache = developerClientCredentialsTokenCacheFromPayload(payload, source, portal);
  writeDeveloperClientCredentialsTokenCache(source.tokenCachePath, cache);
  return {
    placement: 'bearer',
    token: cache.accessToken,
    source: {
      type: DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS,
      grantType: 'client_credentials',
      clientIdEnv: source.clientIdEnv,
      clientSecretEnv: source.clientSecretEnv,
      tokenCachePath: source.tokenCachePathDisplay || source.tokenCachePath,
      scopes: [...source.scopes]
    },
    tokenCache: redactedDeveloperClientCredentialsTokenCacheContract(source, portal, { status: 'read', cache, error: null }),
    cacheStatus: 'refreshed'
  };
}

async function resolveDeveloperClientCredentialsCredential(portal, auth) {
  const source = requireDeveloperClientCredentialsSource(portal, auth);
  const cacheRead = readDeveloperClientCredentialsTokenCache(source.tokenCachePath);
  const cachedToken = usableDeveloperClientCredentialsCacheToken(source, portal, cacheRead);
  if (cachedToken) {
    return {
      placement: 'bearer',
      token: cachedToken,
      source: {
        type: DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS,
        grantType: 'client_credentials',
        clientIdEnv: source.clientIdEnv,
        clientSecretEnv: source.clientSecretEnv,
        tokenCachePath: source.tokenCachePathDisplay || source.tokenCachePath,
        scopes: [...source.scopes]
      },
      tokenCache: redactedDeveloperClientCredentialsTokenCacheContract(source, portal, cacheRead),
      cacheStatus: 'cache_hit'
    };
  }
  return refreshDeveloperClientCredentialsCredential(portal, source);
}

async function resolveDeveloperCredential(portal, auth) {
  if (auth.required === false) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} does not require auth; refusing to send developer credentials.`);
  }
  if (auth.family !== AUTH_FAMILIES.DEVELOPER) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${auth.family || '<none>'}; developer credentials can only satisfy ${AUTH_FAMILIES.DEVELOPER} endpoints.`);
  }

  if (auth.subtype === DEVELOPER_AUTH_SUBTYPES.DEVELOPER_API_KEY) {
    requireDeveloperApiKeyQueryMetadata(auth);
    const developerApiKey = requireDeveloperEnvValue(
      portal,
      auth,
      'developerApiKeyEnv',
      'auth.developer.developerApiKeyEnv',
      'HubSpot developer API key'
    );
    const query = { hapikey: developerApiKey.value };
    const source = {
      type: DEVELOPER_AUTH_SUBTYPES.DEVELOPER_API_KEY,
      developerApiKeyEnv: developerApiKey.envName
    };
    if (authQueryParams(auth).includes('appId')) {
      const appId = requireDeveloperEnvValue(
        portal,
        auth,
        'appIdEnv',
        'auth.developer.appIdEnv',
        'HubSpot developer app ID'
      );
      query.appId = appId.value;
      source.appIdEnv = appId.envName;
    }
    return {
      placement: 'query',
      query,
      source
    };
  }

  if (auth.subtype === DEVELOPER_AUTH_SUBTYPES.PERSONAL_ACCESS_KEY) {
    const personalAccessKey = requireDeveloperEnvValue(
      portal,
      auth,
      'personalAccessKeyEnv',
      'auth.developer.personalAccessKeyEnv',
      'HubSpot personal access key'
    );
    return {
      placement: 'bearer',
      token: personalAccessKey.value,
      source: {
        type: DEVELOPER_AUTH_SUBTYPES.PERSONAL_ACCESS_KEY,
        personalAccessKeyEnv: personalAccessKey.envName
      }
    };
  }

  if (auth.subtype === DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS) {
    return resolveDeveloperClientCredentialsCredential(portal, auth);
  }

  fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${AUTH_FAMILIES.DEVELOPER}; auth.subtype "${auth.subtype || '<missing>'}" is not supported.`);
}

async function resolveRequestCredential(portal, auth) {
  if (auth.required === false) return null;
  if (auth.family === AUTH_FAMILIES.PORTAL_BEARER) return resolvePortalBearerCredential(portal, auth);
  if (auth.family === AUTH_FAMILIES.OAUTH) return resolveOAuthCredential(portal, auth);
  if (auth.family === AUTH_FAMILIES.DEVELOPER) return resolveDeveloperCredential(portal, auth);
  fail(`Endpoint ${auth.endpointId || '<unknown>'} requires unsupported auth family ${auth.family || '<none>'}.`);
}

function loadTiersData() {
  return readJsonFile(TIERS_FILE);
}

function credentialSourceForAuth(portal, auth) {
  if (auth.required === false) return null;
  if (auth.family === AUTH_FAMILIES.PORTAL_BEARER) {
    if (!portal.portalBearer) {
      fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${AUTH_FAMILIES.PORTAL_BEARER}; portal "${portal.name}" is missing auth.portalBearer.tokenEnv or legacy tokenEnv.`);
    }
    const source = portal.portalBearer;
    const credentialSource = {
      type: 'env',
      name: source.tokenEnv,
      profileField: source.profileField,
      provenance: source.provenance
    };
    if (source.kind) credentialSource.kind = source.kind;
    return credentialSource;
  }
  if (auth.family === AUTH_FAMILIES.OAUTH) {
    if (portal.oauthCommandCredentials) {
      return {
        type: 'command_flags_or_env',
        name: 'oauth_command_credentials',
        redacted: true
      };
    }
    if (!portal.oauth) {
      fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${AUTH_FAMILIES.OAUTH}; portal "${portal.name}" is missing auth.oauth clientIdEnv, clientSecretEnv, refreshTokenEnv, and tokenCachePath.`);
    }
    return {
      type: 'oauth_refresh_token',
      name: portal.oauth.refreshTokenEnv,
      profileField: portal.oauth.profileField,
      provenance: portal.oauth.provenance,
      clientIdEnv: portal.oauth.clientIdEnv,
      clientSecretEnv: portal.oauth.clientSecretEnv,
      refreshTokenEnv: portal.oauth.refreshTokenEnv,
      tokenCache: redactedOAuthTokenCacheContract(portal.oauth),
      redacted: true
    };
  }
  if (auth.family === AUTH_FAMILIES.DEVELOPER) {
    return developerCredentialSourceForAuth(portal, auth);
  }
  return null;
}

function requestAuthMetadata(portal, endpoint) {
  const auth = endpointAuthRequirement(endpoint, {
    defaultFamily: AUTH_FAMILIES.PORTAL_BEARER,
    defaultSubtype: 'private_app_or_static_app',
    defaultProvenance: 'generic_request_default'
  });
  return {
    required: auth.required,
    family: auth.family,
    subtype: auth.subtype || null,
    fallback: auth.fallback,
    provenance: auth.provenance,
    endpointId: auth.endpointId,
    queryParams: auth.queryParams,
    scopes: auth.scopes,
    reason: auth.reason || null,
    credentialSource: credentialSourceForAuth(portal, auth)
  };
}

function resolvePortalBearerCredential(portal, auth) {
  if (auth.required === false) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} does not require auth; refusing to send portal bearer credentials.`);
  }
  if (auth.family !== AUTH_FAMILIES.PORTAL_BEARER) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${auth.family || '<none>'}; portal bearer credentials can only satisfy ${AUTH_FAMILIES.PORTAL_BEARER} endpoints.`);
  }
  if (!portal.portalBearer) {
    fail(`Endpoint ${auth.endpointId || '<unknown>'} requires auth family ${AUTH_FAMILIES.PORTAL_BEARER}; portal "${portal.name}" is missing auth.portalBearer.tokenEnv or legacy tokenEnv.`);
  }
  if (!portal.token) {
    fail(`Missing HubSpot token. Set ${portal.tokenEnv} for portal "${portal.name}".`);
  }
  return {
    token: portal.token,
    source: portal.portalBearer
  };
}

const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'hapikey',
  'refresh_token',
  'token'
]);

function previewUrlForAuth(url, auth) {
  const previewUrl = new URL(url.toString());
  if (auth.family !== AUTH_FAMILIES.DEVELOPER || auth.subtype !== DEVELOPER_AUTH_SUBTYPES.DEVELOPER_API_KEY) {
    return previewUrl;
  }
  const queryParams = auth.credentialSource && auth.credentialSource.queryParams
    ? auth.credentialSource.queryParams
    : {};
  if (queryParams.hapikey) previewUrl.searchParams.set('hapikey', `$${queryParams.hapikey.name}`);
  if (queryParams.appId) previewUrl.searchParams.set('appId', `$${queryParams.appId.name}`);
  return previewUrl;
}

function queryObjectForDisplay(url) {
  const output = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (SENSITIVE_QUERY_KEYS.has(key) && !String(value).startsWith('$')) {
      output[key] = 'REDACTED';
    } else {
      output[key] = value;
    }
  }
  return output;
}

function showRequestPreview(portal, method, url, body, endpoint, options = {}) {
  const auth = options.auth || requestAuthMetadata(portal, endpoint);
  const previewUrl = previewUrlForAuth(url, auth);
  const headers = {
    Accept: 'application/json'
  };
  if (auth.family === AUTH_FAMILIES.PORTAL_BEARER) headers.Authorization = `Bearer $${portal.tokenEnv}`;
  if (auth.family === AUTH_FAMILIES.OAUTH) headers.Authorization = 'Bearer <oauth-access-token>';
  if (auth.family === AUTH_FAMILIES.DEVELOPER && auth.subtype === DEVELOPER_AUTH_SUBTYPES.PERSONAL_ACCESS_KEY) {
    headers.Authorization = `Bearer $${auth.credentialSource.name}`;
  }
  if (auth.family === AUTH_FAMILIES.DEVELOPER && auth.subtype === DEVELOPER_AUTH_SUBTYPES.CLIENT_CREDENTIALS) {
    headers.Authorization = 'Bearer <developer-client-credentials-access-token>';
  }
  if (body !== undefined) headers['Content-Type'] = options.contentType || 'application/json';
  printJson({
    ok: true,
    dryRun: true,
    showRequest: true,
    authFamily: auth.family,
    authSubtype: auth.subtype,
    auth,
    portal: {
      name: portal.name,
      label: portal.label,
      portalId: portal.portalId,
      tokenEnv: portal.tokenEnv
    },
    endpoint,
    request: {
      method,
      url: redactTokenUrl(previewUrl.toString()),
      pathname: previewUrl.pathname,
      query: queryObjectForDisplay(previewUrl),
      headers,
      body: options.previewBody !== undefined ? options.previewBody : (body === undefined ? null : redactSensitiveValue(body))
    }
  });
  exitCli(0);
}

function isCatalogReadOnlyPost(portal, method, target, flags) {
  if (method !== 'POST') return false;
  const url = buildUrl(portal, target, flags);
  return endpointDefinitions(CATALOG_FILE).some((endpoint) => (
    endpoint.readOnlyPost === true &&
    endpoint.risk === 'read' &&
    endpoint.method === method &&
    endpoint.pathTemplate &&
    pathTemplateToRegex(endpoint.pathTemplate).test(url.pathname)
  ));
}

function requireCatalogReadOnlyPost(portal, method, target, flags) {
  if (!isCatalogReadOnlyPost(portal, method, target, flags)) {
    fail(`--read-only is only allowed for catalog-marked read-only POST endpoints. Refusing ${method} ${target}.`);
  }
}

function normalizeTierName(raw) {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim().toLowerCase();
  if (!value) return null;
  if (['free', 'starter', 'pro', 'enterprise'].includes(value)) return value;
  if (value === 'basic') return 'starter';
  return value;
}

function tierRank(tier) {
  const normalized = normalizeTierName(tier);
  const order = { free: 0, starter: 1, pro: 2, enterprise: 3 };
  return normalized in order ? order[normalized] : -1;
}

function featureAvailableAtTier(featureTier, requestedTier) {
  const featureRank = tierRank(featureTier);
  const requestedRank = tierRank(requestedTier);
  if (featureRank < 0 || requestedRank < 0) return false;
  return featureRank <= requestedRank;
}

function extractFeaturesByTier(tiersData, requestedTier, hubFilter = null, options = {}) {
  const includeGlobal = options.includeGlobal === true;
  const matched = [];
  for (const product of tiersData.products || []) {
    const hubId = product.hub && product.hub.id ? product.hub.id : null;
    if (hubFilter && hubId !== hubFilter) continue;
    if (!hubFilter && hubId === 'free' && !includeGlobal) continue;
    const features = (product.features || [])
      .filter((feature) => featureAvailableAtTier(feature.minTier, requestedTier))
      .map((feature) => ({
        name: feature.name,
        minTier: feature.minTier,
        docsUrl: feature.docsUrl || null,
        disclaimer: feature.disclaimer || null
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    matched.push({
      hub: product.hub || null,
      tiers: product.tiers || [],
      featureCount: features.length,
      features
    });
  }
  return matched;
}

function globalApiSurfaceSummary(tiersData) {
  const freeProduct = (tiersData.products || []).find((product) => product.hub && product.hub.id === 'free');
  const features = freeProduct && Array.isArray(freeProduct.features) ? freeProduct.features : [];
  return {
    hub: freeProduct ? freeProduct.hub : { id: 'free', name: 'Free' },
    featureCount: features.length,
    note: 'This is HubSpot\'s broad free/global API surface. It is not enough to prove a portal has access to subscription-gated capabilities such as custom object schemas, calculated-property limits, or association-label limits. Use product-tier rows and live API checks for entitlement decisions.'
  };
}

function tier403Note() {
  return 'A 403 on custom-object/schema endpoints can mean either the app token is missing the needed API scope, or the portal subscription does not include custom objects/schemas. Check both the token scopes and the HubSpot tier matrix before assuming the API is broken.';
}

function gatedAccessNote(feature, tierText) {
  return `A 403 on ${feature} can mean either the app token is missing the needed API scope, or the portal subscription does not include that feature${tierText ? ` (${tierText})` : ''}. Check both the token scopes and the HubSpot tier matrix before assuming the API is broken.`;
}

function accessNoteForError(urlString, status) {
  if (status !== 403) return null;
  let pathname = '';
  try {
    pathname = new URL(urlString).pathname;
  } catch (_error) {
    return null;
  }
  if (pathname.includes('/crm-object-schemas/') || pathname.includes('/crm/v3/limits/custom-object-types')) {
    return tier403Note();
  }
  if (pathname.includes('/crm/v3/limits/calculated-properties')) {
    return gatedAccessNote('calculated property limits', 'Professional or Enterprise');
  }
  if (pathname.includes('/crm/v3/limits/associations/labels')) {
    return gatedAccessNote('association label limits', 'Professional or Enterprise');
  }
  if (pathname.includes('/communication-preferences/2026-03/statuses/batch')) {
    return gatedAccessNote('batch subscription status endpoints', 'Marketing Hub Enterprise plus batch subscription scopes');
  }
  if (pathname.includes('/crm/v3/objects/custom-objects') || pathname.includes('/crm/objects/custom-objects')) {
    return tier403Note();
  }
  return null;
}

function previewMutation(portal, method, target, body) {
  printJson({
    ok: false,
    dryRun: true,
    message: 'Mutation blocked. Re-run with --yes to execute.',
    portal: portal.name,
    method,
    target,
    body: body || null
  });
  exitCli(2);
}

async function guardedFetch(portal, method, target, flags, body, options = {}) {
  const isReadOnlyPost = options.readOnly === true;
  const requiresConfirmation = !SAFE_METHODS.has(method) && !isReadOnlyPost;
  if (requiresConfirmation && !boolFlag(flags, 'yes') && !boolFlag(flags, 'show-request')) {
    previewMutation(portal, method, target, body);
  }
  return hubspotFetch(portal, method, target, flags, body, options.endpoint || null);
}

async function guardedMultipartFetch(portal, method, target, flags, formBody, previewBody, options = {}) {
  const requiresConfirmation = !SAFE_METHODS.has(method);
  if (requiresConfirmation && !boolFlag(flags, 'yes') && !boolFlag(flags, 'show-request')) {
    previewMutation(portal, method, target, previewBody);
  }
  return hubspotMultipartFetch(portal, method, target, flags, formBody, previewBody, options.endpoint || null);
}

const SENSITIVE_BODY_KEYS = new Set([
  'access_token',
  'client_secret',
  'code',
  'developerApiKey',
  'developer_api_key',
  'hapikey',
  'personalAccessKey',
  'personal_access_key',
  'refresh_token',
  'signed_access_token',
  'token'
]);

function redactSensitiveValue(value) {
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (value && typeof value === 'object') {
    const redacted = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      redacted[key] = SENSITIVE_BODY_KEYS.has(key) ? 'REDACTED' : redactSensitiveValue(nestedValue);
    }
    return redacted;
  }
  return value;
}

function maybeRedactSensitivePayload(payload, flags) {
  return boolFlag(flags, 'show-secrets') ? payload : redactSensitiveValue(payload);
}

function showNoAuthRequestPreview(portal, method, url, body, endpoint, options = {}) {
  const auth = options.auth || requestAuthMetadata(portal, endpoint);
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = options.contentType || 'application/json';
  printJson({
    ok: true,
    dryRun: true,
    showRequest: true,
    authFamily: auth.family,
    authSubtype: auth.subtype,
    auth,
    portal: {
      name: portal.name,
      label: portal.label,
      portalId: portal.portalId,
      tokenEnv: portal.tokenEnv
    },
    endpoint,
    request: {
      method,
      url: redactTokenUrl(url.toString()),
      pathname: url.pathname,
      query: queryObjectForDisplay(url),
      headers,
      body: options.previewBody !== undefined ? options.previewBody : (body === undefined ? null : body)
    }
  });
  exitCli(0);
}

async function externalNoAuthJsonFetch(portal, method, url, flags, body, endpointOverride = null) {
  const endpoint = endpointOverride || findEndpointDefinition(method, url.pathname);
  const auth = requestAuthMetadata(portal, endpoint);
  if (boolFlag(flags, 'show-request')) {
    showNoAuthRequestPreview(portal, method, url, body, endpoint, { auth });
  }

  const options = {
    method,
    headers: {
      Accept: 'application/json'
    }
  };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = text;
    }
  }

  if (!response.ok) {
    printJson({
      ok: false,
      status: response.status,
      statusText: response.statusText,
      ...responseMeta(response),
      portal: portal.name,
      method,
      url: redactTokenUrl(url.toString()),
      response: payload
    });
    exitCli(1);
  }

  return {
    ok: true,
    status: response.status,
    ...responseMeta(response),
    portal: portal.name,
    method,
    url: redactTokenUrl(url.toString()),
    data: payload
  };
}

async function guardedExternalNoAuthJsonFetch(portal, method, url, flags, body, options = {}) {
  const requiresConfirmation = !SAFE_METHODS.has(method);
  if (requiresConfirmation && !boolFlag(flags, 'yes') && !boolFlag(flags, 'show-request')) {
    previewMutation(portal, method, redactTokenUrl(url.toString()), body);
  }
  return externalNoAuthJsonFetch(portal, method, url, flags, body, options.endpoint || null);
}

async function externalNoAuthFormFetch(portal, method, url, flags, body, endpointOverride = null, options = {}) {
  const endpoint = endpointOverride || findEndpointDefinition(method, url.pathname);
  const auth = requestAuthMetadata(portal, endpoint);
  if (boolFlag(flags, 'show-request')) {
    showNoAuthRequestPreview(portal, method, url, body, endpoint, {
      auth,
      contentType: 'application/x-www-form-urlencoded',
      previewBody: redactSensitiveValue(body)
    });
  }

  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(body)
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = text;
    }
  }

  if (!response.ok) {
    printJson({
      ok: false,
      status: response.status,
      statusText: response.statusText,
      ...responseMeta(response),
      portal: portal.name,
      method,
      url: redactTokenUrl(url.toString()),
      response: maybeRedactSensitivePayload(payload, flags)
    });
    exitCli(1);
  }

  return {
    ok: true,
    status: response.status,
    ...responseMeta(response),
    portal: portal.name,
    method,
    url: redactTokenUrl(url.toString()),
    data: maybeRedactSensitivePayload(payload, flags),
    redacted: !boolFlag(flags, 'show-secrets')
  };
}

async function guardedExternalNoAuthFormFetch(portal, method, url, flags, body, options = {}) {
  const requiresConfirmation = !SAFE_METHODS.has(method) && options.readOnly !== true;
  if (requiresConfirmation && !boolFlag(flags, 'yes') && !boolFlag(flags, 'show-request')) {
    previewMutation(portal, method, redactTokenUrl(url.toString()), redactSensitiveValue(body));
  }
  return externalNoAuthFormFetch(portal, method, url, flags, body, options.endpoint || null, options);
}

async function externalBearerJsonFetch(portal, method, url, flags, body, endpointOverride = null) {
  const endpoint = endpointOverride || findEndpointDefinition(method, url.pathname);
  const auth = requestAuthMetadata(portal, endpoint);
  if (boolFlag(flags, 'show-request')) {
    showRequestPreview(portal, method, url, body, endpoint, { auth });
  }

  const credential = await resolveRequestCredential(portal, auth);
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
  applyCredentialToRequest(url, headers, credential);

  const response = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = text;
    }
  }

  if (!response.ok) {
    printJson({
      ok: false,
      status: response.status,
      statusText: response.statusText,
      ...responseMeta(response),
      portal: portal.name,
      method,
      url: redactTokenUrl(url.toString()),
      response: payload
    });
    exitCli(1);
  }

  return {
    ok: true,
    status: response.status,
    ...responseMeta(response),
    portal: portal.name,
    method,
    url: redactTokenUrl(url.toString()),
    data: payload
  };
}

async function guardedExternalBearerJsonFetch(portal, method, url, flags, body, options = {}) {
  const requiresConfirmation = !SAFE_METHODS.has(method);
  if (requiresConfirmation && !boolFlag(flags, 'yes') && !boolFlag(flags, 'show-request')) {
    previewMutation(portal, method, redactTokenUrl(url.toString()), body);
  }
  return externalBearerJsonFetch(portal, method, url, flags, body, options.endpoint || null);
}

function requireFlag(flags, name) {
  if (flags[name] === undefined || flags[name] === true || flags[name] === '') {
    fail(`Missing required --${name}.`);
  }
  return flags[name];
}

function optionalNumber(raw) {
  if (raw === undefined || raw === true || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`Expected number, got "${raw}".`);
  return value;
}

function optionalBoolean(raw, flagName) {
  if (raw === undefined) return undefined;
  if (raw === true || raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`Expected boolean for --${flagName}, got "${raw}".`);
}

function pathPart(value) {
  return encodeURIComponent(String(value));
}

function pathTail(value, label = 'path') {
  const normalized = String(value || '').replace(/^\/+/, '');
  if (!normalized) fail(`Missing required ${label}.`);
  return normalized.split('/').map((part) => {
    if (!part || part === '.' || part === '..') fail(`Invalid ${label}: ${value}`);
    return pathPart(part);
  }).join('/');
}

function bodyFromFlags(flags, allowedFields) {
  const body = {};
  for (const field of allowedFields) {
    if (flags[field] !== undefined) body[field] = flags[field];
  }
  if (flags['display-order'] !== undefined) body.displayOrder = optionalNumber(flags['display-order']);
  return body;
}

function associationLimitBodyFromFlags(flags, options = {}) {
  const body = parseBody(flags.body);
  if (body) return body;

  const category = flags.category;
  const typeId = flags['type-id'];
  if (!category || typeId === undefined) {
    fail('association-limits requires --body <json|@file> or --category <category> --type-id <id>.');
  }

  const input = {
    category: String(category),
    typeId: optionalNumber(typeId)
  };

  if (options.requireMax) {
    if (flags['max-to-object-ids'] === undefined) {
      fail('association-limits create/update requires --max-to-object-ids when --body is not provided.');
    }
    input.maxToObjectIds = optionalNumber(flags['max-to-object-ids']);
  }

  return { inputs: [input] };
}

async function collectPages(portal, method, inputPath, flags, body) {
  const maxResults = parseNonNegativeIntegerFlag(flags['max-results'], 'max-results');
  const firstUrl = buildUrl(portal, inputPath, flags);
  let after = firstUrl.searchParams.get('after');
  const results = [];
  let pageCount = 0;
  let last = null;
  let truncated = false;
  let truncation = null;

  while (true) {
    const pageFlags = { ...flags, query: [] };
    const url = new URL(firstUrl.toString());
    if (after) url.searchParams.set('after', after);
    last = await hubspotFetch(portal, method, url.toString(), pageFlags, body);
    pageCount += 1;

    const data = last.data;
    if (data && Array.isArray(data.results)) {
      if (maxResults === undefined) {
        results.push(...data.results);
      } else {
        const remaining = Math.max(maxResults - results.length, 0);
        if (remaining > 0) results.push(...data.results.slice(0, remaining));
        const nextAfter = data && data.paging && data.paging.next && data.paging.next.after;
        if (data.results.length > remaining || (results.length >= maxResults && nextAfter)) {
          truncated = true;
          truncation = {
            reason: 'max-results',
            path: 'results',
            maxResults,
            returnedResultCount: results.length,
            fetchedPageResultCount: data.results.length,
            pageCount,
            nextAfter: nextAfter || null
          };
          if (data.results.length > remaining) {
            truncation.limitedWithinPage = true;
          }
          break;
        }
      }
    }

    after = data && data.paging && data.paging.next && data.paging.next.after;
    if (!after) break;
  }

  const output = {
    ok: true,
    status: last.status,
    portal: portal.name,
    method,
    url: redactTokenUrl(firstUrl.toString()),
    pageCount,
    resultCount: results.length,
    results
  };
  if (truncated) {
    output.truncated = true;
    output.truncation = truncation;
  }
  return output;
}

function crmSearchRequestFromFlags(flags, options = {}) {
  const criteria = crmSearchCriteriaFromFlags(flags, options);
  const body = {
    filterGroups: [{ filters: criteria.filters }],
    limit: Number(flags.limit || options.defaultLimit || 10)
  };
  if (options.includeProperties !== false && criteria.properties.length) body.properties = criteria.properties;
  if (options.includePropertiesWithHistory !== false && criteria.propertiesWithHistory.length) {
    body.propertiesWithHistory = criteria.propertiesWithHistory;
  }
  if (criteria.sorts.length) body.sorts = criteria.sorts;
  if (criteria.query !== null) body.query = criteria.query;
  if (flags.after !== undefined) body.after = String(flags.after);
  return { body, criteria };
}

function crmSearchCriteriaFromFlags(flags, options = {}) {
  const commandName = options.commandName || 'crm search';
  let rawFilters = values(flags.filter);
  let defaultFilter = false;
  if (!rawFilters.length && options.defaultAllFilter === true) {
    rawFilters = ['hs_object_id:GT:0'];
    defaultFilter = true;
  }

  const filters = rawFilters.map((raw) => {
    const parts = String(raw).split(':');
    if (parts.length < 3) {
      fail(`Invalid --filter "${raw}". Expected property:OP:value, e.g. dealstage:EQ:closedwon`);
    }
    const [propertyName, operator, ...valueParts] = parts;
    return { propertyName, operator, value: valueParts.join(':') };
  });

  if (!filters.length && options.requireFilter !== false) {
    fail(`${commandName} requires at least one --filter property:OP:value`);
  }

  const properties = parsePropertiesList(flags.properties);
  const propertiesWithHistory = parsePropertiesList(flags['properties-with-history']);
  const sorts = parseSearchSorts(flags.sort);
  return {
    filters,
    filterSummary: filters.map(formatCrmFilter),
    defaultFilter,
    properties,
    propertiesWithHistory,
    sorts,
    query: flags.search === undefined ? null : String(flags.search)
  };
}

function searchBodyFromFlags(flags) {
  return crmSearchRequestFromFlags(flags).body;
}

function formatCrmFilter(filter) {
  return `${filter.propertyName}:${filter.operator}:${filter.value}`;
}

function crmQuerySummaryFromSearchCriteria(criteria) {
  const summary = {};
  if (criteria.filterSummary.length) summary.filters = criteria.filterSummary;
  if (criteria.defaultFilter) summary.defaultFilter = true;
  if (criteria.query !== null) summary.query = criteria.query;
  return summary;
}

function crmQuerySummaryFromListFlags(flags) {
  const summary = {};
  if (boolFlag(flags, 'archived')) summary.archived = true;
  return summary;
}

function countInfoFromPayload(data, pageLimit) {
  if (data && Number.isFinite(Number(data.total))) {
    return {
      count: Number(data.total),
      countType: 'exact',
      countSource: 'response.total'
    };
  }

  if (data && Array.isArray(data.results)) {
    const returnedCount = data.results.length;
    const nextAfter = data.paging && data.paging.next ? data.paging.next.after || null : null;
    const exact = !nextAfter;
    return {
      count: returnedCount,
      countType: exact ? 'exact' : 'page-limited',
      countSource: exact ? 'exhausted-page' : 'first-page',
      pageLimit,
      returnedCount,
      hasMore: Boolean(nextAfter),
      nextAfter
    };
  }

  return {
    count: null,
    countType: 'unavailable',
    countSource: 'response-shape',
    reason: 'Response did not include total or results.'
  };
}

function crmCountOutput(portal, objectType, source, querySummary, data, pageLimit) {
  const countInfo = countInfoFromPayload(data, pageLimit);
  const output = {
    ok: true,
    portal: portal.name,
    objectType,
    source,
    ...querySummary,
    count: countInfo.count,
    countType: countInfo.countType,
    countSource: countInfo.countSource
  };
  for (const key of ['pageLimit', 'returnedCount', 'hasMore', 'nextAfter', 'reason']) {
    if (countInfo[key] !== undefined && countInfo[key] !== null) output[key] = countInfo[key];
  }
  return output;
}

function firstCrmResult(data) {
  return data && Array.isArray(data.results) && data.results.length ? data.results[0] : null;
}

function crmObjectTypesFromFlags(flags) {
  const family = String(flags.family || 'all').toLowerCase();
  const allowed = new Set(['all', 'core', 'commerce', 'activity']);
  if (!allowed.has(family)) fail('crm object-types --family must be core, commerce, activity, or all.');
  const objectTypes = CRM_OBJECT_TYPE_CATALOG
    .filter((entry) => family === 'all' || entry.family === family)
    .map((entry) => ({ ...entry }));
  if (boolFlag(flags, 'names-only')) {
    return {
      ok: true,
      family,
      count: objectTypes.length,
      names: objectTypes.map((entry) => entry.objectType)
    };
  }
  return { ok: true, family, count: objectTypes.length, objectTypes };
}

function parseSearchSorts(raw) {
  return parseStringList(raw, 'sort').map((item) => {
    if (item.startsWith('-')) {
      return { propertyName: item.slice(1), direction: 'DESCENDING' };
    }
    const [propertyName, directionRaw = 'ASCENDING'] = item.split(':');
    const direction = directionRaw.toUpperCase();
    if (!propertyName) fail('crm search --sort requires a property name.');
    if (direction === 'ASC' || direction === 'ASCENDING') {
      return { propertyName, direction: 'ASCENDING' };
    }
    if (direction === 'DESC' || direction === 'DESCENDING') {
      return { propertyName, direction: 'DESCENDING' };
    }
    fail(`crm search --sort direction must be ASC or DESC, got "${directionRaw}".`);
  });
}

function propertyDefinitionBodyFromFlags(flags, options = {}) {
  const rawBody = flags.body || flags.property;
  if (rawBody !== undefined) return parseBody(rawBody);

  const body = {};
  const stringMappings = {
    name: 'name',
    label: 'label',
    type: 'type',
    'field-type': 'fieldType',
    'group-name': 'groupName',
    group: 'groupName',
    description: 'description',
    'calculation-formula': 'calculationFormula',
    'currency-property-name': 'currencyPropertyName',
    'data-sensitivity': 'dataSensitivity',
    'number-display-hint': 'numberDisplayHint',
    'referenced-object-type': 'referencedObjectType'
  };
  for (const [flagName, bodyName] of Object.entries(stringMappings)) {
    if (flags[flagName] !== undefined) body[bodyName] = flags[flagName];
  }

  const displayOrder = optionalNumber(flags['display-order']);
  if (displayOrder !== undefined) body.displayOrder = displayOrder;

  for (const flagName of ['external-options', 'form-field', 'has-unique-value', 'hidden', 'show-currency-symbol']) {
    const value = optionalBoolean(flags[flagName], flagName);
    if (value !== undefined) {
      body[flagName.replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
    }
  }

  if (flags.options !== undefined) {
    body.options = parseBody(flags.options);
    if (!Array.isArray(body.options)) fail('--options must be a JSON array.');
  }

  if (options.requireCreateFields) {
    for (const required of ['groupName', 'name', 'label', 'type', 'fieldType']) {
      if (body[required] === undefined || body[required] === '') {
        fail(`properties create requires --body or --${required.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}.`);
      }
    }
  }

  return body;
}

function pipelineStageBodyFromFlags(flags, options = {}) {
  const rawBody = flags.body || flags.stage;
  if (rawBody !== undefined) return parseBody(rawBody);

  const body = {};
  if (flags.label !== undefined) body.label = flags.label;
  const displayOrder = optionalNumber(flags['display-order']);
  if (displayOrder !== undefined) body.displayOrder = displayOrder;
  if (flags.metadata !== undefined) body.metadata = parseBody(flags.metadata);

  if (options.requireCreateFields) {
    for (const required of ['label', 'displayOrder']) {
      if (body[required] === undefined || body[required] === '') {
        fail(`pipeline stage create requires --body or --${required === 'displayOrder' ? 'display-order' : required}.`);
      }
    }
  }

  return body;
}

async function main(argv = process.argv.slice(2)) {
  const { positionals, flags } = parseArgs(argv);
  currentOutputFlags = flags;
  const [area, action, ...rest] = positionals;

  if (!area || area === 'help' || boolFlag(flags, 'help')) {
    writeStdout(usage());
    return;
  }

  outputOptionsFromFlags(flags);

  if (area === 'catalog') {
    await runCatalog(action);
    return;
  }

  if (area === 'mcp' && action === 'serve') {
    const { serveMcpStdio } = require('./mcp-server');
    serveMcpStdio();
    return;
  }

  if (area === 'tiers' && (action === 'products' || action === 'apis')) {
    await runTiers({ knownPlanLabel: null }, action, flags);
    return;
  }

  if (area === 'crm' && action === 'object-types') {
    printJson(crmObjectTypesFromFlags(flags));
    return;
  }

  if (area === 'auth' || area === 'oauth') {
    await runAuth(action, rest, flags);
    return;
  }

  const { configPath, config } = loadConfig();

  if (area === 'profiles' && action === 'list') {
    const profiles = Object.entries(config.portals).map(([name, portal]) => {
      const portalBearer = maybeResolvePortalBearerProfile(portal, name);
      const oauth = resolveOAuthProfile(portal, name);
      const developer = resolveDeveloperProfile(portal, name);
      if (!portalBearer && !oauth && !developer) {
        fail(`Portal "${name}" is missing auth.portalBearer.tokenEnv, auth.oauth, auth.developer, or legacy tokenEnv. Named profiles must declare at least one explicit credential family.`);
      }
      const tokenEnv = portalBearer ? portalBearer.tokenEnv : null;
      const families = [];
      if (portalBearer) families.push(AUTH_FAMILIES.PORTAL_BEARER);
      if (oauth) families.push(AUTH_FAMILIES.OAUTH);
      if (developer) families.push(AUTH_FAMILIES.DEVELOPER);
      const profile = {
        name,
        label: portal.label || name,
        portalId: portal.portalId || null,
        baseUrl: portal.baseUrl || 'https://api.hubapi.com',
        tokenEnv,
        tokenPresent: Boolean(tokenEnv && process.env[tokenEnv]),
        authFamilies: families,
        authDefaultFamily: resolveProfileDefaultFamily(portal, name)
      };
      if (oauth) {
        profile.oauth = {
          clientIdEnv: oauth.clientIdEnv,
          clientIdPresent: Boolean(process.env[oauth.clientIdEnv]),
          clientSecretEnv: oauth.clientSecretEnv,
          clientSecretPresent: Boolean(process.env[oauth.clientSecretEnv]),
          refreshTokenEnv: oauth.refreshTokenEnv,
          refreshTokenPresent: Boolean(process.env[oauth.refreshTokenEnv]),
          tokenCache: redactedOAuthTokenCacheContract(oauth)
        };
      }
      if (developer) {
        profile.developer = {
          personalAccessKeyEnv: developer.personalAccessKeyEnv,
          personalAccessKeyPresent: Boolean(developer.personalAccessKeyEnv && process.env[developer.personalAccessKeyEnv]),
          developerApiKeyEnv: developer.developerApiKeyEnv,
          developerApiKeyPresent: Boolean(developer.developerApiKeyEnv && process.env[developer.developerApiKeyEnv]),
          appIdEnv: developer.appIdEnv,
          appIdPresent: Boolean(developer.appIdEnv && process.env[developer.appIdEnv]),
          clientIdEnv: developer.clientIdEnv,
          clientIdPresent: Boolean(developer.clientIdEnv && process.env[developer.clientIdEnv]),
          clientSecretEnv: developer.clientSecretEnv,
          clientSecretPresent: Boolean(developer.clientSecretEnv && process.env[developer.clientSecretEnv]),
          tokenCachePath: developer.tokenCachePathDisplay
        };
      }
      return profile;
    });
    printJson({ ok: true, configPath, default: config.default || null, profiles });
    return;
  }

  const portal = resolvePortal(config, flags);

  if (area === 'request') {
    const method = String(action || '').toUpperCase();
    const target = rest[0];
    if (!method || !target) fail(usage());
    const body = parseBody(flags.body || flags.data);
    if (!SAFE_METHODS.has(method) && !boolFlag(flags, 'yes') && !boolFlag(flags, 'show-request')) {
      if (boolFlag(flags, 'read-only')) {
        requireCatalogReadOnlyPost(portal, method, target, flags);
      } else {
        previewMutation(portal, method, target, body);
      }
    }
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, method, target, flags, body)
      : await hubspotFetch(portal, method, target, flags, body);
    printJson(result);
    return;
  }

  if (area === 'crm') {
    await runCrm(portal, action, rest, flags);
    return;
  }

  if (area === 'properties') {
    await runProperties(portal, action, rest, flags);
    return;
  }

  if (area === 'associations') {
    await runAssociations(portal, action, rest, flags);
    return;
  }

  if (area === 'account') {
    await runAccount(portal, action, flags);
    return;
  }

  if (area === 'tiers') {
    await runTiers(portal, action, flags);
    return;
  }

  if (area === 'property-groups') {
    await runPropertyGroups(portal, action, rest, flags);
    return;
  }

  if (area === 'property-validations') {
    await runPropertyValidations(portal, action, rest, flags);
    return;
  }

  if (area === 'schemas') {
    await runSchemas(portal, action, rest, flags);
    return;
  }

  if (area === 'object-library') {
    await runObjectLibrary(portal, action, rest, flags);
    return;
  }

  if (area === 'association-labels') {
    await runAssociationLabels(portal, action, rest, flags);
    return;
  }

  if (area === 'association-limits') {
    await runAssociationLimits(portal, action, rest, flags);
    return;
  }

  if (area === 'pipelines') {
    await runPipelines(portal, action, rest, flags);
    return;
  }

  if (area === 'lists') {
    await runLists(portal, action, rest, flags);
    return;
  }

  if (area === 'exports') {
    await runExports(portal, action, rest, flags);
    return;
  }

  if (area === 'imports') {
    await runImports(portal, action, rest, flags);
    return;
  }

  if (area === 'subscriptions' || area === 'communication-preferences') {
    await runSubscriptions(portal, action, rest, flags);
    return;
  }

  if (area === 'files') {
    await runFiles(portal, action, rest, flags);
    return;
  }

  if (area === 'events') {
    await runEvents(portal, action, rest, flags);
    return;
  }

  if (area === 'webhooks') {
    await runWebhooks(portal, action, rest, flags);
    return;
  }

  if (area === 'webhook-journal' || area === 'webhooks-journal') {
    await runWebhookJournal(portal, action, rest, flags);
    return;
  }

  if (area === 'conversations') {
    await runConversations(portal, action, rest, flags);
    return;
  }

  if (area === 'marketing') {
    await runMarketing(portal, action, rest, flags);
    return;
  }

  if (area === 'automation') {
    await runAutomation(portal, action, rest, flags);
    return;
  }

  if (area === 'extensions') {
    await runExtensions(portal, action, rest, flags);
    return;
  }

  if (area === 'forms') {
    await runForms(portal, action, rest, flags);
    return;
  }

  if (area === 'cms') {
    await runCms(portal, action, rest, flags);
    return;
  }

  if (area === 'scheduler') {
    await runScheduler(portal, action, rest, flags);
    return;
  }

  if (area === 'limits') {
    await runLimits(portal, action, rest, flags);
    return;
  }

  fail(usage());
}

async function runAuth(action, rest, flags) {
  if (action === 'doctor' || action === 'validate') {
    runAuthDoctor(flags);
    return;
  }

  const portal = authBasePortal(flags);
  const tokenUrl = new URL('/oauth/2026-03/token', portal.baseUrl);

  if (action === 'authorize-url' || action === 'authorization-url') {
    const url = authUrlFromFlags(flags);
    printJson({
      ok: true,
      authorizationUrl: url.toString(),
      params: {
        clientId: url.searchParams.get('client_id'),
        redirectUri: url.searchParams.get('redirect_uri'),
        scope: url.searchParams.get('scope'),
        optionalScopes: url.searchParams.get('optional_scopes') || null,
        state: url.searchParams.get('state') || null
      }
    });
    return;
  }

  if (action === 'token' || action === 'exchange') {
    printJson(await guardedExternalNoAuthFormFetch(portal, 'POST', tokenUrl, flags, authTokenExchangeBodyFromFlags(flags), {
      endpoint: endpointDefinitionById('auth.oauth.token')
    }));
    return;
  }

  if (action === 'refresh') {
    printJson(await guardedExternalNoAuthFormFetch(portal, 'POST', tokenUrl, flags, authRefreshBodyFromFlags(flags), {
      endpoint: endpointDefinitionById('auth.oauth.refresh')
    }));
    return;
  }

  if (action === 'introspect') {
    printJson(await guardedExternalNoAuthFormFetch(portal, 'POST', new URL('/oauth/2026-03/token/introspect', portal.baseUrl), flags, authIntrospectBodyFromFlags(flags), {
      endpoint: endpointDefinitionById('auth.oauth.introspect'),
      readOnly: true
    }));
    return;
  }

  if (action === 'revoke') {
    if (!boolFlag(flags, 'danger-revoke-token')) fail('auth revoke requires --danger-revoke-token.');
    printJson(await guardedExternalNoAuthFormFetch(portal, 'POST', new URL('/oauth/2026-03/token/revoke', portal.baseUrl), flags, authRevokeBodyFromFlags(flags), {
      endpoint: endpointDefinitionById('auth.oauth.revoke')
    }));
    return;
  }

  fail(`Unknown auth action: ${action}`);
}

async function runCrm(portal, action, rest, flags) {
  if (action === 'object-types') {
    printJson(crmObjectTypesFromFlags(flags));
    return;
  }

  const objectType = rest[0];
  if (!objectType) fail('Missing CRM object type.');

  if (action === 'list') {
    const queryFlags = { ...flags };
    queryFlags.query = values(queryFlags.query).filter((item) => String(item).split('=')[0] !== 'limit');
    queryFlags.query.push(`limit=${boolFlag(flags, 'count-only') ? 1 : (flags.limit || 10)}`);
    if (boolFlag(flags, 'archived')) queryFlags.query.push('archived=true');
    if (!boolFlag(flags, 'count-only')) {
      for (const property of parsePropertiesList(flags.properties)) {
        queryFlags.query.push(`properties=${property}`);
      }
    }
    const result = boolFlag(flags, 'paginate') && !boolFlag(flags, 'count-only')
      ? await collectPages(portal, 'GET', `/crm/objects/2026-03/${pathPart(objectType)}`, queryFlags)
      : await hubspotFetch(portal, 'GET', `/crm/objects/2026-03/${pathPart(objectType)}`, queryFlags);
    printJson(boolFlag(flags, 'count-only')
      ? crmCountOutput(portal, objectType, 'crm.list', crmQuerySummaryFromListFlags(flags), result.data, 1)
      : result);
    return;
  }

  if (action === 'get') {
    const id = rest[1];
    if (!id) fail('crm get requires object id.');
    const queryFlags = { ...flags, query: values(flags.query) };
    for (const property of parsePropertiesList(flags.properties)) {
      queryFlags.query.push(`properties=${property}`);
    }
    for (const property of parsePropertiesList(flags['properties-with-history'])) {
      queryFlags.query.push(`propertiesWithHistory=${property}`);
    }
    if (flags['id-property']) queryFlags.query.push(`idProperty=${flags['id-property']}`);
    const result = await hubspotFetch(portal, 'GET', `/crm/objects/2026-03/${pathPart(objectType)}/${pathPart(id)}`, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'search') {
    const countOnly = boolFlag(flags, 'count-only');
    const { body, criteria } = crmSearchRequestFromFlags(
      countOnly ? { ...flags, limit: 1 } : flags,
      countOnly ? { defaultLimit: 1, includeProperties: false, includePropertiesWithHistory: false } : {}
    );
    const result = await hubspotFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/search`, flags, body);
    printJson(countOnly
      ? crmCountOutput(portal, objectType, 'crm.search', crmQuerySummaryFromSearchCriteria(criteria), result.data, 1)
      : result);
    return;
  }

  if (action === 'count') {
    const countFlags = { ...flags, limit: 1 };
    const { body, criteria } = crmSearchRequestFromFlags(countFlags, {
      commandName: 'crm count',
      defaultAllFilter: true,
      defaultLimit: 1,
      includeProperties: false
    });
    const result = await hubspotFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/search`, flags, body);
    printJson(crmCountOutput(portal, objectType, 'crm.search', crmQuerySummaryFromSearchCriteria(criteria), result.data, 1));
    return;
  }

  if (action === 'exists') {
    const existsFlags = { ...flags, limit: 1 };
    const { body, criteria } = crmSearchRequestFromFlags(existsFlags, {
      commandName: 'crm exists',
      defaultLimit: 1,
      includeProperties: false
    });
    const result = await hubspotFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/search`, flags, body);
    const countOutput = crmCountOutput(portal, objectType, 'crm.search', crmQuerySummaryFromSearchCriteria(criteria), result.data, 1);
    printJson({
      ok: true,
      portal: portal.name,
      objectType,
      source: 'crm.search',
      ...crmQuerySummaryFromSearchCriteria(criteria),
      exists: countOutput.count === null ? null : countOutput.count > 0,
      count: countOutput.count,
      countType: countOutput.countType,
      countSource: countOutput.countSource
    });
    return;
  }

  if (action === 'find-one') {
    const findFlags = { ...flags, limit: 1 };
    const { body, criteria } = crmSearchRequestFromFlags(findFlags, {
      commandName: 'crm find-one',
      defaultLimit: 1
    });
    const result = await hubspotFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/search`, flags, body);
    const countOutput = crmCountOutput(portal, objectType, 'crm.search', crmQuerySummaryFromSearchCriteria(criteria), result.data, 1);
    const properties = parsePropertiesList(flags.properties);
    const output = {
      ok: true,
      portal: portal.name,
      objectType,
      source: 'crm.search',
      ...crmQuerySummaryFromSearchCriteria(criteria),
      found: Boolean(firstCrmResult(result.data)),
      count: countOutput.count,
      countType: countOutput.countType,
      countSource: countOutput.countSource,
      record: firstCrmResult(result.data)
    };
    if (properties.length) output.properties = properties;
    printJson(output);
    return;
  }

  if (action === 'create') {
    const body = recordCreateBodyFromFlags(flags);
    printJson(await guardedFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}`, flags, body));
    return;
  }

  if (action === 'batch-read') {
    const body = batchReadBodyFromFlags(flags);
    const result = await hubspotFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/batch/read`, flags, body);
    printJson(result);
    return;
  }

  if (action === 'batch-create') {
    const body = batchWriteBodyFromFlags(flags, 'crm batch-create');
    printJson(await guardedFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/batch/create`, flags, body));
    return;
  }

  if (action === 'batch-update') {
    const body = batchWriteBodyFromFlags(flags, 'crm batch-update', { allowIdProperty: true });
    printJson(await guardedFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/batch/update`, flags, body));
    return;
  }

  if (action === 'batch-upsert') {
    const body = batchWriteBodyFromFlags(flags, 'crm batch-upsert', { allowIdProperty: true });
    printJson(await guardedFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/batch/upsert`, flags, body));
    return;
  }

  if (action === 'batch-archive') {
    const body = batchArchiveBodyFromFlags(flags);
    printJson(await guardedFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/batch/archive`, flags, body));
    return;
  }

  if (action === 'update') {
    const id = rest[1];
    if (!id) fail('crm update requires object id.');
    const properties = assertObjectBody(parseBody(flags.properties), 'crm update --properties');
    const body = { properties };
    const target = `/crm/objects/2026-03/${pathPart(objectType)}/${pathPart(id)}`;
    if (!boolFlag(flags, 'yes') && !boolFlag(flags, 'show-request')) previewMutation(portal, 'PATCH', target, body);
    const result = await hubspotFetch(portal, 'PATCH', target, flags, body);
    printJson(result);
    return;
  }

  if (action === 'archive') {
    const id = rest[1];
    if (!id) fail('crm archive requires object id.');
    printJson(await guardedFetch(portal, 'DELETE', `/crm/objects/2026-03/${pathPart(objectType)}/${pathPart(id)}`, flags));
    return;
  }

  if (action === 'merge') {
    if (!boolFlag(flags, 'danger-merge')) {
      fail('crm merge requires --danger-merge plus --yes.');
    }
    const body = mergeBodyFromFlags(flags, rest[1], rest[2]);
    printJson(await guardedFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/merge`, flags, body));
    return;
  }

  if (action === 'gdpr-delete') {
    if (!boolFlag(flags, 'danger-gdpr-delete')) {
      fail('crm gdpr-delete requires --danger-gdpr-delete plus --yes.');
    }
    const body = gdprDeleteBodyFromFlags(flags, rest[1]);
    printJson(await guardedFetch(portal, 'POST', `/crm/objects/2025-09/${pathPart(objectType)}/gdpr-delete`, flags, body));
    return;
  }

  fail(`Unknown crm action: ${action}`);
}

async function runProperties(portal, action, rest, flags) {
  const objectType = rest[0];
  if (!objectType) fail('Missing object type.');
  const base = `/crm/properties/2026-03/${pathPart(objectType)}`;

  if (action === 'list' || action === 'names') {
    const result = await hubspotFetch(portal, 'GET', base, flags);
    if (action === 'names' || boolFlag(flags, 'names-only')) {
      const names = result.data && Array.isArray(result.data.results)
        ? result.data.results.map((property) => property.name).sort()
        : [];
      printJson({ ok: true, portal: portal.name, objectType, count: names.length, names });
    } else {
      printJson(result);
    }
    return;
  }

  if (action === 'get') {
    const propertyName = rest[1];
    if (!propertyName) fail('properties get requires property name.');
    const result = await hubspotFetch(portal, 'GET', `${base}/${pathPart(propertyName)}`, flags);
    printJson(result);
    return;
  }

  if (action === 'create') {
    const body = propertyDefinitionBodyFromFlags(flags, { requireCreateFields: true });
    printJson(await guardedFetch(portal, 'POST', base, flags, body));
    return;
  }

  if (action === 'update') {
    const propertyName = rest[1];
    if (!propertyName) fail('properties update requires <objectType> <propertyName>.');
    const body = propertyDefinitionBodyFromFlags(flags);
    if (!Object.keys(body).length) fail('properties update requires --body or at least one property definition flag.');
    printJson(await guardedFetch(portal, 'PATCH', `${base}/${pathPart(propertyName)}`, flags, body));
    return;
  }

  if (action === 'archive' || action === 'delete') {
    const propertyName = rest[1];
    if (!propertyName) fail(`properties ${action} requires <objectType> <propertyName>.`);
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(propertyName)}`, flags));
    return;
  }

  fail(`Unknown properties action: ${action}`);
}

async function runAssociations(portal, action, rest, flags) {
  const [fromType, second, third, fourth] = rest;
  if (!fromType || !second) fail('Missing association arguments.');

  if (action === 'types') {
    const toType = second;
    const result = await hubspotFetch(portal, 'GET', `/crm/associations/2026-03/${pathPart(fromType)}/${pathPart(toType)}/labels`, flags, undefined, endpointDefinitionById('associations.labels'));
    printJson(result);
    return;
  }

  if (action === 'list') {
    const fromId = second;
    const toType = third;
    if (!toType) fail('associations list requires <fromType> <fromId> <toType>.');
    const queryFlags = { ...flags, query: values(flags.query) };
    queryFlags.query.push(`limit=${flags.limit || 100}`);
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', `/crm/objects/2026-03/${pathPart(fromType)}/${pathPart(fromId)}/associations/${pathPart(toType)}`, queryFlags)
      : await hubspotFetch(portal, 'GET', `/crm/objects/2026-03/${pathPart(fromType)}/${pathPart(fromId)}/associations/${pathPart(toType)}`, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'create-default') {
    const fromId = second;
    const toType = third;
    const toId = fourth;
    if (!toType || !toId) fail('associations create-default requires <fromType> <fromId> <toType> <toId>.');
    printJson(await guardedFetch(portal, 'PUT', `/crm/objects/2026-03/${pathPart(fromType)}/${pathPart(fromId)}/associations/default/${pathPart(toType)}/${pathPart(toId)}`, flags));
    return;
  }

  if (action === 'create') {
    const fromId = second;
    const toType = third;
    const toId = fourth;
    if (!toType || !toId) fail('associations create requires <fromType> <fromId> <toType> <toId>.');
    const body = associationTypesBodyFromFlags(flags);
    printJson(await guardedFetch(portal, 'PUT', `/crm/objects/2026-03/${pathPart(fromType)}/${pathPart(fromId)}/associations/${pathPart(toType)}/${pathPart(toId)}`, flags, body));
    return;
  }

  if (action === 'delete' || action === 'archive') {
    const fromId = second;
    const toType = third;
    const toId = fourth;
    if (!toType || !toId) fail(`associations ${action} requires <fromType> <fromId> <toType> <toId>.`);
    printJson(await guardedFetch(portal, 'DELETE', `/crm/objects/2026-03/${pathPart(fromType)}/${pathPart(fromId)}/associations/${pathPart(toType)}/${pathPart(toId)}`, flags));
    return;
  }

  if (action === 'batch-read') {
    const toType = second;
    const body = { inputs: parseIdInputs(flags.ids, 'ids') };
    const result = await hubspotFetch(portal, 'POST', `/crm/associations/2026-03/${pathPart(fromType)}/${pathPart(toType)}/batch/read`, flags, body);
    printJson(result);
    return;
  }

  if (action === 'batch-create-default') {
    const toType = second;
    const body = associationBatchBodyFromFlags(flags, 'associations batch-create-default');
    printJson(await guardedFetch(portal, 'POST', `/crm/associations/2026-03/${pathPart(fromType)}/${pathPart(toType)}/batch/associate/default`, flags, body));
    return;
  }

  if (action === 'batch-create') {
    const toType = second;
    const body = associationBatchBodyFromFlags(flags, 'associations batch-create');
    printJson(await guardedFetch(portal, 'POST', `/crm/associations/2026-03/${pathPart(fromType)}/${pathPart(toType)}/batch/create`, flags, body));
    return;
  }

  if (action === 'batch-archive') {
    const toType = second;
    const body = associationBatchBodyFromFlags(flags, 'associations batch-archive');
    printJson(await guardedFetch(portal, 'POST', `/crm/associations/2026-03/${pathPart(fromType)}/${pathPart(toType)}/batch/archive`, flags, body));
    return;
  }

  if (action === 'batch-labels-archive') {
    const toType = second;
    const body = associationBatchBodyFromFlags(flags, 'associations batch-labels-archive');
    printJson(await guardedFetch(portal, 'POST', `/crm/associations/2026-03/${pathPart(fromType)}/${pathPart(toType)}/batch/labels/archive`, flags, body));
    return;
  }

  fail(`Unknown associations action: ${action}`);
}

async function runAccount(portal, action, flags) {
  if (action === 'details') {
    printJson(await hubspotFetch(portal, 'GET', '/account-info/2026-03/details', flags));
    return;
  }

  if (action === 'usage') {
    printJson(await hubspotFetch(portal, 'GET', '/account-info/2026-03/api-usage/daily/private-apps', flags));
    return;
  }

  if (action === 'subscription') {
    const account = await hubspotFetch(portal, 'GET', '/account-info/2026-03/details', flags);
    printJson({
      ok: true,
      portal: portal.name,
      label: portal.label,
      portalId: portal.portalId,
      accountType: account.data && account.data.accountType ? account.data.accountType : null,
      knownPlanLabel: portal.knownPlanLabel,
      knownPlanSource: portal.knownPlanSource,
      note: 'HubSpot account-info exposes portal/account metadata, but not a complete Starter/Pro/Enterprise bundle field. Use the tier matrix plus enabled features to infer what is available.',
      data: account.data
    });
    return;
  }

  fail(`Unknown account action: ${action}`);
}

async function runTiers(portal, action, flags) {
  const tiersData = loadTiersData();

  if (action === 'products') {
    const products = (tiersData.products || []).map((product) => ({
      hub: product.hub || null,
      tiers: product.tiers || [],
      featureCount: Array.isArray(product.features) ? product.features.length : 0
    }));
    printJson({
      ok: true,
      sourceUrl: tiersData.sourceUrl || null,
      generatedAt: tiersData.generatedAt || null,
      note: tiersData.note || null,
      products
    });
    return;
  }

  if (action === 'apis') {
    const requestedTier = normalizeTierName(flags.tier || portal.knownPlanLabel || 'starter');
    if (!requestedTier) fail('tiers apis requires a valid --tier free|starter|pro|enterprise or a portal known plan.');
    const hubFilter = flags.hub ? String(flags.hub).trim().toLowerCase() : null;
    const includeGlobal = boolFlag(flags, 'include-global') || hubFilter === 'free';
    const products = extractFeaturesByTier(tiersData, requestedTier, hubFilter, { includeGlobal });
    printJson({
      ok: true,
      sourceUrl: tiersData.sourceUrl || null,
      generatedAt: tiersData.generatedAt || null,
      requestedTier,
      hubFilter,
      globalApiSurface: hubFilter ? undefined : globalApiSurfaceSummary(tiersData),
      products
    });
    return;
  }

  if (action === 'portal') {
    const account = await hubspotFetch(portal, 'GET', '/account-info/2026-03/details', flags);
    const inferredTier = normalizeTierName(portal.knownPlanLabel);
    const productTierApis = inferredTier ? extractFeaturesByTier(tiersData, inferredTier, null, { includeGlobal: false }) : [];
    printJson({
      ok: true,
      portal: {
        name: portal.name,
        label: portal.label,
        portalId: portal.portalId,
        accountType: account.data && account.data.accountType ? account.data.accountType : null,
        knownPlanLabel: portal.knownPlanLabel,
        knownPlanSource: portal.knownPlanSource
      },
      note: tier403Note(),
      inferredTier,
      globalApiSurface: globalApiSurfaceSummary(tiersData),
      productTierApis,
      account: account.data
    });
    return;
  }

  fail(`Unknown tiers action: ${action}`);
}

async function runPropertyGroups(portal, action, rest, flags) {
  const objectType = rest[0];
  if (!objectType) fail('property-groups requires <objectType>.');
  const base = `/crm/properties/2026-03/${pathPart(objectType)}/groups`;

  if (action === 'list') {
    printJson(await hubspotFetch(portal, 'GET', base, flags));
    return;
  }

  if (action === 'create') {
    const body = {
      name: requireFlag(flags, 'name'),
      label: requireFlag(flags, 'label')
    };
    const displayOrder = optionalNumber(flags['display-order']);
    if (displayOrder !== undefined) body.displayOrder = displayOrder;
    printJson(await guardedFetch(portal, 'POST', base, flags, body));
    return;
  }

  if (action === 'update') {
    const groupName = rest[1];
    if (!groupName) fail('property-groups update requires <objectType> <groupName>.');
    const body = bodyFromFlags(flags, ['label']);
    if (!Object.keys(body).length) fail('property-groups update needs at least one field.');
    printJson(await guardedFetch(portal, 'PATCH', `${base}/${pathPart(groupName)}`, flags, body));
    return;
  }

  if (action === 'archive' || action === 'delete') {
    const groupName = rest[1];
    if (!groupName) fail(`property-groups ${action} requires <objectType> <groupName>.`);
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(groupName)}`, flags));
    return;
  }

  fail(`Unknown property-groups action: ${action}`);
}

async function runPropertyValidations(portal, action, rest, flags) {
  const [objectType, propertyName, ruleType] = rest;
  if (!objectType) fail('property-validations requires <objectType>.');

  if (action === 'list') {
    printJson(await hubspotFetch(portal, 'GET', `/crm/property-validations/2026-03/${pathPart(objectType)}`, flags));
    return;
  }

  if (action === 'set') {
    if (!propertyName || !ruleType) {
      fail('property-validations set requires <objectType> <propertyName> <ruleType>.');
    }
    const ruleArguments = parseBody(requireFlag(flags, 'arguments'));
    const body = {
      ruleArguments,
      shouldApplyNormalization: boolFlag(flags, 'normalize') || undefined
    };
    printJson(await guardedFetch(
      portal,
      'PUT',
      `/crm/property-validations/2026-03/${pathPart(objectType)}/${pathPart(propertyName)}/rule-type/${pathPart(ruleType)}`,
      flags,
      body
    ));
    return;
  }

  fail(`Unknown property-validations action: ${action}`);
}

async function runSchemas(portal, action, rest, flags) {
  const base = '/crm-object-schemas/2026-03/schemas';

  if (action === 'list') {
    printJson(await hubspotFetch(portal, 'GET', base, flags));
    return;
  }

  if (action === 'get') {
    const objectType = rest[0];
    if (!objectType) fail('schemas get requires <objectTypeId|fullyQualifiedName>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(objectType)}`, flags));
    return;
  }

  if (action === 'create') {
    const body = parseBody(flags.body || flags.schema);
    if (!body) fail('schemas create requires --body <json|@file>.');
    printJson(await guardedFetch(portal, 'POST', base, flags, body));
    return;
  }

  if (action === 'update') {
    const objectType = rest[0];
    if (!objectType) fail('schemas update requires <objectTypeId>.');
    const body = parseBody(flags.body || flags.schema);
    if (!body) fail('schemas update requires --body <json|@file>.');
    printJson(await guardedFetch(portal, 'PATCH', `${base}/${pathPart(objectType)}`, flags, body));
    return;
  }

  if (action === 'delete') {
    const objectType = rest[0];
    if (!objectType) fail('schemas delete requires <objectTypeId>.');
    if (!boolFlag(flags, 'danger-archive-schema')) {
      fail('schemas delete requires --danger-archive-schema plus --yes.');
    }
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(objectType)}`, flags));
    return;
  }

  fail(`Unknown schemas action: ${action}`);
}

async function runObjectLibrary(portal, action, rest, flags) {
  if (action === 'status') {
    const objectType = rest[0];
    const target = objectType
      ? `/crm/v3/object-library/enablement/${pathPart(objectType)}`
      : '/crm/v3/object-library/enablement';
    printJson(await hubspotFetch(portal, 'GET', target, flags));
    return;
  }

  fail(`Unknown object-library action: ${action}`);
}

async function runAssociationLabels(portal, action, rest, flags) {
  const [fromType, toType, typeId] = rest;
  if (!fromType || !toType) fail('association-labels requires <fromType> <toType>.');
  const base = `/crm/associations/2026-03/${pathPart(fromType)}/${pathPart(toType)}/labels`;

  if (action === 'list') {
    printJson(await hubspotFetch(portal, 'GET', base, flags));
    return;
  }

  if (action === 'create') {
    const body = {
      name: requireFlag(flags, 'name'),
      label: requireFlag(flags, 'label')
    };
    if (flags['inverse-label']) body.inverseLabel = flags['inverse-label'];
    printJson(await guardedFetch(portal, 'POST', base, flags, body));
    return;
  }

  if (action === 'update') {
    if (!typeId) fail('association-labels update requires <fromType> <toType> <typeId>.');
    const body = {
      associationTypeId: Number(typeId),
      label: requireFlag(flags, 'label')
    };
    if (flags['inverse-label']) body.inverseLabel = flags['inverse-label'];
    printJson(await guardedFetch(portal, 'PUT', base, flags, body));
    return;
  }

  if (action === 'delete') {
    if (!typeId) fail('association-labels delete requires <fromType> <toType> <typeId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(typeId)}`, flags));
    return;
  }

  fail(`Unknown association-labels action: ${action}`);
}

async function runAssociationLimits(portal, action, rest, flags) {
  const [fromType, toType] = rest;
  if (!fromType || !toType) fail('association-limits requires <fromType> <toType>.');
  const base = `/crm/associations/2026-03/definitions/configurations/${pathPart(fromType)}/${pathPart(toType)}`;

  if (action === 'list') {
    printJson(await hubspotFetch(portal, 'GET', base, flags));
    return;
  }

  if (action === 'create' || action === 'update' || action === 'delete' || action === 'purge') {
    const isDelete = action === 'delete' || action === 'purge';
    const body = associationLimitBodyFromFlags(flags, { requireMax: !isDelete });
    const suffix = isDelete
      ? 'batch/purge'
      : action === 'create' ? 'batch/create' : 'batch/update';
    printJson(await guardedFetch(portal, 'POST', `${base}/${suffix}`, flags, body));
    return;
  }

  fail(`Unknown association-limits action: ${action}`);
}

async function runPipelines(portal, action, rest, flags) {
  const objectType = rest[0];
  if (!objectType) fail('pipelines requires <objectType>.');
  const base = `/crm/pipelines/2026-03/${pathPart(objectType)}`;

  if (action === 'list') {
    printJson(await hubspotFetch(portal, 'GET', base, flags));
    return;
  }

  if (action === 'get') {
    const pipelineId = rest[1];
    if (!pipelineId) fail('pipelines get requires <objectType> <pipelineId>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(pipelineId)}`, flags));
    return;
  }

  if (action === 'create') {
    const body = parseBody(flags.body);
    if (!body) fail('pipelines create requires --body <json|@file>.');
    printJson(await guardedFetch(portal, 'POST', base, flags, body));
    return;
  }

  if (action === 'update') {
    const pipelineId = rest[1];
    if (!pipelineId) fail('pipelines update requires <objectType> <pipelineId>.');
    const body = parseBody(flags.body) || bodyFromFlags(flags, ['label']);
    if (!Object.keys(body).length) fail('pipelines update needs --body or --label.');
    printJson(await guardedFetch(portal, 'PATCH', `${base}/${pathPart(pipelineId)}`, flags, body));
    return;
  }

  if (action === 'delete') {
    const pipelineId = rest[1];
    if (!pipelineId) fail('pipelines delete requires <objectType> <pipelineId>.');
    const queryFlags = { ...flags, query: values(flags.query) };
    if (boolFlag(flags, 'validate-references')) queryFlags.query.push('validateReferencesBeforeDelete=true');
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(pipelineId)}`, queryFlags));
    return;
  }

  if (action === 'stages') {
    const pipelineId = rest[1];
    if (!pipelineId) fail('pipelines stages requires <objectType> <pipelineId>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(pipelineId)}/stages`, flags));
    return;
  }

  if (action === 'stage-create') {
    const pipelineId = rest[1];
    if (!pipelineId) fail('pipelines stage-create requires <objectType> <pipelineId>.');
    const body = pipelineStageBodyFromFlags(flags, { requireCreateFields: true });
    printJson(await guardedFetch(portal, 'POST', `${base}/${pathPart(pipelineId)}/stages`, flags, body));
    return;
  }

  if (action === 'stage-update') {
    const [pipelineId, stageId] = [rest[1], rest[2]];
    if (!pipelineId || !stageId) fail('pipelines stage-update requires <objectType> <pipelineId> <stageId>.');
    const body = pipelineStageBodyFromFlags(flags);
    if (!Object.keys(body).length) fail('pipelines stage-update requires --body or at least one stage field.');
    printJson(await guardedFetch(portal, 'PATCH', `${base}/${pathPart(pipelineId)}/stages/${pathPart(stageId)}`, flags, body));
    return;
  }

  if (action === 'stage-delete') {
    const [pipelineId, stageId] = [rest[1], rest[2]];
    if (!pipelineId || !stageId) fail('pipelines stage-delete requires <objectType> <pipelineId> <stageId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(pipelineId)}/stages/${pathPart(stageId)}`, flags));
    return;
  }

  if (action === 'stage-audit') {
    const [pipelineId, stageId] = [rest[1], rest[2]];
    if (!pipelineId || !stageId) fail('pipelines stage-audit requires <objectType> <pipelineId> <stageId>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(pipelineId)}/stages/${pathPart(stageId)}/audit`, flags));
    return;
  }

  fail(`Unknown pipelines action: ${action}`);
}

async function runLists(portal, action, rest, flags) {
  const base = '/crm/lists/2026-03';

  if (action === 'search') {
    const body = listSearchBodyFromFlags(flags);
    printJson(await hubspotFetch(portal, 'POST', `${base}/search`, flags, body));
    return;
  }

  if (action === 'get') {
    const listId = rest[0];
    if (!listId) fail('lists get requires <listId>.');
    const queryFlags = { ...flags, query: values(flags.query) };
    if (boolFlag(flags, 'include-filters')) queryFlags.query.push('includeFilters=true');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(listId)}`, queryFlags));
    return;
  }

  if (action === 'get-by-name') {
    const [objectTypeId, listName] = rest;
    if (!objectTypeId || !listName) fail('lists get-by-name requires <objectTypeId> <listName>.');
    const queryFlags = { ...flags, query: values(flags.query) };
    if (boolFlag(flags, 'include-filters')) queryFlags.query.push('includeFilters=true');
    printJson(await hubspotFetch(portal, 'GET', `${base}/object-type-id/${pathPart(objectTypeId)}/name/${pathPart(listName)}`, queryFlags));
    return;
  }

  if (action === 'create') {
    const body = listCreateBodyFromFlags(flags);
    printJson(await guardedFetch(portal, 'POST', base, flags, body));
    return;
  }

  if (action === 'update-name') {
    const listId = rest[0];
    if (!listId) fail('lists update-name requires <listId>.');
    const queryFlags = { ...flags, query: values(flags.query) };
    queryFlags.query.push(`listName=${requireFlag(flags, 'name')}`);
    if (boolFlag(flags, 'include-filters')) queryFlags.query.push('includeFilters=true');
    printJson(await guardedFetch(portal, 'PUT', `${base}/${pathPart(listId)}/update-list-name`, queryFlags));
    return;
  }

  if (action === 'delete') {
    const listId = rest[0];
    if (!listId) fail('lists delete requires <listId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(listId)}`, flags));
    return;
  }

  if (action === 'restore') {
    const listId = rest[0];
    if (!listId) fail('lists restore requires <listId>.');
    printJson(await guardedFetch(portal, 'PUT', `${base}/${pathPart(listId)}/restore`, flags));
    return;
  }

  if (action === 'memberships') {
    const listId = rest[0];
    if (!listId) fail('lists memberships requires <listId>.');
    const queryFlags = { ...flags, query: values(flags.query) };
    queryFlags.query.push(`limit=${flags.limit || 100}`);
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(listId)}/memberships`, queryFlags));
    return;
  }

  if (action === 'membership-update') {
    const listId = rest[0];
    if (!listId) fail('lists membership-update requires <listId>.');
    const body = listMembershipBodyFromFlags(flags);
    printJson(await guardedFetch(portal, 'PUT', `${base}/${pathPart(listId)}/memberships/add-and-remove`, flags, body));
    return;
  }

  if (action === 'memberships-clear') {
    const listId = rest[0];
    if (!listId) fail('lists memberships-clear requires <listId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(listId)}/memberships`, flags));
    return;
  }

  if (action === 'record-memberships') {
    const [objectTypeId, recordId] = rest;
    if (!objectTypeId || !recordId) fail('lists record-memberships requires <objectTypeId> <recordId>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/records/${pathPart(objectTypeId)}/${pathPart(recordId)}/memberships`, flags));
    return;
  }

  fail(`Unknown lists action: ${action}`);
}

async function runExports(portal, action, rest, flags) {
  const base = '/crm/exports/2026-03/export';

  if (action === 'start') {
    const body = exportStartBodyFromFlags(flags);
    printJson(await guardedFetch(portal, 'POST', `${base}/async`, flags, body));
    return;
  }

  if (action === 'get') {
    const exportId = rest[0];
    if (!exportId) fail('exports get requires <exportId>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(exportId)}`, flags));
    return;
  }

  if (action === 'status') {
    const taskId = rest[0];
    if (!taskId) fail('exports status requires <taskId>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/async/tasks/${pathPart(taskId)}/status`, flags));
    return;
  }

  fail(`Unknown exports action: ${action}`);
}

async function runImports(portal, action, rest, flags) {
  const base = '/crm/imports/2026-03';

  if (action === 'list') {
    const queryFlags = { ...flags, query: values(flags.query) };
    if (flags.limit !== undefined) queryFlags.query.push(`limit=${flags.limit}`);
    if (flags.after !== undefined) queryFlags.query.push(`after=${flags.after}`);
    printJson(await hubspotFetch(portal, 'GET', base, queryFlags));
    return;
  }

  if (action === 'get') {
    const importId = rest[0];
    if (!importId) fail('imports get requires <importId>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(importId)}`, flags));
    return;
  }

  if (action === 'errors') {
    const importId = rest[0];
    if (!importId) fail('imports errors requires <importId>.');
    const queryFlags = { ...flags, query: values(flags.query) };
    if (flags.limit !== undefined) queryFlags.query.push(`limit=${flags.limit}`);
    if (flags.after !== undefined) queryFlags.query.push(`after=${flags.after}`);
    if (flags['include-error-message'] !== undefined) queryFlags.query.push(`includeErrorMessage=${boolFlag(flags, 'include-error-message')}`);
    if (flags['include-row-data'] !== undefined) queryFlags.query.push(`includeRowData=${boolFlag(flags, 'include-row-data')}`);
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(importId)}/errors`, queryFlags));
    return;
  }

  if (action === 'cancel') {
    const importId = rest[0];
    if (!importId) fail('imports cancel requires <importId>.');
    printJson(await guardedFetch(portal, 'POST', `${base}/${pathPart(importId)}/cancel`, flags));
    return;
  }

  if (action === 'start') {
    const { form, previewBody } = importMultipartFromFlags(flags);
    printJson(await guardedMultipartFetch(portal, 'POST', base, flags, form, previewBody));
    return;
  }

  fail(`Unknown imports action: ${action}`);
}

async function runSubscriptions(portal, action, rest, flags) {
  const base = '/communication-preferences/2026-03';

  if (action === 'definitions') {
    const queryFlags = subscriptionQueryFlags(flags);
    printJson(await hubspotFetch(portal, 'GET', `${base}/definitions`, queryFlags));
    return;
  }

  if (action === 'status') {
    const subscriberIdString = rest[0] || flags.email || flags['subscriber-id-string'];
    if (!subscriberIdString) fail('subscriptions status requires <email>.');
    const queryFlags = subscriptionQueryFlags(flags, { defaultChannel: 'EMAIL' });
    printJson(await hubspotFetch(portal, 'GET', `${base}/statuses/${pathPart(subscriberIdString)}`, queryFlags));
    return;
  }

  if (action === 'unsubscribe-all-status') {
    const subscriberIdString = rest[0] || flags.email || flags['subscriber-id-string'];
    if (!subscriberIdString) fail('subscriptions unsubscribe-all-status requires <email>.');
    const queryFlags = subscriptionQueryFlags(flags);
    printJson(await hubspotFetch(portal, 'GET', `${base}/statuses/${pathPart(subscriberIdString)}/unsubscribe-all`, queryFlags));
    return;
  }

  if (action === 'set-status') {
    const subscriberIdString = rest[0] || flags.email || flags['subscriber-id-string'];
    if (!subscriberIdString) fail('subscriptions set-status requires <email>.');
    const body = subscriptionStatusBodyFromFlags(flags);
    printJson(await guardedFetch(portal, 'POST', `${base}/statuses/${pathPart(subscriberIdString)}`, flags, body));
    return;
  }

  if (action === 'unsubscribe-all') {
    const subscriberIdString = rest[0] || flags.email || flags['subscriber-id-string'];
    if (!subscriberIdString) fail('subscriptions unsubscribe-all requires <email>.');
    const queryFlags = subscriptionQueryFlags(flags);
    printJson(await guardedFetch(portal, 'POST', `${base}/statuses/${pathPart(subscriberIdString)}/unsubscribe-all`, queryFlags));
    return;
  }

  if (action === 'batch-read') {
    const queryFlags = subscriptionQueryFlags(flags, { defaultChannel: 'EMAIL' });
    const body = subscriptionBatchEmailsBodyFromFlags(flags, 'subscriptions batch-read');
    printJson(await guardedFetch(portal, 'POST', `${base}/statuses/batch/read`, queryFlags, body, { readOnly: true }));
    return;
  }

  if (action === 'batch-unsubscribe-all-read') {
    const queryFlags = subscriptionQueryFlags(flags, { defaultChannel: 'EMAIL' });
    const body = subscriptionBatchEmailsBodyFromFlags(flags, 'subscriptions batch-unsubscribe-all-read');
    printJson(await guardedFetch(portal, 'POST', `${base}/statuses/batch/unsubscribe-all/read`, queryFlags, body, { readOnly: true }));
    return;
  }

  if (action === 'batch-unsubscribe-all') {
    const queryFlags = subscriptionQueryFlags(flags, { defaultChannel: 'EMAIL' });
    const body = subscriptionBatchEmailsBodyFromFlags(flags, 'subscriptions batch-unsubscribe-all');
    printJson(await guardedFetch(portal, 'POST', `${base}/statuses/batch/unsubscribe-all`, queryFlags, body));
    return;
  }

  if (action === 'batch-write') {
    const queryFlags = subscriptionQueryFlags(flags);
    const body = batchWriteBodyFromFlags(flags, 'subscriptions batch-write');
    printJson(await guardedFetch(portal, 'POST', `${base}/statuses/batch/write`, queryFlags, body));
    return;
  }

  if (action === 'generate-links') {
    const queryFlags = subscriptionQueryFlags(flags, { defaultChannel: 'EMAIL' });
    const body = subscriptionGenerateLinksBodyFromFlags(rest[0], flags);
    printJson(await guardedFetch(portal, 'POST', '/communication-preferences/v4/links/generate', queryFlags, body, { readOnly: true }));
    return;
  }

  fail(`Unknown subscriptions action: ${action}`);
}

async function runFiles(portal, action, rest, flags) {
  const filesBase = '/files/2026-03/files';
  const foldersBase = '/files/2026-03/folders';

  if (action === 'search') {
    const queryFlags = fileSearchQueryFlags(flags);
    const target = `${filesBase}/search`;
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', target, queryFlags)
      : await hubspotFetch(portal, 'GET', target, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'get') {
    const fileId = rest[0];
    if (!fileId) fail('files get requires <fileId>.');
    printJson(await hubspotFetch(portal, 'GET', `${filesBase}/${pathPart(fileId)}`, propertiesQueryFlags(flags)));
    return;
  }

  if (action === 'signed-url') {
    const fileId = rest[0];
    if (!fileId) fail('files signed-url requires <fileId>.');
    printJson(await hubspotFetch(portal, 'GET', `${filesBase}/${pathPart(fileId)}/signed-url`, propertiesQueryFlags(flags, 'property')));
    return;
  }

  if (action === 'upload') {
    const { form, previewBody } = fileMultipartFromFlags(flags, 'files upload', { requireFolder: true });
    printJson(await guardedMultipartFetch(portal, 'POST', filesBase, flags, form, previewBody));
    return;
  }

  if (action === 'replace') {
    const fileId = rest[0];
    if (!fileId) fail('files replace requires <fileId>.');
    const { form, previewBody } = fileMultipartFromFlags(flags, 'files replace');
    printJson(await guardedMultipartFetch(portal, 'PUT', `${filesBase}/${pathPart(fileId)}`, flags, form, previewBody));
    return;
  }

  if (action === 'update') {
    const fileId = rest[0];
    if (!fileId) fail('files update requires <fileId>.');
    printJson(await guardedFetch(portal, 'PATCH', `${filesBase}/${pathPart(fileId)}`, flags, fileUpdateBodyFromFlags(flags)));
    return;
  }

  if (action === 'import-url') {
    printJson(await guardedFetch(portal, 'POST', `${filesBase}/import-from-url/async`, flags, fileImportUrlBodyFromFlags(flags)));
    return;
  }

  if (action === 'import-status') {
    const taskId = rest[0];
    if (!taskId) fail('files import-status requires <taskId>.');
    printJson(await hubspotFetch(portal, 'GET', `${filesBase}/import-from-url/async/tasks/${pathPart(taskId)}/status`, flags));
    return;
  }

  if (action === 'delete') {
    const fileId = rest[0];
    if (!fileId) fail('files delete requires <fileId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${filesBase}/${pathPart(fileId)}`, flags));
    return;
  }

  if (action === 'gdpr-delete') {
    const fileId = rest[0];
    if (!fileId) fail('files gdpr-delete requires <fileId>.');
    if (!boolFlag(flags, 'danger-gdpr-delete')) {
      fail('files gdpr-delete requires --danger-gdpr-delete plus --yes.');
    }
    printJson(await guardedFetch(portal, 'DELETE', `${filesBase}/${pathPart(fileId)}/gdpr-delete`, flags));
    return;
  }

  if (action === 'folder-search') {
    const queryFlags = folderSearchQueryFlags(flags);
    const target = `${foldersBase}/search`;
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', target, queryFlags)
      : await hubspotFetch(portal, 'GET', target, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'folder-get') {
    const folderId = rest[0];
    if (!folderId) fail('files folder-get requires <folderId>.');
    printJson(await hubspotFetch(portal, 'GET', `${foldersBase}/${pathPart(folderId)}`, propertiesQueryFlags(flags)));
    return;
  }

  if (action === 'folder-create') {
    printJson(await guardedFetch(portal, 'POST', foldersBase, flags, folderBodyFromFlags(flags, 'files folder-create', { requireName: true })));
    return;
  }

  if (action === 'folder-update') {
    const folderId = rest[0];
    if (!folderId) fail('files folder-update requires <folderId>.');
    printJson(await guardedFetch(portal, 'PATCH', `${foldersBase}/${pathPart(folderId)}`, flags, folderBodyFromFlags(flags, 'files folder-update')));
    return;
  }

  if (action === 'folder-update-async') {
    const folderId = rest[0] || flags.id || flags['folder-id'];
    if (!folderId) fail('files folder-update-async requires <folderId> or --id.');
    printJson(await guardedFetch(portal, 'POST', `${foldersBase}/update/async`, flags, folderBodyFromFlags(flags, 'files folder-update-async', { folderId })));
    return;
  }

  if (action === 'folder-update-status') {
    const taskId = rest[0];
    if (!taskId) fail('files folder-update-status requires <taskId>.');
    printJson(await hubspotFetch(portal, 'GET', `${foldersBase}/update/async/tasks/${pathPart(taskId)}/status`, flags));
    return;
  }

  fail(`Unknown files action: ${action}`);
}

async function runEvents(portal, action, rest, flags) {
  const occurrencesBase = '/events/event-occurrences/2026-03';
  const definitionsBase = '/events/2026-03/event-definitions';
  const sendBase = '/events/2026-03/send';

  if (action === 'types') {
    printJson(await hubspotFetch(portal, 'GET', `${occurrencesBase}/event-types`, flags));
    return;
  }

  if (action === 'occurrences') {
    const queryFlags = eventOccurrencesQueryFlags(flags);
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', occurrencesBase, queryFlags)
      : await hubspotFetch(portal, 'GET', occurrencesBase, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'definitions') {
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', definitionsBase, genericListQueryFlags(flags))
      : await hubspotFetch(portal, 'GET', definitionsBase, genericListQueryFlags(flags));
    printJson(result);
    return;
  }

  if (action === 'definition-get') {
    const eventName = rest[0];
    if (!eventName) fail('events definition-get requires <eventName>.');
    printJson(await hubspotFetch(portal, 'GET', `${definitionsBase}/${pathPart(eventName)}`, flags));
    return;
  }

  if (action === 'definition-create') {
    printJson(await guardedFetch(portal, 'POST', definitionsBase, flags, eventDefinitionBodyFromFlags(flags, 'events definition-create')));
    return;
  }

  if (action === 'definition-update') {
    const eventName = rest[0];
    if (!eventName) fail('events definition-update requires <eventName>.');
    printJson(await guardedFetch(portal, 'PATCH', `${definitionsBase}/${pathPart(eventName)}`, flags, eventDefinitionBodyFromFlags(flags, 'events definition-update')));
    return;
  }

  if (action === 'definition-delete') {
    const eventName = rest[0];
    if (!eventName) fail('events definition-delete requires <eventName>.');
    printJson(await guardedFetch(portal, 'DELETE', `${definitionsBase}/${pathPart(eventName)}`, flags));
    return;
  }

  if (action === 'property-create') {
    const eventName = rest[0];
    if (!eventName) fail('events property-create requires <eventName>.');
    printJson(await guardedFetch(portal, 'POST', `${definitionsBase}/${pathPart(eventName)}/property`, flags, eventPropertyBodyFromFlags(flags, 'events property-create')));
    return;
  }

  if (action === 'property-update') {
    const [eventName, propertyName] = rest;
    if (!eventName || !propertyName) fail('events property-update requires <eventName> <propertyName>.');
    printJson(await guardedFetch(portal, 'PATCH', `${definitionsBase}/${pathPart(eventName)}/property/${pathPart(propertyName)}`, flags, eventPropertyBodyFromFlags(flags, 'events property-update')));
    return;
  }

  if (action === 'property-delete') {
    const [eventName, propertyName] = rest;
    if (!eventName || !propertyName) fail('events property-delete requires <eventName> <propertyName>.');
    printJson(await guardedFetch(portal, 'DELETE', `${definitionsBase}/${pathPart(eventName)}/property/${pathPart(propertyName)}`, flags));
    return;
  }

  if (action === 'send') {
    printJson(await guardedFetch(portal, 'POST', sendBase, flags, eventSendBodyFromFlags(flags, 'events send')));
    return;
  }

  if (action === 'send-batch') {
    printJson(await guardedFetch(portal, 'POST', `${sendBase}/batch`, flags, eventSendBodyFromFlags(flags, 'events send-batch')));
    return;
  }

  fail(`Unknown events action: ${action}`);
}

async function runWebhooks(portal, action, rest, flags) {
  const appId = rest[0] || flags['app-id'];
  if (!appId) fail('webhooks requires <appId> or --app-id.');
  const base = `/webhooks/2026-03/${pathPart(appId)}`;

  if (action === 'settings') {
    printJson(await hubspotFetch(portal, 'GET', `${base}/settings`, flags));
    return;
  }

  if (action === 'settings-update') {
    printJson(await guardedFetch(portal, 'PUT', `${base}/settings`, flags, webhookSettingsBodyFromFlags(flags)));
    return;
  }

  if (action === 'settings-delete') {
    printJson(await guardedFetch(portal, 'DELETE', `${base}/settings`, flags));
    return;
  }

  if (action === 'subscription-create') {
    printJson(await guardedFetch(portal, 'POST', `${base}/subscriptions`, flags, webhookSubscriptionBodyFromFlags(flags, 'webhooks subscription-create')));
    return;
  }

  if (action === 'subscription-update') {
    const subscriptionId = rest[1] || flags['subscription-id'];
    if (!subscriptionId) fail('webhooks subscription-update requires <appId> <subscriptionId>.');
    printJson(await guardedFetch(portal, 'PATCH', `${base}/subscriptions/${pathPart(subscriptionId)}`, flags, webhookSubscriptionBodyFromFlags(flags, 'webhooks subscription-update')));
    return;
  }

  if (action === 'subscription-batch-update') {
    const body = batchWriteBodyFromFlags(flags, 'webhooks subscription-batch-update');
    printJson(await guardedFetch(portal, 'POST', `${base}/subscriptions/batch/update`, flags, body));
    return;
  }

  fail(`Unknown webhooks action: ${action}`);
}

async function runWebhookJournal(portal, action, rest, flags) {
  const journalBase = '/webhooks-journal/journal/2026-03';
  const localBase = '/webhooks-journal/journal-local/2026-03';
  const subscriptionsBase = '/webhooks-journal/subscriptions/2026-03';

  if (action === 'journal-earliest') {
    printJson(await hubspotFetch(portal, 'GET', `${journalBase}/earliest`, flags));
    return;
  }

  if (action === 'journal-status') {
    const statusId = rest[0];
    if (!statusId) fail('webhook-journal journal-status requires <statusId>.');
    printJson(await hubspotFetch(portal, 'GET', `${journalBase}/status/${pathPart(statusId)}`, flags));
    return;
  }

  if (action === 'journal-batch-read') {
    printJson(await guardedFetch(portal, 'POST', `${journalBase}/batch/read`, flags, offsetsBodyFromFlags(flags, 'webhook-journal journal-batch-read'), { readOnly: true }));
    return;
  }

  if (action === 'local-earliest') {
    printJson(await hubspotFetch(portal, 'GET', `${localBase}/earliest`, flags));
    return;
  }

  if (action === 'local-latest') {
    printJson(await hubspotFetch(portal, 'GET', `${localBase}/latest`, flags));
    return;
  }

  if (action === 'local-next') {
    const offset = rest[0] || flags.offset;
    if (offset === undefined) fail('webhook-journal local-next requires <offset>.');
    printJson(await hubspotFetch(portal, 'GET', `${localBase}/offset/${pathPart(offset)}/next`, flags));
    return;
  }

  if (action === 'local-status') {
    const statusId = rest[0];
    if (!statusId) fail('webhook-journal local-status requires <statusId>.');
    printJson(await hubspotFetch(portal, 'GET', `${localBase}/status/${pathPart(statusId)}`, flags));
    return;
  }

  if (action === 'local-batch-earliest' || action === 'local-batch-latest') {
    const count = rest[0] || flags.count;
    if (count === undefined) fail(`webhook-journal ${action} requires <count>.`);
    const direction = action === 'local-batch-earliest' ? 'earliest' : 'latest';
    printJson(await hubspotFetch(portal, 'GET', `${localBase}/batch/${direction}/${pathPart(count)}`, flags));
    return;
  }

  if (action === 'local-batch-read') {
    printJson(await guardedFetch(portal, 'POST', `${localBase}/batch/read`, flags, offsetsBodyFromFlags(flags, 'webhook-journal local-batch-read'), { readOnly: true }));
    return;
  }

  if (action === 'snapshot-crm') {
    printJson(await guardedFetch(portal, 'POST', '/webhooks-journal/snapshots/2026-03/crm', flags, mappedBodyFromFlags(flags, 'webhook-journal snapshot-crm', {
      'portal-id': 'portalId',
      'object-type': 'objectType',
      properties: { name: 'properties', type: 'json' }
    })));
    return;
  }

  if (action === 'subscription-list') {
    printJson(await hubspotFetch(portal, 'GET', subscriptionsBase, genericListQueryFlags(flags)));
    return;
  }

  if (action === 'subscription-create') {
    printJson(await guardedFetch(portal, 'POST', subscriptionsBase, flags, webhookJournalSubscriptionBodyFromFlags(flags, 'webhook-journal subscription-create')));
    return;
  }

  if (action === 'subscription-delete') {
    const subscriptionId = rest[0] || flags['subscription-id'];
    if (!subscriptionId) fail('webhook-journal subscription-delete requires <subscriptionId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${subscriptionsBase}/${pathPart(subscriptionId)}`, flags));
    return;
  }

  if (action === 'subscription-delete-portal') {
    const portalId = rest[0] || flags['portal-id'];
    if (!portalId) fail('webhook-journal subscription-delete-portal requires <portalId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${subscriptionsBase}/portals/${pathPart(portalId)}`, flags));
    return;
  }

  if (action === 'filter-create') {
    printJson(await guardedFetch(portal, 'POST', `${subscriptionsBase}/filters`, flags, mappedBodyFromFlags(flags, 'webhook-journal filter-create', {
      'subscription-id': 'subscriptionId',
      'object-type': 'objectType',
      'property-name': 'propertyName',
      operator: 'operator',
      value: 'value',
      filters: { name: 'filters', type: 'json' }
    })));
    return;
  }

  if (action === 'filter-list') {
    const subscriptionId = rest[0] || flags['subscription-id'];
    if (!subscriptionId) fail('webhook-journal filter-list requires <subscriptionId>.');
    printJson(await hubspotFetch(portal, 'GET', `${subscriptionsBase}/filters/subscription/${pathPart(subscriptionId)}`, flags));
    return;
  }

  if (action === 'filter-get') {
    const filterId = rest[0] || flags['filter-id'];
    if (!filterId) fail('webhook-journal filter-get requires <filterId>.');
    printJson(await hubspotFetch(portal, 'GET', `${subscriptionsBase}/filters/${pathPart(filterId)}`, flags));
    return;
  }

  if (action === 'filter-delete') {
    const filterId = rest[0] || flags['filter-id'];
    if (!filterId) fail('webhook-journal filter-delete requires <filterId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${subscriptionsBase}/filters/${pathPart(filterId)}`, flags));
    return;
  }

  fail(`Unknown webhook-journal action: ${action}`);
}

async function runConversations(portal, action, rest, flags) {
  const betaBase = '/conversations/conversations/2026-09-beta';
  const customBase = '/conversations/custom-channels/2026-03';

  if (action === 'threads') {
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', `${betaBase}/threads`, genericListQueryFlags(flags))
      : await hubspotFetch(portal, 'GET', `${betaBase}/threads`, genericListQueryFlags(flags));
    printJson(result);
    return;
  }

  if (action === 'thread-get') {
    const threadId = rest[0];
    if (!threadId) fail('conversations thread-get requires <threadId>.');
    printJson(await hubspotFetch(portal, 'GET', `${betaBase}/threads/${pathPart(threadId)}`, flags));
    return;
  }

  if (action === 'thread-update') {
    const threadId = rest[0];
    if (!threadId) fail('conversations thread-update requires <threadId>.');
    printJson(await guardedFetch(portal, 'PATCH', `${betaBase}/threads/${pathPart(threadId)}`, flags, conversationBodyFromFlags(flags, 'conversations thread-update')));
    return;
  }

  if (action === 'thread-delete') {
    const threadId = rest[0];
    if (!threadId) fail('conversations thread-delete requires <threadId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${betaBase}/threads/${pathPart(threadId)}`, flags));
    return;
  }

  if (action === 'assignee-update') {
    const threadId = rest[0];
    if (!threadId) fail('conversations assignee-update requires <threadId>.');
    printJson(await guardedFetch(portal, 'PUT', `${betaBase}/threads/${pathPart(threadId)}/assignee`, flags, conversationBodyFromFlags(flags, 'conversations assignee-update')));
    return;
  }

  if (action === 'assignee-delete') {
    const threadId = rest[0];
    if (!threadId) fail('conversations assignee-delete requires <threadId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${betaBase}/threads/${pathPart(threadId)}/assignee`, flags));
    return;
  }

  if (action === 'messages') {
    const threadId = rest[0];
    if (!threadId) fail('conversations messages requires <threadId>.');
    printJson(await hubspotFetch(portal, 'GET', `${betaBase}/threads/${pathPart(threadId)}/messages`, genericListQueryFlags(flags)));
    return;
  }

  if (action === 'message-get' || action === 'message-original') {
    const [threadId, messageId] = rest;
    if (!threadId || !messageId) fail(`conversations ${action} requires <threadId> <messageId>.`);
    const suffix = action === 'message-original' ? '/original-content' : '';
    printJson(await hubspotFetch(portal, 'GET', `${betaBase}/threads/${pathPart(threadId)}/messages/${pathPart(messageId)}${suffix}`, flags));
    return;
  }

  if (action === 'message-create') {
    const threadId = rest[0];
    if (!threadId) fail('conversations message-create requires <threadId>.');
    printJson(await guardedFetch(portal, 'POST', `${betaBase}/threads/${pathPart(threadId)}/messages`, flags, conversationBodyFromFlags(flags, 'conversations message-create')));
    return;
  }

  if (action === 'actors-get') {
    const actorId = rest[0];
    if (!actorId) fail('conversations actors-get requires <actorId>.');
    printJson(await hubspotFetch(portal, 'GET', `${betaBase}/actors/${pathPart(actorId)}`, flags));
    return;
  }

  if (action === 'actors-batch-read') {
    printJson(await guardedFetch(portal, 'POST', `${betaBase}/actors/batch/read`, flags, inputsBodyFromFlags(flags, 'conversations actors-batch-read'), { readOnly: true }));
    return;
  }

  if (action === 'channels' || action === 'channel-accounts' || action === 'inboxes') {
    const route = action === 'channel-accounts' ? 'channel-accounts' : action;
    printJson(await hubspotFetch(portal, 'GET', `${betaBase}/${route}`, genericListQueryFlags(flags)));
    return;
  }

  if (action === 'channel-get' || action === 'channel-account-get' || action === 'inbox-get') {
    const id = rest[0];
    if (!id) fail(`conversations ${action} requires <id>.`);
    const route = action === 'channel-get' ? 'channels' : action === 'channel-account-get' ? 'channel-accounts' : 'inboxes';
    printJson(await hubspotFetch(portal, 'GET', `${betaBase}/${route}/${pathPart(id)}`, flags));
    return;
  }

  if (action === 'custom-channels') {
    printJson(await hubspotFetch(portal, 'GET', customBase, genericListQueryFlags(flags)));
    return;
  }

  if (action === 'custom-channel-get') {
    const channelId = rest[0];
    if (!channelId) fail('conversations custom-channel-get requires <channelId>.');
    printJson(await hubspotFetch(portal, 'GET', `${customBase}/${pathPart(channelId)}`, flags));
    return;
  }

  if (action === 'custom-channel-create') {
    printJson(await guardedFetch(portal, 'POST', customBase, flags, conversationBodyFromFlags(flags, 'conversations custom-channel-create')));
    return;
  }

  if (action === 'custom-channel-update') {
    const channelId = rest[0];
    if (!channelId) fail('conversations custom-channel-update requires <channelId>.');
    printJson(await guardedFetch(portal, 'PATCH', `${customBase}/${pathPart(channelId)}`, flags, conversationBodyFromFlags(flags, 'conversations custom-channel-update')));
    return;
  }

  if (action === 'custom-channel-delete') {
    const channelId = rest[0];
    if (!channelId) fail('conversations custom-channel-delete requires <channelId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${customBase}/${pathPart(channelId)}`, flags));
    return;
  }

  if (action === 'custom-channel-accounts') {
    const channelId = rest[0];
    if (!channelId) fail('conversations custom-channel-accounts requires <channelId>.');
    printJson(await hubspotFetch(portal, 'GET', `${customBase}/${pathPart(channelId)}/channel-accounts`, genericListQueryFlags(flags)));
    return;
  }

  if (action === 'custom-channel-account-get') {
    const [channelId, channelAccountId] = rest;
    if (!channelId || !channelAccountId) fail('conversations custom-channel-account-get requires <channelId> <channelAccountId>.');
    printJson(await hubspotFetch(portal, 'GET', `${customBase}/${pathPart(channelId)}/channel-accounts/${pathPart(channelAccountId)}`, flags));
    return;
  }

  if (action === 'custom-channel-account-create') {
    const channelId = rest[0];
    if (!channelId) fail('conversations custom-channel-account-create requires <channelId>.');
    printJson(await guardedFetch(portal, 'POST', `${customBase}/${pathPart(channelId)}/channel-accounts`, flags, conversationBodyFromFlags(flags, 'conversations custom-channel-account-create')));
    return;
  }

  if (action === 'custom-message-create') {
    const channelId = rest[0];
    if (!channelId) fail('conversations custom-message-create requires <channelId>.');
    printJson(await guardedFetch(portal, 'POST', `${customBase}/${pathPart(channelId)}/messages`, flags, conversationBodyFromFlags(flags, 'conversations custom-message-create')));
    return;
  }

  if (action === 'custom-message-get' || action === 'custom-message-update') {
    const [channelId, messageId] = rest;
    if (!channelId || !messageId) fail(`conversations ${action} requires <channelId> <messageId>.`);
    const target = `${customBase}/${pathPart(channelId)}/messages/${pathPart(messageId)}`;
    if (action === 'custom-message-get') {
      printJson(await hubspotFetch(portal, 'GET', target, flags));
    } else {
      printJson(await guardedFetch(portal, 'PATCH', target, flags, conversationBodyFromFlags(flags, 'conversations custom-message-update')));
    }
    return;
  }

  if (action === 'visitor-token') {
    printJson(await guardedFetch(portal, 'POST', '/visitor-identification/2026-03/tokens/create', flags, conversationBodyFromFlags(flags, 'conversations visitor-token')));
    return;
  }

  fail(`Unknown conversations action: ${action}`);
}

async function runMarketing(portal, action, rest, flags) {
  if (action === 'emails') {
    await runMarketingEmails(portal, rest, flags);
    return;
  }

  if (action === 'campaigns') {
    await runMarketingCampaigns(portal, rest, flags);
    return;
  }

  if (action === 'events') {
    await runMarketingEvents(portal, rest, flags);
    return;
  }

  if (action === 'transactional' || action === 'transactional-email' || action === 'transactional-emails') {
    await runMarketingTransactional(portal, rest, flags);
    return;
  }

  fail(`Unknown marketing action: ${action}`);
}

async function runMarketingEmails(portal, rest, flags) {
  const action = rest[0];
  const actionRest = rest.slice(1);
  const base = '/marketing/emails/2026-03';

  if (action === 'create') {
    printJson(await guardedFetch(portal, 'POST', base, flags, marketingEmailBodyFromFlags(flags, 'marketing emails create')));
    return;
  }

  if (action === 'update' || action === 'patch') {
    const emailId = actionRest[0] || flags['email-id'];
    if (!emailId) fail(`marketing emails ${action} requires <emailId>.`);
    printJson(await guardedFetch(portal, 'PATCH', `${base}/${pathPart(emailId)}`, flags, marketingEmailBodyFromFlags(flags, `marketing emails ${action}`)));
    return;
  }

  if (action === 'delete' || action === 'archive') {
    const emailId = actionRest[0] || flags['email-id'];
    if (!emailId) fail(`marketing emails ${action} requires <emailId>.`);
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(emailId)}`, flags));
    return;
  }

  fail(`Unknown marketing emails action: ${action}`);
}

async function runMarketingCampaigns(portal, rest, flags) {
  const action = rest[0];
  const actionRest = rest.slice(1);
  const base = '/marketing/campaigns/2026-03';

  if (action === 'create') {
    printJson(await guardedFetch(portal, 'POST', base, flags, campaignBodyFromFlags(flags, 'marketing campaigns create')));
    return;
  }

  if (action === 'get') {
    const campaignGuid = actionRest[0] || flags['campaign-guid'] || flags['campaign-id'];
    if (!campaignGuid) fail('marketing campaigns get requires <campaignGuid>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(campaignGuid)}`, genericListQueryFlags(flags)));
    return;
  }

  if (action === 'delete' || action === 'archive') {
    const campaignGuid = actionRest[0] || flags['campaign-guid'] || flags['campaign-id'];
    if (!campaignGuid) fail(`marketing campaigns ${action} requires <campaignGuid>.`);
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(campaignGuid)}`, flags));
    return;
  }

  fail(`Unknown marketing campaigns action: ${action}`);
}

async function runMarketingEvents(portal, rest, flags) {
  const action = rest[0];
  const base = '/marketing/marketing-events/2026-03';

  if (action === 'list') {
    const queryFlags = genericListQueryFlags(flags);
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', base, queryFlags)
      : await hubspotFetch(portal, 'GET', base, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'create') {
    printJson(await guardedFetch(portal, 'POST', `${base}/events`, flags, marketingEventBodyFromFlags(flags, 'marketing events create')));
    return;
  }

  if (action === 'upsert') {
    printJson(await guardedFetch(portal, 'POST', `${base}/events/upsert`, flags, marketingEventBodyFromFlags(flags, 'marketing events upsert', { wrapInputs: true })));
    return;
  }

  fail(`Unknown marketing events action: ${action}`);
}

async function runMarketingTransactional(portal, rest, flags) {
  const action = rest[0];
  if (action !== 'send') fail(`Unknown marketing transactional action: ${action}`);
  printJson(await guardedFetch(portal, 'POST', '/marketing/transactional/2026-03/single-email/send', flags, transactionalEmailBodyFromFlags(flags, 'marketing transactional send')));
}

async function runAutomation(portal, action, rest, flags) {
  if (action === 'workflows') {
    await runAutomationWorkflows(portal, rest, flags);
    return;
  }

  if (action === 'sequences') {
    await runAutomationSequences(portal, rest, flags);
    return;
  }

  fail(`Unknown automation action: ${action}`);
}

async function runAutomationWorkflows(portal, rest, flags) {
  const action = rest[0];
  const actionRest = rest.slice(1);
  const base = '/automation/v3/workflows';

  if (action === 'list') {
    printJson(await hubspotFetch(portal, 'GET', base, flags));
    return;
  }

  if (action === 'get') {
    const workflowId = actionRest[0] || flags['workflow-id'];
    if (!workflowId) fail('automation workflows get requires <workflowId> or --workflow-id.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(workflowId)}`, workflowGetQueryFlags(flags)));
    return;
  }

  if (action === 'current-enrollment' || action === 'current_enrollment') {
    const vid = actionRest[0] || flags.vid || flags['contact-id'];
    if (!vid) fail(`automation workflows ${action} requires <vid>, --vid, or --contact-id.`);
    printJson(await hubspotFetch(portal, 'GET', `/automation/v2/workflows/enrollments/contacts/${pathPart(vid)}`, flags));
    return;
  }

  if (action === 'enroll' || action === 'enroll-contact') {
    const workflowId = actionRest[0] || flags['workflow-id'];
    const email = actionRest[1] || flags.email;
    if (!workflowId) fail(`automation workflows ${action} requires <workflowId> or --workflow-id.`);
    if (!email) fail(`automation workflows ${action} requires <email> or --email.`);
    printJson(await guardedFetch(portal, 'POST', `/automation/v2/workflows/${pathPart(workflowId)}/enrollments/contacts/${pathPart(email)}`, flags));
    return;
  }

  fail(`Unknown automation workflows action: ${action}`);
}

async function runAutomationSequences(portal, rest, flags) {
  const action = rest[0];
  const actionRest = rest.slice(1);
  const base = '/automation/sequences/2026-03';

  if (action === 'list') {
    const queryFlags = sequenceQueryFlags(flags, 'automation sequences list', {
      list: true,
      requireUser: true
    });
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', base, queryFlags)
      : await hubspotFetch(portal, 'GET', base, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'get') {
    const sequenceId = actionRest[0] || flags['sequence-id'];
    if (!sequenceId) fail('automation sequences get requires <sequenceId> or --sequence-id.');
    const queryFlags = sequenceQueryFlags(flags, 'automation sequences get', {
      requireUser: true
    });
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(sequenceId)}`, queryFlags));
    return;
  }

  if (action === 'enroll' || action === 'enroll-contact') {
    const queryFlags = sequenceQueryFlags(flags, 'automation sequences enroll', {
      requireUser: true
    });
    printJson(await guardedFetch(portal, 'POST', `${base}/enrollments`, queryFlags, sequenceEnrollmentBodyFromFlags(flags)));
    return;
  }

  if (action === 'status' || action === 'enrollment-status') {
    const contactId = actionRest[0] || flags['contact-id'];
    if (!contactId) fail(`automation sequences ${action} requires <contactId> or --contact-id.`);
    printJson(await hubspotFetch(portal, 'GET', `${base}/enrollments/contact/${pathPart(contactId)}`, flags));
    return;
  }

  fail(`Unknown automation sequences action: ${action}`);
}

async function runExtensions(portal, action, rest, flags) {
  if (action === 'calling') {
    await runCallingExtensions(portal, rest, flags);
    return;
  }

  if (action === 'videoconferencing' || action === 'video-conferencing' || action === 'video') {
    await runVideoConferencingExtensions(portal, rest, flags);
    return;
  }

  fail(`Unknown extensions action: ${action}`);
}

async function runVideoConferencingExtensions(portal, rest, flags) {
  const group = rest[0];
  const action = rest[1];
  const actionRest = rest.slice(2);

  if (group === 'settings') {
    const appId = actionRest[0] || flags['app-id'];
    if (!appId) fail(`extensions videoconferencing settings ${action || ''}`.trim() + ' requires <appId> or --app-id.');
    const base = `/crm/extensions/videoconferencing/2026-03/settings/${pathPart(appId)}`;
    if (action === 'get') {
      printJson(await hubspotFetch(portal, 'GET', base, flags));
      return;
    }
    if (action === 'delete') {
      printJson(await guardedFetch(portal, 'DELETE', base, flags));
      return;
    }
    fail(`Unknown extensions videoconferencing settings action: ${action}`);
  }

  fail(`Unknown extensions videoconferencing group: ${group}`);
}

async function runCallingExtensions(portal, rest, flags) {
  const group = rest[0];
  const action = rest[1];
  const actionRest = rest.slice(2);

  if (group === 'settings') {
    const appId = actionRest[0] || flags['app-id'];
    if (!appId) fail(`extensions calling settings ${action || ''}`.trim() + ' requires <appId> or --app-id.');
    const base = `/crm/extensions/calling/2026-03/${pathPart(appId)}/settings`;
    if (action === 'get') {
      printJson(await hubspotFetch(portal, 'GET', base, flags));
      return;
    }
    if (action === 'delete') {
      printJson(await guardedFetch(portal, 'DELETE', base, flags));
      return;
    }
    fail(`Unknown extensions calling settings action: ${action}`);
  }

  if (group === 'recording-settings' || group === 'recording_settings') {
    const appId = actionRest[0] || flags['app-id'];
    if (!appId) fail(`extensions calling recording-settings ${action || ''}`.trim() + ' requires <appId> or --app-id.');
    const base = `/crm/v3/extensions/calling/${pathPart(appId)}/settings/recording`;
    if (action === 'get') {
      printJson(await hubspotFetch(portal, 'GET', base, flags));
      return;
    }
    if (action === 'create') {
      printJson(await guardedFetch(portal, 'POST', base, flags, callingRecordingSettingsBodyFromFlags(flags, 'extensions calling recording-settings create')));
      return;
    }
    if (action === 'update') {
      printJson(await guardedFetch(portal, 'PATCH', base, flags, callingRecordingSettingsBodyFromFlags(flags, 'extensions calling recording-settings update')));
      return;
    }
    fail(`Unknown extensions calling recording-settings action: ${action}`);
  }

  if (group === 'channel-connection' || group === 'channel_connection') {
    const appId = actionRest[0] || flags['app-id'];
    if (!appId) fail(`extensions calling channel-connection ${action || ''}`.trim() + ' requires <appId> or --app-id.');
    if (action === 'delete') {
      printJson(await guardedFetch(portal, 'DELETE', `/crm/extensions/calling/2026-03/${pathPart(appId)}/settings/channel-connection`, flags));
      return;
    }
    fail(`Unknown extensions calling channel-connection action: ${action}`);
  }

  if (group === 'recordings') {
    if (action === 'ready') {
      printJson(await guardedFetch(portal, 'POST', '/crm/extensions/calling/2026-03/recordings/ready', flags, callingRecordingReadyBodyFromFlags(flags)));
      return;
    }
    fail(`Unknown extensions calling recordings action: ${action}`);
  }

  if (group === 'transcripts') {
    if (action === 'create') {
      printJson(await guardedFetch(portal, 'POST', '/crm/extensions/calling/2026-03/transcripts', flags, callingTranscriptCreateBodyFromFlags(flags)));
      return;
    }
    if (action === 'get') {
      const transcriptId = actionRest[0] || flags['transcript-id'];
      if (!transcriptId) fail('extensions calling transcripts get requires <transcriptId> or --transcript-id.');
      printJson(await hubspotFetch(portal, 'GET', `/crm/extensions/calling/2026-03/transcripts/${pathPart(transcriptId)}`, flags));
      return;
    }
    fail(`Unknown extensions calling transcripts action: ${action}`);
  }

  fail(`Unknown extensions calling group: ${group}`);
}

async function runForms(portal, action, rest, flags) {
  const formsBase = '/marketing/v3/forms';

  if (action === 'list') {
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', formsBase, formListQueryFlags(flags))
      : await hubspotFetch(portal, 'GET', formsBase, formListQueryFlags(flags));
    printJson(result);
    return;
  }

  if (action === 'get') {
    const formId = rest[0] || flags['form-id'];
    if (!formId) fail('forms get requires <formId>.');
    printJson(await hubspotFetch(portal, 'GET', `${formsBase}/${pathPart(formId)}`, formListQueryFlags(flags)));
    return;
  }

  if (action === 'create') {
    printJson(await guardedFetch(portal, 'POST', formsBase, flags, formDefinitionBodyFromFlags(flags, 'forms create', { defaultFormType: true })));
    return;
  }

  if (action === 'patch' || action === 'partial-update') {
    const formId = rest[0] || flags['form-id'];
    if (!formId) fail(`forms ${action} requires <formId>.`);
    printJson(await guardedFetch(portal, 'PATCH', `${formsBase}/${pathPart(formId)}`, flags, formDefinitionBodyFromFlags(flags, 'forms patch')));
    return;
  }

  if (action === 'update') {
    const formId = rest[0] || flags['form-id'];
    if (!formId) fail('forms update requires <formId>.');
    printJson(await guardedFetch(portal, 'PUT', `${formsBase}/${pathPart(formId)}`, flags, formDefinitionBodyFromFlags(flags, 'forms update', { defaultFormType: true })));
    return;
  }

  if (action === 'archive' || action === 'delete') {
    const formId = rest[0] || flags['form-id'];
    if (!formId) fail(`forms ${action} requires <formId>.`);
    printJson(await guardedFetch(portal, 'DELETE', `${formsBase}/${pathPart(formId)}`, flags));
    return;
  }

  if (action === 'submissions') {
    const formGuid = rest[0] || flags['form-guid'];
    if (!formGuid) fail('forms submissions requires <formGuid>.');
    const queryFlags = appendMappedSearchQuery(flags, {
      after: 'after',
      limit: 'limit'
    });
    printJson(await hubspotFetch(portal, 'GET', `/form-integrations/v1/submissions/forms/${pathPart(formGuid)}`, queryFlags));
    return;
  }

  if (action === 'submit') {
    const portalId = rest[0] || flags['portal-id'] || portal.portalId;
    const formGuid = rest[1] || flags['form-guid'];
    if (!portalId || !formGuid) fail('forms submit requires <portalId> <formGuid>, or --portal-id and --form-guid.');
    const url = new URL(`/submissions/v3/integration/submit/${pathPart(portalId)}/${pathPart(formGuid)}`, 'https://api.hsforms.com');
    printJson(await guardedExternalNoAuthJsonFetch(portal, 'POST', url, flags, formSubmissionBodyFromFlags(flags, 'forms submit'), {
      endpoint: endpointDefinitionById('forms.submit')
    }));
    return;
  }

  if (action === 'secure-submit') {
    const portalId = rest[0] || flags['portal-id'] || portal.portalId;
    const formGuid = rest[1] || flags['form-guid'];
    if (!portalId || !formGuid) fail('forms secure-submit requires <portalId> <formGuid>, or --portal-id and --form-guid.');
    const url = new URL(`/submissions/v3/integration/secure/submit/${pathPart(portalId)}/${pathPart(formGuid)}`, 'https://api.hsforms.com');
    printJson(await guardedExternalBearerJsonFetch(portal, 'POST', url, flags, formSubmissionBodyFromFlags(flags, 'forms secure-submit'), {
      endpoint: endpointDefinitionById('forms.secure_submit')
    }));
    return;
  }

  fail(`Unknown forms action: ${action}`);
}

async function runCms(portal, action, rest, flags) {
  if (action === 'site-pages' || action === 'landing-pages') {
    await runCmsPages(portal, action, rest, flags);
    return;
  }

  if (action === 'blog-posts') {
    await runCmsBlogPosts(portal, rest, flags);
    return;
  }

  if (action === 'redirects') {
    await runCmsRedirects(portal, rest, flags);
    return;
  }

  if (action === 'hubdb') {
    await runCmsHubDb(portal, rest, flags);
    return;
  }

  if (action === 'source-code') {
    await runCmsSourceCode(portal, rest, flags);
    return;
  }

  if (action === 'domains') {
    await runCmsDomains(portal, rest, flags);
    return;
  }

  if (action === 'search' || action === 'indexed-data') {
    await runCmsSearch(portal, action, rest, flags);
    return;
  }

  fail(`Unknown cms action: ${action}`);
}

async function runCmsHubDb(portal, rest, flags) {
  const resource = rest[0];
  const action = rest[1];
  const actionRest = rest.slice(2);
  const base = '/cms/hubdb/2026-03/tables';

  if (resource === 'tables') {
    if (action === 'list') {
      const queryFlags = genericListQueryFlags(flags);
      const result = boolFlag(flags, 'paginate')
        ? await collectPages(portal, 'GET', base, queryFlags)
        : await hubspotFetch(portal, 'GET', base, queryFlags);
      printJson(result);
      return;
    }

    if (action === 'get') {
      const tableIdOrName = actionRest[0] || flags['table-id-or-name'] || flags.table;
      if (!tableIdOrName) fail('cms hubdb tables get requires <tableIdOrName>.');
      printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(tableIdOrName)}`, genericListQueryFlags(flags)));
      return;
    }

    if (action === 'create') {
      printJson(await guardedFetch(portal, 'POST', base, flags, hubDbTableBodyFromFlags(flags, 'cms hubdb tables create')));
      return;
    }

    fail(`Unknown cms hubdb tables action: ${action}`);
  }

  if (resource === 'rows') {
    const tableIdOrName = actionRest[0] || flags['table-id-or-name'] || flags.table;
    if (!tableIdOrName) fail(`cms hubdb rows ${action || ''} requires <tableIdOrName>.`);

    if (action === 'list') {
      const queryFlags = genericListQueryFlags(flags);
      const result = boolFlag(flags, 'paginate')
        ? await collectPages(portal, 'GET', `${base}/${pathPart(tableIdOrName)}/rows`, queryFlags)
        : await hubspotFetch(portal, 'GET', `${base}/${pathPart(tableIdOrName)}/rows`, queryFlags);
      printJson(result);
      return;
    }

    if (action === 'create') {
      printJson(await guardedFetch(portal, 'POST', `${base}/${pathPart(tableIdOrName)}/rows`, flags, hubDbRowBodyFromFlags(flags, 'cms hubdb rows create')));
      return;
    }

    fail(`Unknown cms hubdb rows action: ${action}`);
  }

  fail(`Unknown cms hubdb resource: ${resource}`);
}

async function runCmsSourceCode(portal, rest, flags) {
  const action = rest[0];
  const actionRest = rest.slice(1);
  const environment = actionRest[0] || flags.environment;
  const sourcePath = actionRest[1] || flags.path || flags['source-path'];
  if (!environment) fail(`cms source-code ${action || ''} requires <environment>.`);
  if (!sourcePath) fail(`cms source-code ${action || ''} requires <path>.`);

  const base = `/cms/source-code/2026-03/${pathPart(environment)}`;
  const encodedPath = pathTail(sourcePath, 'source path');

  if (action === 'upload' || action === 'put') {
    const { form, previewBody } = sourceCodeMultipartFromFlags(flags, 'cms source-code upload');
    printJson(await guardedMultipartFetch(portal, 'PUT', `${base}/content/${encodedPath}`, flags, form, previewBody, {
      endpoint: endpointDefinitionById('cms.source_code.upload')
    }));
    return;
  }

  if (action === 'validate') {
    const { form, previewBody } = sourceCodeMultipartFromFlags(flags, 'cms source-code validate');
    printJson(await hubspotMultipartFetch(portal, 'POST', `${base}/validate/${encodedPath}`, flags, form, previewBody, endpointDefinitionById('cms.source_code.validate')));
    return;
  }

  if (action === 'delete' || action === 'archive') {
    printJson(await guardedFetch(portal, 'DELETE', `${base}/content/${encodedPath}`, flags, undefined, {
      endpoint: endpointDefinitionById('cms.source_code.delete')
    }));
    return;
  }

  fail(`Unknown cms source-code action: ${action}`);
}

async function runCmsPages(portal, pageType, rest, flags) {
  const base = `/cms/pages/2026-03/${pageType}`;
  const action = rest[0];
  const actionRest = rest.slice(1);

  if (action === 'list') {
    const queryFlags = cmsPageListQueryFlags(flags);
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', base, queryFlags)
      : await hubspotFetch(portal, 'GET', base, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'get') {
    const pageId = actionRest[0] || flags['page-id'];
    if (!pageId) fail(`cms ${pageType} get requires <pageId>.`);
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(pageId)}`, flags));
    return;
  }

  if (action === 'create') {
    printJson(await guardedFetch(portal, 'POST', base, flags, cmsPageBodyFromFlags(flags, `cms ${pageType} create`, {
      requireName: true,
      requireTemplatePath: true
    })));
    return;
  }

  if (action === 'draft-get') {
    const pageId = actionRest[0] || flags['page-id'];
    if (!pageId) fail(`cms ${pageType} draft-get requires <pageId>.`);
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(pageId)}/draft`, flags));
    return;
  }

  if (action === 'draft-update' || action === 'patch' || action === 'update') {
    const pageId = actionRest[0] || flags['page-id'];
    if (!pageId) fail(`cms ${pageType} ${action} requires <pageId>.`);
    printJson(await guardedFetch(portal, 'PATCH', `${base}/${pathPart(pageId)}/draft`, flags, cmsPageBodyFromFlags(flags, `cms ${pageType} ${action}`)));
    return;
  }

  if (action === 'draft-reset' || action === 'reset') {
    const pageId = actionRest[0] || flags['page-id'];
    if (!pageId) fail(`cms ${pageType} ${action} requires <pageId>.`);
    printJson(await guardedFetch(portal, 'POST', `${base}/${pathPart(pageId)}/draft/reset`, flags));
    return;
  }

  if (action === 'push-live') {
    const pageId = actionRest[0] || flags['page-id'];
    if (!pageId) fail(`cms ${pageType} push-live requires <pageId>.`);
    printJson(await guardedFetch(portal, 'POST', `${base}/${pathPart(pageId)}/draft/push-live`, flags));
    return;
  }

  if (action === 'schedule') {
    const pageId = actionRest[0] || flags['page-id'] || flags.id;
    printJson(await guardedFetch(portal, 'POST', `${base}/schedule`, flags, cmsScheduleBodyFromFlags(flags, `cms ${pageType} schedule`, pageId)));
    return;
  }

  if (action === 'delete') {
    const pageId = actionRest[0] || flags['page-id'];
    if (!pageId) fail(`cms ${pageType} delete requires <pageId>.`);
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(pageId)}`, flags));
    return;
  }

  fail(`Unknown cms ${pageType} action: ${action}`);
}

async function runCmsBlogPosts(portal, rest, flags) {
  const base = '/cms/blogs/2026-03/posts';
  const action = rest[0];
  const actionRest = rest.slice(1);

  if (action === 'list') {
    const queryFlags = cmsBlogPostListQueryFlags(flags);
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', base, queryFlags)
      : await hubspotFetch(portal, 'GET', base, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'get') {
    const postId = actionRest[0] || flags['post-id'];
    if (!postId) fail('cms blog-posts get requires <postId>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(postId)}`, flags));
    return;
  }

  if (action === 'create') {
    printJson(await guardedFetch(portal, 'POST', base, flags, cmsBlogPostBodyFromFlags(flags, 'cms blog-posts create', {
      requireName: true,
      requireContentGroupId: true
    })));
    return;
  }

  if (action === 'draft-get') {
    const postId = actionRest[0] || flags['post-id'];
    if (!postId) fail('cms blog-posts draft-get requires <postId>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(postId)}/draft`, flags));
    return;
  }

  if (action === 'draft-update' || action === 'patch' || action === 'update') {
    const postId = actionRest[0] || flags['post-id'];
    if (!postId) fail(`cms blog-posts ${action} requires <postId>.`);
    printJson(await guardedFetch(portal, 'PATCH', `${base}/${pathPart(postId)}/draft`, flags, cmsBlogPostBodyFromFlags(flags, `cms blog-posts ${action}`)));
    return;
  }

  if (action === 'draft-reset' || action === 'reset') {
    const postId = actionRest[0] || flags['post-id'];
    if (!postId) fail('cms blog-posts draft-reset requires <postId>.');
    printJson(await guardedFetch(portal, 'POST', `${base}/${pathPart(postId)}/draft/reset`, flags));
    return;
  }

  if (action === 'push-live') {
    const postId = actionRest[0] || flags['post-id'];
    if (!postId) fail('cms blog-posts push-live requires <postId>.');
    printJson(await guardedFetch(portal, 'POST', `${base}/${pathPart(postId)}/draft/push-live`, flags));
    return;
  }

  if (action === 'schedule') {
    const postId = actionRest[0] || flags['post-id'] || flags.id;
    printJson(await guardedFetch(portal, 'POST', `${base}/schedule`, flags, cmsScheduleBodyFromFlags(flags, 'cms blog-posts schedule', postId)));
    return;
  }

  if (action === 'delete') {
    const postId = actionRest[0] || flags['post-id'];
    if (!postId) fail('cms blog-posts delete requires <postId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(postId)}`, flags));
    return;
  }

  fail(`Unknown cms blog-posts action: ${action}`);
}

async function runCmsRedirects(portal, rest, flags) {
  const base = '/cms/url-redirects/2026-03';
  const action = rest[0];
  const actionRest = rest.slice(1);

  if (action === 'list') {
    const queryFlags = genericListQueryFlags(flags);
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', base, queryFlags)
      : await hubspotFetch(portal, 'GET', base, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'get') {
    const redirectId = actionRest[0] || flags['redirect-id'];
    if (!redirectId) fail('cms redirects get requires <redirectId>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(redirectId)}`, flags));
    return;
  }

  if (action === 'create') {
    printJson(await guardedFetch(portal, 'POST', base, flags, cmsRedirectBodyFromFlags(flags, 'cms redirects create', {
      requireRoutePrefix: true,
      requireDestination: true
    })));
    return;
  }

  if (action === 'update') {
    const redirectId = actionRest[0] || flags['redirect-id'];
    if (!redirectId) fail('cms redirects update requires <redirectId>.');
    printJson(await guardedFetch(portal, 'PATCH', `${base}/${pathPart(redirectId)}`, flags, cmsRedirectBodyFromFlags(flags, 'cms redirects update')));
    return;
  }

  if (action === 'delete') {
    const redirectId = actionRest[0] || flags['redirect-id'];
    if (!redirectId) fail('cms redirects delete requires <redirectId>.');
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(redirectId)}`, flags));
    return;
  }

  fail(`Unknown cms redirects action: ${action}`);
}

async function runCmsDomains(portal, rest, flags) {
  const base = '/cms/domains/2026-03';
  const action = rest[0];

  if (action === 'list') {
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', base, genericListQueryFlags(flags))
      : await hubspotFetch(portal, 'GET', base, genericListQueryFlags(flags));
    printJson(result);
    return;
  }

  if (action === 'get') {
    const domainId = rest[1] || flags['domain-id'];
    if (!domainId) fail('cms domains get requires <domainId>.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(domainId)}`, flags));
    return;
  }

  fail(`Unknown cms domains action: ${action}`);
}

async function runCmsSearch(portal, action, rest, flags) {
  const base = '/cms/site-search/2026-03';

  if (action === 'search') {
    const q = flags.q !== undefined ? flags.q : (flags.search !== undefined ? flags.search : rest[0]);
    if (!q) fail('cms search requires --q <term> or a positional search term.');
    const queryFlags = cmsSearchQueryFlags({ ...flags, q });
    printJson(await hubspotFetch(portal, 'GET', `${base}/search`, queryFlags));
    return;
  }

  if (action === 'indexed-data') {
    const contentId = rest[0] || flags['content-id'];
    if (!contentId) fail('cms indexed-data requires <contentId>.');
    const queryFlags = cmsIndexedDataQueryFlags(flags);
    printJson(await hubspotFetch(portal, 'GET', `${base}/indexed-data/${pathPart(contentId)}`, queryFlags));
    return;
  }

  fail(`Unknown cms action: ${action}`);
}

async function runScheduler(portal, action, rest, flags) {
  const meetingsBase = '/scheduler/2026-03/meetings';
  const meetingLinksBase = `${meetingsBase}/meeting-links`;

  if (action === 'links' || action === 'meeting-links') {
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', meetingLinksBase, schedulerLinksQueryFlags(flags))
      : await hubspotFetch(portal, 'GET', meetingLinksBase, schedulerLinksQueryFlags(flags));
    printJson(result);
    return;
  }

  if (action === 'booking-info' || action === 'link') {
    const slug = rest[0] || flags.slug;
    if (!slug) fail(`scheduler ${action} requires <slug>.`);
    printJson(await hubspotFetch(portal, 'GET', `${meetingLinksBase}/book/${pathPart(slug)}`, schedulerBookingQueryFlags(flags)));
    return;
  }

  if (action === 'availability') {
    const slug = rest[0] || flags.slug;
    if (!slug) fail('scheduler availability requires <slug>.');
    printJson(await hubspotFetch(portal, 'GET', `${meetingLinksBase}/book/availability-page/${pathPart(slug)}`, schedulerBookingQueryFlags(flags)));
    return;
  }

  if (action === 'book') {
    const slug = rest[0] || flags.slug;
    printJson(await guardedFetch(portal, 'POST', `${meetingLinksBase}/book`, flags, schedulerBookBodyFromFlags(slug, flags)));
    return;
  }

  if (action === 'calendar-create') {
    const queryFlags = appendMappedSearchQuery(flags, {
      'organizer-user-id': 'organizerUserId'
    });
    if (!flags['organizer-user-id'] && !values(flags.query).some((item) => String(item).startsWith('organizerUserId='))) {
      fail('scheduler calendar-create requires --organizer-user-id or --query organizerUserId=<id>.');
    }
    printJson(await guardedFetch(portal, 'POST', `${meetingsBase}/calendar`, queryFlags, schedulerCalendarBodyFromFlags(flags)));
    return;
  }

  fail(`Unknown scheduler action: ${action}`);
}

async function runLimits(portal, action, rest, flags) {
  if (action === 'association-labels') {
    const queryFlags = { ...flags, query: values(flags.query) };
    if (rest[0]) queryFlags.query.push(`fromObjectTypeId=${rest[0]}`);
    if (rest[1]) queryFlags.query.push(`toObjectTypeId=${rest[1]}`);
    printJson(await hubspotFetch(portal, 'GET', '/crm/v3/limits/associations/labels', queryFlags));
    return;
  }

  const routes = {
    records: '/crm/v3/limits/records',
    associations: rest[0]
      ? `/crm/v3/limits/associations/records/${pathPart(rest[0])}${rest[1] ? `/${pathPart(rest[1])}` : '/to'}`
      : '/crm/v3/limits/associations/records/from',
    properties: '/crm/v3/limits/custom-properties',
    'custom-properties': '/crm/v3/limits/custom-properties',
    'calculated-properties': '/crm/v3/limits/calculated-properties',
    pipelines: '/crm/v3/limits/pipelines',
    'custom-objects': '/crm/v3/limits/custom-object-types',
    'custom-object-types': '/crm/v3/limits/custom-object-types'
  };
  const target = routes[action];
  if (!target) fail(`Unknown limits action: ${action}`);
  printJson(await hubspotFetch(portal, 'GET', target, flags));
}

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
  CliExitError,
  runCli
};

if (require.main === module) {
  runCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    capture: false
  }).then((result) => {
    if (result.status !== 0) process.exit(result.status);
  }).catch((error) => {
    writeStderr(error.stack || error.message);
    process.exit(1);
  });
}
