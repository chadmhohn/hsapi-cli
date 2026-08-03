#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function stripJsonComments(source) {
  let output = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (current === '\n') {
        lineComment = false;
        output += current;
      }
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false;
        index += 1;
      } else if (current === '\n') {
        output += current;
      }
      continue;
    }
    if (!inString && current === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (!inString && current === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    output += current;
    if (inString) {
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === '"') inString = false;
    } else if (current === '"') {
      inString = true;
    }
  }
  return output;
}

function readJson(relativePath, allowComments = false) {
  const text = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  return JSON.parse(allowComments ? stripJsonComments(text) : text);
}

function scopes(value, label) {
  assert.strictEqual(typeof value, 'string', `${label} must be a scope string`);
  const parsed = value.split(/\s+/).filter(Boolean);
  assert.strictEqual(new Set(parsed).size, parsed.length, `${label} contains duplicate scopes`);
  return parsed;
}

function assertSameSet(actual, expected, label) {
  assert.deepStrictEqual([...actual].sort(), [...expected].sort(), label);
}

function configVariants(config) {
  return [
    ['default', config.vars],
    ...Object.entries(config.env || {}).map(([name, entry]) => [name, entry.vars]),
  ];
}

function assertBrokerConfig(config, role, requiredScopes, optionalScopes, label) {
  for (const [environment, vars] of configVariants(config)) {
    assert(vars, `${label} ${environment} is missing vars`);
    assert.strictEqual(vars.HSAPI_BROKER_ROLE, role, `${label} ${environment} broker role drifted`);
    assertSameSet(scopes(vars.HUBSPOT_REQUIRED_SCOPES, `${label} ${environment} required scopes`), requiredScopes, `${label} ${environment} required scopes drifted`);
    assertSameSet(scopes(vars.HUBSPOT_OPTIONAL_SCOPES, `${label} ${environment} optional scopes`), optionalScopes, `${label} ${environment} optional scopes drifted`);
    const remoteCallbacks = String(vars.HSAPI_ALLOWED_REMOTE_COMPLETION_REDIRECT_URIS || '').trim();
    assert.strictEqual(Boolean(remoteCallbacks), role === 'remote', `${label} ${environment} callback boundary drifted`);
    assert(!Object.prototype.hasOwnProperty.call(vars, 'HUBSPOT_CLIENT_SECRET'), `${label} ${environment} must not store a client secret in vars`);
  }
}

function assertPublicAppConfig(app, requiredScopes, optionalScopes, label) {
  assert.strictEqual(app.type, 'app', `${label} must be an app component`);
  assert(app.config, `${label} is missing config`);
  assert.strictEqual(app.config.distribution, 'marketplace', `${label} must use marketplace distribution`);
  assert.strictEqual(app.config.isUserLevel, true, `${label} must remain user-level`);
  assert(app.config.auth, `${label} is missing auth config`);
  assert.strictEqual(app.config.auth.type, 'oauth', `${label} must use OAuth`);
  assertSameSet(app.config.auth.requiredScopes, requiredScopes, `${label} required scopes drifted`);
  assertSameSet(app.config.auth.optionalScopes, optionalScopes, `${label} optional scopes drifted`);
  assert(!app.config.auth.optionalScopes.some((scope) => scope.startsWith('cpq.price_books.')), `${label} must exclude ServiceKey-only Price Books scopes`);
}

function main() {
  const appManifest = readJson('data/hubspot-oauth-apps.json');
  const broadScopes = appManifest.scopeProfiles.broadPublicAppOptional;
  const remoteReadScopes = appManifest.scopeProfiles.remoteReadRequest;
  const remoteWriteScopes = appManifest.scopeProfiles.remoteWriteRequest;
  const remoteRequestedScopes = [...remoteReadScopes, ...remoteWriteScopes];
  const customObjectCandidates = appManifest.scopeRecheckCandidates.customObjects;
  const newPublicApiCandidates = appManifest.scopeRecheckCandidates.newPublicApis;
  const localApp = readJson(appManifest.apps.localHostedOAuth.appProjectConfig);
  const remoteApp = readJson(appManifest.apps.remoteMcpOAuth.appProjectConfig);
  const localBroker = readJson('cloudflare/hsapi-oauth-broker/wrangler.jsonc', true);
  const remoteBroker = readJson('cloudflare/hsapi-oauth-broker/wrangler.remote.jsonc', true);
  const remoteConnector = readJson('cloudflare/hsapi-remote-mcp/wrangler.jsonc', true);

  assertSameSet(broadScopes, [...new Set(broadScopes)], 'broad public-app scope profile contains duplicates');
  assertSameSet(remoteReadScopes, [...new Set(remoteReadScopes)], 'remote read scope profile contains duplicates');
  assertSameSet(remoteWriteScopes, [...new Set(remoteWriteScopes)], 'remote write scope profile contains duplicates');
  assertSameSet(remoteRequestedScopes, [...new Set(remoteRequestedScopes)], 'remote request scope profiles overlap');
  assert(remoteReadScopes.every((scope) => broadScopes.includes(scope)), 'remote read scopes must be a subset of the public-app scope profile');
  assert(remoteWriteScopes.every((scope) => broadScopes.includes(scope)), 'remote write scopes must be a subset of the public-app scope profile');
  assert(remoteReadScopes.includes('crm.objects.contracts.read'), 'remote read profile must include Contracts read');
  assert(remoteReadScopes.includes('settings.users.teams.read'), 'remote read profile must include Teams read');
  assert(remoteReadScopes.includes('automation.sequences.read'), 'remote read profile must include Sequences read');
  assert(remoteWriteScopes.includes('automation.sequences.enrollments.write'), 'remote write profile must include Sequences enrollment write');
  assertSameSet(customObjectCandidates, [
    'crm.objects.custom.read',
    'crm.objects.custom.write',
    'crm.schemas.custom.read',
    'crm.schemas.custom.write',
  ], 'custom-object scope recheck candidates drifted');
  assert(!broadScopes.some((scope) => customObjectCandidates.includes(scope)), 'unrecognized custom-object scopes must not enter the active public-app profile');
  assert(!remoteReadScopes.some((scope) => customObjectCandidates.includes(scope)), 'unrecognized custom-object scopes must not enter the active remote request');
  assert(!remoteWriteScopes.some((scope) => customObjectCandidates.includes(scope)), 'unrecognized custom-object scopes must not enter the active remote request');
  assertSameSet(newPublicApiCandidates, [
    'crm.objects.commercepayments.read',
    'sales-templates-public-read',
    'sales-templates-public-write',
    'settings.users.teams.write',
  ], 'new public-API scope recheck candidates drifted');
  assert(!broadScopes.some((scope) => newPublicApiCandidates.includes(scope)), 'rejected public-API scopes must not enter the active public-app profile');
  assert(!remoteReadScopes.some((scope) => newPublicApiCandidates.includes(scope)), 'rejected public-API scopes must not enter the active remote read request');
  assert(!remoteWriteScopes.some((scope) => newPublicApiCandidates.includes(scope)), 'rejected public-API scopes must not enter the active remote write request');
  assert(!remoteReadScopes.some((scope) => scope.endsWith('.write')), 'remote read profile must exclude write scopes');
  assert(remoteWriteScopes.every((scope) => scope.endsWith('.write')), 'remote write profile must contain only write scopes');
  assert(remoteWriteScopes.includes('crm.objects.marketing_events.write'), 'remote write profile must include Marketing Events write');
  assert(!remoteWriteScopes.includes('cpq.quotes.write'), 'remote write profile must exclude CPQ quote authority without a matching verified endpoint');
  assert(!broadScopes.some((scope) => scope.startsWith('cpq.price_books.')), 'public-app scope profile must exclude ServiceKey-only Price Books scopes');
  assert(!remoteReadScopes.some((scope) => scope.startsWith('cpq.price_books.')), 'remote read profile must exclude ServiceKey-only Price Books scopes');
  assert(!remoteWriteScopes.some((scope) => scope.startsWith('cpq.price_books.')), 'remote write profile must exclude ServiceKey-only Price Books scopes');
  assert(!broadScopes.includes('crm.objects.contracts.write'), 'an unpublished Contracts write scope must not be guessed');

  assertPublicAppConfig(localApp, ['oauth'], broadScopes, 'local public app');
  assertPublicAppConfig(remoteApp, ['oauth'], broadScopes, 'remote public app');
  assert.notStrictEqual(localApp.uid, remoteApp.uid, 'local and remote app component UIDs must be different');
  assert(localApp.config.auth.redirectUrls.includes('https://hsapi-oauth.groundworkrevops.com/v1/oauth/callback'), 'local app must include its local-role broker callback');
  assert(!localApp.config.auth.redirectUrls.includes('https://hsapi-mcp.groundworkrevops.com/hubspot/callback'), 'local app must not retain the remote MCP callback after split cutover');
  assert.deepStrictEqual(remoteApp.config.auth.redirectUrls, ['https://hsapi-remote-oauth.groundworkrevops.com/v1/oauth/callback'], 'remote app must expose only its dedicated broker callback');

  assertBrokerConfig(localBroker, 'local', ['oauth'], broadScopes, 'local broker');
  assertBrokerConfig(remoteBroker, 'remote', ['oauth'], broadScopes, 'remote broker');

  const localVariants = new Map(configVariants(localBroker));
  const remoteVariants = new Map(configVariants(remoteBroker));
  const connectorVariants = new Map(configVariants(remoteConnector));
  for (const environment of ['default', 'staging', 'production']) {
    const localVars = localVariants.get(environment);
    const remoteVars = remoteVariants.get(environment);
    const connectorVars = connectorVariants.get(environment);
    assert(localVars && remoteVars && connectorVars, `missing ${environment} OAuth deployment variant`);
    assert.notStrictEqual(localVars.HUBSPOT_CLIENT_ID, remoteVars.HUBSPOT_CLIENT_ID, `${environment} local and remote apps must use different client IDs`);
    assert.strictEqual(connectorVars.HUBSPOT_CLIENT_ID, remoteVars.HUBSPOT_CLIENT_ID, `${environment} remote connector must match its remote broker app`);
    assertSameSet(scopes(connectorVars.HUBSPOT_REQUIRED_SCOPES, `${environment} remote connector required scopes`), ['oauth'], `${environment} remote connector required scopes drifted`);
    assertSameSet(scopes(connectorVars.HUBSPOT_OPTIONAL_SCOPES, `${environment} remote connector optional scopes`), remoteRequestedScopes, `${environment} remote connector requested scopes drifted`);
    assert.strictEqual(connectorVars.REMOTE_WRITES_ENABLED, 'true', `${environment} remote connector must enable reviewed writes`);
    assertSameSet(scopes(connectorVars.HUBSPOT_APP_SCOPE_CEILING, `${environment} remote app scope ceiling`), ['oauth', ...broadScopes], `${environment} remote app scope ceiling drifted`);
    assert.notStrictEqual(connectorVars.HUBSPOT_BROKER_URL, 'https://hsapi-oauth.groundworkrevops.com', `${environment} remote connector still points at the local broker`);
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    localBrokerRole: 'local',
    remoteBrokerRole: 'remote',
    broadOptionalScopeCount: broadScopes.length,
    remoteRequestedReadScopeCount: remoteReadScopes.length,
    remoteRequestedWriteScopeCount: remoteWriteScopes.length,
    remoteRequestedScopeCount: remoteRequestedScopes.length,
  }, null, 2) + '\n');
}

main();
