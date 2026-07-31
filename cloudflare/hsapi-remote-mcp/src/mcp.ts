import { McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ConfirmationLedger } from "./confirmation-ledger";
import { createConfirmationToken, readConfirmationToken } from "./crypto";
import {
  confirmationBinding,
  executeHubSpotRequest,
  RemoteExecutionError,
  requestPreview,
} from "./hubspot-request";
import {
  missingHubSpotScopes,
  planRemoteRequest,
  REMOTE_CAPABILITY_REVISION,
  remoteCapabilitySummary,
  remoteEndpointHelp,
  RemotePolicyError,
} from "./remote-policy";
import type { HubSpotAccessProps, JsonValue, RemoteRequestSourceInput, RuntimeConfig } from "./types";

const pathParamsSchema = z.record(z.string(), z.string()).optional();
const querySchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string()).max(100)]),
).optional();
const requestFields = {
  endpointId: z.string().min(1).max(160).optional(),
  pathParams: pathParamsSchema,
  method: z.string().min(1).max(16).optional(),
  path: z.string().min(1).max(8192).optional(),
  query: querySchema,
  body: z.unknown().optional(),
};

function validateRequestSource(
  value: { endpointId?: string; pathParams?: Record<string, string>; method?: string; path?: string },
  context: z.RefinementCtx,
): void {
  const named = value.endpointId !== undefined;
  const raw = value.method !== undefined || value.path !== undefined;
  if (named === raw) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Supply either endpointId/pathParams or method/path, but not both." });
    return;
  }
  if (raw && (value.method === undefined || value.path === undefined || value.pathParams !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Raw requests require method and path and cannot include pathParams." });
  }
}

const requestSchema = z.object(requestFields).superRefine(validateRequestSource);
const mutationSchema = z.object({
  ...requestFields,
  confirmMutation: z.boolean().optional(),
  confirmationToken: z.string().min(16).max(4096).optional(),
}).superRefine(validateRequestSource);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateAccessProps(value: unknown, config: RuntimeConfig): HubSpotAccessProps {
  if (!isRecord(value)) throw new RemoteExecutionError("invalid_auth_context", "The remote authorization context is unavailable.");
  const hubId = Number(value.hubId);
  const userId = Number(value.userId);
  const expiresAt = Number(value.accessTokenExpiresAtMs);
  const mcpExpiresAt = Number(value.mcpAccessTokenExpiresAtMs);
  const scopes = Array.isArray(value.scopes) ? value.scopes.filter((scope): scope is string => typeof scope === "string") : [];
  const mcpScopes = Array.isArray(value.mcpScopes) ? value.mcpScopes.filter((scope): scope is string => typeof scope === "string") : [];
  if (
    value.version !== 1
    || typeof value.accessToken !== "string"
    || !value.accessToken
    || !Number.isSafeInteger(hubId)
    || hubId <= 0
    || !Number.isSafeInteger(userId)
    || userId <= 0
    || !Number.isSafeInteger(expiresAt)
    || expiresAt <= Date.now()
    || !Number.isSafeInteger(mcpExpiresAt)
    || mcpExpiresAt <= Date.now()
    || typeof value.clientId !== "string"
    || value.clientId !== config.hubSpotClientId
    || scopes.length !== (value.scopes as unknown[]).length
    || typeof value.mcpClientId !== "string"
    || !value.mcpClientId
    || mcpScopes.length !== (value.mcpScopes as unknown[]).length
    || (config.hubSpotRequireUserLevel && value.isUserLevel !== true)
  ) throw new RemoteExecutionError("invalid_auth_context", "The remote authorization context must be renewed.");
  return {
    version: 1,
    accessToken: value.accessToken,
    accessTokenExpiresAtMs: expiresAt,
    hubId,
    userId,
    ...(typeof value.hubDomain === "string" && value.hubDomain ? { hubDomain: value.hubDomain } : {}),
    scopes,
    isUserLevel: value.isUserLevel === true,
    clientId: value.clientId,
    mcpClientId: value.mcpClientId,
    mcpScopes,
    mcpAccessTokenExpiresAtMs: mcpExpiresAt,
  };
}

function hasDownstreamScope(authInfo: AuthInfo | undefined, scope: string): boolean {
  return Boolean(authInfo?.scopes?.includes(scope));
}

function result(payload: Record<string, unknown>, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function safeError(error: unknown): ReturnType<typeof result> {
  if (error instanceof RemotePolicyError || error instanceof RemoteExecutionError) {
    return result({ ok: false, error: { code: error.code, message: error.message } }, true);
  }
  console.error(JSON.stringify({ event: "remote_tool_error", code: "internal_error" }));
  return result({ ok: false, error: { code: "internal_error", message: "The remote request could not be completed." } }, true);
}

function toolInput(args: z.infer<typeof requestSchema> | z.infer<typeof mutationSchema>): RemoteRequestSourceInput {
  if (args.endpointId) {
    return {
      endpointId: args.endpointId,
      ...(args.pathParams ? { pathParams: args.pathParams } : {}),
      ...(args.query ? { query: args.query } : {}),
      ...(args.body !== undefined ? { body: args.body as JsonValue } : {}),
    };
  }
  return {
    method: args.method!,
    path: args.path!,
    ...(args.query ? { query: args.query } : {}),
    ...(args.body !== undefined ? { body: args.body as JsonValue } : {}),
  };
}

function assertAuthorized(
  plan: ReturnType<typeof planRemoteRequest>,
  props: HubSpotAccessProps,
  authInfo: AuthInfo | undefined,
): void {
  if (!hasDownstreamScope(authInfo, plan.downstreamScope)) {
    throw new RemoteExecutionError("insufficient_mcp_scope", `This operation requires downstream scope ${plan.downstreamScope}.`);
  }
  const missing = missingHubSpotScopes(plan, props.scopes);
  if (missing.length) {
    throw new RemoteExecutionError("missing_hubspot_scope", `Reconnect after granting the required HubSpot scope: ${missing.join(", ")}.`);
  }
}

export function createRemoteMcpServer(
  config: RuntimeConfig,
  rawProps: unknown,
  authInfo: AuthInfo | undefined,
  confirmationLedger: DurableObjectNamespace<ConfirmationLedger>,
): McpServer {
  const props = validateAccessProps(rawProps, config);
  const server = new McpServer(
    { name: "hsapi-remote-mcp", version: "0.1.0" },
    {
      instructions: "OAuth-only HubSpot connector. Use the read tool for reads. Either use a named endpointId or the scope-bound raw method/path fallback. For a mutation or destructive operation that is within the user's request, inspect the preview and then resubmit the exact request with confirmMutation=true and its preview-bound confirmationToken. The model may make that decision; this server does not require a separate human approval step. The upstream origin and authorization headers are fixed. ServiceKey and private-app credentials are never accepted.",
      cacheHints: {
        "server/discover": { ttlMs: 60_000, cacheScope: "private" },
        "tools/list": { ttlMs: 60_000, cacheScope: "private" },
      },
    },
  );

  server.registerTool(
    "hsapi_remote_identity",
    {
      title: "Remote HubSpot identity",
      description: "Return the HubSpot account and effective tool-scope metadata for this OAuth connection. Tokens are never returned.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => result({
      ok: true,
      hubId: props.hubId,
      ...(props.hubDomain ? { hubDomain: props.hubDomain } : {}),
      isUserLevel: props.isUserLevel,
      effectiveHubSpotScopes: props.scopes,
      // Compatibility alias for clients that connected before the field was
      // named precisely. Both values are the scope-attenuated tool set.
      hubSpotScopes: props.scopes,
      mcpScopes: authInfo?.scopes ?? [],
      capabilityRevision: REMOTE_CAPABILITY_REVISION,
      upstreamBrokerRole: "remote",
      serviceKeyAccepted: false,
    }),
  );

  server.registerTool(
    "hsapi_remote_capabilities",
    {
      title: "Remote HubSpot capabilities",
      description: "List the remote endpoint/object capabilities, scope-bound raw fallback, and whether the current HubSpot grant can use each capability.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => result({
      ok: true,
      writesEnabled: config.remoteWritesEnabled,
      capabilities: remoteCapabilitySummary(
        props.scopes,
        config.remoteWritesEnabled,
      ),
    }),
  );

  server.registerTool(
    "hsapi_remote_endpoint_help",
    {
      title: "Remote HubSpot endpoint help",
      description: "Explain one remote endpoint ID, its path parameters, required HubSpot scope, current availability, and an executor input example. Supply objectType for object-specific scope availability.",
      inputSchema: z.object({
        endpointId: z.string().min(1).max(160),
        objectType: z.string().min(1).max(160).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ endpointId, objectType }) => {
      try {
        return result({
          ok: true,
          capabilityRevision: REMOTE_CAPABILITY_REVISION,
          endpoint: remoteEndpointHelp(
            endpointId,
            objectType,
            props.scopes,
            config.remoteWritesEnabled,
          ),
        });
      } catch (error) {
        return safeError(error);
      }
    },
  );

  if (hasDownstreamScope(authInfo, "hsapi.read")) {
    server.registerTool(
      "hsapi_request_execute_read",
      {
        title: "Execute remote HubSpot read",
        description: "Execute a HubSpot OAuth read using either endpointId/pathParams or raw method/path with optional query/body. Raw paths must map to an exposed OAuth scope; origin, headers, portal, and auth mode remain fixed.",
        inputSchema: requestSchema,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async (args) => {
        try {
          const plan = planRemoteRequest(toolInput(args));
          if (plan.risk !== "read") throw new RemoteExecutionError("mutation_not_allowed", "Use hsapi_request_execute for mutation previews and confirmed writes.");
          assertAuthorized(plan, props, authInfo);
          const response = await executeHubSpotRequest(plan, props);
          return result({ executed: true, request: requestPreview(plan), response }, response.ok !== true);
        } catch (error) {
          return safeError(error);
        }
      },
    );
  }

  if (config.remoteWritesEnabled && hasDownstreamScope(authInfo, "hsapi.write")) {
    server.registerTool(
      "hsapi_request_execute",
      {
        title: "Preview or execute remote HubSpot mutation",
        description: "Preview a HubSpot OAuth mutation or destructive operation using either endpointId/pathParams or raw method/path with optional query/body. If the preview is consistent with the user's request, the model may execute it by resubmitting the exact request with confirmMutation=true and the returned short-lived confirmationToken; no separate human approval is required by this server.",
        inputSchema: mutationSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async (args) => {
        try {
          const plan = planRemoteRequest(toolInput(args));
          if (plan.risk === "read") throw new RemoteExecutionError("read_tool_required", "Use hsapi_request_execute_read for read operations.");
          assertAuthorized(plan, props, authInfo);
          const preview = requestPreview(plan);
          const binding = confirmationBinding(plan, props, REMOTE_CAPABILITY_REVISION);
          if (args.confirmMutation !== true) {
            return result({
              ok: true,
              executed: false,
              confirmationRequired: true,
              confirmationExpiresInSeconds: 180,
              confirmationToken: await createConfirmationToken(config.stateEncryptionKey, binding),
              preview,
            });
          }
          const confirmation = args.confirmationToken
            ? await readConfirmationToken(args.confirmationToken, config.stateEncryptionKey, binding)
            : undefined;
          if (!confirmation) {
            throw new RemoteExecutionError("invalid_confirmation", "The mutation confirmation token is missing, expired, or does not match this exact request.");
          }
          const claimed = await confirmationLedger.getByName(confirmation.nonce)
            .claim(confirmation.expiresAtMs);
          if (!claimed) {
            throw new RemoteExecutionError("invalid_confirmation", "The mutation confirmation token is expired or has already been used.");
          }
          const response = await executeHubSpotRequest(plan, props);
          console.log(JSON.stringify({
            event: "remote_mutation",
            endpointId: plan.endpointId,
            risk: plan.risk,
            status: response.status,
          }));
          return result({ executed: true, request: preview, response }, response.ok !== true);
        } catch (error) {
          return safeError(error);
        }
      },
    );
  }

  return server;
}
