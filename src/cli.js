#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  AUTH_FAMILIES,
  DEVELOPER_AUTH_SUBTYPES,
  endpointAuthRequirement
} = require('./auth');
const {
  commandLiteralPrefix,
  endpointDefinitionById,
  endpointDefinitions,
  endpointForCommandTokens,
  findEndpointDefinition,
  loadCatalogData,
  pathTemplateToRegex,
  summarizeCatalogCoverage
} = require('./catalog');
const { buildUsage } = require('./usage');
const {
  CliExitError,
  exitCli,
  fail,
  getCurrentRuntime,
  memoryStream,
  setCurrentRuntime,
  writeStderr,
  writeStdout
} = require('./runtime');
const {
  addFlag,
  boolFlag,
  configString,
  normalizeBatchIdInput,
  optionalBoolean,
  optionalNumber,
  parseArgs,
  parseBody,
  parseIdInputs,
  parseMaybeJson,
  parsePropertiesList,
  parseStringList,
  pathPart,
  pathTail,
  readArgumentText,
  readAtArgumentText,
  readStdinText,
  requireFlag,
  resolveHomeDirectory,
  expandUserPath,
  SAFE_METHODS,
  values
} = require('./flags');
const {
  JSONL_STREAMED,
  jsonlStreamFromFlags,
  jsonlStreamingRequested,
  outputOptionsFromFlags,
  parseNonNegativeIntegerFlag,
  printJson,
  redactTokenUrl,
  setCurrentOutputFlags
} = require('./output');
const {
  historyEnabled,
  historyFilePath,
  parseHistorySince,
  recordMutationHistory,
  setHistoryArgv
} = require('./history');
const {
  appendMappedSearchQuery,
  assertObjectBody,
  associationBatchBodyFromFlags,
  associationLimitBodyFromFlags,
  associationTypesBodyFromFlags,
  authBasePortal,
  authIntrospectBodyFromFlags,
  authRefreshBodyFromFlags,
  authRevokeBodyFromFlags,
  authTokenExchangeBodyFromFlags,
  authUrlFromFlags,
  batchArchiveBodyFromFlags,
  batchReadBodyFromFlags,
  batchWriteBodyFromFlags,
  bodyFromFlags,
  callingRecordingReadyBodyFromFlags,
  callingRecordingSettingsBodyFromFlags,
  callingTranscriptCreateBodyFromFlags,
  campaignBodyFromFlags,
  cmsBlogPostBodyFromFlags,
  cmsBlogPostListQueryFlags,
  cmsIndexedDataQueryFlags,
  cmsPageBodyFromFlags,
  cmsPageListQueryFlags,
  cmsRedirectBodyFromFlags,
  cmsScheduleBodyFromFlags,
  cmsSearchQueryFlags,
  conversationBodyFromFlags,
  eventDefinitionBodyFromFlags,
  eventOccurrencesQueryFlags,
  eventPropertyBodyFromFlags,
  eventSendBodyFromFlags,
  exportStartBodyFromFlags,
  fileImportUrlBodyFromFlags,
  fileMultipartFromFlags,
  fileSearchQueryFlags,
  fileUpdateBodyFromFlags,
  folderBodyFromFlags,
  folderSearchQueryFlags,
  formDefinitionBodyFromFlags,
  formListQueryFlags,
  formSubmissionBodyFromFlags,
  gdprDeleteBodyFromFlags,
  genericListQueryFlags,
  hubDbRowBodyFromFlags,
  hubDbTableBodyFromFlags,
  importMultipartFromFlags,
  inputsBodyFromFlags,
  listCreateBodyFromFlags,
  listMembershipBodyFromFlags,
  listSearchBodyFromFlags,
  mappedBodyFromFlags,
  marketingEmailBodyFromFlags,
  marketingEventBodyFromFlags,
  mergeBodyFromFlags,
  offsetsBodyFromFlags,
  pipelineStageBodyFromFlags,
  propertiesQueryFlags,
  propertyDefinitionBodyFromFlags,
  recordCreateBodyFromFlags,
  schedulerBookBodyFromFlags,
  schedulerBookingQueryFlags,
  schedulerCalendarBodyFromFlags,
  schedulerLinksQueryFlags,
  sequenceEnrollmentBodyFromFlags,
  sequenceQueryFlags,
  sourceCodeMultipartFromFlags,
  subscriptionBatchEmailsBodyFromFlags,
  subscriptionGenerateLinksBodyFromFlags,
  subscriptionQueryFlags,
  subscriptionStatusBodyFromFlags,
  transactionalEmailBodyFromFlags,
  webhookJournalSubscriptionBodyFromFlags,
  webhookSettingsBodyFromFlags,
  webhookSubscriptionBodyFromFlags,
  workflowGetQueryFlags,
} = require('./command-inputs');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = process.env.HSAPI_WORKSPACE_ROOT
  ? path.resolve(process.env.HSAPI_WORKSPACE_ROOT)
  : PACKAGE_ROOT;
const DEFAULT_CONFIG = path.join(WORKSPACE_ROOT, 'config', 'hubspot-portals.json');
const CATALOG_FILE = process.env.HSAPI_CATALOG_FILE || path.join(PACKAGE_ROOT, 'data', 'hubspot-api-catalog.json');
const TIERS_FILE = process.env.HSAPI_TIERS_FILE || path.join(PACKAGE_ROOT, 'data', 'hubspot-api-tiers.json');
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
  const previousRuntime = getCurrentRuntime();
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
  setCurrentRuntime(runtime);
  setCurrentOutputFlags({});
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
    setCurrentRuntime(previousRuntime);
    setCurrentOutputFlags({});
    restoreEnv();
  }
}
const CRM_OBJECT_TYPE_CATALOG = [
  {
    family: 'core',
    objectType: 'contacts',
    objectTypeId: '0-1',
    label: 'Contacts',
    aliases: ['contact'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts/guide'
  },
  {
    family: 'core',
    objectType: 'companies',
    objectTypeId: '0-2',
    label: 'Companies',
    aliases: ['company'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/companies/guide'
  },
  {
    family: 'core',
    objectType: 'deals',
    objectTypeId: '0-3',
    label: 'Deals',
    aliases: ['deal'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/deals/guide'
  },
  {
    family: 'core',
    objectType: 'tickets',
    objectTypeId: '0-5',
    label: 'Tickets',
    aliases: ['ticket'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/tickets/guide'
  },
  {
    family: 'commerce',
    objectType: 'products',
    objectTypeId: '0-7',
    label: 'Products',
    aliases: ['product'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/products/guide',
    notes: 'Common product library object. Frequently associated to line items.'
  },
  {
    family: 'commerce',
    objectType: 'line_items',
    objectTypeId: '0-8',
    label: 'Line items',
    aliases: ['line_item', 'line item', 'line items'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/line-items/guide',
    notes: 'Line items usually need name, quantity, and price, then associations to deals, quotes, invoices, or subscriptions.'
  },
  {
    family: 'commerce',
    objectType: 'quotes',
    objectTypeId: '0-14',
    label: 'Quotes',
    aliases: ['quote'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/quotes/guide',
    notes: 'Quote records usually sit in a commerce workflow with deals and line items.'
  },
  {
    family: 'commerce',
    objectType: 'invoices',
    objectTypeId: '0-53',
    label: 'Invoices',
    aliases: ['invoice'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/invoices/guide',
    notes: 'Invoice records depend on commerce/payment setup and should be tested in disposable portals first.'
  },
  {
    family: 'commerce',
    objectType: 'commerce_payments',
    objectTypeId: '0-101',
    label: 'Commerce payments',
    aliases: ['commerce_payment', 'payment', 'payments'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/commerce-payments/guide',
    notes: 'Payment records are tied to HubSpot payments or Stripe payment processing setup.'
  },
  {
    family: 'commerce',
    objectType: 'subscriptions',
    objectTypeId: '0-69',
    label: 'Commerce subscriptions',
    aliases: ['subscription', 'commerce_subscription', 'commerce subscriptions'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/commerce-subscriptions/guide',
    notes: 'Commerce subscriptions use the subscriptions object type, distinct from marketing communication preferences.'
  },
  {
    family: 'commerce',
    objectType: 'orders',
    objectTypeId: '0-123',
    label: 'Orders',
    aliases: ['order'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/orders/guide'
  },
  {
    family: 'commerce',
    objectType: 'carts',
    objectTypeId: '0-142',
    label: 'Carts',
    aliases: ['cart'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/carts/guide'
  },
  {
    family: 'commerce',
    objectType: 'fees',
    objectTypeId: '0-85',
    label: 'Fees',
    aliases: ['fee'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/fees/guide'
  },
  {
    family: 'commerce',
    objectType: 'discounts',
    objectTypeId: '0-84',
    label: 'Discounts',
    aliases: ['discount'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/discounts/guide'
  },
  {
    family: 'commerce',
    objectType: 'taxes',
    objectTypeId: '0-86',
    label: 'Taxes',
    aliases: ['tax'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/taxes/guide'
  },
  {
    family: 'commerce',
    objectType: 'listings',
    objectTypeId: '0-420',
    label: 'Listings',
    aliases: ['listing'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/listings/guide',
    notes: 'Optional object-library object. Check enablement before assuming records are available.'
  },
  {
    family: 'commerce',
    objectType: 'services',
    objectTypeId: '0-162',
    label: 'Services',
    aliases: ['service'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/services/guide',
    notes: 'Optional object-library object. Check enablement before assuming records are available.'
  },
  {
    family: 'activity',
    objectType: 'calls',
    objectTypeId: '0-48',
    label: 'Calls',
    aliases: ['call'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/calls/guide'
  },
  {
    family: 'activity',
    objectType: 'meetings',
    objectTypeId: '0-47',
    label: 'Meetings',
    aliases: ['meeting'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/meetings/guide'
  },
  {
    family: 'activity',
    objectType: 'notes',
    objectTypeId: '0-46',
    label: 'Notes',
    aliases: ['note'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/notes/guide'
  },
  {
    family: 'activity',
    objectType: 'emails',
    objectTypeId: '0-49',
    label: 'Emails',
    aliases: ['email'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/emails/guide'
  },
  {
    family: 'activity',
    objectType: 'tasks',
    objectTypeId: '0-27',
    label: 'Tasks',
    aliases: ['task'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/tasks/guide'
  },
  {
    family: 'activity',
    objectType: 'communications',
    objectTypeId: '0-18',
    label: 'Communications',
    aliases: ['communication'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/communications/guide'
  },
  {
    family: 'activity',
    objectType: 'postal_mail',
    objectTypeId: '0-116',
    label: 'Postal mail',
    aliases: ['postal mail', 'postal_mail'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/postal-mail/guide'
  },
  {
    family: 'activity',
    objectType: 'projects',
    objectTypeId: '0-970',
    label: 'Projects',
    aliases: ['project'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/projects/guide'
  },
  {
    family: 'optional',
    objectType: 'appointments',
    objectTypeId: '0-421',
    label: 'Appointments',
    aliases: ['appointment'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/appointments/guide',
    notes: 'Optional object-library object. Check enablement before assuming records are available.'
  },
  {
    family: 'optional',
    objectType: 'courses',
    objectTypeId: '0-410',
    label: 'Courses',
    aliases: ['course'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/courses/guide',
    notes: 'Optional object-library object. Check enablement before assuming records are available.'
  },
  {
    family: 'optional',
    objectType: 'leads',
    objectTypeId: '0-136',
    label: 'Leads',
    aliases: ['lead'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/leads/guide',
    notes: 'Optional object-library object. Check enablement before assuming records are available.'
  },
  {
    family: 'optional',
    objectType: 'feedback_submissions',
    objectTypeId: '0-19',
    label: 'Feedback submissions',
    aliases: ['feedback_submission', 'feedback submission', 'feedback submissions'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/feedback-submissions/guide'
  },
  {
    family: 'optional',
    objectType: 'goals',
    objectTypeId: '0-74',
    label: 'Goals',
    aliases: ['goal'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/goals/guide'
  },
  {
    family: 'optional',
    objectType: 'users',
    objectTypeId: '0-115',
    label: 'Users',
    aliases: ['user', 'owner', 'owners'],
    docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/users/guide'
  }
];

const CRM_OBJECT_TYPE_RESOLUTION_CACHE = new Map();

function normalizeCrmObjectLookupValue(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^hubspot[\s_-]+/, '')
    .replace(/['"`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function crmObjectLookupKeys(value) {
  const normalized = normalizeCrmObjectLookupValue(value);
  if (!normalized) return [];
  const keys = new Set([normalized]);
  for (const suffix of ['_object', '_objects', '_record', '_records']) {
    if (normalized.endsWith(suffix)) keys.add(normalized.slice(0, -suffix.length));
  }
  for (const key of [...keys]) {
    if (key.endsWith('ies')) keys.add(`${key.slice(0, -3)}y`);
    if (key.endsWith('s')) keys.add(key.slice(0, -1));
  }
  return [...keys].filter(Boolean);
}

function crmObjectCatalogEntryForOutput(entry) {
  const output = {
    family: entry.family,
    objectType: entry.objectType,
    objectTypeId: entry.objectTypeId,
    label: entry.label,
    docsUrl: entry.docsUrl
  };
  if (entry.aliases && entry.aliases.length) output.aliases = [...entry.aliases];
  if (entry.notes) output.notes = entry.notes;
  return output;
}

function standardCrmObjectTypeIndex() {
  const index = new Map();
  for (const entry of CRM_OBJECT_TYPE_CATALOG) {
    const valuesToIndex = [
      entry.objectType,
      entry.objectTypeId,
      entry.label,
      ...(entry.aliases || [])
    ];
    for (const value of valuesToIndex) {
      for (const key of crmObjectLookupKeys(value)) {
        if (!index.has(key)) index.set(key, entry);
      }
    }
  }
  return index;
}

const STANDARD_CRM_OBJECT_TYPE_INDEX = standardCrmObjectTypeIndex();

function resolveStandardCrmObjectType(input) {
  const trimmedInput = String(input || '').trim();
  for (const key of crmObjectLookupKeys(input)) {
    const entry = STANDARD_CRM_OBJECT_TYPE_INDEX.get(key);
    if (entry) {
      const suppliedObjectTypeId = trimmedInput === entry.objectTypeId;
      return {
        resolved: true,
        source: 'standard-catalog',
        input,
        objectType: entry.objectType,
        objectTypeId: entry.objectTypeId,
        pathObjectType: suppliedObjectTypeId ? entry.objectTypeId : entry.objectType,
        standard: true,
        catalogEntry: crmObjectCatalogEntryForOutput(entry)
      };
    }
  }
  return null;
}

function looksLikeCustomObjectTypeId(input) {
  return /^2-\d+$/i.test(String(input || '').trim());
}

function looksLikeFullyQualifiedCustomObjectName(input) {
  return /^p\d+_[a-z0-9_]+$/i.test(String(input || '').trim());
}

function unresolvedCrmObjectType(input) {
  const pathObjectType = String(input || '').trim();
  return {
    resolved: false,
    source: looksLikeCustomObjectTypeId(pathObjectType) ? 'custom-object-type-id'
      : (looksLikeFullyQualifiedCustomObjectName(pathObjectType) ? 'custom-fully-qualified-name' : 'unresolved'),
    input,
    objectType: pathObjectType,
    objectTypeId: looksLikeCustomObjectTypeId(pathObjectType) ? pathObjectType : null,
    pathObjectType,
    standard: false
  };
}

function resolveCrmObjectType(input) {
  const cacheKey = String(input || '').trim();
  if (CRM_OBJECT_TYPE_RESOLUTION_CACHE.has(cacheKey)) {
    return { ...CRM_OBJECT_TYPE_RESOLUTION_CACHE.get(cacheKey) };
  }
  const resolved = resolveStandardCrmObjectType(cacheKey) || unresolvedCrmObjectType(cacheKey);
  CRM_OBJECT_TYPE_RESOLUTION_CACHE.set(cacheKey, resolved);
  return { ...resolved };
}

function resolvedCrmPathObjectType(input) {
  return resolveCrmObjectType(input).pathObjectType;
}

function resolvedCrmObjectTypeIdOrInput(input) {
  const resolution = resolveCrmObjectType(input);
  return resolution.objectTypeId || resolution.pathObjectType;
}

function schemaLookupValues(schema) {
  if (!schema || typeof schema !== 'object') return [];
  const labels = schema.labels && typeof schema.labels === 'object' ? schema.labels : {};
  return [
    schema.objectTypeId,
    schema.fullyQualifiedName,
    schema.name,
    labels.singular,
    labels.plural
  ].filter(Boolean);
}

function customSchemaMatchesInput(schema, input) {
  const wanted = new Set(crmObjectLookupKeys(input));
  return schemaLookupValues(schema).some((value) => (
    crmObjectLookupKeys(value).some((key) => wanted.has(key))
  ));
}

async function resolveCrmObjectTypeWithCustomFallback(portal, input, flags) {
  const standard = resolveCrmObjectType(input);
  if (standard.resolved || standard.source !== 'unresolved') return standard;

  const lookup = await hubspotFetchAllowError(portal, 'GET', '/crm-object-schemas/2026-03/schemas', flags);
  if (!lookup.ok) {
    return {
      ...standard,
      customLookup: {
        attempted: true,
        available: false,
        status: lookup.status,
        statusText: lookup.statusText,
        note: accessNoteForError(lookup.url, lookup.status) || null
      }
    };
  }

  const schemas = lookup.data && Array.isArray(lookup.data.results) ? lookup.data.results : [];
  const match = schemas.find((schema) => customSchemaMatchesInput(schema, input));
  if (!match) {
    return {
      ...standard,
      customLookup: {
        attempted: true,
        available: true,
        matched: false,
        schemaCount: schemas.length
      }
    };
  }

  const objectTypeId = match.objectTypeId || match.fullyQualifiedName || standard.pathObjectType;
  return {
    resolved: true,
    source: 'custom-schema',
    input,
    objectType: objectTypeId,
    objectTypeId: match.objectTypeId || null,
    pathObjectType: objectTypeId,
    standard: false,
    customSchema: {
      objectTypeId: match.objectTypeId || null,
      fullyQualifiedName: match.fullyQualifiedName || null,
      name: match.name || null,
      labels: match.labels || null
    },
    customLookup: {
      attempted: true,
      available: true,
      matched: true,
      schemaCount: schemas.length
    }
  };
}

function usage() {
  return buildUsage(DEFAULT_CONFIG, CATALOG_FILE);
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

function assertConfigObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value;
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

// All command JSON flows through this small output layer so generic requests
// and typed helpers share projection, compact mode, and agent-safe budgets.

function commandHelpOutput(tokens) {
  const endpoint = endpointForCommandTokens(tokens, CATALOG_FILE);
  if (!endpoint) return null;
  return {
    ok: true,
    command: endpoint.command,
    endpointId: endpoint.id,
    family: endpoint.family,
    method: endpoint.method,
    path: endpoint.pathTemplate,
    risk: endpoint.risk,
    readOnlyPost: endpoint.readOnlyPost === true ? true : undefined,
    auth: endpoint.auth ? { family: endpoint.auth.family, subtype: endpoint.auth.subtype || null } : null,
    requiredScopes: endpoint.requiredScopes.length ? endpoint.requiredScopes : undefined,
    tierRequirement: endpoint.tierRequirement || undefined,
    docsUrl: endpoint.docsUrl || undefined,
    contextUrl: endpoint.contextUrl || undefined,
    argsDocumented: endpoint.args.length > 0,
    args: endpoint.args.length ? endpoint.args : undefined,
    note: endpoint.args.length
      ? undefined
      : 'No argspec documented for this command yet (issue #17 rollout in progress). Preview with --show-request before executing.'
  };
}

function runCommandHelp(tokens) {
  if (!tokens.length) {
    writeStdout(usage());
    return;
  }
  const output = commandHelpOutput(tokens);
  if (!output) {
    fail(`No catalog command matches "${tokens.join(' ')}". Discover commands with: hsapi catalog commands --pick commands[].command`);
  }
  printJson(output);
}

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

const MAX_RETRY_AFTER_MS = 15000;

function retryDelayMs(response, attempt = 0) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null && retryAfter !== '') {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      if (seconds <= 0) return 0;
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) + Math.floor(Math.random() * 100);
    }
  }
  return Math.min(200 * (attempt + 1), 1000) + Math.floor(Math.random() * 100);
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

function shouldRetryResponse(method, response, attempt, limit, options = {}) {
  if (attempt >= limit) return false;
  if (response.status !== 429 && response.status < 500) return false;
  // Safe HTTP methods are always retryable. Catalog-marked read-only POSTs
  // (CRM search and friends - HubSpot's tightest rate limit) are read
  // semantics over POST and are equally safe to retry.
  return SAFE_METHODS.has(method) || options.readOnlyPostRetry === true;
}

function readOnlyPostRetryOption(endpoint) {
  return {
    readOnlyPostRetry: Boolean(endpoint && endpoint.readOnlyPost === true && endpoint.risk === 'read')
  };
}

async function hubspotFetchResponse(url, options, method, retryOptions = {}) {
  const limit = safeRetryLimit();
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, options);
    if (!shouldRetryResponse(method, response, attempt, limit, retryOptions)) return response;
    await sleep(retryDelayMs(response, attempt));
  }
}

async function hubspotFetchAllowError(portal, method, inputPath, flags, body, endpointOverride = null) {
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

  const response = await hubspotFetchResponse(url, options, method, readOnlyPostRetryOption(endpoint));
  recordMutationHistory(portal, method, url, endpoint, response);
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = text;
    }
  }

  const output = {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    ...responseMeta(response),
    portal: portal.name,
    method,
    url: redactTokenUrl(url.toString())
  };
  if (response.ok) {
    output.data = payload;
  } else {
    output.response = redactSensitiveValue(payload);
    const accessNote = accessNoteForError(output.url, response.status);
    if (accessNote) output.note = accessNote;
  }
  return output;
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

  const response = await hubspotFetchResponse(url, options, method, readOnlyPostRetryOption(endpoint));
  recordMutationHistory(portal, method, url, endpoint, response);
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
  recordMutationHistory(portal, method, url, endpoint, response);
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

// Issue #21: --paginate --format jsonl streams one record per line page-by-page
// (flat memory, pipe-friendly). Records bypass processOutput, so projection and
// character budgets cannot combine with it; --max-results still applies.
const DEFAULT_PAGINATE_MAX_RESULTS = 1000;

function paginationBudgetFromFlags(flags) {
  const raw = parseNonNegativeIntegerFlag(flags['max-results'], 'max-results');
  if (raw === 0) return { maxResults: undefined, defaultCap: false };
  if (raw === undefined) return { maxResults: DEFAULT_PAGINATE_MAX_RESULTS, defaultCap: true };
  return { maxResults: raw, defaultCap: false };
}

async function collectPages(portal, method, inputPath, flags, body) {
  const stream = jsonlStreamFromFlags(flags);
  const { maxResults, defaultCap } = paginationBudgetFromFlags(flags);
  const firstUrl = buildUrl(portal, inputPath, flags);
  let after = firstUrl.searchParams.get('after');
  const results = [];
  let collected = 0;
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
      const remaining = maxResults === undefined ? Infinity : Math.max(maxResults - collected, 0);
      const accepted = data.results.length > remaining ? data.results.slice(0, remaining) : data.results;
      if (stream) {
        for (const record of accepted) writeStdout(JSON.stringify(record));
        stream.streamed += accepted.length;
      } else {
        results.push(...accepted);
      }
      collected += accepted.length;
      if (maxResults !== undefined) {
        const nextAfter = data && data.paging && data.paging.next && data.paging.next.after;
        if (data.results.length > remaining || (collected >= maxResults && nextAfter)) {
          truncated = true;
          truncation = {
            reason: 'max-results',
            path: 'results',
            maxResults,
            defaultCap: defaultCap || undefined,
            note: defaultCap ? 'Default pagination cap. Pass an explicit --max-results, or --max-results 0 for unlimited.' : undefined,
            returnedResultCount: collected,
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

  if (stream) {
    writeStderr(jsonlStreamSummary(collected, pageCount, truncated, truncation));
    return JSONL_STREAMED;
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

function jsonlStreamSummary(collected, pageCount, truncated, truncation) {
  const base = `jsonl: streamed ${collected} record(s) over ${pageCount} page(s)`;
  if (!truncated || !truncation) return base;
  if (truncation.reason === 'search-window') {
    return `${base} (stopped at HubSpot's ${CRM_SEARCH_WINDOW_LIMIT}-result search window; narrow the filters to fetch the rest)`;
  }
  return `${base} (stopped at --max-results ${truncation.maxResults}${truncation.defaultCap ? ' default cap; pass --max-results 0 for unlimited' : ''}; nextAfter ${truncation.nextAfter || 'n/a'})`;
}

const CRM_SEARCH_WINDOW_LIMIT = 10000;

async function collectSearchPages(portal, objectType, flags, baseBody) {
  const stream = jsonlStreamFromFlags(flags);
  const { maxResults, defaultCap } = paginationBudgetFromFlags(flags);
  const target = `/crm/objects/2026-03/${pathPart(objectType)}/search`;
  const results = [];
  let collected = 0;
  let after = baseBody.after;
  let pageCount = 0;
  let last = null;
  let truncated = false;
  let truncation = null;

  while (true) {
    const body = { ...baseBody };
    if (after === undefined || after === null) {
      delete body.after;
    } else {
      body.after = String(after);
    }
    last = await hubspotFetch(portal, 'POST', target, flags, body);
    pageCount += 1;

    const data = last.data;
    const pageResults = data && Array.isArray(data.results) ? data.results : [];
    const nextAfter = data && data.paging && data.paging.next && data.paging.next.after;

    const remaining = maxResults === undefined ? Infinity : Math.max(maxResults - collected, 0);
    const accepted = pageResults.length > remaining ? pageResults.slice(0, remaining) : pageResults;
    if (stream) {
      for (const record of accepted) writeStdout(JSON.stringify(record));
      stream.streamed += accepted.length;
    } else {
      results.push(...accepted);
    }
    collected += accepted.length;
    if (maxResults !== undefined && (pageResults.length > remaining || (collected >= maxResults && nextAfter))) {
      truncated = true;
      truncation = {
        reason: 'max-results',
        path: 'results',
        maxResults,
        defaultCap: defaultCap || undefined,
        note: defaultCap ? 'Default pagination cap. Pass an explicit --max-results, or --max-results 0 for unlimited.' : undefined,
        returnedResultCount: collected,
        fetchedPageResultCount: pageResults.length,
        pageCount,
        nextAfter: nextAfter || null
      };
      break;
    }

    if (!nextAfter) break;
    if (Number.isFinite(Number(nextAfter)) && Number(nextAfter) >= CRM_SEARCH_WINDOW_LIMIT) {
      truncated = true;
      truncation = {
        reason: 'search-window',
        message: `HubSpot CRM search only pages through the first ${CRM_SEARCH_WINDOW_LIMIT} results. Narrow the filters to fetch the rest.`,
        returnedResultCount: collected,
        pageCount,
        nextAfter: String(nextAfter)
      };
      break;
    }
    after = nextAfter;
  }

  if (stream) {
    writeStderr(jsonlStreamSummary(collected, pageCount, truncated, truncation));
    return JSONL_STREAMED;
  }

  const output = {
    ok: true,
    status: last.status,
    portal: portal.name,
    objectType,
    method: 'POST',
    url: redactTokenUrl(buildUrl(portal, target, { query: [] }).toString()),
    pageCount,
    resultCount: results.length,
    total: last.data && typeof last.data.total === 'number' ? last.data.total : undefined,
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
    limit: Number(flags.limit || options.defaultLimit || 10)
  };
  if (criteria.filterGroups.length) body.filterGroups = criteria.filterGroups;
  if (options.includeProperties !== false && criteria.properties.length) body.properties = criteria.properties;
  if (options.includePropertiesWithHistory !== false && criteria.propertiesWithHistory.length) {
    body.propertiesWithHistory = criteria.propertiesWithHistory;
  }
  if (criteria.sorts.length) body.sorts = criteria.sorts;
  if (criteria.query !== null) body.query = criteria.query;
  if (flags.after !== undefined) body.after = String(flags.after);
  return { body, criteria };
}

const CRM_FILTER_NO_VALUE_OPERATORS = new Set(['HAS_PROPERTY', 'NOT_HAS_PROPERTY']);
const CRM_FILTER_MULTI_VALUE_OPERATORS = new Set(['IN', 'NOT_IN']);

function parseCrmFilterExpression(raw) {
  const text = String(raw).trim();
  const parts = text.split(':');
  if (parts.length < 2 || !parts[0].trim() || !parts[1].trim()) {
    fail(`Invalid --filter "${raw}". Expected property:OP[:value], e.g. dealstage:EQ:closedwon, email:HAS_PROPERTY, dealstage:IN:a,b, amount:BETWEEN:1:100`);
  }
  const propertyName = parts[0].trim();
  const operator = parts[1].trim().toUpperCase();
  const valueParts = parts.slice(2);

  if (CRM_FILTER_NO_VALUE_OPERATORS.has(operator)) {
    if (valueParts.join(':').trim() !== '') {
      fail(`Invalid --filter "${raw}". ${operator} takes no value.`);
    }
    return { propertyName, operator };
  }

  if (!valueParts.length) {
    fail(`Invalid --filter "${raw}". ${operator} requires a value, e.g. ${propertyName}:${operator}:<value>`);
  }

  if (CRM_FILTER_MULTI_VALUE_OPERATORS.has(operator)) {
    const filterValues = valueParts.join(':').split(',').map((item) => item.trim()).filter(Boolean);
    if (!filterValues.length) {
      fail(`Invalid --filter "${raw}". ${operator} requires at least one comma-separated value.`);
    }
    return { propertyName, operator, values: filterValues };
  }

  if (operator === 'BETWEEN') {
    if (valueParts.length !== 2 || !valueParts[0].trim() || !valueParts[1].trim()) {
      fail(`Invalid --filter "${raw}". BETWEEN requires exactly two values: ${propertyName}:BETWEEN:<low>:<high>`);
    }
    return { propertyName, operator, value: valueParts[0].trim(), highValue: valueParts[1].trim() };
  }

  return { propertyName, operator, value: valueParts.join(':') };
}

function crmSearchCriteriaFromFlags(flags, options = {}) {
  const commandName = options.commandName || 'crm search';
  const rawFilters = values(flags.filter);
  const rawGroups = values(flags['filter-group']);
  if (rawFilters.length && rawGroups.length) {
    fail(`${commandName} accepts --filter or --filter-group, not both. Put every condition into --filter-group expressions when using OR groups.`);
  }

  let filterGroups;
  let defaultFilter = false;
  if (rawGroups.length) {
    filterGroups = rawGroups.map((groupRaw) => {
      const expressions = String(groupRaw).split(';').map((item) => item.trim()).filter(Boolean);
      if (!expressions.length) {
        fail(`Invalid --filter-group "${groupRaw}". Expected one or more ;-separated filter expressions.`);
      }
      return { filters: expressions.map(parseCrmFilterExpression) };
    });
  } else {
    let effectiveFilters = rawFilters;
    if (!effectiveFilters.length && options.defaultAllFilter === true) {
      effectiveFilters = ['hs_object_id:GT:0'];
      defaultFilter = true;
    }
    filterGroups = effectiveFilters.length
      ? [{ filters: effectiveFilters.map(parseCrmFilterExpression) }]
      : [];
  }

  if (!filterGroups.length && options.requireFilter !== false) {
    fail(`${commandName} requires at least one --filter property:OP[:value] or --filter-group "expr;expr"`);
  }

  const filters = filterGroups.length === 1 ? filterGroups[0].filters : [];
  const properties = parsePropertiesList(flags.properties);
  const propertiesWithHistory = parsePropertiesList(flags['properties-with-history']);
  const sorts = parseSearchSorts(flags.sort);
  return {
    filterGroups,
    filters,
    filterSummary: filterGroups.length === 1
      ? filterGroups[0].filters.map(formatCrmFilter)
      : filterGroups.map((group) => group.filters.map(formatCrmFilter)),
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
  if (Array.isArray(filter.values)) return `${filter.propertyName}:${filter.operator}:${filter.values.join(',')}`;
  if (filter.highValue !== undefined) return `${filter.propertyName}:${filter.operator}:${filter.value}:${filter.highValue}`;
  if (filter.value === undefined) return `${filter.propertyName}:${filter.operator}`;
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
  const allowed = new Set(['all', 'core', 'commerce', 'activity', 'optional']);
  if (!allowed.has(family)) fail('crm object-types --family must be core, commerce, activity, optional, or all.');
  const objectTypes = CRM_OBJECT_TYPE_CATALOG
    .filter((entry) => family === 'all' || entry.family === family)
    .map((entry) => crmObjectCatalogEntryForOutput(entry));
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

const PROJECT_BRIDGE_READ_COMMANDS = new Set([
  'list',
  'ls',
  'info',
  'list-builds',
  'logs',
  'validate',
  'lint'
]);

const PROJECT_BRIDGE_CONFIRM_COMMANDS = new Set([
  'upload',
  'deploy',
  'delete',
  'create',
  'init',
  'add',
  'download',
  'migrate',
  'install-deps',
  'update-deps'
]);

const PROJECT_BRIDGE_UNSUPPORTED_COMMANDS = new Set([
  'dev',
  'watch',
  'open',
  'profile',
  'profiles'
]);

const PROJECT_BRIDGE_INTERNAL_FLAGS = new Set([
  'account',
  'hs-bin',
  'yes',
  'show-request',
  'select',
  'pick',
  'raw-value',
  'ids-only',
  'names-only',
  'id-name-map',
  'compact',
  'max-results',
  'max-chars',
  'include-truncated',
  'agent'
]);

function projectBridgeHsBin(flags) {
  return String(flags['hs-bin'] || process.env.HSAPI_HS_BIN || 'hs');
}

function projectBridgeAccount(flags) {
  const account = configString(flags.account);
  if (!account) fail('hsapi project requires --account <account>. Refusing to rely on the HubSpot CLI default account.');
  return account;
}

function projectBridgeRedactText(text) {
  return String(text || '')
    .replace(/\/root\/\.hscli\/config\.yml/g, '~/.hscli/config.yml')
    .replace(/pat-[A-Za-z0-9_-]{20,}/g, 'pat-REDACTED')
    .replace(/(hapikey=)[A-Za-z0-9_-]+/gi, '$1REDACTED')
    .replace(/(access[_-]?token["':=\s]+)(?!REDACTED)[A-Za-z0-9._-]{16,}/gi, '$1REDACTED')
    .replace(/(refresh[_-]?token["':=\s]+)(?!REDACTED)[A-Za-z0-9._-]{16,}/gi, '$1REDACTED')
    .replace(/(client[_-]?secret["':=\s]+)(?!REDACTED)[A-Za-z0-9._-]{16,}/gi, '$1REDACTED')
    .replace(/(personal[_-]?access[_-]?key["':=\s]+)(?!REDACTED)[A-Za-z0-9._-]{16,}/gi, '$1REDACTED');
}

function projectBridgeNormalizeResult(action, result) {
  if (
    projectBridgeNormalizeAction(action) === 'list'
    && !result.ok
    && result.exitCode === 1
    && /no projects found/i.test(`${result.stderr}\n${result.stdout}`)
  ) {
    return {
      ...result,
      ok: true,
      normalized: true,
      empty: true,
      normalizedReason: 'no_projects_found'
    };
  }
  return result;
}

function projectBridgeTextSummary(text, maxLines = 80) {
  const redacted = projectBridgeRedactText(text).trim();
  if (!redacted) return { text: '', lineCount: 0, truncated: false };
  const lines = redacted.split(/\r?\n/);
  const selected = lines.slice(0, maxLines);
  return {
    text: selected.join('\n'),
    lineCount: lines.length,
    truncated: lines.length > selected.length
  };
}

function projectBridgeCommandPreview(hsBin, args) {
  return {
    binary: hsBin,
    args,
    display: ['hs', ...args].join(' ')
  };
}

function runHubSpotCliProjectCommand(hsBin, args, options = {}) {
  const useCmdShim = process.platform === 'win32' && !/\.(?:exe|com)$/i.test(hsBin);
  const command = useCmdShim ? (process.env.ComSpec || 'cmd.exe') : hsBin;
  const commandArgs = useCmdShim ? ['/d', '/c', hsBin, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  if (result.error) {
    return {
      ok: false,
      exitCode: null,
      error: result.error.code || result.error.message,
      stdout: '',
      stderr: projectBridgeRedactText(result.error.message || String(result.error))
    };
  }
  const stdout = projectBridgeTextSummary(result.stdout, options.maxLines || 120);
  const stderr = projectBridgeTextSummary(result.stderr, options.maxLines || 80);
  return {
    ok: result.status === 0,
    exitCode: result.status,
    signal: result.signal || null,
    stdout: stdout.text,
    stdoutLineCount: stdout.lineCount,
    stdoutTruncated: stdout.truncated,
    stderr: stderr.text,
    stderrLineCount: stderr.lineCount,
    stderrTruncated: stderr.truncated
  };
}

function projectBridgeFlagArg(flagName, value) {
  const flag = `--${flagName}`;
  if (value === true) return [flag];
  if (value === false) return [flag, 'false'];
  return [flag, String(value)];
}

function projectBridgeArgsFromFlags(flags) {
  const args = [];
  for (const [flagName, value] of Object.entries(flags)) {
    if (PROJECT_BRIDGE_INTERNAL_FLAGS.has(flagName)) continue;
    for (const item of values(value)) {
      args.push(...projectBridgeFlagArg(flagName, item));
    }
  }
  return args;
}

function projectBridgeNormalizeAction(action) {
  if (action === 'ls') return 'list';
  if (action === 'init') return 'create';
  return action;
}

function projectBridgeDelegatedArgs(action, rest, flags, account) {
  const normalizedAction = projectBridgeNormalizeAction(action);
  const args = ['project', normalizedAction, ...rest, ...projectBridgeArgsFromFlags(flags)];
  if (account) args.push('--account', account);
  return args;
}

function projectBridgeSafety(action) {
  if (PROJECT_BRIDGE_READ_COMMANDS.has(action)) {
    return {
      class: 'read_only_or_local_validation',
      requiresConfirmation: false,
      reason: 'Allowed project bridge command.'
    };
  }
  if (PROJECT_BRIDGE_CONFIRM_COMMANDS.has(action)) {
    return {
      class: 'mutating_or_local_write',
      requiresConfirmation: true,
      reason: 'This project command can create, upload, deploy, delete, download, migrate, or change local dependencies.'
    };
  }
  if (PROJECT_BRIDGE_UNSUPPORTED_COMMANDS.has(action)) {
    return {
      class: 'unsupported_interactive_or_browser',
      requiresConfirmation: true,
      unsupported: true,
      reason: 'This project command is interactive, long-running, browser-opening, deprecated, or better run directly with the official HubSpot CLI.'
    };
  }
  return {
    class: 'unknown_project_command',
    requiresConfirmation: true,
    unsupported: true,
    reason: 'Unknown project bridge command. Run the official HubSpot CLI directly or add explicit hsapi support first.'
  };
}

function projectBridgeBaseOutput(action, account, hsBin, args, safety) {
  return {
    delegated: true,
    delegatedTo: 'official_hubspot_cli',
    commandFamily: 'hs project',
    action,
    account: {
      selector: account,
      provenance: '--account',
      note: 'HubSpot Projects auth is owned by the official hs CLI account configuration, not hsapi portal bearer auth.'
    },
    safety,
    command: projectBridgeCommandPreview(hsBin, args)
  };
}

function projectBridgePreview(action, account, hsBin, args, safety, message, options = {}) {
  printJson({
    ok: options.ok === true,
    dryRun: true,
    showRequest: true,
    message,
    ...projectBridgeBaseOutput(action, account, hsBin, args, safety)
  });
}

async function runProjectDoctor(flags) {
  const hsBin = projectBridgeHsBin(flags);
  const account = projectBridgeAccount(flags);
  const bridgeArgs = projectBridgeArgsFromFlags(flags);
  const checks = [
    {
      id: 'hs_cli.version',
      label: 'HubSpot CLI version',
      args: ['--version']
    },
    {
      id: 'hs_cli.account_info',
      label: 'HubSpot CLI account info',
      args: ['accounts', 'info', account, ...bridgeArgs]
    },
    {
      id: 'hs_cli.project_list',
      label: 'HubSpot CLI project list',
      args: ['project', 'list', ...bridgeArgs, '--account', account]
    }
  ];
  const preview = checks.map((check) => ({
    id: check.id,
    label: check.label,
    command: projectBridgeCommandPreview(hsBin, check.args)
  }));
  if (boolFlag(flags, 'show-request')) {
    printJson({
      ok: true,
      dryRun: true,
      showRequest: true,
      message: 'Project doctor would run non-mutating official HubSpot CLI checks only.',
      delegated: true,
      delegatedTo: 'official_hubspot_cli',
      commandFamily: 'hs project',
      account: {
        selector: account,
        provenance: '--account'
      },
      checks: preview
    });
    return;
  }

  const results = checks.map((check) => {
    const result = projectBridgeNormalizeResult(
      check.id === 'hs_cli.project_list' ? 'list' : check.args[1],
      runHubSpotCliProjectCommand(hsBin, check.args, { maxLines: 60 })
    );
    return {
      id: check.id,
      label: check.label,
      status: result.ok ? 'pass' : 'fail',
      command: projectBridgeCommandPreview(hsBin, check.args),
      result
    };
  });
  const summary = results.reduce((counts, check) => {
    counts[check.status] = (counts[check.status] || 0) + 1;
    return counts;
  }, {});
  const ready = !summary.fail;
  printJson({
    ok: ready,
    ready,
    delegated: true,
    delegatedTo: 'official_hubspot_cli',
    commandFamily: 'hs project',
    message: ready
      ? 'Project bridge doctor checks passed.'
      : 'Project bridge doctor checks failed. Review the official HubSpot CLI account/auth output.',
    hsCli: {
      binary: hsBin,
      version: results[0] && results[0].result && results[0].result.stdout ? results[0].result.stdout.split(/\r?\n/)[0] : null
    },
    account: {
      selector: account,
      provenance: '--account',
      note: 'Project commands delegate to the official hs CLI. hsapi does not treat ~/.hscli/config.yml as portal bearer auth.'
    },
    summary,
    checks: results
  });
  if (!ready) exitCli(1);
}

async function runProjectBridge(action, rest, flags) {
  if (!action || action === 'help') {
    writeStdout(usage());
    return;
  }
  if (action === 'doctor' || action === 'diagnose') {
    await runProjectDoctor(flags);
    return;
  }

  const normalizedAction = projectBridgeNormalizeAction(action);
  const safety = projectBridgeSafety(action);
  const hsBin = projectBridgeHsBin(flags);
  const account = projectBridgeAccount(flags);
  const delegatedArgs = projectBridgeDelegatedArgs(action, rest, flags, account);
  const base = projectBridgeBaseOutput(normalizedAction, account, hsBin, delegatedArgs, safety);

  if (safety.unsupported) {
    printJson({
      ok: false,
      message: safety.reason,
      ...base
    });
    exitCli(1);
  }

  if (boolFlag(flags, 'show-request')) {
    projectBridgePreview(normalizedAction, account, hsBin, delegatedArgs, safety, 'Project bridge preview only. No HubSpot CLI command was executed.', { ok: true });
    return;
  }

  if (safety.requiresConfirmation && !boolFlag(flags, 'yes')) {
    projectBridgePreview(normalizedAction, account, hsBin, delegatedArgs, safety, 'Project bridge command blocked. Re-run with --yes to delegate to the official HubSpot CLI.');
    exitCli(2);
    return;
  }

  const result = projectBridgeNormalizeResult(normalizedAction, runHubSpotCliProjectCommand(hsBin, delegatedArgs));
  printJson({
    ok: result.ok,
    ...base,
    mutationConfirmed: safety.requiresConfirmation ? true : undefined,
    result
  });
  if (!result.ok) exitCli(result.exitCode || 1);
}

const GLOBAL_FLAG_NAMES = new Set([
  'portal', 'query', 'yes', 'show-request', 'show-secrets', 'help', 'json',
  'select', 'pick', 'raw-value', 'ids-only', 'names-only', 'id-name-map',
  'compact', 'agent', 'max-results', 'max-chars', 'include-truncated',
  'limit', 'after', 'before', 'offset', 'sort', 'archived', 'paginate',
  'properties', 'status', 'created-after', 'created-before', 'updated-after', 'updated-before',
  'format'
]);

function flagValidationDisabled() {
  const raw = (configString(process.env.HSAPI_FLAG_VALIDATION) || '').toLowerCase();
  return raw === '0' || raw === 'false' || raw === 'off';
}

// Issue #17: reject unknown or mistyped flags for catalog-documented commands.
// Unknown flags used to be silently ignored, so typos like --propeties produced
// confusing full-table output instead of an error.
function validateCommandFlags(positionals, flags) {
  if (flagValidationDisabled()) return;
  const endpoint = endpointForCommandTokens(positionals, CATALOG_FILE);
  if (!endpoint || !endpoint.args.length) return;

  const knownFlags = new Map();
  for (const arg of endpoint.args) {
    if (arg.kind === 'flag') knownFlags.set(arg.name, arg);
    for (const alias of arg.aliases) knownFlags.set(alias, arg);
  }

  const helpTokens = commandLiteralPrefix(endpoint.command).replace(/^hsapi /, '');
  const unknown = [];
  for (const [name, rawValue] of Object.entries(flags)) {
    const arg = knownFlags.get(name);
    if (!arg) {
      if (!GLOBAL_FLAG_NAMES.has(name)) unknown.push(name);
      continue;
    }
    for (const value of values(rawValue)) {
      if (arg.type === 'integer') {
        if (value === true || value === '' || !Number.isFinite(Number(value))) {
          fail(`--${name} expects an integer for "${endpoint.command}". Got ${value === true ? 'no value' : `"${value}"`}. Flags: hsapi help ${helpTokens}`);
        }
      } else if (arg.type === 'boolean') {
        if (!(value === true || value === 'true' || value === 'false')) {
          fail(`--${name} is a boolean flag for "${endpoint.command}". Pass it bare or as true/false; got "${value}".`);
        }
      } else if (value === true) {
        fail(`--${name} requires a value for "${endpoint.command}". Flags: hsapi help ${helpTokens}`);
      }
    }
  }

  if (unknown.length) {
    const label = unknown.length > 1 ? 'flags' : 'flag';
    fail(`Unknown ${label} ${unknown.map((name) => `--${name}`).join(', ')} for "${endpoint.command}". List flags with: hsapi help ${helpTokens} (set HSAPI_FLAG_VALIDATION=0 to bypass validation)`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const { positionals, flags } = parseArgs(argv);
  setCurrentOutputFlags(flags);
  setHistoryArgv(argv);
  const [area, action, ...rest] = positionals;

  if (!area) {
    writeStdout(usage());
    return;
  }

  if (area === 'help') {
    runCommandHelp([action, ...rest].filter((token) => token !== undefined));
    return;
  }

  if (boolFlag(flags, 'help')) {
    const helpOutput = commandHelpOutput(positionals);
    if (helpOutput) {
      printJson(helpOutput);
      return;
    }
    writeStdout(usage());
    return;
  }

  outputOptionsFromFlags(flags);
  validateCommandFlags(positionals, flags);
  if (jsonlStreamingRequested(flags) && !boolFlag(flags, 'paginate')) {
    fail('--format jsonl is a streaming mode for --paginate. Add --paginate (and optionally --max-results <n>).');
  }

  if (area === 'catalog') {
    await runCatalog(action);
    return;
  }

  if (area === 'history') {
    runHistory(flags);
    return;
  }

  if (area === 'upgrade') {
    await runUpgrade(flags);
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

  if (area === 'project' || area === 'projects') {
    await runProjectBridge(action, rest, flags);
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

  if (area === 'owners' || area === 'owner') {
    await runOwners(portal, action, rest, flags);
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

  if (action === 'resolve-object') {
    const input = rest.join(' ');
    if (!input) fail('crm resolve-object requires <name|objectTypeId>.');
    const resolution = boolFlag(flags, 'custom-fallback')
      ? await resolveCrmObjectTypeWithCustomFallback(portal, input, flags)
      : resolveCrmObjectType(input);
    printJson({
      ok: true,
      portal: portal.name,
      ...resolution
    });
    return;
  }

  const objectTypeInput = rest[0];
  if (!objectTypeInput) fail('Missing CRM object type.');
  const objectType = resolvedCrmPathObjectType(objectTypeInput);

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
    if (flags['search-body'] !== undefined) {
      if (boolFlag(flags, 'count-only')) {
        fail('crm search --search-body does not support --count-only; read data.total from the response instead.');
      }
      if (flags.filter !== undefined || flags['filter-group'] !== undefined) {
        fail('crm search --search-body cannot be combined with --filter or --filter-group.');
      }
      const body = assertObjectBody(parseBody(flags['search-body']), 'crm search --search-body');
      if (body.limit === undefined && flags.limit !== undefined) body.limit = optionalNumber(flags.limit);
      printJson(boolFlag(flags, 'paginate')
        ? await collectSearchPages(portal, objectType, flags, body)
        : await hubspotFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/search`, flags, body));
      return;
    }
    const countOnly = boolFlag(flags, 'count-only');
    const { body, criteria } = crmSearchRequestFromFlags(
      countOnly ? { ...flags, limit: 1 } : flags,
      countOnly ? { defaultLimit: 1, includeProperties: false, includePropertiesWithHistory: false } : {}
    );
    if (boolFlag(flags, 'paginate') && !countOnly) {
      printJson(await collectSearchPages(portal, objectType, flags, body));
      return;
    }
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
    printJson(await guardedFetch(portal, 'PATCH', `/crm/objects/2026-03/${pathPart(objectType)}/${pathPart(id)}`, flags, body));
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
  const objectTypeInput = rest[0];
  if (!objectTypeInput) fail('Missing object type.');
  const objectType = resolvedCrmPathObjectType(objectTypeInput);
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
  const [fromTypeInput, second, third, fourth] = rest;
  if (!fromTypeInput || !second) fail('Missing association arguments.');
  const fromType = resolvedCrmPathObjectType(fromTypeInput);

  if (action === 'types') {
    const toType = resolvedCrmPathObjectType(second);
    const result = await hubspotFetch(portal, 'GET', `/crm/associations/2026-03/${pathPart(fromType)}/${pathPart(toType)}/labels`, flags, undefined, endpointDefinitionById('associations.labels'));
    printJson(result);
    return;
  }

  if (action === 'list') {
    const fromId = second;
    if (!third) fail('associations list requires <fromType> <fromId> <toType>.');
    const toType = resolvedCrmPathObjectType(third);
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
    const toId = fourth;
    if (!third || !toId) fail('associations create-default requires <fromType> <fromId> <toType> <toId>.');
    const toType = resolvedCrmPathObjectType(third);
    printJson(await guardedFetch(portal, 'PUT', `/crm/objects/2026-03/${pathPart(fromType)}/${pathPart(fromId)}/associations/default/${pathPart(toType)}/${pathPart(toId)}`, flags));
    return;
  }

  if (action === 'create') {
    const fromId = second;
    const toId = fourth;
    if (!third || !toId) fail('associations create requires <fromType> <fromId> <toType> <toId>.');
    const toType = resolvedCrmPathObjectType(third);
    const body = associationTypesBodyFromFlags(flags);
    printJson(await guardedFetch(portal, 'PUT', `/crm/objects/2026-03/${pathPart(fromType)}/${pathPart(fromId)}/associations/${pathPart(toType)}/${pathPart(toId)}`, flags, body));
    return;
  }

  if (action === 'delete' || action === 'archive') {
    const fromId = second;
    const toId = fourth;
    if (!third || !toId) fail(`associations ${action} requires <fromType> <fromId> <toType> <toId>.`);
    const toType = resolvedCrmPathObjectType(third);
    printJson(await guardedFetch(portal, 'DELETE', `/crm/objects/2026-03/${pathPart(fromType)}/${pathPart(fromId)}/associations/${pathPart(toType)}/${pathPart(toId)}`, flags));
    return;
  }

  if (action === 'batch-read') {
    const toType = resolvedCrmPathObjectType(second);
    const body = { inputs: parseIdInputs(flags.ids, 'ids') };
    const result = await hubspotFetch(portal, 'POST', `/crm/associations/2026-03/${pathPart(fromType)}/${pathPart(toType)}/batch/read`, flags, body);
    printJson(result);
    return;
  }

  if (action === 'batch-create-default') {
    const toType = resolvedCrmPathObjectType(second);
    const body = associationBatchBodyFromFlags(flags, 'associations batch-create-default');
    printJson(await guardedFetch(portal, 'POST', `/crm/associations/2026-03/${pathPart(fromType)}/${pathPart(toType)}/batch/associate/default`, flags, body));
    return;
  }

  if (action === 'batch-create') {
    const toType = resolvedCrmPathObjectType(second);
    const body = associationBatchBodyFromFlags(flags, 'associations batch-create');
    printJson(await guardedFetch(portal, 'POST', `/crm/associations/2026-03/${pathPart(fromType)}/${pathPart(toType)}/batch/create`, flags, body));
    return;
  }

  if (action === 'batch-archive') {
    const toType = resolvedCrmPathObjectType(second);
    const body = associationBatchBodyFromFlags(flags, 'associations batch-archive');
    printJson(await guardedFetch(portal, 'POST', `/crm/associations/2026-03/${pathPart(fromType)}/${pathPart(toType)}/batch/archive`, flags, body));
    return;
  }

  if (action === 'batch-labels-archive') {
    const toType = resolvedCrmPathObjectType(second);
    const body = associationBatchBodyFromFlags(flags, 'associations batch-labels-archive');
    printJson(await guardedFetch(portal, 'POST', `/crm/associations/2026-03/${pathPart(fromType)}/${pathPart(toType)}/batch/labels/archive`, flags, body));
    return;
  }

  fail(`Unknown associations action: ${action}`);
}

async function runOwners(portal, action, rest, flags) {
  const base = '/crm/v3/owners';

  if (action === 'list') {
    const queryFlags = { ...flags, query: values(flags.query) };
    if (flags.email !== undefined) queryFlags.query.push(`email=${flags.email}`);
    if (flags.limit !== undefined) queryFlags.query.push(`limit=${flags.limit}`);
    if (flags.after !== undefined) queryFlags.query.push(`after=${flags.after}`);
    if (boolFlag(flags, 'archived')) queryFlags.query.push('archived=true');
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', base, queryFlags)
      : await hubspotFetch(portal, 'GET', base, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'get') {
    const ownerId = rest[0];
    if (!ownerId) fail('owners get requires <ownerId>.');
    const queryFlags = { ...flags, query: values(flags.query) };
    if (flags['id-property'] !== undefined) queryFlags.query.push(`idProperty=${flags['id-property']}`);
    if (boolFlag(flags, 'archived')) queryFlags.query.push('archived=true');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(ownerId)}`, queryFlags));
    return;
  }

  fail(`Unknown owners action: ${action}`);
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
  const objectTypeInput = rest[0];
  if (!objectTypeInput) fail('property-groups requires <objectType>.');
  const objectType = resolvedCrmPathObjectType(objectTypeInput);
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
  const [objectTypeInput, propertyName, ruleType] = rest;
  if (!objectTypeInput) fail('property-validations requires <objectType>.');
  const objectType = resolvedCrmPathObjectType(objectTypeInput);

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
    const objectTypeInput = rest[0];
    const resolution = objectTypeInput ? resolveCrmObjectType(objectTypeInput) : null;
    const objectTypeId = resolution && resolution.objectTypeId ? resolution.objectTypeId : objectTypeInput;
    const target = objectTypeInput
      ? `/crm/object-library/2026-03/enablement/${pathPart(objectTypeId)}`
      : '/crm/object-library/2026-03/enablement';
    printJson(await hubspotFetch(portal, 'GET', target, flags));
    return;
  }

  fail(`Unknown object-library action: ${action}`);
}

async function runAssociationLabels(portal, action, rest, flags) {
  const [fromTypeInput, toTypeInput, typeId] = rest;
  if (!fromTypeInput || !toTypeInput) fail('association-labels requires <fromType> <toType>.');
  const fromType = resolvedCrmPathObjectType(fromTypeInput);
  const toType = resolvedCrmPathObjectType(toTypeInput);
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
  const [fromTypeInput, toTypeInput] = rest;
  if (!fromTypeInput || !toTypeInput) fail('association-limits requires <fromType> <toType>.');
  const fromType = resolvedCrmPathObjectType(fromTypeInput);
  const toType = resolvedCrmPathObjectType(toTypeInput);
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
  const objectTypeInput = rest[0];
  if (!objectTypeInput) fail('pipelines requires <objectType>.');
  const objectType = resolvedCrmPathObjectType(objectTypeInput);
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
    const [objectTypeIdInput, listName] = rest;
    if (!objectTypeIdInput || !listName) fail('lists get-by-name requires <objectTypeId> <listName>.');
    const objectTypeId = resolvedCrmObjectTypeIdOrInput(objectTypeIdInput);
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
    const [objectTypeIdInput, recordId] = rest;
    if (!objectTypeIdInput || !recordId) fail('lists record-memberships requires <objectTypeId> <recordId>.');
    const objectTypeId = resolvedCrmObjectTypeIdOrInput(objectTypeIdInput);
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
  if (action === 'flows' || action === 'flow') {
    await runAutomationFlows(portal, rest, flags);
    return;
  }

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

// Automation v4 flows (issue #24): CRUD parity with HubSpot's official Agent
// CLI. Update is a full-document PUT - fetch the flow, edit, and send it back
// with the current revisionId.
async function runAutomationFlows(portal, rest, flags) {
  const action = rest[0];
  const actionRest = rest.slice(1);
  const base = '/automation/v4/flows';

  if (action === 'list') {
    const queryFlags = appendMappedSearchQuery(flags, { limit: 'limit', after: 'after' });
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', base, queryFlags)
      : await hubspotFetch(portal, 'GET', base, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'get') {
    const flowId = actionRest[0] || flags['flow-id'];
    if (!flowId) fail('automation flows get requires <flowId> or --flow-id.');
    printJson(await hubspotFetch(portal, 'GET', `${base}/${pathPart(flowId)}`, flags));
    return;
  }

  if (action === 'email-campaigns') {
    const queryFlags = appendMappedSearchQuery(flags, { limit: 'limit', after: 'after' });
    printJson(await hubspotFetch(portal, 'GET', `${base}/email-campaigns`, queryFlags));
    return;
  }

  if (action === 'batch-read') {
    const explicitBody = parseBody(flags.body);
    const body = explicitBody !== undefined ? explicitBody : {
      inputs: parseStringList(requireFlag(flags, 'ids'), 'ids')
        .map((flowId) => ({ type: 'FLOW_ID', flowId: String(flowId) }))
    };
    printJson(await guardedFetch(portal, 'POST', `${base}/batch/read`, flags, body, { readOnly: true }));
    return;
  }

  if (action === 'create') {
    const body = parseBody(flags.body || flags.flow);
    if (!body) fail('automation flows create requires --body <json|@file> (full flow definition).');
    printJson(await guardedFetch(portal, 'POST', base, flags, body));
    return;
  }

  if (action === 'update') {
    const flowId = actionRest[0] || flags['flow-id'];
    if (!flowId) fail('automation flows update requires <flowId> or --flow-id.');
    const body = parseBody(flags.body || flags.flow);
    if (!body) fail('automation flows update requires --body <json|@file> (full flow document including current revisionId).');
    printJson(await guardedFetch(portal, 'PUT', `${base}/${pathPart(flowId)}`, flags, body));
    return;
  }

  if (action === 'delete' || action === 'archive') {
    const flowId = actionRest[0] || flags['flow-id'];
    if (!flowId) fail(`automation flows ${action} requires <flowId> or --flow-id.`);
    if (!boolFlag(flags, 'danger-delete-flow')) {
      fail('automation flows delete requires --danger-delete-flow plus --yes (deleted flows are unrecoverable after 90 days).');
    }
    printJson(await guardedFetch(portal, 'DELETE', `${base}/${pathPart(flowId)}`, flags));
    return;
  }

  fail(`Unknown automation flows action: ${action}`);
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
  if (action === 'doctor' || action === 'diagnose') {
    await runCmsDoctor(portal, flags);
    return;
  }

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

function cmsDoctorCheckDefinitions(flags = {}) {
  const searchTerm = flags.q !== undefined ? flags.q : (flags.search !== undefined ? flags.search : 'hsapi-doctor');
  const contentId = flags['content-id'] || flags.contentId || flags.id || null;
  const indexedDataType = flags.type || flags['content-type'] || 'SITE_PAGE';
  const listQuery = ['limit=1'];
  return [
    {
      id: 'domains',
      label: 'Domains',
      command: 'hsapi cms domains list',
      method: 'GET',
      path: '/cms/domains/2026-03',
      query: listQuery,
      endpointId: 'cms.domains.list'
    },
    {
      id: 'site_pages',
      label: 'Site pages',
      command: 'hsapi cms site-pages list',
      method: 'GET',
      path: '/cms/pages/2026-03/site-pages',
      query: listQuery,
      endpointId: 'cms.pages.site.list'
    },
    {
      id: 'landing_pages',
      label: 'Landing pages',
      command: 'hsapi cms landing-pages list',
      method: 'GET',
      path: '/cms/pages/2026-03/landing-pages',
      query: listQuery,
      endpointId: 'cms.pages.landing.list'
    },
    {
      id: 'blog_posts',
      label: 'Blog posts',
      command: 'hsapi cms blog-posts list',
      method: 'GET',
      path: '/cms/blogs/2026-03/posts',
      query: listQuery,
      endpointId: 'cms.blogs.posts.list'
    },
    {
      id: 'url_redirects',
      label: 'URL redirects',
      command: 'hsapi cms redirects list',
      method: 'GET',
      path: '/cms/url-redirects/2026-03',
      query: listQuery,
      endpointId: 'cms.url_redirects.list'
    },
    {
      id: 'site_search',
      label: 'Site search',
      command: 'hsapi cms search',
      method: 'GET',
      path: '/cms/site-search/2026-03/search',
      query: [`q=${String(searchTerm)}`, 'limit=1'],
      endpointId: 'cms.site_search.search'
    },
    {
      id: 'indexed_data',
      label: 'Indexed data',
      command: 'hsapi cms indexed-data',
      method: 'GET',
      path: contentId ? `/cms/site-search/2026-03/indexed-data/${pathPart(contentId)}` : null,
      query: [`type=${String(indexedDataType)}`],
      endpointId: 'cms.site_search.indexed_data',
      skipped: !contentId,
      skipReason: 'Provide --content-id <id> to check indexed-data for a specific CMS object.'
    }
  ];
}

function cmsDoctorPlannedRequest(portal, check) {
  if (check.skipped) return null;
  const url = buildUrl(portal, check.path, { query: check.query || [] });
  return {
    method: check.method,
    url: redactTokenUrl(url.toString()),
    pathname: url.pathname,
    query: queryObjectForDisplay(url)
  };
}

function cmsDoctorMessageFromResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  return configString(response.message)
    || configString(response.error_description)
    || configString(response.error)
    || configString(response.category)
    || null;
}

function cmsDoctorCapabilityFromResult(result) {
  if (result.ok) return 'success';
  const category = String(hubSpotResponseCategory(result.response) || '').toUpperCase();
  const message = cmsDoctorMessageFromResponse(result.response) || '';
  const haystack = `${category} ${message} ${JSON.stringify(result.response || {})}`.toLowerCase();

  if (result.status === 401) return 'invalid_authentication';
  if (result.status === 403) {
    if (category.includes('MISSING_SCOPE') || /\bscope\b|\bpermission\b|not authorized|forbidden/.test(haystack)) {
      return 'missing_scopes_or_permissions';
    }
    if (/tier|subscription|account.*access|doesn.t have access|not available|not enabled|feature/.test(haystack)) {
      return 'unavailable_feature_or_tier';
    }
    return 'missing_scopes_or_permissions';
  }
  if (result.status === 404 && /not found|not available|not enabled|feature/.test(haystack)) {
    return 'unavailable_feature_or_tier';
  }
  return 'unexpected_api_failure';
}

function cmsDoctorStatusFromCapability(capability) {
  if (capability === 'success') return 'pass';
  if (capability === 'missing_scopes_or_permissions' || capability === 'unavailable_feature_or_tier') return 'warn';
  return 'fail';
}

function cmsDoctorResultCount(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (typeof data.total === 'number') return data.total;
  if (typeof data.totalCount === 'number') return data.totalCount;
  if (Array.isArray(data.results)) return data.results.length;
  if (Array.isArray(data.objects)) return data.objects.length;
  return null;
}

function cmsDoctorAuthPreview(portal, checks) {
  const check = checks.find((item) => !item.skipped);
  if (!check) return null;
  const endpoint = endpointDefinitionById(check.endpointId);
  const auth = requestAuthMetadata(portal, endpoint);
  return {
    authFamily: auth.family,
    authSubtype: auth.subtype,
    provenance: auth.provenance,
    endpointId: auth.endpointId,
    scopes: auth.scopes,
    credentialSource: auth.credentialSource
  };
}

async function runCmsDoctorCheck(portal, check) {
  if (check.skipped) {
    return {
      id: check.id,
      label: check.label,
      command: check.command,
      endpointId: check.endpointId,
      status: 'skip',
      capability: 'skipped',
      ok: true,
      skipped: true,
      message: check.skipReason
    };
  }

  const endpoint = endpointDefinitionById(check.endpointId);
  const request = cmsDoctorPlannedRequest(portal, check);
  const result = await hubspotFetchAllowError(
    portal,
    check.method,
    check.path,
    { query: check.query || [] },
    undefined,
    endpoint
  );
  const capability = cmsDoctorCapabilityFromResult(result);
  const status = cmsDoctorStatusFromCapability(capability);
  const output = {
    id: check.id,
    label: check.label,
    command: check.command,
    endpointId: check.endpointId,
    status,
    capability,
    ok: result.ok,
    httpStatus: result.status,
    request
  };
  const category = hubSpotResponseCategory(result.response);
  if (category) output.category = category;
  const message = cmsDoctorMessageFromResponse(result.response);
  if (message) output.message = message;
  if (result.note) output.note = result.note;
  const resultCount = cmsDoctorResultCount(result.data);
  if (resultCount !== null) output.resultCount = resultCount;
  return output;
}

async function runCmsDoctor(portal, flags) {
  const checks = cmsDoctorCheckDefinitions(flags);
  const auth = cmsDoctorAuthPreview(portal, checks);
  const plannedChecks = checks.map((check) => ({
    id: check.id,
    label: check.label,
    command: check.command,
    endpointId: check.endpointId,
    skipped: Boolean(check.skipped),
    skipReason: check.skipped ? check.skipReason : undefined,
    request: cmsDoctorPlannedRequest(portal, check)
  }));

  if (boolFlag(flags, 'show-request')) {
    printJson({
      ok: true,
      dryRun: true,
      showRequest: true,
      command: 'hsapi cms doctor',
      message: 'CMS doctor would run read-only GET checks only.',
      portal: {
        name: portal.name,
        label: portal.label,
        portalId: portal.portalId,
        baseUrl: portal.baseUrl
      },
      auth,
      checks: plannedChecks
    });
    return;
  }

  const results = [];
  for (const check of checks) {
    results.push(await runCmsDoctorCheck(portal, check));
  }
  const summary = results.reduce((counts, check) => {
    counts[check.capability] = (counts[check.capability] || 0) + 1;
    counts[check.status] = (counts[check.status] || 0) + 1;
    return counts;
  }, {});
  const ready = !summary.warn && !summary.fail;
  printJson({
    ok: true,
    ready,
    command: 'hsapi cms doctor',
    message: ready
      ? 'CMS diagnostic checks passed.'
      : 'CMS diagnostic completed with warnings or failures. Review checks for missing scopes, unavailable features, or unexpected API failures.',
    portal: {
      name: portal.name,
      label: portal.label,
      portalId: portal.portalId,
      baseUrl: portal.baseUrl
    },
    auth,
    summary,
    checks: results
  });
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
