// hsapi extensions: calling + videoconferencing surfaces.
const {
  fail,
} = require('../runtime');
const {
  pathPart,
} = require('../flags');
const {
  printJson,
} = require('../output');
const {
  callingRecordingReadyBodyFromFlags,
  callingRecordingSettingsBodyFromFlags,
  callingTranscriptCreateBodyFromFlags,
  mappedBodyFromFlags,
} = require('../command-inputs');
const {
  guardedFetch,
  hubspotFetch,
} = require('../request');

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
    if (action === 'update' || action === 'create' || action === 'put') {
      const body = mappedBodyFromFlags(flags, 'extensions videoconferencing settings update', {
        'create-meeting-url': 'createMeetingUrl',
        'update-meeting-url': 'updateMeetingUrl',
        'delete-meeting-url': 'deleteMeetingUrl',
        'user-verify-url': 'userVerifyUrl',
        'fetch-accounts-url': 'fetchAccountsUri'
      });
      printJson(await guardedFetch(portal, 'PUT', base, flags, body));
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

module.exports = {
  runCallingExtensions,
  runExtensions,
  runVideoConferencingExtensions,
};
