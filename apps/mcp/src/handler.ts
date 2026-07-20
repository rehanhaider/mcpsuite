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
 *   `Authorization: Bearer emcp_…` — an MCP client API key created in
 *   Admin → Agents. Scopes + trust profile come from the client record.
 *   Any other request (missing/invalid key) gets 401.
 *
 * Stateless mode: a fresh McpServer + transport per request, no session ids.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { mcpContext, resolveMcpToken, resolveWorkspaceAccess, type AnyRuntime, type Runtime } from "@emcp/db";
import type { RequestContext } from "@emcp/core";
import { createMcpServer, lockedRpcRejection } from "./server.ts";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function resolveContext(request: Request, runtime: Runtime): RequestContext | null {
  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    const client = resolveMcpToken(runtime.db, header.slice("Bearer ".length).trim());
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

    if (runtime.adapter !== "sqlite") {
      // Bearer API keys and workspace access state resolve from the SQLite
      // store (same constraint as requireSqliteRuntime). A hosted deployment
      // on another adapter runs the standalone MCP process instead of this
      // in-process mount — answer clearly instead of crashing.
      return json(501, {
        error: "mcp_unavailable",
        message: "This deployment does not serve MCP in-process; it requires the SQLite runtime.",
      });
    }

    const ctx = resolveContext(request, runtime);
    if (!ctx) {
      return json(401, {
        error: "unauthorized",
        message: "Send Authorization: Bearer <emcp API key> — create one in the web UI under Admin → Agents.",
      });
    }

    const body = await readBody(request);

    // Hosted access gate: the key identified a client (auth succeeded), but a
    // locked workspace refuses tool calls and resource reads at the JSON-RPC
    // layer. Handshake and listing methods still pass through.
    if (resolveWorkspaceAccess(runtime.db, ctx.workspaceId).mode === "locked") {
      const rejection = lockedRpcRejection(body);
      if (rejection) return json(200, rejection);
    }

    const server = createMcpServer(runtime, ctx);
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
      return await transport.handleRequest(request, body === undefined ? undefined : { parsedBody: body });
    } finally {
      // JSON-response mode: the Response body is a complete string by the
      // time handleRequest resolves, so closing here leaks nothing.
      void transport.close();
      void server.close();
    }
  } catch (error) {
    console.error("[emcp-mcp] request failed:", error);
    return json(500, { error: "internal" });
  }
}
