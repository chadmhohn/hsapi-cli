// hsapi forms: definitions, submissions, guarded submits.
const {
  fail,
} = require('../runtime');
const {
  boolFlag,
  pathPart,
} = require('../flags');
const {
  printJson,
} = require('../output');
const {
  appendMappedSearchQuery,
  formDefinitionBodyFromFlags,
  formListQueryFlags,
  formSubmissionBodyFromFlags,
} = require('../command-inputs');
const {
  endpointDefinitionById,
} = require('../catalog');
const {
  collectPages,
  guardedExternalBearerJsonFetch,
  guardedExternalNoAuthJsonFetch,
  guardedFetch,
  hubspotFetch,
} = require('../request');

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

module.exports = {
  runForms,
};
