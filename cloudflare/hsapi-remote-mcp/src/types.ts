import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export type HandlerEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

export interface RuntimeConfig {
  environment: string;
  publicOrigin: string;
  publicHostname: string;
  resourceUrl: string;
  callbackUrl: string;
  allowedOriginHostnames: string[];
  mcpAccessTokenTtlSeconds: number;
  remoteWritesEnabled: boolean;
  hubSpotRequireUserLevel: boolean;
  brokerUrl: string;
  hubSpotClientId: string;
  hubSpotRequiredScopes: string[];
  hubSpotOptionalScopes: string[];
  hubSpotAppScopeCeiling: string[];
  stateEncryptionKey: string;
}

export interface HubSpotIdentity {
  hubId: number;
  userId: number;
  hubDomain?: string;
  scopes: string[];
  isUserLevel: boolean;
  clientId: string;
}

export interface HubSpotGrantProps extends HubSpotIdentity {
  version: 1;
  accessToken: string;
  refreshToken: string;
  brokerCredential: string;
  accessTokenExpiresAtMs: number;
  effectiveScopes: string[];
}

export interface HubSpotAccessProps extends HubSpotIdentity {
  version: 1;
  accessToken: string;
  accessTokenExpiresAtMs: number;
  mcpClientId: string;
  mcpScopes: string[];
  mcpAccessTokenExpiresAtMs: number;
}

export interface ConsentRecord {
  version: 1;
  createdAtMs: number;
  request: AuthRequest;
}

export interface UpstreamStateRecord {
  version: 1;
  createdAtMs: number;
  sessionId: string;
  consumeSecret: string;
  codeVerifier: string;
  request: AuthRequest;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface RemoteRequestInput {
  endpointId: string;
  pathParams?: Record<string, string>;
  query?: Record<string, string | number | boolean | string[]>;
  body?: JsonValue;
}

export interface RemoteRawRequestInput {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | string[]>;
  body?: JsonValue;
}

export type RemoteRequestSourceInput = RemoteRequestInput | RemoteRawRequestInput;

export interface RemoteRequestPlan {
  endpointId: string;
  family: string;
  method: string;
  path: string;
  query: Record<string, string[]>;
  body?: JsonValue;
  risk: "read" | "mutation" | "destructive";
  readOnlyPost: boolean;
  requiredHubSpotScopes: string[];
  downstreamScope: "hsapi.read" | "hsapi.write";
  feature: "account" | "crm";
}
