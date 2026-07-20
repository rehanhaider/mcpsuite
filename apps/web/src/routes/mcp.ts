/**
 * POST /mcp — the MCP endpoint served by the product process itself, so the
 * default install is one process, one port, one health check. Same
 * per-request Bearer auth and stateless transport as the standalone server
 * (apps/mcp/src/http.ts): both delegate to @emcp/mcp's handleMcpRequest, so
 * auth and error shapes cannot drift.
 *
 *   curl -X POST http://localhost:2222/mcp \
 *     -H "authorization: Bearer emcp_…" \
 *     -H "content-type: application/json" \
 *     -H "accept: application/json, text/event-stream" -d '…'
 *
 * On a non-SQLite runtime (hosted Postgres) the handler answers a clear 501
 * JSON error — hosted deployments run the standalone MCP process instead.
 */
import { createFileRoute } from "@tanstack/react-router";
import { getRuntimeAsync } from "@emcp/db";
import { handleMcpRequest } from "@emcp/mcp";

const handle = async ({ request }: { request: Request }): Promise<Response> =>
  handleMcpRequest(request, await getRuntimeAsync());

export const Route = createFileRoute("/mcp")({
  server: {
    handlers: {
      // handleMcpRequest answers non-POST with the same 405 the standalone
      // server sends (stateless mode: no SSE streams or session deletes).
      GET: handle,
      POST: handle,
      DELETE: handle,
    },
  },
});
