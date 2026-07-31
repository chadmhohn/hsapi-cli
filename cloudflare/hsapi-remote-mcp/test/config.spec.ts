import { describe, expect, it } from "vitest";
import { assertCanonicalRequestOrigin, readConfig } from "../src/config";

function baseEnv(overrides: Record<string, string> = {}): Env {
  return {
    ENVIRONMENT: "local",
    PUBLIC_ORIGIN: "http://localhost:8787",
    MCP_ALLOWED_ORIGINS: "http://localhost:8787 https://client.example",
    MCP_ACCESS_TOKEN_TTL_SECONDS: "900",
    REMOTE_WRITES_ENABLED: "false",
    HUBSPOT_REQUIRE_USER_LEVEL: "true",
    HUBSPOT_BROKER_URL: "https://remote-oauth.example.com",
    HUBSPOT_CLIENT_ID: "00000000-0000-4000-8000-000000000001",
    HUBSPOT_REQUIRED_SCOPES: "oauth",
    HUBSPOT_OPTIONAL_SCOPES: "crm.objects.contacts.read oauth crm.objects.contacts.read",
    HUBSPOT_APP_SCOPE_CEILING: "oauth crm.objects.contacts.read crm.objects.contacts.write",
    STATE_ENCRYPTION_KEY: "test-only-state-encryption-key-0000000000000000",
    ...overrides,
  } as unknown as Env;
}

describe("Worker configuration", () => {
  it("normalizes origins and de-duplicates optional scopes", () => {
    const config = readConfig(baseEnv());
    expect(config).toMatchObject({
      publicOrigin: "http://localhost:8787",
      resourceUrl: "http://localhost:8787/mcp",
      callbackUrl: "http://localhost:8787/hubspot/callback",
      remoteWritesEnabled: false,
      hubSpotRequireUserLevel: true,
      brokerUrl: "https://remote-oauth.example.com",
      hubSpotOptionalScopes: ["crm.objects.contacts.read"],
      hubSpotAppScopeCeiling: ["oauth", "crm.objects.contacts.read", "crm.objects.contacts.write"],
    });
    expect(config.allowedOriginHostnames).toEqual(["localhost", "client.example"]);
  });

  it("requires HTTPS and replaced deployment placeholders outside local development", () => {
    expect(() => readConfig(baseEnv({ ENVIRONMENT: "production" }))).toThrow(/HTTPS/);
    expect(() => readConfig(baseEnv({ HUBSPOT_BROKER_URL: "" }))).toThrow(/HUBSPOT_BROKER_URL/);
    expect(() => readConfig(baseEnv({ HUBSPOT_BROKER_URL: "http://broker.example" }))).toThrow(/HTTPS/);
    expect(() => readConfig(baseEnv({ HUBSPOT_BROKER_URL: "https://hsapi-oauth.groundworkrevops.com" }))).toThrow(/dedicated remote-role broker/);
    expect(() => readConfig(baseEnv({
      ENVIRONMENT: "production",
      PUBLIC_ORIGIN: "https://hsapi.REPLACE.example",
      MCP_ALLOWED_ORIGINS: "https://hsapi.REPLACE.example",
    }))).toThrow(/placeholders/);
  });

  it("accepts the production read/write OAuth scope matrix", () => {
    const productionReadScopes = [
      "crm.objects.contacts.read",
      "crm.objects.companies.read",
      "crm.objects.deals.read",
      "crm.objects.tickets.read",
      "crm.objects.line_items.read",
      "crm.objects.products.read",
      "crm.objects.quotes.read",
      "crm.objects.subscriptions.read",
      "crm.objects.carts.read",
      "crm.objects.orders.read",
      "crm.objects.invoices.read",
      "crm.objects.tasks.read",
      "crm.objects.notes.read",
      "crm.objects.calls.read",
      "crm.objects.meetings.read",
      "crm.objects.emails.read",
      "crm.objects.contracts.read",
      "crm.objects.marketing_events.read",
      "mcp.users.read",
    ];
    const productionWriteScopes = [
      "crm.objects.contacts.write",
      "crm.objects.companies.write",
      "crm.objects.deals.write",
      "crm.objects.tickets.write",
      "crm.objects.line_items.write",
      "crm.objects.products.write",
      "crm.objects.tasks.write",
      "crm.objects.notes.write",
      "crm.objects.calls.write",
      "crm.objects.meetings.write",
      "crm.objects.emails.write",
      "crm.objects.marketing_events.write",
    ];
    const config = readConfig(baseEnv({
      ENVIRONMENT: "production",
      PUBLIC_ORIGIN: "https://mcp.example.com",
      MCP_ALLOWED_ORIGINS: "https://mcp.example.com",
      HUBSPOT_CLIENT_ID: "11111111-1111-4111-8111-111111111111",
      REMOTE_WRITES_ENABLED: "true",
      HUBSPOT_OPTIONAL_SCOPES: [...productionReadScopes, ...productionWriteScopes].join(" "),
      HUBSPOT_APP_SCOPE_CEILING: ["oauth", ...productionReadScopes, ...productionWriteScopes].join(" "),
    }));
    expect(config.environment).toBe("production");
    expect(config.hubSpotOptionalScopes).toHaveLength(31);
    expect(config.remoteWritesEnabled).toBe(true);
  });

  it("keeps staged custom record and schema reads grant-gated behind the app ceiling", () => {
    const config = readConfig(baseEnv({
      HUBSPOT_OPTIONAL_SCOPES: "crm.objects.custom.read crm.schemas.custom.read",
      HUBSPOT_APP_SCOPE_CEILING: "oauth crm.objects.custom.read crm.schemas.custom.read",
    }));
    expect(config.hubSpotOptionalScopes).toEqual([
      "crm.objects.custom.read",
      "crm.schemas.custom.read",
    ]);
  });

  it("does not infer booleans or permit missing OAuth scope", () => {
    expect(() => readConfig(baseEnv({ REMOTE_WRITES_ENABLED: "1" }))).toThrow(/exactly true or false/);
    expect(() => readConfig(baseEnv({ HUBSPOT_REQUIRED_SCOPES: "crm.objects.contacts.read" }))).toThrow(/must include oauth/);
    expect(() => readConfig(baseEnv({ HUBSPOT_APP_SCOPE_CEILING: "oauth" }))).toThrow(/outside HUBSPOT_APP_SCOPE_CEILING/);
    expect(() => readConfig(baseEnv({ HUBSPOT_OPTIONAL_SCOPES: "crm.objects.contacts.write" }))).toThrow(/write scopes require/);
    expect(() => readConfig(baseEnv({ HUBSPOT_OPTIONAL_SCOPES: "cpq.price_books.read" }))).toThrow(/not referenced by the remote manifest/);
    expect(() => readConfig(baseEnv({ HUBSPOT_OPTIONAL_SCOPES: "crm.objects.contacts.sensitive" }))).toThrow(/not referenced by the remote manifest/);
    expect(() => readConfig(baseEnv({
      REMOTE_WRITES_ENABLED: "true",
      HUBSPOT_OPTIONAL_SCOPES: "crm.objects.contacts.write crm.objects.owners.write",
    }))).toThrow(/not referenced by the remote manifest/);
  });

  it("rejects requests routed under a different public origin", () => {
    const config = readConfig(baseEnv());
    expect(() => assertCanonicalRequestOrigin(new Request("http://localhost:8787/healthz"), config)).not.toThrow();
    try {
      assertCanonicalRequestOrigin(new Request("https://attacker.example/healthz"), config);
      throw new Error("Expected a misdirected request response.");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(421);
    }
  });
});
