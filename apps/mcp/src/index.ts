/**
 * Public surface of @emcp/mcp for the other workspace apps: the web process
 * imports handleMcpRequest to serve POST /mcp in-process (one installed
 * service). The transports themselves (stdio.ts, http.ts) are entry points,
 * not exports.
 */
export { handleMcpRequest } from "./handler.ts";
export { SERVER_INFO } from "./server.ts";
