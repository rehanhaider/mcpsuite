import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { ACTIVITY_KINDS, type Activity, type Page } from "@emcp/core/domain";
import { opQuery } from "~/lib/api.ts";
import { FeedList } from "~/components/FeedList.tsx";
import { PageHeader, Spinner } from "~/components/ui.tsx";
import { Button } from "~/components/ui/button.tsx";

const searchSchema = z.object({
  kind: z.enum(ACTIVITY_KINDS).optional().catch(undefined),
  actor: z.enum(["human", "agent", "system"]).optional().catch(undefined),
});

export const Route = createFileRoute("/app/activity")({
  validateSearch: searchSchema,
  component: ActivityPage,
});

function ActivityPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [limit, setLimit] = useState(50);
  const feed = useQuery(
    opQuery<Page<Activity>>("activity.list", {
      kind: search.kind,
      actorType: search.actor,
      limit,
      offset: 0,
    }),
  );

  const patch = (p: Partial<z.infer<typeof searchSchema>>) => navigate({ search: (prev) => ({ ...prev, ...p }), replace: true });

  return (
    <div>
      <PageHeader title="Activity" subtitle="Everything that happened across the workspace — humans and agents." />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          <Button variant={!search.kind ? "secondary" : "ghost"} size="xs" onClick={() => patch({ kind: undefined })}>
            all
          </Button>
          {ACTIVITY_KINDS.map((k) => (
            <Button
              key={k}
              variant={search.kind === k ? "secondary" : "ghost"}
              size="xs"
              className="capitalize"
              onClick={() => patch({ kind: k })}
            >
              {k.replace("_", " ")}
            </Button>
          ))}
        </div>
        <span className="mx-1 h-4 w-px bg-border" />
        <div className="flex items-center rounded-lg border border-border p-0.5">
          {(["all", "human", "agent"] as const).map((a) => (
            <Button
              key={a}
              variant={(search.actor ?? "all") === a ? "secondary" : "ghost"}
              size="xs"
              className="capitalize"
              onClick={() => patch({ actor: a === "all" ? undefined : a })}
            >
              {a}
            </Button>
          ))}
        </div>
      </div>

      {feed.isLoading ? (
        <Spinner />
      ) : (
        <>
          <FeedList items={feed.data?.items ?? []} showLinks />
          {feed.data && feed.data.total > feed.data.items.length ? (
            <Button variant="ghost" size="sm" className="mt-3 w-full" onClick={() => setLimit((l) => l + 50)}>
              Load more ({feed.data.total - feed.data.items.length} older)
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
