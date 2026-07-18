/** Record-scoped timeline + composer (notes, calls, emails, meetings, tasks). */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { Activity, Page } from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { ACTIVITY_KIND_ICON, FeedList } from "./FeedList.tsx";
import { OwnerSelect } from "./pickers.tsx";
import { ButtonSpinner, Spinner } from "./ui.tsx";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";

const COMPOSER_KINDS = ["note", "call", "email", "meeting", "task"] as const;

export interface ActivityLinks {
  companyId?: string;
  personId?: string;
  engagementId?: string;
  dealId?: string;
}

export function ActivityFeed(props: {
  links: ActivityLinks;
  showComposer?: boolean;
}) {
  const [limit, setLimit] = useState(30);
  const query = useQuery(
    opQuery<Page<Activity>>("activity.list", {
      ...props.links,
      limit,
      offset: 0,
    }),
  );

  return (
    <div className="space-y-4">
      {props.showComposer !== false ? <Composer links={props.links} /> : null}
      {query.isLoading ? (
        <Spinner />
      ) : (
        <FeedList items={query.data?.items ?? []} />
      )}
      {query.data && query.data.total > query.data.items.length ? (
        <Button
          variant="ghost"
          size="xs"
          className="w-full"
          onClick={() => setLimit((l) => l + 30)}
        >
          Show more ({query.data.total - query.data.items.length} older)
        </Button>
      ) : null}
    </div>
  );
}

function Composer({ links }: { links: ActivityLinks }) {
  const [kind, setKind] = useState<(typeof COMPOSER_KINDS)[number]>("note");
  const [body, setBody] = useState("");
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [assignee, setAssignee] = useState<string | null>(null);
  const log = useOp("activity.log", {
    successToast: "Logged",
    onSuccess: () => {
      setBody("");
      setTitle("");
      setDueAt("");
    },
  });

  const isTask = kind === "task";
  const canSubmit = isTask ? title.trim().length > 0 : body.trim().length > 0;

  function submit() {
    log.mutate({
      kind,
      title: isTask ? title.trim() : title.trim() || undefined,
      body: body.trim() || undefined,
      ...links,
      ...(isTask
        ? { dueAt: dueAt || undefined, assigneeUserId: assignee ?? undefined }
        : {}),
    });
  }

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div role="tablist" className="mb-2 flex gap-1">
        {COMPOSER_KINDS.map((k) => (
          <Button
            key={k}
            role="tab"
            variant="ghost"
            size="sm"
            aria-selected={kind === k}
            className={`capitalize ${
              kind === k
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setKind(k)}
          >
            {ACTIVITY_KIND_ICON[k]} {k}
          </Button>
        ))}
      </div>
      {isTask ? (
        <Input
          className="mb-2"
          placeholder="Task title…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      ) : null}
      <Textarea
        placeholder={
          isTask ? "Details (optional)…" : `Log a ${kind}… (⌘↵ to save)`
        }
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSubmit) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        {isTask ? (
          <>
            <Input
              type="date"
              className="w-40"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              aria-label="Due date"
            />
            <div className="w-44">
              <OwnerSelect value={assignee} onChange={setAssignee} />
            </div>
          </>
        ) : null}
        <Button
          size="sm"
          disabled={!canSubmit || log.isPending}
          onClick={submit}
        >
          {log.isPending ? <ButtonSpinner /> : null}
          {isTask ? "Add task" : "Log"}
        </Button>
      </div>
    </div>
  );
}
