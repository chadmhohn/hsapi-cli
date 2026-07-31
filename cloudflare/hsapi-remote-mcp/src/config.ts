import type { RuntimeConfig } from "./types";
import { REMOTE_HUBSPOT_SCOPES } from "./remote-policy";

const SCOPE_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9-]{8,160}$/;
const KNOWN_LOCAL_BROKER_ORIGINS = new Set([
  "https://hsapi-oauth.groundworkrevops.com",
]);

function required(value: string | undefined, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`Missing required Worker binding: ${label}`);
  return normalized;
}

function parseBoolean(value: string, label: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be exactly true or false.`);
}

function parseInteger(value: string, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function parseOrigin(value: string, label: string, allowLocalHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL origin.`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must contain only a scheme, hostname, and optional port.`);
  }
  const localHttp = allowLocalHttp && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error(`${label} must use HTTPS outside local development.`);
  }
  return url;
}

function parseScopes(value: string, label: string): string[] {
  const scopes = [...new Set(value.split(/\s+/).map((scope) => scope.trim()).filter(Boolean))];
  for (const scope of scopes) {
    if (!SCOPE_PATTERN.test(scope)) throw new Error(`${label} contains an invalid scope identifier.`);
  }
  return scopes;
}

function parseAllowedOriginHostnames(value: string, publicOrigin: URL): string[] {
  const values = value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean);
  const hostnames = values.map((part) => parseOrigin(part, "MCP_ALLOWED_ORIGINS", true).hostname);
  hostnames.push(publicOrigin.hostname);
  return [...new Set(hostnames)];
}

export function readConfig(env: Env): RuntimeConfig {
  const environment = required(env.ENVIRONMENT, "ENVIRONMENT");
  const publicOriginUrl = parseOrigin(required(env.PUBLIC_ORIGIN, "PUBLIC_ORIGIN"), "PUBLIC_ORIGIN", environment === "local");
  const publicOrigin = publicOriginUrl.origin;
  const brokerUrl = parseOrigin(
    required(env.HUBSPOT_BROKER_URL, "HUBSPOT_BROKER_URL"),
    "HUBSPOT_BROKER_URL",
    environment === "local",
  ).origin;
  if (KNOWN_LOCAL_BROKER_ORIGINS.has(brokerUrl)) {
    throw new Error("HUBSPOT_BROKER_URL must identify the dedicated remote-role broker, not the local hosted-OAuth broker.");
  }
  const hubSpotClientId = required(env.HUBSPOT_CLIENT_ID, "HUBSPOT_CLIENT_ID");
  if (!CLIENT_ID_PATTERN.test(hubSpotClientId)) throw new Error("HUBSPOT_CLIENT_ID has an invalid format.");

  const stateEncryptionKey = required(env.STATE_ENCRYPTION_KEY, "STATE_ENCRYPTION_KEY");
  if (stateEncryptionKey.length < 32) throw new Error("STATE_ENCRYPTION_KEY must contain at least 32 characters.");
  if (environment !== "local" && (publicOrigin.includes("REPLACE") || brokerUrl.includes("REPLACE") || /^0{8}-/.test(hubSpotClientId))) {
    throw new Error("Deployment placeholders must be replaced outside local development.");
  }

  const hubSpotRequiredScopes = parseScopes(required(env.HUBSPOT_REQUIRED_SCOPES, "HUBSPOT_REQUIRED_SCOPES"), "HUBSPOT_REQUIRED_SCOPES");
  if (!hubSpotRequiredScopes.includes("oauth")) throw new Error("HUBSPOT_REQUIRED_SCOPES must include oauth.");
  const requiredScopeSet = new Set(hubSpotRequiredScopes);
  const hubSpotOptionalScopes = parseScopes(env.HUBSPOT_OPTIONAL_SCOPES ?? "", "HUBSPOT_OPTIONAL_SCOPES")
    .filter((scope) => !requiredScopeSet.has(scope));
  const hubSpotAppScopeCeiling = parseScopes(
    required(env.HUBSPOT_APP_SCOPE_CEILING, "HUBSPOT_APP_SCOPE_CEILING"),
    "HUBSPOT_APP_SCOPE_CEILING",
  );
  const remoteWritesEnabled = parseBoolean(env.REMOTE_WRITES_ENABLED, "REMOTE_WRITES_ENABLED");
  const configuredWriteScopes = [...hubSpotRequiredScopes, ...hubSpotOptionalScopes]
    .filter((scope) => scope.endsWith(".write"));
  const configuredScopes = [...hubSpotRequiredScopes, ...hubSpotOptionalScopes];
  const remoteScopeSet = new Set(REMOTE_HUBSPOT_SCOPES);
  const unusedScopes = configuredScopes.filter((scope) => !remoteScopeSet.has(scope));
  if (unusedScopes.length) {
    throw new Error(`Configured HubSpot scopes are not referenced by the remote manifest: ${unusedScopes.join(", ")}`);
  }
  if (!remoteWritesEnabled && configuredWriteScopes.length) {
    throw new Error("HubSpot write scopes require REMOTE_WRITES_ENABLED=true.");
  }
  const appScopeCeilingSet = new Set(hubSpotAppScopeCeiling);
  const scopesOutsideAppCeiling = configuredScopes.filter((scope) => !appScopeCeilingSet.has(scope));
  if (scopesOutsideAppCeiling.length) {
    throw new Error(`Remote HubSpot scopes are outside HUBSPOT_APP_SCOPE_CEILING: ${scopesOutsideAppCeiling.join(", ")}`);
  }
  return {
    environment,
    publicOrigin,
    publicHostname: publicOriginUrl.hostname,
    resourceUrl: new URL("/mcp", publicOrigin).href,
    callbackUrl: new URL("/hubspot/callback", publicOrigin).href,
    allowedOriginHostnames: parseAllowedOriginHostnames(required(env.MCP_ALLOWED_ORIGINS, "MCP_ALLOWED_ORIGINS"), publicOriginUrl),
    mcpAccessTokenTtlSeconds: parseInteger(env.MCP_ACCESS_TOKEN_TTL_SECONDS, "MCP_ACCESS_TOKEN_TTL_SECONDS", 60, 1740),
    remoteWritesEnabled,
    hubSpotRequireUserLevel: parseBoolean(env.HUBSPOT_REQUIRE_USER_LEVEL, "HUBSPOT_REQUIRE_USER_LEVEL"),
    brokerUrl,
    hubSpotClientId,
    hubSpotRequiredScopes,
    hubSpotOptionalScopes,
    hubSpotAppScopeCeiling,
    stateEncryptionKey,
  };
}

export function assertCanonicalRequestOrigin(request: Request, config: RuntimeConfig): void {
  if (new URL(request.url).origin !== config.publicOrigin) {
    throw new Response("Misdirected request.", { status: 421 });
  }
}
