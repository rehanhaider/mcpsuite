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
import { getRuntime, mcpContext, resolveMcpToken } from "@emcp/db";
import { createMcpServer } from "./server.ts";

const runtime = getRuntime();

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
