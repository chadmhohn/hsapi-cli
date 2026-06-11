// hsapi cms: pages, blog posts, redirects, hubdb, source code, search, doctor.
const {
  fail,
} = require('../runtime');
const {
  boolFlag,
  configString,
  parseBody,
  pathPart,
  pathTail,
} = require('../flags');
const {
  printJson,
  redactTokenUrl,
} = require('../output');
const {
  appendMappedSearchQuery,
  cmsBlogPostBodyFromFlags,
  cmsBlogPostListQueryFlags,
  cmsIndexedDataQueryFlags,
  cmsPageBodyFromFlags,
  cmsPageListQueryFlags,
  cmsRedirectBodyFromFlags,
  cmsScheduleBodyFromFlags,
  cmsSearchQueryFlags,
  genericListQueryFlags,
  hubDbRowBodyFromFlags,
  hubDbTableBodyFromFlags,
  sourceCodeMultipartFromFlags,
} = require('../command-inputs');
const {
  endpointDefinitionById,
} = require('../catalog');
const {
  hubSpotResponseCategory,
  requestAuthMetadata,
} = require('../auth-resolvers');
const {
  buildUrl,
  collectPages,
  guardedFetch,
  guardedMultipartFetch,
  hubspotFetch,
  hubspotFetchAllowError,
  hubspotMultipartFetch,
  queryObjectForDisplay,
} = require('../request');

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

  if (action === 'audit-logs') {
    const queryFlags = appendMappedSearchQuery(flags, {
      limit: 'limit',
      after: 'after',
      'user-id': 'userId',
      'event-type': 'eventType',
      'object-type': 'objectType',
      'occurred-after': 'occurredAfter',
      'occurred-before': 'occurredBefore'
    });
    const target = '/cms/audit-logs/2026-03';
    const result = boolFlag(flags, 'paginate')
      ? await collectPages(portal, 'GET', target, queryFlags)
      : await hubspotFetch(portal, 'GET', target, queryFlags);
    printJson(result);
    return;
  }

  if (action === 'audit-logs-export') {
    const body = parseBody(flags.body) || {};
    printJson(await guardedFetch(portal, 'POST', '/cms/audit-logs/2026-03/export', flags, body));
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

module.exports = {
  cmsDoctorAuthPreview,
  cmsDoctorCapabilityFromResult,
  cmsDoctorCheckDefinitions,
  cmsDoctorMessageFromResponse,
  cmsDoctorPlannedRequest,
  cmsDoctorResultCount,
  cmsDoctorStatusFromCapability,
  runCms,
  runCmsBlogPosts,
  runCmsDoctor,
  runCmsDoctorCheck,
  runCmsDomains,
  runCmsHubDb,
  runCmsPages,
  runCmsRedirects,
  runCmsSearch,
  runCmsSourceCode,
};
