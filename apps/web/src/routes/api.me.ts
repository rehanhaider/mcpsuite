/**
 * GET /api/me — the current CRM user context for first-party services on the
 * same domain (e.g. a hosted account page). Same session cookie auth as the
 * app and `whoami`; returns only identity and workspace facts, never
 * credentials or CRM records.
 *
 *   curl -b "emcp_session=…" http://localhost:2222/api/me
 */
import { createFileRoute } from "@tanstack/react-router";
import { getRuntimeAsync, resolveSession, resolveWorkspaceAccess } from "@emcp/db";

export const Route = createFileRoute("/api/me")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const runtime = await getRuntimeAsync();
        if (runtime.adapter !== "sqlite") {
          // Cookie sessions resolve from the SQLite store; another adapter
          // cannot authenticate this surface (hosted identity is separate).
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const session = resolveSession(runtime.db, cookieValue(request.headers.get("cookie"), "emcp_session"));
        if (!session) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        // Stays available while the workspace is locked; carries the generic
        // access state so first-party pages (e.g. /account) can react.
        const access = resolveWorkspaceAccess(runtime.db, session.workspaceId);
        return Response.json({
          userId: session.user.id,
          email: session.user.email,
          name: session.user.name,
          role: session.role,
          workspaceId: session.workspaceId,
          accessMode: access.mode,
          accessExpiresAt: access.expiresAt,
        });
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
