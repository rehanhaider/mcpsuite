/**
 * Per-request MCP-over-HTTP handling in web-standard Request/Response form.
 * One code path, two mounts:
 *
 *   - the product web process serves POST /mcp on its own port (the default
 *     one-process install; apps/web/src/routes/mcp.ts), and
 *   - the standalone HTTP server (http.ts) bridges node req/res to it for
 *     deployments that scale MCP separately.
 *
 * Auth, per request:
 *   `Authorization: Bearer mcpsuite_…` — an MCP client API key created in
 *   Admin → Agents. Scopes + trust profile come from the client record.
 *   Any other request (missing/invalid key) gets 401.
 *
 * Stateless mode: a fresh McpServer + transport per request, no session ids.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { mcpContext, type AnyRuntime } from "@mcpsuite/db";
import type { ErrorPayload, OpResult, RequestContext } from "@mcpsuite/core";
import type { PendingAction } from "@mcpsuite/core/domain";
import { createMcpServer, lockedRpcRejection, toText } from "./server.ts";

const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
const POLL_INTERVAL_MS = 5000;
// This 2025-11-25 SDK has no server/discover for the 2026-07-28 extension.
// Stateless JSON-response HTTP has no stream for subscriptions/listen or
// notifications/tasks; this adapter implements polling and cancellation.
type RpcId = string | number;
type PendingResult = Extract<OpResult, { status: "pending_approval" }>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function rpcId(value: unknown): value is RpcId {
  return typeof value === "string" || typeof value === "number";
}

function taskOptIn(message: unknown): boolean {
  const request = record(message);
  if (request?.method !== "tools/call" || !rpcId(request.id)) return false;
  const meta = record(record(request.params)?._meta);
  const capabilities = record(meta?.["io.modelcontextprotocol/clientCapabilities"]);
  const extensions = record(capabilities?.extensions);
  return record(extensions?.[TASKS_EXTENSION]) !== null;
}

function rpcError(id: RpcId, message: string): object {
  return { jsonrpc: "2.0", id, error: { code: -32602, message } };
}

function approvalUrl(taskId: string): string {
  const base = process.env.MCPSUITE_BASE_URL?.trim() || "http://localhost:2222";
  const url = new URL("/app/approvals", base);
  url.searchParams.set("status", "pending");
  url.searchParams.set("action", taskId);
  return url.href;
}

function taskFields(pa: PendingAction, status: string, statusMessage?: string) {
  return {
    taskId: pa.id,
    status,
    ...(statusMessage ? { statusMessage } : {}),
    createdAt: pa.requestedAt,
    lastUpdatedAt: pa.reviewedAt ?? pa.requestedAt,
    ttlMs: new Date(pa.expiresAt).getTime() - new Date(pa.requestedAt).getTime(),
    pollIntervalMs: POLL_INTERVAL_MS,
  };
}

function taskState(pa: PendingAction): object {
  if (pa.status === "pending" && pa.expiresAt < new Date().toISOString()) {
    return { ...taskFields(pa, "cancelled", "expired"), resultType: "complete" };
  }
  if (pa.status === "pending") {
    const preview = pa.preview ? JSON.stringify(pa.preview) : "No preview available";
    return {
      ...taskFields(pa, "input_required", `This ${pa.riskCategory} operation needs human approval.`),
      resultType: "complete",
      inputRequests: {
        approval: {
          method: "elicitation/create",
          params: {
            mode: "url",
            elicitationId: pa.id,
            url: approvalUrl(pa.id),
            message: `Approve ${pa.operation} (${pa.riskCategory}). Preview: ${preview}`,
          },
        },
      },
    };
  }
  if (pa.status === "approved") {
    return { ...taskFields(pa, "completed"), resultType: "complete", result: toText({ status: "ok", data: pa.result?.data }) };
  }
  if (pa.status === "failed") {
    const error = pa.result?.error as ErrorPayload | undefined;
    return {
      ...taskFields(pa, "completed"), resultType: "complete",
      result: toText({ status: "error", error: error ?? { code: "internal", message: "Approved operation failed" } }),
    };
  }
  if (pa.status === "rejected") {
    const note = pa.reviewNote ? `: ${pa.reviewNote}` : "";
    return {
      ...taskFields(pa, "completed"), resultType: "complete",
      result: toText({ status: "error", error: { code: "forbidden", message: `Rejected by reviewer${note}` } }),
    };
  }
  return { ...taskFields(pa, "cancelled"), resultType: "complete" };
}

async function handleTaskRequest(
  request: Record<string, unknown>, runtime: AnyRuntime, ctx: RequestContext,
): Promise<Response> {
  const id = request.id;
  if (!rpcId(id)) return json(200, rpcError(0, "Invalid request id"));
  const params = record(request.params);
  const taskId = params?.taskId;
  if (typeof taskId !== "string") return json(200, rpcError(id, "Invalid taskId"));
  if (request.method === "tasks/update" && !record(params?.inputResponses)) {
    return json(200, rpcError(id, "Invalid inputResponses"));
  }

  // The workspace-scoped port is a narrow owner read. Catalog pendingAction.get
  // requires the approvals scope, which a task creator need not have.
  const pa = await runtime.portsFor(ctx.workspaceId).pendingActions.get(taskId);
  if (!pa || !ctx.clientId || pa.requestedByClientId !== ctx.clientId) {
    return json(200, rpcError(id, "Unknown task"));
  }

  if (request.method === "tasks/get") return json(200, { jsonrpc: "2.0", id, result: taskState(pa) });
  if (request.method === "tasks/cancel" && pa.status === "pending") {
    // Cancellation is cooperative: the catalog may refuse it (for example,
    // after the client's write scope is removed), but a known task still acks.
    try {
      await runtime.run(ctx, "pendingAction.cancel", { id: taskId });
    } catch {
      // The acknowledgement does not promise a terminal cancelled status.
    }
  }
  // URL-mode approval happens in the web UI. inputResponses only acknowledges
  // what the client saw; it never approves or rejects the stored action.
  return json(200, { jsonrpc: "2.0", id, result: { resultType: "complete" } });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function resolveContext(request: Request, runtime: AnyRuntime): Promise<RequestContext | null> {
  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    const client = await runtime.identity.resolveMcpToken(header.slice("Bearer ".length).trim());
    return client ? mcpContext(client) : null;
  }
  return null;
}

async function readBody(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Handle one MCP HTTP request against an already-resolved runtime. Returns a
 * complete Response in every case (including errors) — callers never need a
 * try/catch of their own.
 */
export async function handleMcpRequest(request: Request, runtime: AnyRuntime): Promise<Response> {
  try {
    if (request.method !== "POST") {
      // Stateless mode: no SSE streams or session deletes.
      return json(405, { error: "method_not_allowed" }, { allow: "POST" });
    }

    const ctx = await resolveContext(request, runtime);
    if (!ctx) {
      return json(401, {
        error: "unauthorized",
        message: "Send Authorization: Bearer <mcpsuite API key> — create one in the web UI under Admin → Agents.",
      });
    }

    const body = await readBody(request);

    // Hosted access gate: the key identified a client (auth succeeded), but a
    // locked workspace refuses tool calls and resource reads at the JSON-RPC
    // layer. Handshake and listing methods still pass through.
    if ((await runtime.identity.workspaceAccess(ctx.workspaceId)).mode === "locked") {
      const rejection = lockedRpcRejection(body);
      if (rejection) return json(200, rejection);
    }

    const message = record(body);
    if (message && (message.method === "tasks/get" || message.method === "tasks/update" || message.method === "tasks/cancel")) {
      return await handleTaskRequest(message, runtime, ctx);
    }

    const optedIds = new Set<RpcId>();
    for (const item of Array.isArray(body) ? body : [body]) {
      if (taskOptIn(item)) optedIds.add(record(item)!.id as RpcId);
    }
    const pending = new Map<RpcId, PendingResult>();

    const server = createMcpServer(runtime, ctx, (id, result) => {
      if (optedIds.has(id)) pending.set(id, result);
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      // Body already consumed above; parsedBody hands the transport the parse
      // result. An unparsable body stays undefined — the transport then fails
      // its own req.json() and answers the JSON-RPC parse error, matching the
      // historical node-transport behavior.
      const response = await transport.handleRequest(request, body === undefined ? undefined : { parsedBody: body });
      if (pending.size === 0) return response;

      // The SDK validates CallToolResult and cannot be trusted to preserve an
      // unknown extension result. Rewrite only the matching JSON-RPC result
      // after its normal tool callback has executed runtime.run exactly once.
      const payload = await response.json() as unknown;
      const rewrite = async (value: unknown): Promise<unknown> => {
        const rpc = record(value);
        if (!rpc || !rpcId(rpc.id) || !record(rpc.result)) return value;
        const approval = pending.get(rpc.id);
        if (!approval) return value;
        const pa = await runtime.portsFor(ctx.workspaceId).pendingActions.get(approval.pendingActionId);
        if (!pa || pa.requestedByClientId !== ctx.clientId) return rpcError(rpc.id, "Unknown task");
        return {
          jsonrpc: "2.0", id: rpc.id,
          result: { ...taskFields(pa, "input_required", approval.message), resultType: "task" },
        };
      };
      const rewritten = Array.isArray(payload)
        ? await Promise.all(payload.map(rewrite))
        : await rewrite(payload);
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return json(response.status, rewritten, Object.fromEntries(headers.entries()));
    } finally {
      // JSON-response mode: the Response body is a complete string by the
      // time handleRequest resolves, so closing here leaks nothing.
      void transport.close();
      void server.close();
    }
  } catch (error) {
    console.error("[mcpsuite-mcp] request failed:", error);
    return json(500, { error: "internal" });
  }
}
