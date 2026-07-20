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
const {
  hubSpotResponseCategory,
  loadConfig,
  maybeResolvePortalBearerProfile,
  redactedOAuthTokenCacheContract,
  requestAuthMetadata,
  resolveAgentCliProfile,
  resolveDeveloperProfile,
  resolveOAuthProfile,
  resolvePortal,
  resolveProfileDefaultFamily,
  resolveRequestCredential,
} = require('./auth-resolvers');
const {
  buildUrl,
  collectPages,
  collectSearchPages,
  guardedExternalBearerJsonFetch,
  guardedExternalNoAuthFormFetch,
  guardedExternalNoAuthJsonFetch,
  guardedFetch,
  guardedMultipartFetch,
  hubspotFetch,
  hubspotFetchAllowError,
  hubspotMultipartFetch,
  previewMutation,
  queryObjectForDisplay,
  requireCatalogReadOnlyPost,
} = require('./request');
const {
  crmObjectTypesFromFlags,
  runAccount,
  runAssociationLabels,
  runAssociationLimits,
  runAssociations,
  runAuth,
  runAutomation,
  runBusinessUnits,
  runCatalog,
  runCms,
  runConversations,
  runCrm,
  runCurrencies,
  runEmailEvents,
  runEvents,
  runExports,
  runExtensions,
  runFiles,
  runForms,
  runHistory,
  runImports,
  runLimits,
  runLists,
  runMarketing,
  runObjectLibrary,
  runOwners,
  runPipelines,
  runProjectBridge,
  runAgentCliBridge,
  runAgentCliDoctor,
  runProperties,
  runPropertyGroups,
  runPropertyValidations,
  runQuotes,
  runScheduler,
  runSchemas,
  runSubscriptions,
  runTiers,
  runUpgrade,
  runUsers,
  runWebhookJournal,
  runWebhooks,
} = require('./commands');
const {
  accessNoteForError,
  extractFeaturesByTier,
  globalApiSurfaceSummary,
  loadTiersData,
  normalizeTierName,
  tier403Note
} = require('./tiers');
const {
  CATALOG_FILE,
  DEFAULT_CONFIG,
  PACKAGE_ROOT,
  TIERS_FILE,
  WORKSPACE_ROOT
} = require('./config-paths');
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
  readJsonFile,
  assertConfigObject,
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
function usage() {
  return buildUsage(DEFAULT_CONFIG, CATALOG_FILE);
}
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
      const agentCli = resolveAgentCliProfile(portal, name);
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
      if (agentCli) profile.agentCli = agentCli;
      if (oauth) {
        const oauthMetadata = {
          mode: oauth.mode,
          tokenCache: redactedOAuthTokenCacheContract(oauth)
        };
        if (oauth.mode === 'hosted_broker') {
          oauthMetadata.brokerUrl = oauth.brokerUrl;
        } else {
          oauthMetadata.clientIdEnv = oauth.clientIdEnv;
          oauthMetadata.clientIdPresent = Boolean(
            oauth.clientIdEnv && process.env[oauth.clientIdEnv]
          );
          oauthMetadata.clientSecretEnv = oauth.clientSecretEnv;
          oauthMetadata.clientSecretPresent = Boolean(
            oauth.clientSecretEnv && process.env[oauth.clientSecretEnv]
          );
          oauthMetadata.refreshTokenEnv = oauth.refreshTokenEnv;
          oauthMetadata.refreshTokenPresent = Boolean(
            oauth.refreshTokenEnv && process.env[oauth.refreshTokenEnv]
          );
        }
        profile.oauth = oauthMetadata;
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

  if (area === 'agent-cli' && (action === 'doctor' || action === 'diagnose')) {
    await runAgentCliDoctor(portal, flags);
    return;
  }

  if (area === 'reports' || area === 'views') {
    await runAgentCliBridge(portal, area, action, rest, flags);
    return;
  }

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

  if (area === 'users' || area === 'user') {
    await runUsers(portal, action, rest, flags);
    return;
  }

  if (area === 'account') {
    await runAccount(portal, action, flags);
    return;
  }

  if (area === 'email-events' || area === 'email-event') {
    await runEmailEvents(portal, action, rest, flags);
    return;
  }

  if (area === 'currencies' || area === 'currency') {
    await runCurrencies(portal, action, flags);
    return;
  }

  if (area === 'business-units' || area === 'business-unit') {
    await runBusinessUnits(portal, action, rest, flags);
    return;
  }

  if (area === 'quotes' || area === 'quote') {
    await runQuotes(portal, action, rest, flags);
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
