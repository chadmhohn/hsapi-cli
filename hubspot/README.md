# HubSpot OAuth app projects

This directory keeps both HubSpot public-app projects in the same Git
repository while preserving separate app identities and deployment lifecycles.

- `hsapi-local-oauth-app`: source downloaded from the existing `HubSpot API CLI
  MCP` project. Its desired configuration accepts only the local CLI callback
  and the local-role broker callback. Do not upload this callback removal until
  the remote MCP has moved to its dedicated app and broker.
- `hsapi-remote-mcp-app`: the `HSAPI Remote MCP` project created in the HSAPI
  developer account on 2026-07-30. Build and deploy `#1` created the app with
  one required and 49 optional public-app OAuth scopes.

Price Books scopes must not appear in either project. They are private-app
permissions and stay on the local ServiceKey connector.

Validate either project before upload:

```powershell
cd hubspot/hsapi-remote-mcp-app
hs project validate --account <HSAPI_DEVELOPER_ACCOUNT>
```

Never commit or document a HubSpot client secret. Store the remote app secret
directly in the dedicated Cloudflare broker with `wrangler secret put`.
