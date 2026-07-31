# Network Origins and IP Ranges

HubSpot's stable network-origins API publishes HubSpot ingress and egress IP ranges. The two `2026-03` endpoints are public and the catalog explicitly marks them `auth.required: false`, so `hsapi` refuses to attach portal, OAuth, or developer credentials.

Use the JSON endpoint for structured automation and the `simple` endpoint for a plaintext-oriented result. Both accept repeatable `direction` filters (`INGRESS`, `EGRESS`) and `service` filters such as `API`, `EMAIL`, `DNS`, and `WEB_SCRAPING`.

```bash
hsapi request GET /meta/network-origins/2026-03/ip-ranges --query direction=EGRESS --query service=API --show-request
hsapi request GET /meta/network-origins/2026-03/ip-ranges/simple --query service=EMAIL --accept text/plain --show-request
```

Treat these ranges as discovery data, not a permanent firewall snapshot. Refresh them on the cadence appropriate for the consuming network control.

## Official Reference

- IP ranges guide: https://developers.hubspot.com/docs/api-reference/latest/account/ip-ranges/guide
