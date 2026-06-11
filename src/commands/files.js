// hsapi files: file + folder management.
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
  fileImportUrlBodyFromFlags,
  fileMultipartFromFlags,
  fileSearchQueryFlags,
  fileUpdateBodyFromFlags,
  folderBodyFromFlags,
  folderSearchQueryFlags,
  propertiesQueryFlags,
} = require('../command-inputs');
const {
  collectPages,
  guardedFetch,
  guardedMultipartFetch,
  hubspotFetch,
} = require('../request');

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

module.exports = {
  runFiles,
};
