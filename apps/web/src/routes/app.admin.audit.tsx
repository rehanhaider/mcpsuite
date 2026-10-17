import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Bot, Terminal, User as UserIcon } from "lucide-react";
import { useState } from "react";
import { auditChanges, type AuditEvent, type McpClient, type Page, type Pipeline, type User } from "@mcpsuite/core/domain";
import { opQuery } from "~/lib/api.ts";
import { actorUserName } from "~/lib/actors.ts";
import { chipClass } from "~/lib/colors.ts";
import { formatDateTime, relativeTime, truncate } from "~/lib/format.ts";
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
  const pipelines = useQuery(opQuery<Pipeline[]>("pipeline.list", {}));

  function changeValue(field: string, value: unknown): string | null {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "string") {
      if (field.endsWith("UserId")) return users.data?.find((user) => user.id === value)?.name ?? value;
      if (field === "stageId") {
        return pipelines.data?.flatMap((pipeline) => pipeline.stages).find((stage) => stage.id === value)?.name ?? value;
      }
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return JSON.stringify(value);
  }

  const actorName = (e: AuditEvent) => {
    const userName = actorUserName(e.actorType, e.actorUserId, users.isSuccess ? users.data : undefined);
    if (e.actorType === "agent") {
      if (userName === "Deleted user") return userName;
      const client = clients.data?.find((c) => c.id === e.actorClientId);
      return client?.name ?? "agent";
    }
    if (e.actorType === "human") return userName ?? "user";
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
                {events.data!.items.map((e) => {
                  const changes = auditChanges(e);
                  return (
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
                      <td className="max-w-md px-3 py-2">
                        <div className="truncate text-sm text-foreground/70" title={e.summary}>{e.summary}</div>
                        {changes === null ? null : Object.keys(changes).length === 0 ? (
                          <div className="mt-0.5 text-xs text-muted-foreground/70">No fields changed</div>
                        ) : (
                          <dl className="mt-1 space-y-0.5 text-xs">
                            {Object.entries(changes).map(([field, change]) => (
                              <div key={field} className="flex min-w-0 items-baseline gap-1.5">
                                <dt className="shrink-0 font-mono text-muted-foreground">{field}</dt>
                                <dd className="relative flex min-w-0 items-baseline gap-1.5">
                                  <span className="min-w-0 truncate text-muted-foreground line-through decoration-muted-foreground/50"><ChangeValue text={changeValue(field, change.before)} /></span>
                                  <span aria-hidden className="text-muted-foreground/70">→</span>
                                  <span className="sr-only">changed to</span>
                                  <span className="min-w-0 truncate text-foreground/80"><ChangeValue text={changeValue(field, change.after)} /></span>
                                </dd>
                              </div>
                            ))}
                          </dl>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`font-mono ${chipClass("ghost", "xs")}`}>{e.surface}</span>
                      </td>
                    </tr>
                  );
                })}
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

function ChangeValue({ text }: { text: string | null }) {
  if (text === null) return <span className="italic text-muted-foreground/70">empty</span>;
  return <span title={text}>{truncate(text, 60)}</span>;
}
