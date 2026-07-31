import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { WorkerEntrypoint } from "cloudflare:workers";
import { DefaultHandler } from "./auth-handler";
export { AuthorizationState } from "./authorization-state";
export { ConfirmationLedger } from "./confirmation-ledger";
import { assertCanonicalRequestOrigin, readConfig } from "./config";
import { sha256Base64Url } from "./crypto";
import { handleTokenExchange } from "./hubspot-oauth";
import { boundIncomingRequest } from "./inbound";
import { createRemoteMcpServer } from "./mcp";
import type { HubSpotAccessProps } from "./types";

function supportedMcpScopes(remoteWritesEnabled: boolean): string[] {
  return ["hsapi.read", ...(remoteWritesEnabled ? ["hsapi.write"] : [])];
}

function isAuthorizationRoute(pathname: string): boolean {
  return pathname === "/authorize"
    || pathname === "/oauth/token"
    || pathname === "/hubspot/callback"
    || pathname === "/oauth/register"
    || pathname.startsWith("/oauth/register/");
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1];
}

function accessPropsShape(value: unknown): value is HubSpotAccessProps {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const props = value as Partial<HubSpotAccessProps>;
  return props.version === 1
    && Number.isSafeInteger(props.hubId)
    && Number(props.hubId) > 0
    && typeof props.mcpClientId === "string"
    && props.mcpClientId.length > 0
    && Array.isArray(props.mcpScopes)
    && props.mcpScopes.every((scope) => typeof scope === "string")
    && Number.isSafeInteger(props.mcpAccessTokenExpiresAtMs);
}

export class McpApiHandler extends WorkerEntrypoint<Env, HubSpotAccessProps> {
  async fetch(request: Request): Promise<Response> {
    const config = readConfig(this.env);
    const props = this.ctx.props;
    const token = bearerToken(request);
    if (!token || !accessPropsShape(props)) return new Response("Invalid OAuth context.", { status: 401 });

    const rateLimit = await this.env.REMOTE_RATE_LIMITER.limit({ key: `hub:${props.hubId}` });
    if (!rateLimit.success) {
      return new Response("Rate limit exceeded.", { status: 429, headers: { "retry-after": "60" } });
    }

    const authInfo: AuthInfo = {
      token,
      clientId: props.mcpClientId,
      scopes: [...props.mcpScopes],
      expiresAt: Math.floor(props.mcpAccessTokenExpiresAtMs / 1000),
      resource: new URL(config.resourceUrl),
    };
    const handler = createMcpHandler(
      (context) => createRemoteMcpServer(config, props, context.authInfo, this.env.CONFIRMATION_LEDGER),
      {
        route: "/mcp",
        legacy: "stateless",
        allowedHostnames: [config.publicHostname],
        allowedOriginHostnames: config.allowedOriginHostnames,
        corsOptions: { origin: "*" },
        onerror(error) {
          console.error(JSON.stringify({ event: "mcp_handler_error", name: error.name }));
        },
      },
    );
    return handler.fetch(request, { authInfo });
  }
}

function createProvider(env: Env): OAuthProvider<Env> {
  const config = readConfig(env);
  const mcpScopes = supportedMcpScopes(config.remoteWritesEnabled);
  return new OAuthProvider<Env>({
    apiRoute: config.resourceUrl,
    apiHandler: McpApiHandler,
    defaultHandler: DefaultHandler,
    authorizeEndpoint: new URL("/authorize", config.publicOrigin).href,
    tokenEndpoint: new URL("/oauth/token", config.publicOrigin).href,
    clientRegistrationEndpoint: new URL("/oauth/register", config.publicOrigin).href,
    scopesSupported: mcpScopes,
    allowImplicitFlow: false,
    allowPlainPKCE: false,
    allowTokenExchangeGrant: false,
    disallowPublicClientRegistration: false,
    clientIdMetadataDocumentEnabled: true,
    resourceMatchOriginOnly: false,
    resourceMetadata: {
      resource: config.resourceUrl,
      authorization_servers: [config.publicOrigin],
      scopes_supported: mcpScopes,
      bearer_methods_supported: ["header"],
      resource_name: "HSAPI Remote MCP",
    },
    accessTokenTTL: config.mcpAccessTokenTtlSeconds,
    refreshTokenTTL: 30 * 24 * 60 * 60,
    clientRegistrationTTL: 90 * 24 * 60 * 60,
    tokenExchangeCallback: (options) => handleTokenExchange(options, config),
    onError({ code, status, internal }) {
      console.warn(JSON.stringify({
        event: "oauth_error",
        code,
        status,
        ...(internal?.category ? { category: internal.category } : {}),
      }));
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let config;
    try {
      config = readConfig(env);
      assertCanonicalRequestOrigin(request, config);
    } catch (error) {
      if (error instanceof Response) return error;
      console.error(JSON.stringify({ event: "worker_configuration_error" }));
      return new Response("Worker configuration error.", { status: 500 });
    }
    const sourceAddress = request.headers.get("cf-connecting-ip") ?? "unavailable";
    const sourceHash = await sha256Base64Url(sourceAddress);
    const edgeRateLimit = await env.EDGE_RATE_LIMITER.limit({ key: `edge:${sourceHash}` });
    if (!edgeRateLimit.success) {
      return new Response("Rate limit exceeded.", { status: 429, headers: { "retry-after": "60" } });
    }
    if (isAuthorizationRoute(new URL(request.url).pathname)) {
      const key = `auth:${sourceHash}`;
      const rateLimit = await env.AUTH_RATE_LIMITER.limit({ key });
      if (!rateLimit.success) {
        return new Response("Rate limit exceeded.", { status: 429, headers: { "retry-after": "60" } });
      }
    }
    const boundedRequest = await boundIncomingRequest(request);
    if (boundedRequest instanceof Response) return boundedRequest;
    return createProvider(env).fetch(boundedRequest, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const result = await createProvider(env).purgeExpiredData(env, { batchSize: 200 });
    console.log(JSON.stringify({
      event: "oauth_cleanup",
      grantsChecked: result.grantsChecked,
      grantsPurged: result.grantsPurged,
      tokensChecked: result.tokensChecked,
      tokensPurged: result.tokensPurged,
      done: result.done,
    }));
  },
} satisfies ExportedHandler<Env>;
