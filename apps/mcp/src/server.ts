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
import type { OperationDef, OpResult, RequestContext } from "@emcp/core";
import {
  resolveWorkspaceAccess,
  WORKSPACE_LOCKED_MESSAGE,
  workspaceLockedResult,
  type AnyRuntime,
  type Runtime,
} from "@emcp/db";

export const SERVER_INFO = { name: "emcp-crm", version: "0.1.0" } as const;

/**
 * Both MCP transports authenticate API keys and read the hosted-access lock
 * from the SQLite store (auth.ts / hosting-access.ts are SQLite-typed), so a
 * DATABASE_URL that selects another adapter cannot serve MCP yet: fail at
 * startup with a clear stderr message instead of refusing every request.
 */
export function requireSqliteRuntime(runtime: AnyRuntime, transport: string): Runtime {
  if (runtime.adapter !== "sqlite") {
    console.error(
      `[emcp-mcp] The MCP ${transport} transport requires the SQLite adapter (DATABASE_URL unset or file:); ` +
        `DATABASE_URL selected "${runtime.adapter}". API keys and workspace access state resolve from the SQLite store.`,
    );
    process.exit(1);
  }
  return runtime;
}

// ---------------------------------------------------------------------------
// Hosted access gate (packages/hosting-control/README.md read contract).
// Key auth may succeed — identification is allowed — but a locked workspace
// refuses every tool call and resource read. Checked per call so long-lived
// transports (stdio) pick up lock/unlock without a restart; self-host
// databases (no hc_workspace_access table) always resolve as active.
// ---------------------------------------------------------------------------

/** JSON-RPC error code for a locked workspace (implementation-defined range). */
export const WORKSPACE_LOCKED_RPC_CODE = -32003;

const WORKSPACE_LOCKED_RPC_MESSAGE = `workspace_locked: ${WORKSPACE_LOCKED_MESSAGE}`;

function workspaceLocked(runtime: Runtime, ctx: RequestContext): boolean {
  return resolveWorkspaceAccess(runtime.db, ctx.workspaceId).mode === "locked";
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

function toText(result: OpResult): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
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

export function createMcpServer(runtime: Runtime, ctx: RequestContext): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "emcp CRM — agent-native sales CRM. Naming: engagements are outreach leads; deals carry money. " +
      "Start with stats_home for an operational overview, search_global to find records, " +
      "*_get_context tools for full record bundles. Risky operations may return pendingApproval=true — " +
      "a human must approve them in the web UI (Approvals page) before they take effect.",
  });

  for (const op of runtime.catalog.values()) {
    if (!op.mcpExpose) continue;
    registerTool(server, runtime, ctx, op);
  }
  registerResources(server, runtime, ctx);
  return server;
}

/**
 * Read-only resources for cheap agent context: the operation catalog itself,
 * pipeline/stage config, saved views, pending approvals, and per-record
 * context bundles. Reads go through the catalog so scopes still apply.
 */
function registerResources(server: McpServer, runtime: Runtime, ctx: RequestContext): void {
  const json = (uri: string, data: unknown) => ({
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
  });
  const runOrThrow = async (name: string, input: Record<string, unknown> = {}): Promise<unknown> => {
    if (workspaceLocked(runtime, ctx)) throw lockedMcpError();
    const result = await runtime.run(ctx, name, input);
    if (result.status !== "ok") {
      throw new Error(result.status === "error" ? `${result.error.code}: ${result.error.message}` : result.message);
    }
    return result.data;
  };

  server.registerResource(
    "catalog",
    "emcp://catalog",
    {
      title: "Operation catalog",
      description: "Every operation this CRM exposes: name, risk category, required scope/role.",
      mimeType: "application/json",
    },
    (uri) => {
      if (workspaceLocked(runtime, ctx)) throw lockedMcpError();
      return json(
        uri.href,
        [...runtime.catalog.values()].map((op) => ({
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
    "emcp://pipelines",
    {
      title: "Pipelines and stages",
      description: "Engagement + deal pipelines with their ordered stages (ids needed for stage updates).",
      mimeType: "application/json",
    },
    async (uri) => json(uri.href, await runOrThrow("pipeline.list", {})),
  );

  server.registerResource(
    "saved-views",
    "emcp://views",
    {
      title: "Saved views",
      description: "Saved filters; run one with saved_view_run.",
      mimeType: "application/json",
    },
    async (uri) => json(uri.href, await runOrThrow("savedView.list", {})),
  );

  server.registerResource(
    "pending-approvals",
    "emcp://approvals/pending",
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
    new ResourceTemplate("emcp://context/{type}/{id}", { list: undefined }),
    {
      title: "Record context bundle",
      description: "Full context for one record (type: company | person | engagement | deal).",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      if (workspaceLocked(runtime, ctx)) throw lockedMcpError();
      const type = String(variables.type ?? "");
      const opName = CONTEXT_OPS[type];
      if (!opName) throw new Error(`Unknown context type "${type}" (use company|person|engagement|deal)`);
      return json(uri.href, await runOrThrow(opName, { id: String(variables.id ?? "") }));
    },
  );
}

function registerTool(server: McpServer, runtime: Runtime, ctx: RequestContext, op: OperationDef): void {
  const objectSchema = op.input as unknown as z.ZodObject<ZodRawShape>;
  const shape: ZodRawShape = typeof objectSchema.shape === "object" ? objectSchema.shape : {};
  server.registerTool(
    toolName(op.name),
    {
      title: op.title,
      description: op.risk ? `${op.description} [risk: ${op.risk}]` : op.description,
      inputSchema: shape,
    },
    async (args: Record<string, unknown>) => {
      // Locked workspaces answer with the same catalog error envelope agents
      // already understand; the operation is never executed.
      if (workspaceLocked(runtime, ctx)) return toText(workspaceLockedResult());
      return toText(await runtime.run(ctx, op.name, args ?? {}));
    },
  );
}
