import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import type {
  Activity,
  Company,
  ContactList,
  CustomFieldValue,
  Deal,
  DealStakeholder,
  OfferingLink,
  Offering,
  Person,
  Pipeline,
  Tag,
  User,
} from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { chipClass, dotClass } from "~/lib/colors.ts";
import { formatDate, formatMoneyMinor, relativeTime } from "~/lib/format.ts";
import { ActivityFeed } from "~/components/ActivityFeed.tsx";
import { CustomFieldsCard } from "~/components/CustomFields.tsx";
import {
  ListChips,
  OfferingLinks,
  OwnerSelect,
  TagChips,
} from "~/components/pickers.tsx";
import { PersonField } from "~/routes/app.leads.index.tsx";
import {
  Avatar,
  ButtonSpinner,
  Field,
  Modal,
  SectionCard,
  Spinner,
} from "~/components/ui.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Checkbox } from "~/components/ui/checkbox.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu.tsx";
import { Input } from "~/components/ui/input.tsx";
import { Textarea } from "~/components/ui/textarea.tsx";

interface DealContext {
  deal: Deal;
  company: Company | null;
  primaryPerson: Person | null;
  stakeholders: Array<DealStakeholder & { person: Person }>;
  tags: Tag[];
  lists: ContactList[];
  customFields: Record<string, CustomFieldValue>;
  offerings: Array<OfferingLink & { offering: Offering }>;
  recentActivities: Activity[];
  openTasks: Activity[];
}

export const Route = createFileRoute("/app/deals/$id")({
  component: DealDetailPage,
});

function DealDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const ctx = useQuery(opQuery<DealContext>("deal.getContext", { id }));
  const pipelines = useQuery(
    opQuery<Pipeline[]>("pipeline.list", { type: "deal" }),
  );
  const users = useQuery(opQuery<User[]>("user.list"));
  const [editOpen, setEditOpen] = useState(false);
  const [lostOpen, setLostOpen] = useState(false);
  const [stakeholderOpen, setStakeholderOpen] = useState(false);

  const moveStage = useOp("deal.updateStage", {
    successToast: "Stage updated",
  });
  const markWon = useOp("deal.markWon", { successToast: "Deal won" });
  const reopen = useOp("deal.reopen", { successToast: "Reopened" });
  const archive = useOp("deal.archive", { successToast: "Archived" });
  const restore = useOp("deal.restore", { successToast: "Restored" });
  const hardDelete = useOp("deal.delete", {
    successToast: "Deleted",
    onSuccess: () => navigate({ to: "/app/deals" }),
  });
  const removeStakeholder = useOp("deal.removeStakeholder", {
    successToast: "Removed",
  });

  if (ctx.isLoading) return <Spinner label="Loading deal…" />;
  const data = ctx.data;
  if (!data)
    return (
      <p className="py-20 text-center text-sm text-muted-foreground">
        Deal not found.
      </p>
    );

  const d = data.deal;
  const pipeline = pipelines.data?.find((p) => p.id === d.pipelineId);
  const owner = users.data?.find((u) => u.id === d.ownerUserId);
  const isOpen = d.status === "open";

  return (
    <div>
      <div className="mb-4">
        <Link
          to="/app/deals"
          className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-foreground/70"
        >
          <ArrowLeft className="size-3" /> Deals
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="tnum font-mono text-xs text-muted-foreground/70">
                DEAL-{d.displayId}
              </span>
              {d.status === "won" ? (
                <span className={chipClass("success", "xs")}>won</span>
              ) : null}
              {d.status === "lost" ? (
                <span className={chipClass("error", "xs")}>lost</span>
              ) : null}
              {d.archivedAt ? (
                <span className={chipClass("warning", "xs")}>archived</span>
              ) : null}
            </div>
            <h1 className="mt-0.5 truncate text-xl font-semibold tracking-tight">
              {d.title}
            </h1>
            <p className="tnum mt-0.5 font-mono text-sm text-muted-foreground">
              {formatMoneyMinor(d.amountMinor, d.currency)}
              {d.probability != null && isOpen ? (
                <span className="text-muted-foreground/70">
                  {" "}
                  · {d.probability}%
                </span>
              ) : null}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isOpen ? (
              <>
                <Button
                  size="sm"
                  className="bg-success text-success-foreground hover:bg-success/85"
                  onClick={() => markWon.mutate({ id: d.id })}
                >
                  <ThumbsUp className="size-3.5" /> Won
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setLostOpen(true)}
                >
                  <ThumbsDown className="size-3.5" /> Lost
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => reopen.mutate({ id: d.id })}
              >
                <RotateCcw className="size-3.5" /> Reopen
              </Button>
            )}
            <Button size="sm" onClick={() => setEditOpen(true)}>
              <Pencil className="size-3.5" /> Edit
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="More actions"
                  />
                }
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {d.archivedAt ? (
                  <DropdownMenuItem
                    onClick={() => restore.mutate({ id: d.id })}
                  >
                    <ArchiveRestore className="size-3.5" /> Restore
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onClick={() => archive.mutate({ id: d.id })}
                  >
                    <Archive className="size-3.5" /> Archive
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    if (confirm(`Permanently delete "${d.title}"?`))
                      hardDelete.mutate({ id: d.id });
                  }}
                >
                  <Trash2 className="size-3.5" /> Delete forever
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {pipeline ? (
        <div className="mb-5 flex items-center gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1.5">
          {pipeline.stages.map((s, i) => {
            const isCurrent = s.id === d.stageId;
            const currentIdx = pipeline.stages.findIndex(
              (x) => x.id === d.stageId,
            );
            const isPast = i < currentIdx;
            return (
              <Button
                key={s.id}
                type="button"
                variant="ghost"
                size="xs"
                disabled={isCurrent || moveStage.isPending}
                onClick={() => moveStage.mutate({ id: d.id, stageId: s.id })}
                className={`shrink-0 gap-1.5 px-2.5 ${
                  isCurrent
                    ? "bg-accent font-semibold text-accent-foreground"
                    : isPast
                      ? "text-foreground/60 hover:bg-accent/60"
                      : "text-muted-foreground/70 hover:bg-accent/60"
                }`}
                title={`Move to ${s.name}`}
              >
                <span
                  className={`size-1.5 rounded-full ${dotClass(s.color)} ${isCurrent || isPast ? "" : "opacity-40"}`}
                />
                {s.name}
                {s.probability != null ? (
                  <span className="tnum font-mono text-muted-foreground/60">
                    {s.probability}%
                  </span>
                ) : null}
                {i < pipeline.stages.length - 1 ? (
                  <ChevronRight className="size-3 text-muted-foreground/40" />
                ) : null}
              </Button>
            );
          })}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="space-y-4">
          <SectionCard title="Details">
            <Field label="Company">
              {data.company ? (
                <Link
                  to="/app/companies/$id"
                  params={{ id: data.company.id }}
                  className="hover:underline"
                >
                  {data.company.name}
                </Link>
              ) : (
                "—"
              )}
            </Field>
            <Field label="Contact">
              {data.primaryPerson ? (
                <Link
                  to="/app/people/$id"
                  params={{ id: data.primaryPerson.id }}
                  className="hover:underline"
                >
                  {data.primaryPerson.name}
                </Link>
              ) : (
                "—"
              )}
            </Field>
            <Field label="Value">
              <span className="tnum font-mono">
                {formatMoneyMinor(d.amountMinor, d.currency)}
              </span>
            </Field>
            <Field label="Probability">
              {d.probability != null ? `${d.probability}%` : "—"}
            </Field>
            <Field label="Expected close">{d.expectedCloseDate ?? "—"}</Field>
            <Field label="Owner">{owner?.name ?? "—"}</Field>
            {d.status === "lost" && d.lostReason ? (
              <Field label="Lost reason">{d.lostReason}</Field>
            ) : null}
            {d.closedAt ? (
              <Field label="Closed">{formatDate(d.closedAt)}</Field>
            ) : null}
            <Field label="Next action">
              {d.nextAction ?? "—"}
              {d.nextActionDue ? (
                <span className="ml-1.5 text-xs text-muted-foreground">
                  due {formatDate(d.nextActionDue)}
                </span>
              ) : null}
            </Field>
            <Field label="Last activity">
              {relativeTime(d.lastActivityAt)}
            </Field>
            {d.engagementId ? (
              <Field label="Source lead">
                <Link
                  to="/app/leads/$id"
                  params={{ id: d.engagementId }}
                  className="hover:underline"
                >
                  view lead
                </Link>
              </Field>
            ) : null}
            <div className="mt-2 border-t border-border/60 pt-2.5">
              <TagChips entityType="deal" entityId={d.id} tags={data.tags} />
            </div>
            <div className="mt-2 border-t border-border/60 pt-2.5">
              <ListChips entityType="deal" entityId={d.id} lists={data.lists} />
            </div>
          </SectionCard>

          <SectionCard
            title={`Stakeholders (${data.stakeholders.length})`}
            actions={
              <Button
                variant="ghost"
                size="xs"
                className="gap-1"
                onClick={() => setStakeholderOpen(true)}
              >
                <Plus className="size-3" /> add
              </Button>
            }
          >
            {data.stakeholders.length === 0 ? (
              <p className="py-3 text-center text-sm text-muted-foreground">
                No stakeholders mapped.
              </p>
            ) : (
              <ul className="space-y-1">
                {data.stakeholders.map((sh) => (
                  <li
                    key={sh.id}
                    className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-accent/50"
                  >
                    <Avatar name={sh.person.name} />
                    <div className="min-w-0 flex-1">
                      <Link
                        to="/app/people/$id"
                        params={{ id: sh.person.id }}
                        className="block truncate text-sm font-medium hover:underline"
                      >
                        {sh.person.name}
                        {sh.isPrimary ? (
                          <span
                            className={`ml-1.5 ${chipClass("ghost", "xs")}`}
                          >
                            primary
                          </span>
                        ) : null}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground">
                        {sh.role ?? sh.person.title ?? "—"}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="opacity-0 group-hover:opacity-100"
                      title="Remove"
                      onClick={() => removeStakeholder.mutate({ id: sh.id })}
                    >
                      <X className="size-3" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Offerings">
            <OfferingLinks
              entityType="deal"
              entityId={d.id}
              links={data.offerings}
            />
          </SectionCard>

          <CustomFieldsCard
            entityType="deal"
            entityId={d.id}
            values={data.customFields}
          />
        </div>

        <SectionCard title="Timeline">
          <ActivityFeed links={{ dealId: d.id }} />
        </SectionCard>
      </div>

      <EditDealModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        deal={d}
      />
      <MarkLostModal
        open={lostOpen}
        onClose={() => setLostOpen(false)}
        dealId={d.id}
      />
      <AddStakeholderModal
        open={stakeholderOpen}
        onClose={() => setStakeholderOpen(false)}
        dealId={d.id}
      />
    </div>
  );
}

function EditDealModal({
  open,
  onClose,
  deal: d,
}: {
  open: boolean;
  onClose(): void;
  deal: Deal;
}) {
  const [title, setTitle] = useState(d.title);
  const [amount, setAmount] = useState(
    d.amountMinor != null ? String(d.amountMinor / 100) : "",
  );
  const [currency, setCurrency] = useState(d.currency);
  const [probability, setProbability] = useState(
    d.probability != null ? String(d.probability) : "",
  );
  const [closeDate, setCloseDate] = useState(d.expectedCloseDate ?? "");
  const [owner, setOwner] = useState(d.ownerUserId);
  const [nextAction, setNextAction] = useState(d.nextAction ?? "");
  const [nextActionDue, setNextActionDue] = useState(d.nextActionDue ?? "");
  const update = useOp("deal.update", {
    successToast: "Saved",
    onSuccess: onClose,
  });

  return (
    <Modal open={open} onClose={onClose} title={`Edit DEAL-${d.displayId}`}>
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            Title *
          </span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Amount
            </span>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Currency
            </span>
            <Input
              className="uppercase"
              maxLength={3}
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Probability %
            </span>
            <Input
              type="number"
              min="0"
              max="100"
              value={probability}
              onChange={(e) => setProbability(e.target.value)}
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Expected close
            </span>
            <Input
              type="date"
              value={closeDate}
              onChange={(e) => setCloseDate(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Owner
            </span>
            <OwnerSelect value={owner} onChange={setOwner} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Next action
            </span>
            <Input
              value={nextAction}
              onChange={(e) => setNextAction(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Next action due
            </span>
            <Input
              type="date"
              value={nextActionDue}
              onChange={(e) => setNextActionDue(e.target.value)}
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={
              update.isPending || !title.trim() || currency.length !== 3
            }
            onClick={() =>
              update.mutate({
                id: d.id,
                expectedVersion: d.version,
                title: title.trim(),
                amountMinor:
                  amount === "" ? null : Math.round(Number(amount) * 100),
                currency,
                probability:
                  probability === ""
                    ? null
                    : Math.max(0, Math.min(100, Number(probability))),
                expectedCloseDate: closeDate || null,
                ownerUserId: owner,
                nextAction: nextAction.trim() || null,
                nextActionDue: nextActionDue || null,
              })
            }
          >
            {update.isPending ? <ButtonSpinner /> : null}
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function MarkLostModal({
  open,
  onClose,
  dealId,
}: {
  open: boolean;
  onClose(): void;
  dealId: string;
}) {
  const [reason, setReason] = useState("");
  const markLost = useOp("deal.markLost", {
    successToast: "Marked lost",
    onSuccess: onClose,
  });
  return (
    <Modal open={open} onClose={onClose} title="Mark deal lost">
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            Reason (optional)
          </span>
          <Textarea
            autoFocus
            className="min-h-20"
            placeholder="Budget cut, went with competitor…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={markLost.isPending}
            onClick={() =>
              markLost.mutate({
                id: dealId,
                lostReason: reason.trim() || undefined,
              })
            }
          >
            Mark lost
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AddStakeholderModal({
  open,
  onClose,
  dealId,
}: {
  open: boolean;
  onClose(): void;
  dealId: string;
}) {
  const [personId, setPersonId] = useState<string | null>(null);
  const [role, setRole] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const add = useOp("deal.addStakeholder", {
    successToast: "Stakeholder added",
    onSuccess: onClose,
  });
  return (
    <Modal open={open} onClose={onClose} title="Add stakeholder">
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            Person
          </span>
          <PersonField value={personId} onChange={setPersonId} />
        </label>
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Role in deal
            </span>
            <Input
              placeholder="Decision maker, champion…"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            />
          </label>
          <label className="flex cursor-pointer items-center gap-2 pb-1.5 text-xs">
            <Checkbox
              checked={isPrimary}
              onCheckedChange={(checked) => setIsPrimary(checked === true)}
            />
            primary
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!personId || add.isPending}
            onClick={() =>
              add.mutate({
                dealId,
                personId,
                role: role.trim() || undefined,
                isPrimary,
              })
            }
          >
            Add
          </Button>
        </div>
      </div>
    </Modal>
  );
}
