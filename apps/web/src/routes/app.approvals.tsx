import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Bot, Check, ChevronDown, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { PENDING_STATUSES, type McpClient, type PendingAction, type User } from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { chipClass, type Tone } from "~/lib/colors.ts";
import { formatDateTime, relativeTime } from "~/lib/format.ts";
import { EmptyState, Modal, PageHeader, Spinner } from "~/components/ui.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Textarea } from "~/components/ui/textarea.tsx";
import { whoamiQuery } from "~/routes/__root.tsx";

const searchSchema = z.object({
  status: z.enum(PENDING_STATUSES).catch("pending"),
});

export const Route = createFileRoute("/app/approvals")({
  validateSearch: searchSchema,
  component: ApprovalsPage,
});

const RISK_TONE: Record<string, Tone> = {
  destructive: "error",
  bulk: "warning",
  config: "info",
  data: "warning",
  admin: "error",
};

function ApprovalsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const auth = useQuery(whoamiQuery).data;
  const isAdmin = auth?.role === "owner" || auth?.role === "admin";

  const actions = useQuery(opQuery<PendingAction[]>("pendingAction.list", { status: search.status }));
  const clients = useQuery({ ...opQuery<McpClient[]>("mcpClient.list"), enabled: isAdmin });
  const users = useQuery(opQuery<User[]>("user.list"));

  const requesterName = (pa: PendingAction): string => {
    if (pa.requestedByClientId) return clients.data?.find((c) => c.id === pa.requestedByClientId)?.name ?? "MCP agent";
    if (pa.requestedByUserId) return users.data?.find((u) => u.id === pa.requestedByUserId)?.name ?? "user";
    return "system";
  };

  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle="Risky agent actions wait here for a human decision. Approve to execute with the stored input."
      />

      <div className="mb-4 flex flex-wrap gap-1">
        {PENDING_STATUSES.map((s) => (
          <Button
            key={s}
            variant={search.status === s ? "secondary" : "ghost"}
            size="xs"
            className="capitalize"
            onClick={() => navigate({ search: { status: s }, replace: true })}
          >
            {s}
          </Button>
        ))}
      </div>

      {actions.isLoading ? (
        <Spinner />
      ) : (actions.data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="size-10 text-foreground/20" />}
          title={search.status === "pending" ? "Nothing waiting for review" : `No ${search.status} actions`}
          hint={
            search.status === "pending"
              ? "When an agent attempts a risky operation (bulk edits, deletes, config changes) it lands here."
              : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {actions.data!.map((pa) => (
            <PendingCard key={pa.id} action={pa} requester={requesterName(pa)} isAdmin={isAdmin} reviewer={users.data ?? []} />
          ))}
        </div>
      )}
    </div>
  );
}

function PendingCard({
  action: pa,
  requester,
  isAdmin,
  reviewer,
}: {
  action: PendingAction;
  requester: string;
  isAdmin: boolean;
  reviewer: User[];
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const approve = useOp("pendingAction.approve", { successToast: "Approved & executed" });
  const cancel = useOp("pendingAction.cancel", { successToast: "Cancelled" });
  const isPending = pa.status === "pending";
  const reviewedBy = pa.reviewedByUserId ? reviewer.find((u) => u.id === pa.reviewedByUserId)?.name : null;

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <span className="flex size-8 items-center justify-center rounded-full bg-violet/15 text-violet">
          <Bot className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono font-semibold">{pa.operation}</span>
            <span className={chipClass(RISK_TONE[pa.riskCategory] ?? "ghost", "xs")}>{pa.riskCategory}</span>
            {pa.status !== "pending" ? <span className={`capitalize ${chipClass("ghost", "xs")}`}>{pa.status}</span> : null}
          </p>
          <p className="text-xs text-muted-foreground">
            requested by <span className="text-foreground/70">{requester}</span> · {relativeTime(pa.requestedAt)}
            {isPending ? <> · expires {relativeTime(pa.expiresAt)}</> : null}
            {reviewedBy ? (
              <>
                {" "}
                · reviewed by {reviewedBy} {pa.reviewedAt ? relativeTime(pa.reviewedAt) : ""}
              </>
            ) : null}
          </p>
        </div>
        <Button variant="ghost" size="xs" className="gap-1" onClick={() => setDetailsOpen((o) => !o)}>
          details <ChevronDown className={`size-3.5 transition-transform ${detailsOpen ? "rotate-180" : ""}`} />
        </Button>
        {isPending && isAdmin ? (
          <>
            <Button
              size="xs"
              className="gap-1 bg-success text-success-foreground hover:bg-success/85"
              disabled={approve.isPending}
              onClick={() => approve.mutate({ id: pa.id })}
            >
              <Check className="size-3.5" /> Approve
            </Button>
            <Button
              variant="outline"
              size="xs"
              className="gap-1 border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={() => setRejectOpen(true)}
            >
              <X className="size-3.5" /> Reject
            </Button>
          </>
        ) : null}
        {isPending && !isAdmin ? (
          <Button variant="ghost" size="xs" onClick={() => cancel.mutate({ id: pa.id })}>
            Cancel
          </Button>
        ) : null}
      </div>

      {detailsOpen ? (
        <div className="grid gap-3 border-t border-border/60 px-4 py-3 md:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-semibold tracking-wider uppercase text-muted-foreground/70">Preview</p>
            <pre className="max-h-48 overflow-auto rounded-lg bg-background p-2.5 font-mono text-xs text-foreground/70">
              {JSON.stringify(pa.preview ?? {}, null, 2)}
            </pre>
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold tracking-wider uppercase text-muted-foreground/70">Stored input</p>
            <pre className="max-h-48 overflow-auto rounded-lg bg-background p-2.5 font-mono text-xs text-foreground/70">
              {JSON.stringify(pa.input, null, 2)}
            </pre>
          </div>
          {pa.reviewNote ? (
            <p className="text-xs text-muted-foreground md:col-span-2">
              <span className="font-semibold">Review note:</span> {pa.reviewNote}
            </p>
          ) : null}
          {pa.result ? (
            <div className="md:col-span-2">
              <p className="mb-1 text-xs font-semibold tracking-wider uppercase text-muted-foreground/70">Result</p>
              <pre className="max-h-40 overflow-auto rounded-lg bg-background p-2.5 font-mono text-xs text-foreground/70">
                {JSON.stringify(pa.result, null, 2)}
              </pre>
            </div>
          ) : null}
          <p className="text-[11px] text-muted-foreground/60 md:col-span-2">
            Requested {formatDateTime(pa.requestedAt)} · id {pa.id}
          </p>
        </div>
      ) : null}

      <RejectModal open={rejectOpen} onClose={() => setRejectOpen(false)} id={pa.id} operation={pa.operation} />
    </div>
  );
}

function RejectModal({ open, onClose, id, operation }: { open: boolean; onClose(): void; id: string; operation: string }) {
  const [note, setNote] = useState("");
  const reject = useOp("pendingAction.reject", { successToast: "Rejected", onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title={`Reject ${operation}`}>
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">Note for the agent (optional)</span>
          <Textarea
            autoFocus
            className="min-h-20"
            placeholder="Why is this rejected? Agents can read this."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" disabled={reject.isPending} onClick={() => reject.mutate({ id, note: note.trim() || undefined })}>
            Reject
          </Button>
        </div>
      </div>
    </Modal>
  );
}
