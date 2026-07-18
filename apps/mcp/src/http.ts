/**
 * Streamable HTTP transport on :8765 (MCP_PORT) for Claude Desktop / Cowork
 * and any remote agent.
 *
 * Auth, per request:
 *   `Authorization: Bearer emcp_…` — an MCP client API key created in
 *   Admin → Agents. Scopes + trust profile come from the client record.
 *   Any other request (missing/invalid key) gets 401.
 *
 * Stateless mode: a fresh McpServer + transport per request, no session ids.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getRuntimeAsync, mcpContext, resolveMcpToken, resolveWorkspaceAccess } from "@emcp/db";
import type { RequestContext } from "@emcp/core";
import { createMcpServer, lockedRpcRejection, requireSqliteRuntime } from "./server.ts";

const PORT = Number(process.env.MCP_PORT ?? 8765);
const HOST = process.env.MCP_HOST ?? "127.0.0.1";

// DATABASE_URL adapter selection happens inside getRuntimeAsync (unset ->
// SQLite default, file: -> SQLite at that path); Bearer auth needs SQLite.
const runtime = requireSqliteRuntime(await getRuntimeAsync(), "HTTP");

function resolveContext(req: IncomingMessage): RequestContext | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const client = resolveMcpToken(runtime.db, header.slice("Bearer ".length).trim());
    return client ? mcpContext(client) : null;
  }
  return null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/healthz") {
      return json(res, 200, { ok: true, server: "emcp-mcp", operations: runtime.catalog.size });
    }

    if (url.pathname !== "/mcp") {
      return json(res, 404, { error: "not_found", hint: "MCP endpoint is /mcp" });
    }

    if (req.method !== "POST") {
      // Stateless mode: no SSE streams or session deletes.
      res.writeHead(405, { allow: "POST", "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "method_not_allowed" }));
    }

    const ctx = resolveContext(req);
    if (!ctx) {
      return json(res, 401, {
        error: "unauthorized",
        message: "Send Authorization: Bearer <emcp API key> — create one in the web UI under Admin → Agents.",
      });
    }

    const body = await readBody(req);

    // Hosted access gate: the key identified a client (auth succeeded), but a
    // locked workspace refuses tool calls and resource reads at the JSON-RPC
    // layer. Handshake and listing methods still pass through.
    if (resolveWorkspaceAccess(runtime.db, ctx.workspaceId).mode === "locked") {
      const rejection = lockedRpcRejection(body);
      if (rejection) return json(res, 200, rejection);
    }

    const server = createMcpServer(runtime, ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error("[emcp-mcp] request failed:", error);
    if (!res.headersSent) json(res, 500, { error: "internal" });
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(
    `[emcp-mcp] HTTP listening on http://${HOST}:${PORT}/mcp — ${runtime.catalog.size} operations, Bearer API key required`,
  );
});
