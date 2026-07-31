# Local and Remote OAuth App Operations

HSAPI uses one Git repository and two independent HubSpot public OAuth apps.
The shared repository keeps catalog, policy, tests, and security fixes aligned;
the app identities and deployed OAuth state remain separate.

## Deployment inventory

| Boundary | Local hosted OAuth | Remote MCP OAuth |
|---|---|---|
| HubSpot public app | Dedicated local app | Dedicated remote app |
| Broker role | `local` | `remote` |
| Broker config template | `cloudflare/hsapi-oauth-broker/wrangler.jsonc` | `cloudflare/hsapi-oauth-broker/wrangler.remote.jsonc` |
| Operator config | `wrangler.operator.jsonc` | `wrangler.remote.operator.jsonc` |
| Completion accepted by broker | `http://127.0.0.1:<port>/oauth/hsapi/callback` only | Exact allowlisted `<REMOTE_MCP_ORIGIN>/hubspot/callback` HTTPS URL only |
| HubSpot callback | Local broker `/v1/oauth/callback` | Remote broker `/v1/oauth/callback` |
| Token storage | External cache on the operator's machine | Remote MCP `OAUTH_KV` plus provider-owned downstream OAuth state |
| ServiceKey/private app | Optional in an explicitly combined local portal profile | Never accepted |

The two HubSpot client IDs, client secrets, broker signing keys, Worker names,
callback domains, rate-limit namespaces, and production state must be
different. Staging and production state must also be different within each
boundary.

`data/hubspot-oauth-apps.json` is the checked-in app/scope manifest. Run:

```powershell
npm run oauth-apps:check
```

That gate proves that both broker configs still use different app IDs and
roles, that the remote Worker points only at the remote broker/app, and that
the checked-in scope profiles remain synchronized.

## Scope policy

Both HubSpot app registrations may expose the current broad optional-scope
profile in `data/hubspot-oauth-apps.json`. Only `oauth` is required so an
account that lacks an optional product does not make the whole installation
ineligible.

The local broker requests the broad profile because the local CLI has the full
catalog and explicit mutation gates. The remote broker has the same app-level
maximum, but the remote Worker requests only `remoteReadRequest` plus
`remoteWriteRequest`, then attenuates the usable tool scopes again through its
explicit endpoint and object manifest. A scope in the HubSpot app does not
create a remote MCP tool.

The current remote read request includes Contracts read. Custom record/schema
read support is staged in the Worker, but a July 30, 2026 upload of the 2026.03
user-level app rejected `crm.objects.custom.read` as unrecognized. The four
custom scope candidates therefore remain outside both active app manifests and
broker requests until a later live recheck succeeds. Price Books permissions
are private-app access scopes rather than public-app OAuth scopes, so Price Books
stay on the local ServiceKey connector and are excluded from both OAuth apps and
the remote MCP. Reviewed remote writes, including destructive CRM calls, are
enabled behind `hsapi.write`, an exact object-family write scope, and
exact-preview confirmation. The remote executor also accepts raw method/path
calls inside that same scope boundary. Do not add a Contracts write scope or endpoint until HubSpot
publishes the public-beta contract.

## Creating the remote app and broker

1. Create a second HubSpot public app whose name clearly says `HSAPI Remote MCP`.
2. Configure required scope `oauth` and the optional scopes from
   `broadPublicAppOptional` in `data/hubspot-oauth-apps.json` that HubSpot makes
   selectable for the app/account tier.
3. Choose the remote broker origin. The recommended production shape is a
   dedicated hostname such as `https://hsapi-remote-oauth.groundworkrevops.com`.
4. Register exactly
   `<REMOTE_BROKER_ORIGIN>/v1/oauth/callback` in the remote HubSpot app. Do not
   register the MCP Worker's callback in HubSpot.
5. Copy `cloudflare/hsapi-oauth-broker/wrangler.remote.jsonc` to the ignored
   `wrangler.remote.operator.jsonc`. Replace the client ID, broker origin,
   remote MCP completion URL, account ID, and account-local rate-limit IDs.
6. Set the remote app secret and a distinct broker signing key interactively:

   ```powershell
   cd cloudflare/hsapi-oauth-broker
   npx wrangler secret put HUBSPOT_CLIENT_SECRET --config wrangler.remote.operator.jsonc --env staging
   npx wrangler secret put BROKER_SIGNING_KEY --config wrangler.remote.operator.jsonc --env staging
   ```

7. Dry-run and deploy staging:

   ```powershell
   npm run check
   npx wrangler deploy --dry-run --config wrangler.remote.operator.jsonc --env staging
   npm run deploy:remote:staging
   ```

8. Confirm remote broker `GET /healthz` reports `ready: true` and
   `brokerRole: "remote"`.
9. In `cloudflare/hsapi-remote-mcp/wrangler.operator.jsonc`, set
   `HUBSPOT_BROKER_URL` to that remote broker and `HUBSPOT_CLIENT_ID` to the
   remote app. Keep the reviewed write and confirmation gates enabled.
10. Deploy and validate the remote MCP staging matrix in
    `cloudflare/hsapi-remote-mcp/README.md`.

Never put either app secret, signing key, OAuth code, token, cache, or
ServiceKey into Git, an operator JSON file, command arguments, or chat.

## Coordinated production cutover

Do not convert the existing local broker to `local` role until the remote MCP
has successfully moved to the dedicated remote broker. The safe order is:

1. create and validate the remote HubSpot app and remote broker in staging;
2. deploy the remote broker production environment and verify
   `brokerRole: "remote"`;
3. update the remote MCP production operator config to the remote broker/app,
   deploy it, reconnect a test client, and prove identity, Contracts read,
   replay rejection, refresh, and a missing-scope failure;
4. prepare the local broker operator config with `HSAPI_BROKER_ROLE=local` and
   an empty remote completion allowlist;
5. deploy the local broker and prove a fresh CLI login, refresh, and logout;
6. release the CLI version that recognizes the broker role; and
7. remove any obsolete shared-app authorization only after rollback is no
   longer needed.

Until steps 1-3 exist, the current remote production connection remains a
transition deployment and must not receive the role-enforcing Worker build.
Code readiness is not production readiness without the second HubSpot app,
its secret, exact callback registration, and live staging proof.

## Rollback

Keep the previous remote MCP Worker version and its operator-only deployment
inventory through the validation window. If the new remote app fails, roll the
remote MCP Worker back without changing the local broker. If the local broker
cutover fails, restore only the previous local broker Worker version. Never
point the remote Worker at the local-role broker to work around an OAuth error;
the role checks intentionally reject that configuration.
