/**
 * stdio transport — used by Claude Code via .mcp.json and Claude Desktop via
 * the WSL launcher. Authenticates with an emcp API key read from the
 * EMCP_API_KEY env var (created in the web UI under Admin → Agents), resolved
 * exactly like the HTTP transport. Scopes + trust profile come from the client
 * record.
 *
 * NOTE: stdout is the protocol channel; log only to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getRuntimeAsync, mcpContext, resolveMcpToken } from "@emcp/db";
import { createMcpServer, requireSqliteRuntime } from "./server.ts";

// DATABASE_URL adapter selection happens inside getRuntimeAsync (unset ->
// SQLite default, file: -> SQLite at that path); key auth below needs SQLite.
const runtime = requireSqliteRuntime(await getRuntimeAsync(), "stdio");

const apiKey = process.env.EMCP_API_KEY?.trim();
const client = apiKey ? resolveMcpToken(runtime.db, apiKey) : null;
if (!client) {
  console.error(
    "[emcp-mcp] EMCP_API_KEY is missing or invalid. Create an API key in the " +
      "web UI (Admin → Agents) and export it as EMCP_API_KEY before starting the " +
      "stdio server.",
  );
  process.exit(1);
}

const ctx = mcpContext(client, "mcp_stdio");
const server = createMcpServer(runtime, ctx);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[emcp-mcp] stdio server ready as "${client.name}" (${runtime.catalog.size} operations, trust=${ctx.trust})`,
);
