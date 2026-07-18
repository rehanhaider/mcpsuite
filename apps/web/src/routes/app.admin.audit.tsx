import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Bot, Terminal, User as UserIcon } from "lucide-react";
import { useState } from "react";
import type { AuditEvent, McpClient, Page, User } from "@emcp/core/domain";
import { opQuery } from "~/lib/api.ts";
import { chipClass } from "~/lib/colors.ts";
import { formatDateTime, relativeTime } from "~/lib/format.ts";
import { EmptyState, Spinner } from "~/components/ui.tsx";
import { TABLE_CLASS, TableShell } from "~/components/TableShell.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Input } from "~/components/ui/input.tsx";

export const Route = createFileRoute("/app/admin/audit")({ component: AuditAdmin });

function AuditAdmin() {
  const [actorType, setActorType] = useState<"human" | "agent" | "system" | undefined>();
  const [operation, setOperation] = useState("");
  const [limit, setLimit] = useState(50);
  const events = useQuery(
    opQuery<Page<AuditEvent>>("audit.list", {
      actorType,
      operation: operation.trim() || undefined,
      limit,
      offset: 0,
    }),
  );
  const users = useQuery(opQuery<User[]>("user.list"));
  const clients = useQuery(opQuery<McpClient[]>("mcpClient.list"));

  const actorName = (e: AuditEvent) => {
    if (e.actorType === "agent") return clients.data?.find((c) => c.id === e.actorClientId)?.name ?? "agent";
    if (e.actorType === "human") return users.data?.find((u) => u.id === e.actorUserId)?.name ?? "user";
    return "system";
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-lg border border-border p-0.5">
          {(["all", "human", "agent", "system"] as const).map((a) => (
            <Button
              key={a}
              variant={(actorType ?? "all") === a ? "secondary" : "ghost"}
              size="xs"
              className="capitalize"
              onClick={() => setActorType(a === "all" ? undefined : a)}
            >
              {a}
            </Button>
          ))}
        </div>
        <Input
          className="h-6 w-56 font-mono text-xs"
          placeholder="filter by operation, e.g. deal."
          value={operation}
          onChange={(e) => setOperation(e.target.value)}
        />
      </div>

      {events.isLoading ? (
        <Spinner />
      ) : (events.data?.items.length ?? 0) === 0 ? (
        <EmptyState title="No audit events match" />
      ) : (
        <>
          <TableShell>
            <table className={TABLE_CLASS}>
              <thead>
                <tr className="border-b border-border text-left text-xs tracking-wider uppercase text-muted-foreground/70">
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Actor</th>
                  <th className="px-3 py-2 font-medium">Operation</th>
                  <th className="px-3 py-2 font-medium">Summary</th>
                  <th className="px-3 py-2 font-medium">Surface</th>
                </tr>
              </thead>
              <tbody>
                {events.data!.items.map((e) => (
                  <tr key={e.id} className="border-b border-border/60 last:border-0 hover:bg-accent/40">
                    <td className="px-3 py-2 text-xs whitespace-nowrap text-muted-foreground" title={formatDateTime(e.createdAt)}>
                      {relativeTime(e.createdAt)}
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5 text-xs">
                        {e.actorType === "agent" ? (
                          <Bot className="size-3.5 text-violet" />
                        ) : e.actorType === "human" ? (
                          <UserIcon className="size-3.5 text-muted-foreground" />
                        ) : (
                          <Terminal className="size-3.5 text-muted-foreground/70" />
                        )}
                        {actorName(e)}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{e.operation}</td>
                    <td className="max-w-md truncate px-3 py-2 text-sm text-foreground/70" title={e.summary}>
                      {e.summary}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`font-mono ${chipClass("ghost", "xs")}`}>{e.surface}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
          {events.data && events.data.total > events.data.items.length ? (
            <Button variant="ghost" size="sm" className="mt-3 w-full" onClick={() => setLimit((l) => l + 50)}>
              Load more ({events.data.total - events.data.items.length} older)
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
