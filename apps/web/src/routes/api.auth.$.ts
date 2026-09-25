/**
 * /api/auth/* — the OpenAuth issuer (authorize, token, password/*,
 * .well-known/*) plus the CRM first-party endpoints (login, callback,
 * set-password, logout). Contract: docs/auth-api.md. All logic lives in
 * src/server/auth-issuer.ts; this file only adapts the Fetch handlers.
 */
import { createFileRoute } from "@tanstack/react-router";
import { getRuntimeAsync } from "@mcpsuite/db";
import { handleAuthRequest } from "~/server/auth-issuer.ts";

async function handle(request: Request): Promise<Response> {
  const runtime = await getRuntimeAsync();
  return handleAuthRequest(runtime.identity, request);
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
