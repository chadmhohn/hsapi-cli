# Association Limits

Association limits control how many records of one object type can be associated to another object type, optionally for a specific association label.

Use these endpoints when a RevOps design needs to enforce relationship structure, such as:

- one primary implementation contact per deal;
- a maximum number of companies associated to a ticket;
- preventing overuse of a custom association label.

Do not use these endpoints to create or remove record-level associations. Record associations are separate data operations. Association limits change the schema/configuration that governs future associations.

## Commands

Preview current limits:

```bash
hsapi association-limits list deals contacts --show-request
```

Create a limit:

```bash
hsapi association-limits create deals contacts \
  --category HUBSPOT_DEFINED \
  --type-id 3 \
  --max-to-object-ids 5 \
  --show-request
```

Update a limit:

```bash
hsapi association-limits update deals contacts \
  --category HUBSPOT_DEFINED \
  --type-id 3 \
  --max-to-object-ids 10 \
  --show-request
```

Delete a limit and return to the HubSpot default:

```bash
hsapi association-limits delete deals contacts \
  --category USER_DEFINED \
  --type-id 35 \
  --show-request
```

All create, update, and delete commands require `--yes` to execute.

## Access Notes

A 403 can mean the token is missing CRM schema/association configuration scopes, or the portal subscription does not include the relevant association-label/limit capability. Check both before assuming the endpoint is broken.

Use `association-labels list` first when you need the numeric `typeId` for a custom label. HubSpot-defined and user-defined labels use different `category` values.

Official docs: https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associations-schema/guide
