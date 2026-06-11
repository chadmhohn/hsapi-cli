// Command input builders: every *BodyFromFlags / *QueryFlags translator that
// turns parsed CLI flags into HubSpot request bodies and query strings, plus
// the multipart form assemblers. Pure translation; failures route through
// runtime.fail and all flag semantics live in flags.js.
const fs = require('fs');
const path = require('path');
const { fail } = require('./runtime');
const {
  boolFlag,
  normalizeBatchIdInput,
  optionalBoolean,
  optionalNumber,
  parseBody,
  parseIdInputs,
  parseMaybeJson,
  parsePropertiesList,
  parseStringList,
  readArgumentText,
  requireFlag,
  values
} = require('./flags');

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

function parseBatchInputsValue(raw, label, commandName) {
  const text = readArgumentText(raw, label).trim();
  if (!text) fail(`--${label} must not be empty.`);
  try {
    return JSON.parse(text);
  } catch (_error) {
    // Fall through to JSONL parsing: one JSON object per line.
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const inputs = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      inputs.push(JSON.parse(lines[index]));
    } catch (error) {
      fail(`${commandName} --${label} line ${index + 1} is not valid JSON. Expected a JSON array, an object with an inputs array, or JSONL (one JSON object per line): ${error.message}`);
    }
  }
  return inputs;
}

function batchWriteBodyFromFlags(flags, commandName, options = {}) {
  const explicitBody = parseBody(flags.body);
  if (explicitBody !== undefined) return assertBatchInputsBody(explicitBody, commandName);

  const rawInputs = requireFlag(flags, 'inputs');
  const parsed = parseBatchInputsValue(rawInputs, 'inputs', commandName);
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
  const parsed = parseBatchInputsValue(rawInputs, 'inputs', commandName);
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

module.exports = {
  appendMappedSearchQuery,
  appendQueryList,
  appendQueryValue,
  applyInputIdProperty,
  assertBatchInputsBody,
  assertObjectBody,
  associationBatchBodyFromFlags,
  associationLimitBodyFromFlags,
  associationTypesBodyFromFlags,
  authBasePortal,
  authClientId,
  authClientSecret,
  authIntrospectBodyFromFlags,
  authRefreshBodyFromFlags,
  authRevokeBodyFromFlags,
  authTokenExchangeBodyFromFlags,
  authTokenTypeHint,
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
  cmsListQueryFlags,
  cmsPageBodyFromFlags,
  cmsPageListQueryFlags,
  cmsRedirectBodyFromFlags,
  cmsScheduleBodyFromFlags,
  cmsSearchQueryFlags,
  coerceFlagValue,
  conversationBodyFromFlags,
  eventDefinitionBodyFromFlags,
  eventOccurrencesQueryFlags,
  eventPropertyBodyFromFlags,
  eventSendBodyFromFlags,
  exportStartBodyFromFlags,
  fileImportUrlBodyFromFlags,
  fileMultipartFromFlags,
  fileOptionsFromFlags,
  fileSearchQueryFlags,
  fileUpdateBodyFromFlags,
  folderBodyFromFlags,
  folderSearchQueryFlags,
  formDefinitionBodyFromFlags,
  formListQueryFlags,
  formSubmissionBodyFromFlags,
  gdprDeleteBodyFromFlags,
  genericListQueryFlags,
  hasQueryParameter,
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
  marketingEventInputFromFlags,
  mergeBodyFromFlags,
  objectFromJsonFlag,
  offsetsBodyFromFlags,
  optionalAuthToken,
  parseBatchInputsValue,
  pipelineStageBodyFromFlags,
  propertiesQueryFlags,
  propertyDefinitionBodyFromFlags,
  recordCreateBodyFromFlags,
  requireOneFolderTarget,
  requireOneParentFolderTarget,
  schedulerBookBodyFromFlags,
  schedulerBookingQueryFlags,
  schedulerCalendarBodyFromFlags,
  schedulerLinksQueryFlags,
  secretFromNamedEnv,
  secretValue,
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
};
