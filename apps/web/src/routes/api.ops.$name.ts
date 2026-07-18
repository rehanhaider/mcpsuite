/**
 * POST /api/ops/:name — the catalog over plain HTTP for non-web human clients
 * (curl, scripts, future mobile). Same session cookie auth as the app; the
 * response is the raw OpResult envelope (ok | error | pending_approval).
 *
 *   curl -X POST -H "content-type: application/json" -b "emcp_session=…" \
 *     http://localhost:2222/api/ops/company.list -d '{"limit":5}'
 */
import { createFileRoute } from "@tanstack/react-router";
import { getRuntimeAsync, resolveSession, resolveWorkspaceAccess, webContext, workspaceLockedResult } from "@emcp/db";

export const Route = createFileRoute("/api/ops/$name")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const runtime = await getRuntimeAsync();
        if (runtime.adapter !== "sqlite") {
          // Cookie sessions resolve from the SQLite store; another adapter
          // cannot authenticate this surface (hosted identity is separate).
          return Response.json(
            { status: "error", error: { code: "unauthorized", message: "Sign in first" } },
            { status: 401 },
          );
        }
        const session = resolveSession(runtime.db, cookieValue(request.headers.get("cookie"), "emcp_session"));
        if (!session) {
          return Response.json(
            { status: "error", error: { code: "unauthorized", message: "Sign in first" } },
            { status: 401 },
          );
        }
        // Hosted access gate: identification succeeded, but a locked
        // workspace refuses every catalog operation.
        if (resolveWorkspaceAccess(runtime.db, session.workspaceId).mode === "locked") {
          return Response.json(workspaceLockedResult(), { status: 403 });
        }
        let input: unknown = {};
        try {
          const text = await request.text();
          input = text ? JSON.parse(text) : {};
        } catch {
          return Response.json(
            { status: "error", error: { code: "validation", message: "Body must be JSON" } },
            { status: 400 },
          );
        }
        const result = await runtime.run(webContext(session), params.name, input);
        const status =
          result.status === "ok" ? 200 : result.status === "pending_approval" ? 202 : httpStatus(result.error.code);
        return Response.json(result, { status });
      },
    },
  },
});

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

function httpStatus(code: string): number {
  switch (code) {
    case "not_found":
      return 404;
    case "forbidden":
    case "workspace_locked":
      return 403;
    case "unauthorized":
      return 401;
    case "conflict":
    case "version_conflict":
    case "in_use":
    case "invalid_state":
      return 409;
    case "validation":
      return 400;
    default:
      return 500;
  }
}
