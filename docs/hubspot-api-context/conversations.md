# Conversations

The Conversations slice covers the 2026-09 beta Conversations API, 2026-03 custom channels, and visitor identification tokens.

Conversation content can include live chat transcripts, email-like messages, contact identifiers, agent/user IDs, and original message bodies. Treat reads and previews as sensitive support and customer communication data.

## Common Commands

- `hsapi conversations threads --inbox-id <inboxId>`
- `hsapi conversations thread-get <threadId>`
- `hsapi conversations message-original <threadId> <messageId>`
- `hsapi conversations message-create <threadId> --text "Following up" --actor-id <actorId>`
- `hsapi conversations actors-batch-read --ids <actorId1>,<actorId2>`
- `hsapi conversations channel-accounts`
- `hsapi conversations inboxes`
- `hsapi conversations custom-channels`
- `hsapi conversations custom-channel-create --name "External chat" --url https://example.com`
- `hsapi conversations custom-channel-account-create <channelId> --name "Support inbox"`
- `hsapi conversations custom-message-create <channelId> --text "Inbound message" --channel-account-id <accountId>`
- `hsapi conversations visitor-token --email ada@example.com --first-name Ada`

## Safety Notes

- Mutating commands require `--yes`.
- Thread updates, assignee changes, message creation, and custom-channel writes can affect live support operations.
- Use `--show-request` before sending messages. Confirm the thread, actor, channel, channel account, and inbox IDs.
- Slack replies back through HubSpot should only be used for live chat conversations. Email conversations may create Slack notifications, but replying in Slack does not send an email response through HubSpot.
- Original content endpoints can expose raw customer message content. Avoid pasting outputs into shared channels.
- Visitor identification tokens are customer-identifying artifacts. Treat generated tokens like secrets until their lifetime and allowed usage are known.
- The convenience flags cover common fields only. Use `--body <json|@file>` for exact HubSpot payloads, especially beta Conversations payloads.

## Official References

- Conversations guide: https://developers.hubspot.com/docs/api-reference/latest/conversations/guide
- Custom channels guide: https://developers.hubspot.com/docs/api-reference/latest/conversations/custom-channels/guide
- Visitor identification token: https://developers.hubspot.com/docs/api-reference/latest/conversations/visitor-identification/create-visitor-identification
