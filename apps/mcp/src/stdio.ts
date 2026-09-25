/**
 * stdio transport — used by Claude Code via .mcp.json and Claude Desktop via
 * the WSL launcher. Authenticates with an mcpsuite API key read from the
 * MCPSUITE_API_KEY env var (created in the web UI under Admin → Agents), resolved
 * exactly like the HTTP transport. Scopes + trust profile come from the client
 * record.
 *
 * NOTE: stdout is the protocol channel; log only to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getRuntimeAsync, mcpContext } from "@mcpsuite/db";
import { createMcpServer } from "./server.ts";

// DATABASE_URL adapter selection happens inside getRuntimeAsync (unset ->
// SQLite default, file: -> SQLite at that path, postgresql:// -> PostgreSQL);
// the key resolves through the runtime's identity store on every adapter.
const runtime = await getRuntimeAsync();

const apiKey = process.env.MCPSUITE_API_KEY?.trim();
const client = apiKey ? await runtime.identity.resolveMcpToken(apiKey) : null;
if (!client) {
  console.error(
    "[mcpsuite-mcp] MCPSUITE_API_KEY is missing or invalid. Create an API key in the " +
      "web UI (Admin → Agents) and export it as MCPSUITE_API_KEY before starting the " +
      "stdio server.",
  );
  process.exit(1);
}

const ctx = mcpContext(client, "mcp_stdio");
const server = createMcpServer(runtime, ctx);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[mcpsuite-mcp] stdio server ready as "${client.name}" (${runtime.catalog.size} operations, trust=${ctx.trust})`,
);
