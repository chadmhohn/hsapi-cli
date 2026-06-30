// hsapi crm: record CRUD/search plus the filter grammar and count/exists helpers.
const {
  fail,
} = require('../runtime');
const {
  boolFlag,
  optionalNumber,
  parseBody,
  parsePropertiesList,
  parseStringList,
  pathPart,
  values,
} = require('../flags');
const {
  printJson,
} = require('../output');
const {
  assertObjectBody,
  batchArchiveBodyFromFlags,
  batchReadBodyFromFlags,
  batchWriteBodyFromFlags,
  gdprDeleteBodyFromFlags,
  mergeBodyFromFlags,
  recordCreateBodyFromFlags,
} = require('../command-inputs');
const {
  collectPages,
  collectSearchPages,
  guardedFetch,
  hubspotFetch,
} = require('../request');
const {
  AUTH_FAMILIES,
} = require('../auth');
const {
  findEndpointDefinition,
} = require('../catalog');
const {
  CRM_OBJECT_TYPE_CATALOG,
  crmObjectCatalogEntryForOutput,
  crmObjectTokenAudience,
  resolveCrmObjectType,
  resolveCrmObjectTypeWithCustomFallback,
} = require('../crm-object-types');

// Build the per-request endpoint metadata for a CRM CRUD data op, carrying the
// object's tokenAudience so the least-privilege resolver (issue #80) routes it
// correctly. For reads and writes the audience follows the OBJECT (user-capable
// standard object -> 'user'; custom / non-capable standard / unresolved ->
// 'admin'). DELETE is always 'admin': HubSpot user-level OAuth apps return 403
// on any CRM delete regardless of object type (live-validated 2026-06-30).
//
// The CRM object CRUD endpoints are cataloged generically (path template
// {objectType}, declared portal_bearer + admin), so per-object audience can't
// live in the catalog and must be injected here. We resolve the real catalog
// endpoint and override only auth.tokenAudience - preserving its id, risk, and
// readOnlyPost so --show-request, history, and retry policy stay accurate.
// family stays portal_bearer: that is the non-user credential used when the
// portal has no OAuth identity, so portal_bearer-only profiles are unaffected.
function crmAudienceEndpoint(resolution, method, path) {
  const tokenAudience = method === 'DELETE' ? 'admin' : crmObjectTokenAudience(resolution);
  const catalogEndpoint = findEndpointDefinition(method, path);
  if (catalogEndpoint && catalogEndpoint.auth) {
    return {
      ...catalogEndpoint,
      auth: { ...catalogEndpoint.auth, tokenAudience }
    };
  }
  return {
    auth: {
      required: true,
      family: AUTH_FAMILIES.PORTAL_BEARER,
      tokenAudience,
      fallback: 'none'
    }
  };
}

const CRM_FILTER_NO_VALUE_OPERATORS = new Set(['HAS_PROPERTY', 'NOT_HAS_PROPERTY']);

const CRM_FILTER_MULTI_VALUE_OPERATORS = new Set(['IN', 'NOT_IN']);

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
  const objectResolution = resolveCrmObjectType(objectTypeInput);
  const objectType = objectResolution.pathObjectType;
  // Per-op endpoint metadata carrying the object's tokenAudience, threaded into
  // every data op so the resolver routes user-capable objects to OAuth (when the
  // portal has it) and everything else to the admin credential. Issue #80.
  const audienceEndpointFor = (method, path) => crmAudienceEndpoint(objectResolution, method, path);

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
      ? await collectPages(portal, 'GET', `/crm/objects/2026-03/${pathPart(objectType)}`, queryFlags, undefined, audienceEndpointFor('GET', `/crm/objects/2026-03/${pathPart(objectType)}`))
      : await hubspotFetch(portal, 'GET', `/crm/objects/2026-03/${pathPart(objectType)}`, queryFlags, undefined, audienceEndpointFor('GET', `/crm/objects/2026-03/${pathPart(objectType)}`));
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
    const result = await hubspotFetch(portal, 'GET', `/crm/objects/2026-03/${pathPart(objectType)}/${pathPart(id)}`, queryFlags, undefined, audienceEndpointFor('GET', `/crm/objects/2026-03/${pathPart(objectType)}/${pathPart(id)}`));
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
      const searchBodyEndpoint = audienceEndpointFor('POST', `/crm/objects/2026-03/${pathPart(objectType)}/search`);
      printJson(boolFlag(flags, 'paginate')
        ? await collectSearchPages(portal, objectType, flags, body, searchBodyEndpoint)
        : await hubspotFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/search`, flags, body, searchBodyEndpoint));
      return;
    }
    const countOnly = boolFlag(flags, 'count-only');
    const { body, criteria } = crmSearchRequestFromFlags(
      countOnly ? { ...flags, limit: 1 } : flags,
      countOnly ? { defaultLimit: 1, includeProperties: false, includePropertiesWithHistory: false } : {}
    );
    const searchEndpoint = audienceEndpointFor('POST', `/crm/objects/2026-03/${pathPart(objectType)}/search`);
    if (boolFlag(flags, 'paginate') && !countOnly) {
      printJson(await collectSearchPages(portal, objectType, flags, body, searchEndpoint));
      return;
    }
    const result = await hubspotFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/search`, flags, body, searchEndpoint);
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
    const result = await hubspotFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/search`, flags, body, audienceEndpointFor('POST', `/crm/objects/2026-03/${pathPart(objectType)}/search`));
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
    const result = await hubspotFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/search`, flags, body, audienceEndpointFor('POST', `/crm/objects/2026-03/${pathPart(objectType)}/search`));
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
    const result = await hubspotFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/search`, flags, body, audienceEndpointFor('POST', `/crm/objects/2026-03/${pathPart(objectType)}/search`));
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
    printJson(await guardedFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}`, flags, body, { endpoint: audienceEndpointFor('POST', `/crm/objects/2026-03/${pathPart(objectType)}`) }));
    return;
  }

  if (action === 'batch-read') {
    const body = batchReadBodyFromFlags(flags);
    const result = await hubspotFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/batch/read`, flags, body, audienceEndpointFor('POST', `/crm/objects/2026-03/${pathPart(objectType)}/batch/read`));
    printJson(result);
    return;
  }

  if (action === 'batch-create') {
    const body = batchWriteBodyFromFlags(flags, 'crm batch-create');
    printJson(await guardedFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/batch/create`, flags, body, { endpoint: audienceEndpointFor('POST', `/crm/objects/2026-03/${pathPart(objectType)}/batch/create`) }));
    return;
  }

  if (action === 'batch-update') {
    const body = batchWriteBodyFromFlags(flags, 'crm batch-update', { allowIdProperty: true });
    printJson(await guardedFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/batch/update`, flags, body, { endpoint: audienceEndpointFor('POST', `/crm/objects/2026-03/${pathPart(objectType)}/batch/update`) }));
    return;
  }

  if (action === 'batch-upsert') {
    const body = batchWriteBodyFromFlags(flags, 'crm batch-upsert', { allowIdProperty: true });
    printJson(await guardedFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/batch/upsert`, flags, body, { endpoint: audienceEndpointFor('POST', `/crm/objects/2026-03/${pathPart(objectType)}/batch/upsert`) }));
    return;
  }

  if (action === 'batch-archive') {
    const body = batchArchiveBodyFromFlags(flags);
    printJson(await guardedFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/batch/archive`, flags, body, { endpoint: audienceEndpointFor('POST', `/crm/objects/2026-03/${pathPart(objectType)}/batch/archive`) }));
    return;
  }

  if (action === 'update') {
    const id = rest[1];
    if (!id) fail('crm update requires object id.');
    const properties = assertObjectBody(parseBody(flags.properties), 'crm update --properties');
    const body = { properties };
    printJson(await guardedFetch(portal, 'PATCH', `/crm/objects/2026-03/${pathPart(objectType)}/${pathPart(id)}`, flags, body, { endpoint: audienceEndpointFor('PATCH', `/crm/objects/2026-03/${pathPart(objectType)}/${pathPart(id)}`) }));
    return;
  }

  if (action === 'archive') {
    const id = rest[1];
    if (!id) fail('crm archive requires object id.');
    printJson(await guardedFetch(portal, 'DELETE', `/crm/objects/2026-03/${pathPart(objectType)}/${pathPart(id)}`, flags, undefined, { endpoint: audienceEndpointFor('DELETE', `/crm/objects/2026-03/${pathPart(objectType)}/${pathPart(id)}`) }));
    return;
  }

  if (action === 'merge') {
    if (!boolFlag(flags, 'danger-merge')) {
      fail('crm merge requires --danger-merge plus --yes.');
    }
    const body = mergeBodyFromFlags(flags, rest[1], rest[2]);
    printJson(await guardedFetch(portal, 'POST', `/crm/objects/2026-03/${pathPart(objectType)}/merge`, flags, body, { endpoint: audienceEndpointFor('POST', `/crm/objects/2026-03/${pathPart(objectType)}/merge`) }));
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

module.exports = {
  CRM_FILTER_MULTI_VALUE_OPERATORS,
  CRM_FILTER_NO_VALUE_OPERATORS,
  countInfoFromPayload,
  crmCountOutput,
  crmObjectTypesFromFlags,
  crmQuerySummaryFromListFlags,
  crmQuerySummaryFromSearchCriteria,
  crmSearchCriteriaFromFlags,
  crmSearchRequestFromFlags,
  firstCrmResult,
  formatCrmFilter,
  parseCrmFilterExpression,
  parseSearchSorts,
  runCrm,
  searchBodyFromFlags,
};
