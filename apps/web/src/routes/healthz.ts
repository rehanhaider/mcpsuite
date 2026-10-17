/**
 * GET /healthz — readiness check for Docker HEALTHCHECK, reverse proxies,
 * and uptime probes. Performs a trivial CRM database read.
 */
import { createFileRoute } from "@tanstack/react-router";
import { checkDatabaseHealth, getRuntimeAsync } from "@mcpsuite/db";
import { version } from "../../../../package.json";

export const Route = createFileRoute("/healthz")({
  server: {
    handlers: {
      GET: async () => {
        const ok = await checkDatabaseHealth(getRuntimeAsync);
        return Response.json({ ok, server: "mcpsuite-web", version }, { status: ok ? 200 : 503 });
      },
    },
  },
});
