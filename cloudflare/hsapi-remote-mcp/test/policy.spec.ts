import { describe, expect, it } from "vitest";
import {
  assertRemoteManifestMatchesCatalog,
  missingHubSpotScopes,
  planRemoteRequest,
  remoteCapabilitySummary,
  remoteEndpointHelp,
  RemotePolicyError,
} from "../src/remote-policy";

function expectPolicyError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected the remote policy to reject the request.");
  } catch (error) {
    expect(error).toBeInstanceOf(RemotePolicyError);
    expect((error as RemotePolicyError).code).toBe(code);
  }
}

describe("remote capability policy", () => {
  it("matches the packaged catalog snapshot", () => {
    expect(() => assertRemoteManifestMatchesCatalog()).not.toThrow();
  });

  it("plans canonical CRM reads without allowing caller-controlled routing", () => {
    const plan = planRemoteRequest({
      endpointId: "objects.get",
      pathParams: { objectType: "contacts", id: "123 456" },
      query: { archived: false, properties: ["email", "firstname"] },
    });

    expect(plan).toMatchObject({
      method: "GET",
      path: "/crm/objects/2026-03/contacts/123%20456",
      risk: "read",
      downstreamScope: "hsapi.read",
      requiredHubSpotScopes: ["crm.objects.contacts.read"],
    });
    expect(plan.query).toEqual({ archived: ["false"], properties: ["email", "firstname"] });
  });

  it("allows contract reads, including generic search, while writes remain scope-gated", () => {
    for (const endpointId of ["objects.list", "objects.get", "objects.search", "objects.batch_read"]) {
      const pathParams: Record<string, string> = endpointId === "objects.get"
        ? { objectType: "contracts", id: "901" }
        : { objectType: "contracts" };
      const plan = planRemoteRequest({ endpointId, pathParams });
      expect(plan.risk).toBe("read");
      expect(plan.requiredHubSpotScopes).toEqual(["crm.objects.contracts.read"]);
    }

    expectPolicyError(
      () => planRemoteRequest({ endpointId: "objects.create", pathParams: { objectType: "contracts" }, body: {} }),
      "unsupported_object_type",
    );
  });

  it("allows custom object and schema reads by numeric object type ID", () => {
    for (const endpointId of ["objects.list", "objects.get", "objects.search", "objects.batch_read"]) {
      const pathParams: Record<string, string> = endpointId === "objects.get"
        ? { objectType: "2-123456", id: "901" }
        : { objectType: "2-123456" };
      const plan = planRemoteRequest({ endpointId, pathParams });
      expect(plan.requiredHubSpotScopes).toEqual(["crm.objects.custom.read"]);
      expect(plan.path).toContain("/2-123456");
    }

    expect(planRemoteRequest({ endpointId: "schemas.list" })).toMatchObject({
      path: "/crm-object-schemas/2026-03/schemas",
      requiredHubSpotScopes: ["crm.schemas.custom.read"],
    });
    expect(planRemoteRequest({ endpointId: "schemas.get", pathParams: { objectType: "2-123456" } })).toMatchObject({
      path: "/crm-object-schemas/2026-03/schemas/2-123456",
      requiredHubSpotScopes: ["crm.schemas.custom.read"],
    });
  });

  it("fails closed for unsafe aliases while staging custom writes and destructive operations behind write scopes", () => {
    for (const objectType of ["p123_widget", "contact", "CONTACTS", "../contacts", "2-not-numeric"]) {
      expectPolicyError(
        () => planRemoteRequest({ endpointId: "objects.list", pathParams: { objectType } }),
        "unsupported_object_type",
      );
    }
    expectPolicyError(
      () => planRemoteRequest({ endpointId: "schemas.get", pathParams: { objectType: "p123_widget" } }),
      "unsupported_object_type",
    );
    expect(planRemoteRequest({ endpointId: "objects.create", pathParams: { objectType: "2-123456" }, body: {} })).toMatchObject({
      risk: "mutation",
      requiredHubSpotScopes: ["crm.objects.custom.write"],
      downstreamScope: "hsapi.write",
    });
    for (const [endpointId, pathParams] of [
      ["objects.archive", { objectType: "contacts", id: "1" }],
      ["objects.merge", { objectType: "contacts" }],
      ["objects.gdpr_delete", { objectType: "contacts" }],
      ["objects.batch_archive", { objectType: "contacts" }],
    ] as const) {
      expect(planRemoteRequest({ endpointId, pathParams, body: endpointId === "objects.archive" ? undefined : {} })).toMatchObject({
        risk: "destructive",
        requiredHubSpotScopes: ["crm.objects.contacts.write"],
        downstreamScope: "hsapi.write",
      });
    }
  });

  it("keeps ServiceKey-only Price Books out of the remote OAuth manifest", () => {
    expectPolicyError(
      () => planRemoteRequest({ endpointId: "price_books.get", pathParams: { priceBookId: "1" } }),
      "endpoint_not_allowed",
    );
  });

  it("allows typed Marketing Events reads and confirmed writes", () => {
    expect(planRemoteRequest({ endpointId: "marketing.events.list" })).toMatchObject({
      method: "GET",
      path: "/marketing/marketing-events/2026-03",
      risk: "read",
      downstreamScope: "hsapi.read",
      requiredHubSpotScopes: ["crm.objects.marketing_events.read"],
    });
    for (const endpointId of ["marketing.events.create", "marketing.events.upsert"]) {
      expect(planRemoteRequest({ endpointId, body: { inputs: [] } })).toMatchObject({
        method: "POST",
        risk: "mutation",
        downstreamScope: "hsapi.write",
        requiredHubSpotScopes: ["crm.objects.marketing_events.write"],
      });
    }
    expectPolicyError(
      () => planRemoteRequest({ endpointId: "marketing.marketing_events.post_marketing_marketing_events_2026_03_batch_archive", body: { inputs: [] } }),
      "endpoint_not_allowed",
    );
  });

  it("supports scope-bound raw reads, mutations, and destructive calls", () => {
    expect(planRemoteRequest({
      method: "POST",
      path: "/crm/objects/2026-03/contacts/search",
      body: { filterGroups: [] },
    })).toMatchObject({
      endpointId: "objects.search",
      risk: "read",
      readOnlyPost: true,
      requiredHubSpotScopes: ["crm.objects.contacts.read"],
      downstreamScope: "hsapi.read",
    });
    expect(planRemoteRequest({
      method: "PATCH",
      path: "/crm/objects/2026-03/contacts/123/associations/deals/456",
      body: { associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 },
    })).toMatchObject({
      endpointId: "raw.crm.objects",
      risk: "mutation",
      requiredHubSpotScopes: ["crm.objects.contacts.write"],
      downstreamScope: "hsapi.write",
    });
    expect(planRemoteRequest({
      method: "DELETE",
      path: "/crm/objects/2026-03/contacts/123",
    })).toMatchObject({
      endpointId: "objects.archive",
      risk: "destructive",
      requiredHubSpotScopes: ["crm.objects.contacts.write"],
    });
    expect(planRemoteRequest({
      method: "PUT",
      path: "/marketing/marketing-events/2026-03/events/abc",
      body: { eventName: "Updated" },
    })).toMatchObject({
      risk: "mutation",
      requiredHubSpotScopes: ["crm.objects.marketing_events.write"],
      downstreamScope: "hsapi.write",
    });
    expect(planRemoteRequest({
      method: "POST",
      path: "/marketing/marketing-events/2026-03/batch/archive",
      body: { inputs: [] },
    })).toMatchObject({
      endpointId: "marketing.marketing_events.post_marketing_marketing_events_2026_03_batch_archive",
      risk: "destructive",
      requiredHubSpotScopes: ["crm.objects.marketing_events.write"],
    });
  });

  it("rejects raw proxy escapes and paths without an exposed OAuth scope", () => {
    for (const path of [
      "https://api.hubapi.com/crm/objects/2026-03/contacts",
      "//api.hubapi.com/crm/objects/2026-03/contacts",
      "/crm/objects/2026-03/contacts?archived=true",
      "/crm/objects/2026-03/contacts/%2e%2e",
      "/crm/objects/2026-03/contacts/a%2Fb",
      "/crm/objects/2026-03/contacts/a%5Cb",
    ]) {
      expectPolicyError(() => planRemoteRequest({ method: "GET", path }), "invalid_request_path");
    }
    for (const path of [
      "/settings/v3/users",
      "/developer/projects/v3/apps",
      "/crm/commerce/price-books/v3/price-books/1",
    ]) {
      expectPolicyError(() => planRemoteRequest({ method: "GET", path }), "endpoint_not_allowed");
    }
    expectPolicyError(
      () => planRemoteRequest({ method: "GET", path: "/crm/objects/2026-03/contacts", query: { access_token: "nope" } }),
      "invalid_query_parameter",
    );
  });

  it("rejects credential-like query parameters, unexpected path parameters, and oversized bodies", () => {
    expectPolicyError(
      () => planRemoteRequest({ endpointId: "account.details", query: { access_token: "nope" } }),
      "invalid_query_parameter",
    );
    expectPolicyError(
      () => planRemoteRequest({ endpointId: "account.details", pathParams: { portalId: "123" } }),
      "unexpected_path_parameter",
    );
    expectPolicyError(
      () => planRemoteRequest({ endpointId: "objects.create", pathParams: { objectType: "contacts" }, body: { value: "x".repeat(513 * 1024) } }),
      "invalid_body",
    );
  });

  it("reports availability from actual granted scopes and the write feature flag", () => {
    const scopes = ["oauth", "crm.objects.contracts.read", "crm.objects.custom.read", "crm.schemas.custom.read"];
    const summary = remoteCapabilitySummary(scopes, false);
    const objects = summary.crmObjects as Array<Record<string, unknown>>;

    expect(objects.find((entry) => entry.objectType === "contracts")).toMatchObject({
      readAvailable: true,
      writeAvailable: false,
      searchAvailable: true,
    });
    expect(summary.customObjects).toMatchObject({
      objectTypePattern: "2-<digits>",
      recordReadAvailable: true,
      recordWriteAvailable: false,
      schemaReadAvailable: true,
    });
    expect(summary.rawFallback).toMatchObject({
      enabled: true,
      fixedOrigin: "https://api.hubapi.com",
      destructiveOperationsSupported: false,
    });
    const writeSummary = remoteCapabilitySummary(
      ["oauth", "crm.objects.marketing_events.read", "crm.objects.marketing_events.write"],
      true,
    );
    expect(writeSummary.direct).toEqual(expect.arrayContaining([
      expect.objectContaining({ endpointId: "marketing.events.create", operation: "write", available: true }),
      expect.objectContaining({ endpointId: "marketing.events.upsert", operation: "write", available: true }),
    ]));
    expect(missingHubSpotScopes(
      planRemoteRequest({ endpointId: "objects.get", pathParams: { objectType: "contacts", id: "1" } }),
      ["oauth"],
    )).toEqual(["crm.objects.contacts.read"]);
  });

  it("describes exact executor inputs without making unavailable capabilities look usable", () => {
    expect(remoteEndpointHelp(
      "objects.get",
      "contracts",
      ["oauth", "crm.objects.contracts.read"],
      false,
    )).toMatchObject({
      endpointId: "objects.get",
      method: "GET",
      pathParameters: ["objectType", "id"],
      requiredHubSpotScopes: ["crm.objects.contracts.read"],
      available: true,
      tool: "hsapi_request_execute_read",
      inputExample: {
        endpointId: "objects.get",
        pathParams: { objectType: "contracts", id: "<id>" },
      },
    });

    expect(remoteEndpointHelp(
      "objects.search",
      "2-123456",
      ["oauth", "crm.objects.custom.read"],
      false,
    )).toMatchObject({
      requiredHubSpotScopes: ["crm.objects.custom.read"],
      customObjectTypePattern: "2-<digits>",
      available: true,
    });
    expect(remoteEndpointHelp(
      "schemas.get",
      "2-123456",
      ["oauth", "crm.schemas.custom.read"],
      false,
    )).toMatchObject({
      requiredHubSpotScopes: ["crm.schemas.custom.read"],
      available: true,
      inputExample: {
        endpointId: "schemas.get",
        pathParams: { objectType: "2-123456" },
      },
    });

    expectPolicyError(
      () => remoteEndpointHelp("price_books.get", undefined, ["oauth"], false),
      "endpoint_not_allowed",
    );
    expect(remoteEndpointHelp(
      "objects.search",
      "contracts",
      ["oauth", "crm.objects.contracts.read"],
      false,
    )).toMatchObject({
      requiredHubSpotScopes: ["crm.objects.contracts.read"],
      available: true,
    });
  });
});
