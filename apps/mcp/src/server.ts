/**
 * Transport-agnostic MCP server: every catalog operation with `mcpExpose`
 * becomes a tool (dots → underscores). Results come back as JSON text.
 *
 * The RequestContext is resolved by the transport (stdio = local owner-agent,
 * HTTP = Bearer API key) and injected per server instance.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
import type { z } from "zod";
import type { OperationDef, OpResult, RequestContext } from "@mcpsuite/core";
import { WORKSPACE_LOCKED_MESSAGE, workspaceLockedResult, type AnyRuntime } from "@mcpsuite/db";

export const SERVER_INFO = { name: "mcpsuite-crm", version: "0.1.0" } as const;

// ---------------------------------------------------------------------------
// Hosted access gate (packages/hosting-control/README.md read contract).
// Key auth may succeed — identification is allowed — but a locked workspace
// refuses every tool call and resource read. Checked per call, through the
// runtime's identity store, so long-lived transports (stdio) pick up
// lock/unlock without a restart; self-host always resolves as active.
// ---------------------------------------------------------------------------

/** JSON-RPC error code for a locked workspace (implementation-defined range). */
export const WORKSPACE_LOCKED_RPC_CODE = -32003;

const WORKSPACE_LOCKED_RPC_MESSAGE = `workspace_locked: ${WORKSPACE_LOCKED_MESSAGE}`;

async function workspaceLocked(runtime: AnyRuntime, ctx: RequestContext): Promise<boolean> {
  return (await runtime.identity.workspaceAccess(ctx.workspaceId)).mode === "locked";
}

function lockedMcpError(): McpError {
  return new McpError(WORKSPACE_LOCKED_RPC_CODE, WORKSPACE_LOCKED_RPC_MESSAGE);
}

/** Methods that stay available while locked: identification + listings only. */
const LOCKED_ALLOWED_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
]);

/**
 * JSON-RPC rejection for a locked workspace, built from a raw (already
 * parsed) request body before it reaches the SDK. Returns the error
 * response(s) to send, or null when nothing in the body needs rejecting
 * (handshake/listing methods and notifications pass through).
 */
export function lockedRpcRejection(body: unknown): unknown | null {
  const messages = Array.isArray(body) ? body : [body];
  const rejected = messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    const { id, method } = message as { id?: unknown; method?: unknown };
    if (typeof method !== "string" || LOCKED_ALLOWED_METHODS.has(method)) return [];
    if (id === undefined || id === null) return []; // notifications get no response
    return [
      {
        jsonrpc: "2.0" as const,
        id: id as string | number,
        error: {
          code: WORKSPACE_LOCKED_RPC_CODE,
          message: WORKSPACE_LOCKED_RPC_MESSAGE,
          data: { code: "workspace_locked" },
        },
      },
    ];
  });
  if (rejected.length === 0) return null;
  return Array.isArray(body) ? rejected : rejected[0];
}

export function toText(result: OpResult): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  if (result.status === "ok") {
    return { content: [{ type: "text", text: JSON.stringify(result.data ?? null, null, 2) }] };
  }
  if (result.status === "pending_approval") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              pendingApproval: true,
              pendingActionId: result.pendingActionId,
              operation: result.operation,
              riskCategory: result.riskCategory,
              preview: result.preview,
              message: result.message,
            },
            null,
            2,
          ),
        },
      ],
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify({ error: result.error }, null, 2) }],
    isError: true,
  };
}

/** company.create → company_create */
export function toolName(operationName: string): string {
  return operationName.replace(/\./g, "_");
}

export function createMcpServer(
  runtime: AnyRuntime,
  ctx: RequestContext,
  onPendingApproval?: (requestId: string | number, result: Extract<OpResult, { status: "pending_approval" }>) => void,
): McpServer {
  const server = new McpServer(SERVER_INFO, {
    ...(onPendingApproval ? { capabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } } } : {}),
    instructions:
      "mcpsuite CRM — agent-native sales CRM. Naming: engagements are outreach leads; deals carry money. " +
      "Start with stats_home for an operational overview, search_global to find records, " +
      "*_get_context tools for full record bundles. Risky operations may return pendingApproval=true; " +
      "task-capable HTTP clients receive a task handle instead. A human must approve in the web UI " +
      "(Approvals page) before the operation takes effect.",
  });

  for (const op of runtime.catalog.values()) {
    if (!op.mcpExpose) continue;
    registerTool(server, runtime, ctx, op, onPendingApproval);
  }
  registerResources(server, runtime, ctx);
  return server;
}

/**
 * Read-only resources for cheap agent context: the operation catalog itself,
 * pipeline/stage config, saved views, pending approvals, and per-record
 * context bundles. Reads go through the catalog so scopes still apply.
 */
function registerResources(server: McpServer, runtime: AnyRuntime, ctx: RequestContext): void {
  const json = (uri: string, data: unknown) => ({
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
  });
  const runOrThrow = async (name: string, input: Record<string, unknown> = {}): Promise<unknown> => {
    if (await workspaceLocked(runtime, ctx)) throw lockedMcpError();
    const result = await runtime.run(ctx, name, input);
    if (result.status !== "ok") {
      throw new Error(result.status === "error" ? `${result.error.code}: ${result.error.message}` : result.message);
    }
    return result.data;
  };

  server.registerResource(
    "catalog",
    "mcpsuite://catalog",
    {
      title: "Operation catalog",
      description: "Every operation this CRM exposes: name, risk category, required scope/role.",
      mimeType: "application/json",
    },
    async (uri) => {
      if (await workspaceLocked(runtime, ctx)) throw lockedMcpError();
      return json(
        uri.href,
        [...runtime.catalog.values()].filter((op) => op.mcpExpose).map((op) => ({
          name: op.name,
          tool: toolName(op.name),
          title: op.title,
          description: op.description,
          scope: op.scope,
          minRole: op.minRole,
          risk: op.risk ?? null,
          mcpExpose: op.mcpExpose,
        })),
      );
    },
  );

  server.registerResource(
    "pipelines",
    "mcpsuite://pipelines",
    {
      title: "Pipelines and stages",
      description: "Engagement + deal pipelines with their ordered stages (ids needed for stage updates).",
      mimeType: "application/json",
    },
    async (uri) => json(uri.href, await runOrThrow("pipeline.list", {})),
  );

  server.registerResource(
    "saved-views",
    "mcpsuite://views",
    {
      title: "Saved views",
      description: "Saved filters; run one with saved_view_run.",
      mimeType: "application/json",
    },
    async (uri) => json(uri.href, await runOrThrow("savedView.list", {})),
  );

  server.registerResource(
    "pending-approvals",
    "mcpsuite://approvals/pending",
    {
      title: "Pending approvals",
      description: "Actions waiting for human review.",
      mimeType: "application/json",
    },
    async (uri) => json(uri.href, await runOrThrow("pendingAction.list", { status: "pending" })),
  );

  const CONTEXT_OPS: Record<string, string> = {
    company: "company.getContext",
    person: "person.getContext",
    engagement: "engagement.getContext",
    deal: "deal.getContext",
  };
  server.registerResource(
    "record-context",
    new ResourceTemplate("mcpsuite://context/{type}/{id}", { list: undefined }),
    {
      title: "Record context bundle",
      description: "Full context for one record (type: company | person | engagement | deal).",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      if (await workspaceLocked(runtime, ctx)) throw lockedMcpError();
      const type = String(variables.type ?? "");
      const opName = CONTEXT_OPS[type];
      if (!opName) throw new Error(`Unknown context type "${type}" (use company|person|engagement|deal)`);
      return json(uri.href, await runOrThrow(opName, { id: String(variables.id ?? "") }));
    },
  );
}

function registerTool(
  server: McpServer,
  runtime: AnyRuntime,
  ctx: RequestContext,
  op: OperationDef,
  onPendingApproval?: (requestId: string | number, result: Extract<OpResult, { status: "pending_approval" }>) => void,
): void {
  const objectSchema = op.input as unknown as z.ZodObject<ZodRawShape>;
  const shape: ZodRawShape = typeof objectSchema.shape === "object" ? objectSchema.shape : {};
  server.registerTool(
    toolName(op.name),
    {
      title: op.title,
      description: op.risk ? `${op.description} [risk: ${op.risk}]` : op.description,
      inputSchema: shape,
    },
    async (args: Record<string, unknown>, extra) => {
      // Locked workspaces answer with the same catalog error envelope agents
      // already understand; the operation is never executed.
      if (await workspaceLocked(runtime, ctx)) return toText(workspaceLockedResult());
      const result = await runtime.run(ctx, op.name, args ?? {});
      if (result.status === "pending_approval") onPendingApproval?.(extra.requestId, result);
      return toText(result);
    },
  );
}
