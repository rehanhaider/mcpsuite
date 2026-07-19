/**
 * /api/auth/* — the OpenAuth issuer (authorize, token, password/*,
 * .well-known/*) plus the CRM first-party endpoints (login, callback,
 * set-password, logout). Contract: docs/auth-api.md. All logic lives in
 * src/server/auth-issuer.ts; this file only adapts the Fetch handlers.
 */
import { createFileRoute } from "@tanstack/react-router";
import { getRuntimeAsync } from "@emcp/db";
import { handleAuthRequest } from "~/server/auth-issuer.ts";

async function handle(request: Request): Promise<Response> {
  const runtime = await getRuntimeAsync();
  if (runtime.adapter !== "sqlite") {
    // The PostgreSQL adapter's issuer storage lands with the hosted identity
    // stream; until then this surface only exists on SQLite deployments.
    return Response.json(
      { ok: false, error: { code: "unavailable", message: "Authentication is not available on this deployment" } },
      { status: 501 },
    );
  }
  return handleAuthRequest(runtime.db, request);
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
      OPTIONS: ({ request }) => handle(request),
    },
  },
});
