import catalogJson from "../../../data/hubspot-api-catalog.json";
import type {
  JsonValue,
  RemoteRawRequestInput,
  RemoteRequestInput,
  RemoteRequestPlan,
  RemoteRequestSourceInput,
} from "./types";

export const REMOTE_CAPABILITY_REVISION = "2026-08-03.1";

type Risk = "read" | "sensitive-read" | "mutation" | "destructive";

interface CatalogEndpoint {
  family: string;
  name: string;
  method: string;
  path: string;
  risk: Risk;
  readOnlyPost?: boolean;
  status: "typed" | "catalog-only";
  requiredScopes?: string[];
  auth?: { family?: string; subtype?: string; tokenAudience?: string };
}

interface EndpointSnapshot {
  method: string;
  path: string;
  risk: Risk;
  readOnlyPost?: boolean;
  status: "typed" | "catalog-only";
  scopes: string[];
  catalogScopes?: string[];
  audience?: string;
  catalogAudience?: string;
  feature: RemoteRequestPlan["feature"];
}

export class RemotePolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RemotePolicyError";
    this.code = code;
  }
}

const DIRECT_ENDPOINTS: Record<string, EndpointSnapshot> = {
  "account.details": {
    method: "GET",
    path: "/account-info/2026-03/details",
    risk: "read",
    status: "typed",
    scopes: [],
    audience: "user",
    feature: "account",
  },
  "schemas.list": {
    method: "GET",
    path: "/crm-object-schemas/2026-03/schemas",
    risk: "read",
    status: "typed",
    scopes: ["crm.schemas.custom.read"],
    catalogScopes: [],
    feature: "crm",
  },
  "schemas.get": {
    method: "GET",
    path: "/crm-object-schemas/2026-03/schemas/{objectType}",
    risk: "read",
    status: "typed",
    scopes: ["crm.schemas.custom.read"],
    catalogScopes: [],
    feature: "crm",
  },
  "marketing.events.list": {
    method: "GET",
    path: "/marketing/marketing-events/2026-03",
    risk: "read",
    status: "typed",
    scopes: ["crm.objects.marketing_events.read"],
    feature: "crm",
  },
  "marketing.events.create": {
    method: "POST",
    path: "/marketing/marketing-events/2026-03/events",
    risk: "mutation",
    status: "typed",
    scopes: ["crm.objects.marketing_events.write"],
    feature: "crm",
  },
  "marketing.events.upsert": {
    method: "POST",
    path: "/marketing/marketing-events/2026-03/events/upsert",
    risk: "mutation",
    status: "typed",
    scopes: ["crm.objects.marketing_events.write"],
    feature: "crm",
  },
  "automation.sequences.list": {
    method: "GET",
    path: "/automation/sequences/2026-03",
    risk: "read",
    status: "typed",
    scopes: ["automation.sequences.read"],
    audience: "user",
    feature: "crm",
  },
  "automation.sequences.get": {
    method: "GET",
    path: "/automation/sequences/2026-03/{sequenceId}",
    risk: "read",
    status: "typed",
    scopes: ["automation.sequences.read"],
    audience: "user",
    feature: "crm",
  },
  "automation.sequences.enroll_contact": {
    method: "POST",
    path: "/automation/sequences/2026-03/enrollments",
    risk: "mutation",
    status: "typed",
    scopes: ["automation.sequences.read", "automation.sequences.enrollments.write"],
    audience: "user",
    feature: "crm",
  },
  "automation.sequences.enrollment_status": {
    method: "GET",
    path: "/automation/sequences/2026-03/enrollments/contact/{contactId}",
    risk: "read",
    status: "typed",
    scopes: ["automation.sequences.read"],
    audience: "user",
    feature: "crm",
  },
  "automation.sequences.beta_create": {
    method: "POST",
    path: "/automation/sequences/2026-09-beta/serviceaccounts/sequences",
    risk: "mutation",
    status: "catalog-only",
    scopes: ["automation.sequences.read", "automation.sequences.enrollments.write"],
    audience: "user",
    feature: "crm",
  },
  "automation.sequences.beta_list": {
    method: "GET",
    path: "/automation/sequences/2026-09-beta/serviceaccounts/sequences",
    risk: "read",
    status: "catalog-only",
    scopes: ["automation.sequences.read"],
    audience: "user",
    feature: "crm",
  },
  "automation.sequences.beta_get": {
    method: "GET",
    path: "/automation/sequences/2026-09-beta/serviceaccounts/sequences/{sequenceId}",
    risk: "read",
    status: "catalog-only",
    scopes: ["automation.sequences.read"],
    audience: "user",
    feature: "crm",
  },
  "automation.sequences.beta_update": {
    method: "PUT",
    path: "/automation/sequences/2026-09-beta/serviceaccounts/sequences/{sequenceId}",
    risk: "mutation",
    status: "catalog-only",
    scopes: ["automation.sequences.read", "automation.sequences.enrollments.write"],
    audience: "user",
    feature: "crm",
  },
  "automation.sequences.beta_delete": {
    method: "DELETE",
    path: "/automation/sequences/2026-09-beta/serviceaccounts/sequences/{sequenceId}",
    risk: "destructive",
    status: "catalog-only",
    scopes: ["automation.sequences.read", "automation.sequences.enrollments.write"],
    audience: "user",
    feature: "crm",
  },
  "automation.sequences.beta_enroll_contact": {
    method: "POST",
    path: "/automation/sequences/2026-09-beta/enrollments",
    risk: "mutation",
    status: "catalog-only",
    scopes: ["automation.sequences.read", "automation.sequences.enrollments.write"],
    audience: "user",
    feature: "crm",
  },
  "automation.sequences.beta_enrollment_status": {
    method: "GET",
    path: "/automation/sequences/2026-09-beta/enrollments/contact/{contactId}",
    risk: "read",
    status: "catalog-only",
    scopes: ["automation.sequences.read"],
    audience: "user",
    feature: "crm",
  },
  "settings.users.teams": {
    method: "GET",
    path: "/settings/users/2026-03/teams",
    risk: "read",
    status: "typed",
    scopes: ["settings.users.teams.read"],
    audience: "user",
    feature: "account",
  },
  "settings.teams.beta_list": {
    method: "GET",
    path: "/settings/teams/2026-09-beta",
    risk: "read",
    status: "catalog-only",
    scopes: ["settings.users.teams.read"],
    audience: "user",
    feature: "account",
  },
  "settings.teams.beta_get": {
    method: "GET",
    path: "/settings/teams/2026-09-beta/{teamId}",
    risk: "read",
    status: "catalog-only",
    scopes: ["settings.users.teams.read"],
    audience: "user",
    feature: "account",
  },
  "settings.teams.beta_members_list": {
    method: "GET",
    path: "/settings/teams/2026-09-beta/{teamId}/members",
    risk: "read",
    status: "catalog-only",
    scopes: ["settings.users.teams.read"],
    audience: "user",
    feature: "account",
  },
};

const CRM_ENDPOINTS: Record<string, Omit<EndpointSnapshot, "scopes" | "audience" | "feature">> = {
  "objects.list": { method: "GET", path: "/crm/objects/2026-03/{objectType}", risk: "read", status: "typed" },
  "objects.get": { method: "GET", path: "/crm/objects/2026-03/{objectType}/{id}", risk: "read", status: "typed" },
  "objects.search": { method: "POST", path: "/crm/objects/2026-03/{objectType}/search", risk: "read", readOnlyPost: true, status: "typed" },
  "objects.batch_read": { method: "POST", path: "/crm/objects/2026-03/{objectType}/batch/read", risk: "read", readOnlyPost: true, status: "typed" },
  "objects.create": { method: "POST", path: "/crm/objects/2026-03/{objectType}", risk: "mutation", status: "typed" },
  "objects.update": { method: "PATCH", path: "/crm/objects/2026-03/{objectType}/{id}", risk: "mutation", status: "typed" },
  "objects.batch_create": { method: "POST", path: "/crm/objects/2026-03/{objectType}/batch/create", risk: "mutation", status: "typed" },
  "objects.batch_update": { method: "POST", path: "/crm/objects/2026-03/{objectType}/batch/update", risk: "mutation", status: "typed" },
  "objects.batch_upsert": { method: "POST", path: "/crm/objects/2026-03/{objectType}/batch/upsert", risk: "mutation", status: "typed" },
  "objects.archive": { method: "DELETE", path: "/crm/objects/2026-03/{objectType}/{id}", risk: "destructive", status: "typed" },
  "objects.merge": { method: "POST", path: "/crm/objects/2026-03/{objectType}/merge", risk: "destructive", status: "typed" },
  "objects.gdpr_delete": { method: "POST", path: "/crm/objects/2025-09/{objectType}/gdpr-delete", risk: "destructive", status: "typed" },
  "objects.batch_archive": { method: "POST", path: "/crm/objects/2026-03/{objectType}/batch/archive", risk: "destructive", status: "typed" },
};

const CRM_READ_SCOPES: Record<string, string> = {
  contacts: "crm.objects.contacts.read",
  companies: "crm.objects.companies.read",
  deals: "crm.objects.deals.read",
  tickets: "crm.objects.tickets.read",
  line_items: "crm.objects.line_items.read",
  products: "crm.objects.products.read",
  quotes: "crm.objects.quotes.read",
  invoices: "crm.objects.invoices.read",
  subscriptions: "crm.objects.subscriptions.read",
  orders: "crm.objects.orders.read",
  carts: "crm.objects.carts.read",
  tasks: "crm.objects.tasks.read",
  notes: "crm.objects.notes.read",
  calls: "crm.objects.calls.read",
  meetings: "crm.objects.meetings.read",
  emails: "crm.objects.emails.read",
  contracts: "crm.objects.contracts.read",
  marketing_events: "crm.objects.marketing_events.read",
  users: "mcp.users.read",
};

const CRM_WRITE_SCOPES: Record<string, string> = {
  contacts: "crm.objects.contacts.write",
  companies: "crm.objects.companies.write",
  deals: "crm.objects.deals.write",
  tickets: "crm.objects.tickets.write",
  line_items: "crm.objects.line_items.write",
  products: "crm.objects.products.write",
  tasks: "crm.objects.tasks.write",
  notes: "crm.objects.notes.write",
  calls: "crm.objects.calls.write",
  meetings: "crm.objects.meetings.write",
  emails: "crm.objects.emails.write",
  marketing_events: "crm.objects.marketing_events.write",
};

const CUSTOM_OBJECT_TYPE_PATTERN = /^2-\d+$/;
const CUSTOM_OBJECT_READ_SCOPE = "crm.objects.custom.read";
const CUSTOM_OBJECT_WRITE_SCOPE = "crm.objects.custom.write";

export const REMOTE_HUBSPOT_SCOPES: readonly string[] = Object.freeze([...new Set([
  "oauth",
  ...Object.values(DIRECT_ENDPOINTS).flatMap((endpoint) => endpoint.scopes),
  ...Object.values(CRM_READ_SCOPES),
  ...Object.values(CRM_WRITE_SCOPES),
  CUSTOM_OBJECT_READ_SCOPE,
  CUSTOM_OBJECT_WRITE_SCOPE,
])]);

const catalogEndpoints = (catalogJson as unknown as { endpoints: CatalogEndpoint[] }).endpoints;
const catalogById = new Map(catalogEndpoints.map((endpoint) => [endpoint.name, endpoint]));

function equalStrings(left: string[], right: string[]): boolean {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

function verifySnapshot(id: string, expected: EndpointSnapshot | Omit<EndpointSnapshot, "scopes" | "audience" | "feature">): void {
  const endpoint = catalogById.get(id);
  if (!endpoint) throw new Error(`Remote MCP manifest references missing catalog endpoint ${id}.`);
  const actualScopes = endpoint.requiredScopes ?? [];
  const expectedScopes = expected.catalogScopes ?? ("scopes" in expected ? expected.scopes : []);
  const expectedAudience = expected.catalogAudience ?? ("audience" in expected ? expected.audience : undefined);
  if (
    endpoint.method !== expected.method
    || endpoint.path !== expected.path
    || endpoint.risk !== expected.risk
    || Boolean(endpoint.readOnlyPost) !== Boolean(expected.readOnlyPost)
    || endpoint.status !== expected.status
    || !equalStrings(actualScopes, expectedScopes)
    || endpoint.auth?.tokenAudience !== expectedAudience
  ) throw new Error(`Remote MCP manifest drift detected for catalog endpoint ${id}.`);
}

export function assertRemoteManifestMatchesCatalog(): void {
  for (const [id, snapshot] of Object.entries(DIRECT_ENDPOINTS)) verifySnapshot(id, snapshot);
  for (const [id, snapshot] of Object.entries(CRM_ENDPOINTS)) verifySnapshot(id, snapshot);
}

assertRemoteManifestMatchesCatalog();

function safePathSegment(name: string, value: string): string {
  if (!value || value.length > 240 || value === "." || value === ".." || /[\/\\\u0000-\u001f\u007f]/.test(value)) {
    throw new RemotePolicyError("invalid_path_parameter", `${name} is not a safe path segment.`);
  }
  return encodeURIComponent(value);
}

function fillPath(template: string, supplied: Record<string, string>): string {
  const placeholders = [...template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]);
  const allowed = new Set(placeholders);
  for (const key of Object.keys(supplied)) {
    if (!allowed.has(key)) throw new RemotePolicyError("unexpected_path_parameter", `Unexpected path parameter ${key}.`);
  }
  let result = template;
  for (const placeholder of placeholders) {
    const value = supplied[placeholder];
    if (typeof value !== "string") throw new RemotePolicyError("missing_path_parameter", `Missing path parameter ${placeholder}.`);
    result = result.replace(`{${placeholder}}`, safePathSegment(placeholder, value));
  }
  return result;
}

function normalizeQuery(query: RemoteRequestSourceInput["query"]): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  let count = 0;
  for (const [key, rawValue] of Object.entries(query ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(key) || /^(access_token|authorization|client_secret|hapikey)$/i.test(key)) {
      throw new RemotePolicyError("invalid_query_parameter", `Query parameter ${key} is not allowed.`);
    }
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    if (!values.length || values.length > 100) throw new RemotePolicyError("invalid_query_parameter", `Query parameter ${key} has an invalid value count.`);
    output[key] = values.map((value) => {
      if (!["string", "number", "boolean"].includes(typeof value)) throw new RemotePolicyError("invalid_query_parameter", `Query parameter ${key} has an invalid value.`);
      const normalized = String(value);
      if (normalized.length > 4096 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new RemotePolicyError("invalid_query_parameter", `Query parameter ${key} is too large or contains control characters.`);
      count += 1;
      return normalized;
    });
  }
  if (count > 500) throw new RemotePolicyError("invalid_query_parameter", "Too many query parameter values.");
  return output;
}

function assertJsonBody(value: JsonValue | undefined): void {
  if (value === undefined) return;
  const serialized = JSON.stringify(value);
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > 512 * 1024) {
    throw new RemotePolicyError("invalid_body", "The JSON body exceeds the 512 KiB remote limit.");
  }
}

function planRisk(risk: Risk): RemoteRequestPlan["risk"] {
  if (risk === "read" || risk === "sensitive-read") return "read";
  return risk;
}

function scopeForObjectType(objectType: string, risk: RemoteRequestPlan["risk"]): string {
  const customObject = CUSTOM_OBJECT_TYPE_PATTERN.test(objectType);
  if (!customObject && !/^[a-z][a-z0-9_]*$/.test(objectType)) {
    throw new RemotePolicyError("unsupported_object_type", "Remote CRM requests require an exact canonical standard object type or a custom object type ID in 2-<digits> form.");
  }
  const requiredScope = customObject
    ? (risk === "read" ? CUSTOM_OBJECT_READ_SCOPE : CUSTOM_OBJECT_WRITE_SCOPE)
    : (risk === "read" ? CRM_READ_SCOPES[objectType] : CRM_WRITE_SCOPES[objectType]);
  if (!requiredScope) {
    throw new RemotePolicyError("unsupported_object_type", "This object and operation are not enabled for remote OAuth.");
  }
  return requiredScope;
}

function genericCrmPlan(input: RemoteRequestInput, endpoint: CatalogEndpoint, snapshot: typeof CRM_ENDPOINTS[string]): RemoteRequestPlan {
  const pathParams = input.pathParams ?? {};
  const objectType = pathParams.objectType;
  if (typeof objectType !== "string") {
    throw new RemotePolicyError("unsupported_object_type", "Remote CRM requests require an exact canonical standard object type or a custom object type ID in 2-<digits> form.");
  }
  const risk = planRisk(snapshot.risk);
  const requiredScope = scopeForObjectType(objectType, risk);
  return {
    endpointId: input.endpointId,
    family: endpoint.family,
    method: snapshot.method,
    path: fillPath(snapshot.path, pathParams),
    query: normalizeQuery(input.query),
    ...(input.body !== undefined ? { body: input.body } : {}),
    risk,
    readOnlyPost: Boolean(snapshot.readOnlyPost),
    requiredHubSpotScopes: [requiredScope],
    downstreamScope: risk === "read" ? "hsapi.read" : "hsapi.write",
    feature: "crm",
  };
}

function planNamedRequest(input: RemoteRequestInput): RemoteRequestPlan {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.endpointId !== "string") {
    throw new RemotePolicyError("invalid_request", "endpointId is required.");
  }
  assertJsonBody(input.body);
  const endpoint = catalogById.get(input.endpointId);
  if (!endpoint) throw new RemotePolicyError("endpoint_not_allowed", "The endpoint is not present in the packaged catalog.");

  const crmSnapshot = CRM_ENDPOINTS[input.endpointId];
  if (crmSnapshot) return genericCrmPlan(input, endpoint, crmSnapshot);

  const direct = DIRECT_ENDPOINTS[input.endpointId];
  if (!direct) throw new RemotePolicyError("endpoint_not_allowed", "The endpoint is not enabled by the remote OAuth manifest.");
  if (input.endpointId === "schemas.get") {
    const objectType = input.pathParams?.objectType;
    if (typeof objectType !== "string" || !CUSTOM_OBJECT_TYPE_PATTERN.test(objectType)) {
      throw new RemotePolicyError("unsupported_object_type", "Remote custom schema reads require an object type ID in 2-<digits> form.");
    }
  }
  return {
    endpointId: input.endpointId,
    family: endpoint.family,
    method: direct.method,
    path: fillPath(direct.path, input.pathParams ?? {}),
    query: normalizeQuery(input.query),
    ...(input.body !== undefined ? { body: input.body } : {}),
    risk: planRisk(direct.risk),
    readOnlyPost: Boolean(direct.readOnlyPost),
    requiredHubSpotScopes: direct.scopes.length ? [...direct.scopes] : ["oauth"],
    downstreamScope: planRisk(direct.risk) === "read" ? "hsapi.read" : "hsapi.write",
    feature: direct.feature,
  };
}

const RAW_METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const REMOTE_SCOPE_MANIFEST = new Set(REMOTE_HUBSPOT_SCOPES);

function canonicalRawPath(rawPath: string): string {
  if (
    !rawPath
    || rawPath.length > 8192
    || !rawPath.startsWith("/")
    || rawPath.startsWith("//")
    || rawPath.includes("?")
    || rawPath.includes("#")
    || /[\\\u0000-\u001f\u007f]/.test(rawPath)
    || /%(?:2f|5c|2e)/i.test(rawPath)
  ) {
    throw new RemotePolicyError("invalid_request_path", "Raw requests require a path-only HubSpot API target without a host, query string, fragment, traversal, or encoded separators.");
  }
  const rawSegments = rawPath.slice(1).split("/");
  if (!rawSegments.length || rawSegments.some((segment) => !segment)) {
    throw new RemotePolicyError("invalid_request_path", "Raw request paths cannot contain empty segments.");
  }
  const segments = rawSegments.map((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new RemotePolicyError("invalid_request_path", "Raw request paths must use valid percent encoding.");
    }
    if (decoded === "." || decoded === ".." || /[\/\\\u0000-\u001f\u007f]/.test(decoded)) {
      throw new RemotePolicyError("invalid_request_path", "Raw request paths cannot contain traversal or separator segments.");
    }
    return encodeURIComponent(decoded);
  });
  return `/${segments.join("/")}`;
}

function matchPathTemplate(template: string, path: string): Record<string, string> | undefined {
  const templateSegments = template.slice(1).split("/");
  const pathSegments = path.slice(1).split("/");
  if (templateSegments.length !== pathSegments.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < templateSegments.length; index += 1) {
    const templateSegment = templateSegments[index];
    const pathSegment = decodeURIComponent(pathSegments[index]);
    const placeholder = /^\{([A-Za-z][A-Za-z0-9_]*)\}$/.exec(templateSegment);
    if (placeholder) params[placeholder[1]] = pathSegment;
    else if (templateSegment !== pathSegment) return undefined;
  }
  return params;
}

interface CatalogMatch {
  endpoint: CatalogEndpoint;
  pathParams: Record<string, string>;
}

function catalogMatches(method: string, path: string): CatalogMatch[] {
  return catalogEndpoints
    .filter((endpoint) => endpoint.method === method)
    .map((endpoint) => ({ endpoint, pathParams: matchPathTemplate(endpoint.path, path) }))
    .filter((match): match is CatalogMatch => match.pathParams !== undefined)
    .sort((left, right) => {
      const leftStatic = left.endpoint.path.split("/").filter((segment) => segment && !segment.startsWith("{")).length;
      const rightStatic = right.endpoint.path.split("/").filter((segment) => segment && !segment.startsWith("{")).length;
      return rightStatic - leftStatic;
    });
}

function inferredRawRisk(method: string, path: string, matches: CatalogMatch[]): RemoteRequestPlan["risk"] {
  if (matches.length) {
    if (matches.some(({ endpoint }) => endpoint.risk === "destructive")) return "destructive";
    if (matches.some(({ endpoint }) => endpoint.risk === "mutation")) return "mutation";
    return "read";
  }
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return "read";
  if (method === "DELETE" || /\/(?:archive|delete|gdpr-delete|merge)(?:\/|$)/i.test(path)) return "destructive";
  return "mutation";
}

function rawPlan(
  input: RemoteRawRequestInput,
  method: string,
  path: string,
  endpointId: string,
  family: string,
  risk: RemoteRequestPlan["risk"],
  requiredHubSpotScopes: string[],
  readOnlyPost: boolean,
): RemoteRequestPlan {
  return {
    endpointId,
    family,
    method,
    path,
    query: normalizeQuery(input.query),
    ...(input.body !== undefined ? { body: input.body } : {}),
    risk,
    readOnlyPost,
    requiredHubSpotScopes,
    downstreamScope: risk === "read" ? "hsapi.read" : "hsapi.write",
    feature: family === "account" ? "account" : "crm",
  };
}

function planRawRequest(input: RemoteRawRequestInput): RemoteRequestPlan {
  if (typeof input.method !== "string" || typeof input.path !== "string") {
    throw new RemotePolicyError("invalid_request", "Raw requests require method and path.");
  }
  const method = input.method.toUpperCase();
  if (!RAW_METHODS.has(method)) {
    throw new RemotePolicyError("method_not_allowed", "Raw requests support GET, HEAD, OPTIONS, POST, PUT, PATCH, and DELETE.");
  }
  const path = canonicalRawPath(input.path);
  const matches = catalogMatches(method, path);
  const risk = inferredRawRisk(method, path, matches);
  const preferred = matches[0];

  const crmMatch = /^\/crm\/objects\/(?:v3|\d{4}-\d{2})\/([^/]+)(?:\/|$)/.exec(path);
  if (crmMatch) {
    const objectType = decodeURIComponent(crmMatch[1]);
    const requiredScope = scopeForObjectType(objectType, risk);
    return rawPlan(
      input,
      method,
      path,
      preferred?.endpoint.name ?? "raw.crm.objects",
      preferred?.endpoint.family ?? "crm.objects",
      risk,
      [requiredScope],
      risk === "read" && method === "POST" && Boolean(preferred?.endpoint.readOnlyPost),
    );
  }

  if (/^\/marketing\/(?:marketing-events\/(?:v3|\d{4}-\d{2})|v3\/marketing-events)(?:\/|$)/.test(path)) {
    return rawPlan(
      input,
      method,
      path,
      preferred?.endpoint.name ?? "raw.marketing.marketing_events",
      preferred?.endpoint.family ?? "marketing.marketing_events",
      risk,
      [risk === "read" ? "crm.objects.marketing_events.read" : "crm.objects.marketing_events.write"],
      risk === "read" && method === "POST" && Boolean(preferred?.endpoint.readOnlyPost),
    );
  }

  const namedMatch = matches.find(({ endpoint }) => DIRECT_ENDPOINTS[endpoint.name]);
  if (namedMatch) {
    return planNamedRequest({
      endpointId: namedMatch.endpoint.name,
      ...(Object.keys(namedMatch.pathParams).length ? { pathParams: namedMatch.pathParams } : {}),
      ...(input.query ? { query: input.query } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
    });
  }

  const scopedMatch = matches.find(({ endpoint }) => (
    endpoint.auth?.family === "portal_bearer"
    && Boolean(endpoint.requiredScopes?.length)
    && endpoint.requiredScopes!.every((scope) => REMOTE_SCOPE_MANIFEST.has(scope))
  ));
  if (!scopedMatch) {
    throw new RemotePolicyError("endpoint_not_allowed", "The raw path is not tied to a HubSpot OAuth scope exposed by this remote connector.");
  }
  const scopedRisk = planRisk(scopedMatch.endpoint.risk);
  return rawPlan(
    input,
    method,
    path,
    scopedMatch.endpoint.name,
    scopedMatch.endpoint.family,
    scopedRisk,
    [...scopedMatch.endpoint.requiredScopes!],
    Boolean(scopedMatch.endpoint.readOnlyPost),
  );
}

export function planRemoteRequest(input: RemoteRequestSourceInput): RemoteRequestPlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RemotePolicyError("invalid_request", "A named endpoint request or a raw method/path request is required.");
  }
  assertJsonBody(input.body);
  if ("endpointId" in input) return planNamedRequest(input);
  return planRawRequest(input);
}

export function missingHubSpotScopes(plan: RemoteRequestPlan, grantedScopes: string[]): string[] {
  const granted = new Set(grantedScopes);
  return plan.requiredHubSpotScopes.filter((scope) => !granted.has(scope));
}

function pathParameterNames(pathTemplate: string): string[] {
  return [...pathTemplate.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
    .map((match) => match[1]);
}

function requestExample(
  endpointId: string,
  pathTemplate: string,
  objectType?: string,
): Record<string, unknown> {
  const pathParams = Object.fromEntries(pathParameterNames(pathTemplate).map((name) => [
    name,
    name === "objectType"
      ? (objectType ?? (endpointId.startsWith("schemas.") ? "2-<custom-object-type-id>" : "contacts"))
      : `<${name}>`,
  ]));
  return {
    endpointId,
    ...(Object.keys(pathParams).length ? { pathParams } : {}),
  };
}

export function remoteEndpointHelp(
  endpointId: string,
  objectType: string | undefined,
  grantedScopes: string[],
  writesEnabled: boolean,
): Record<string, unknown> {
  const direct = DIRECT_ENDPOINTS[endpointId];
  if (direct) {
    const acceptsObjectType = pathParameterNames(direct.path).includes("objectType");
    if (objectType !== undefined && !acceptsObjectType) {
      throw new RemotePolicyError("invalid_request", "objectType does not apply to this endpoint ID.");
    }
    if (endpointId === "schemas.get" && objectType !== undefined && !CUSTOM_OBJECT_TYPE_PATTERN.test(objectType)) {
      throw new RemotePolicyError("unsupported_object_type", "Remote custom schema reads require an object type ID in 2-<digits> form.");
    }
    const requiredScopes = direct.scopes.length ? [...direct.scopes] : ["oauth"];
    const write = direct.risk !== "read";
    const featureEnabled = !write || writesEnabled;
    const missingScopes = requiredScopes.filter((scope) => !grantedScopes.includes(scope));
    return {
      endpointId,
      feature: direct.feature,
      method: direct.method,
      pathTemplate: direct.path,
      pathParameters: pathParameterNames(direct.path),
      operation: write ? "write" : "read",
      readOnlyPost: Boolean(direct.readOnlyPost),
      status: direct.status,
      requiredHubSpotScopes: requiredScopes,
      missingHubSpotScopes: missingScopes,
      featureEnabled,
      available: featureEnabled && missingScopes.length === 0,
      tool: write ? "hsapi_request_execute" : "hsapi_request_execute_read",
      inputExample: requestExample(endpointId, direct.path, objectType),
    };
  }

  const crm = CRM_ENDPOINTS[endpointId];
  if (!crm) {
    throw new RemotePolicyError("endpoint_not_allowed", "The endpoint is not enabled by the remote OAuth manifest.");
  }
  const write = crm.risk !== "read";
  const scopeMap = write ? CRM_WRITE_SCOPES : CRM_READ_SCOPES;
  const supportedObjectTypes = Object.keys(scopeMap);
  let requiredScopes: string[] = [];
  if (objectType !== undefined) {
    const customObject = CUSTOM_OBJECT_TYPE_PATTERN.test(objectType);
    if (!customObject && !supportedObjectTypes.includes(objectType)) {
      throw new RemotePolicyError("unsupported_object_type", "This object and operation are not enabled for remote OAuth.");
    }
    requiredScopes = [customObject
      ? (write ? CUSTOM_OBJECT_WRITE_SCOPE : CUSTOM_OBJECT_READ_SCOPE)
      : scopeMap[objectType]];
  }
  const missingScopes = requiredScopes.filter((scope) => !grantedScopes.includes(scope));
  return {
    endpointId,
    feature: "crm",
    method: crm.method,
    pathTemplate: crm.path,
    pathParameters: pathParameterNames(crm.path),
    operation: write ? "write" : "read",
    readOnlyPost: Boolean(crm.readOnlyPost),
    status: crm.status,
    objectTypeRequired: true,
    ...(objectType ? { objectType } : {}),
    supportedObjectTypes,
    customObjectTypePattern: "2-<digits>",
    requiredHubSpotScopes: requiredScopes,
    missingHubSpotScopes: missingScopes,
    featureEnabled: !write || writesEnabled,
    available: objectType !== undefined && (!write || writesEnabled) && missingScopes.length === 0,
    tool: write ? "hsapi_request_execute" : "hsapi_request_execute_read",
    inputExample: requestExample(endpointId, crm.path, objectType),
  };
}

export function remoteCapabilitySummary(
  grantedScopes: string[],
  writesEnabled: boolean,
): Record<string, unknown> {
  const granted = new Set(grantedScopes);
  const direct = Object.entries(DIRECT_ENDPOINTS).map(([endpointId, snapshot]) => {
    const requiredScopes = snapshot.scopes.length ? snapshot.scopes : ["oauth"];
    const write = snapshot.risk !== "read";
    return {
      endpointId,
      operation: write ? "write" : "read",
      feature: snapshot.feature,
      requiredScopes,
      available: (!write || writesEnabled)
        && requiredScopes.every((scope) => granted.has(scope)),
    };
  });
  const crmObjects = Object.keys(CRM_READ_SCOPES).map((objectType) => ({
    objectType,
    readScope: CRM_READ_SCOPES[objectType],
    readAvailable: granted.has(CRM_READ_SCOPES[objectType]),
    writeScope: CRM_WRITE_SCOPES[objectType] ?? null,
    writeAvailable: writesEnabled && Boolean(CRM_WRITE_SCOPES[objectType]) && granted.has(CRM_WRITE_SCOPES[objectType]),
    searchAvailable: granted.has(CRM_READ_SCOPES[objectType]),
  }));
  return {
    revision: REMOTE_CAPABILITY_REVISION,
    direct,
    crmObjects,
    customObjects: {
      objectTypePattern: "2-<digits>",
      recordReadScope: CUSTOM_OBJECT_READ_SCOPE,
      recordReadAvailable: granted.has(CUSTOM_OBJECT_READ_SCOPE),
      recordWriteScope: CUSTOM_OBJECT_WRITE_SCOPE,
      recordWriteAvailable: writesEnabled && granted.has(CUSTOM_OBJECT_WRITE_SCOPE),
      schemaReadScope: "crm.schemas.custom.read",
      schemaReadAvailable: granted.has("crm.schemas.custom.read"),
      recordReadEndpoints: ["objects.list", "objects.get", "objects.search", "objects.batch_read"],
      recordWriteEndpoints: ["objects.create", "objects.update", "objects.batch_create", "objects.batch_update", "objects.batch_upsert", "objects.archive", "objects.merge", "objects.gdpr_delete", "objects.batch_archive"],
      schemaReadEndpoints: ["schemas.list", "schemas.get"],
    },
    rawFallback: {
      enabled: true,
      tools: ["hsapi_request_execute_read", "hsapi_request_execute"],
      input: "method + path + optional query/body",
      fixedOrigin: "https://api.hubapi.com",
      scopeBoundary: "catalog-backed paths or strict CRM object and Marketing Events paths tied to a scope in the remote OAuth manifest",
      mutationsRequirePreviewConfirmation: true,
      destructiveOperationsSupported: writesEnabled,
    },
    deliberatelyUnavailable: [
      "ServiceKey/private-app authentication",
      "Price Books require the local ServiceKey connector",
      "custom object record and schema reads remain grant-gated until HubSpot accepts the public-app scopes",
      "custom object writes remain grant-gated until HubSpot accepts crm.objects.custom.write for the public app",
      "Commerce Payments remain local until HubSpot accepts crm.objects.commercepayments.read for the user-level app",
      "sales email templates remain local until HubSpot accepts the documented public read and write scopes",
      "team writes remain local until HubSpot accepts settings.users.teams.write for the user-level app",
      "contract writes remain unavailable until HubSpot publishes and grants an OAuth write scope",
      "reports/views and other local Agent CLI bridges",
    ],
  };
}
