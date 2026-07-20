/**
 * GET /healthz — cheap liveness for the one-process install (Docker
 * HEALTHCHECK, reverse proxies, uptime probes). Deliberately touches no
 * database: it answers "the process is up", nothing more.
 */
import { createFileRoute } from "@tanstack/react-router";
import { version } from "../../../../package.json";

export const Route = createFileRoute("/healthz")({
  server: {
    handlers: {
      GET: () => Response.json({ ok: true, server: "emcp-web", version }),
    },
  },
});
