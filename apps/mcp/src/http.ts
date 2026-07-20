/**
 * Standalone Streamable HTTP transport on :8765 (MCP_PORT) for deployments
 * that scale MCP separately from the web process (the default install serves
 * POST /mcp inside the web process itself — see PRODUCTION.md).
 *
 * Auth, per request:
 *   `Authorization: Bearer emcp_…` — an MCP client API key created in
 *   Admin → Agents. Scopes + trust profile come from the client record.
 *   Any other request (missing/invalid key) gets 401.
 *
 * Stateless mode: a fresh McpServer + transport per request, no session ids.
 * The per-request handling itself lives in handler.ts (web-standard
 * Request/Response), shared with the in-process mount so auth and error
 * shapes cannot drift; this file is only the node:http bridge around it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getRuntimeAsync } from "@emcp/db";
import { handleMcpRequest } from "./handler.ts";
import { requireSqliteRuntime } from "./server.ts";

const PORT = Number(process.env.MCP_PORT ?? 8765);
const HOST = process.env.MCP_HOST ?? "127.0.0.1";

// DATABASE_URL adapter selection happens inside getRuntimeAsync (unset ->
// SQLite default, file: -> SQLite at that path); Bearer auth needs SQLite.
const runtime = requireSqliteRuntime(await getRuntimeAsync(), "HTTP");

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/** node req -> web-standard Request (body fully buffered; requests are small). */
async function toFetchRequest(req: IncomingMessage, url: URL): Promise<Request> {
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
  }
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers });
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Request(url, { method, headers, body: Buffer.concat(chunks) });
}

/** web-standard Response -> node res (JSON mode: bodies are complete strings). */
async function writeFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
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

    await writeFetchResponse(res, await handleMcpRequest(await toFetchRequest(req, url), runtime));
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
