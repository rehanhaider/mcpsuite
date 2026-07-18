import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ChevronRight,
  CircleDollarSign,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import type {
  Activity,
  Company,
  ContactList,
  CustomFieldValue,
  Deal,
  Engagement,
  OfferingLink,
  Offering,
  Person,
  Pipeline,
  Tag,
  User,
} from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { chipClass, dotClass } from "~/lib/colors.ts";
import { CHANNEL_HINTS } from "~/lib/channels.ts";
import { formatDate, relativeTime } from "~/lib/format.ts";
import { ActivityFeed } from "~/components/ActivityFeed.tsx";
import { CustomFieldsCard } from "~/components/CustomFields.tsx";
import { CompanyField, PersonField } from "~/routes/app.leads.index.tsx";
import {
  OfferingLinks,
  ListChips,
  OwnerSelect,
  TagChips,
} from "~/components/pickers.tsx";
import {
  ButtonSpinner,
  Field,
  Modal,
  SectionCard,
  Spinner,
} from "~/components/ui.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu.tsx";
import { Input } from "~/components/ui/input.tsx";

interface LeadContext {
  engagement: Engagement;
  company: Company | null;
  person: Person | null;
  deal: Deal | null;
  tags: Tag[];
  lists: ContactList[];
  customFields: Record<string, CustomFieldValue>;
  offerings: Array<OfferingLink & { offering: Offering }>;
  recentActivities: Activity[];
  openTasks: Activity[];
}

export const Route = createFileRoute("/app/leads/$id")({
  component: LeadDetailPage,
});

function LeadDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const ctx = useQuery(opQuery<LeadContext>("engagement.getContext", { id }));
  const pipelines = useQuery(
    opQuery<Pipeline[]>("pipeline.list", { type: "engagement" }),
  );
  const users = useQuery(opQuery<User[]>("user.list"));
  const [editOpen, setEditOpen] = useState(false);
  const [dealOpen, setDealOpen] = useState(false);

  const moveStage = useOp("engagement.updateStage", {
    successToast: "Stage updated",
  });
  const archive = useOp("engagement.archive", { successToast: "Archived" });
  const restore = useOp("engagement.restore", { successToast: "Restored" });
  const hardDelete = useOp("engagement.delete", {
    successToast: "Deleted",
    onSuccess: () => navigate({ to: "/app/leads" }),
  });

  if (ctx.isLoading) return <Spinner label="Loading lead…" />;
  const data = ctx.data;
  if (!data)
    return (
      <p className="py-20 text-center text-sm text-muted-foreground">
        Lead not found.
      </p>
    );

  const e = data.engagement;
  const pipeline = pipelines.data?.find((p) => p.id === e.pipelineId);
  const stage = pipeline?.stages.find((s) => s.id === e.stageId);
  const owner = users.data?.find((u) => u.id === e.ownerUserId);

  return (
    <div>
      <div className="mb-4">
        <Link
          to="/app/leads"
          className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-foreground/70"
        >
          <ArrowLeft className="size-3" /> Leads
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="tnum font-mono text-xs text-muted-foreground/70">
                LEAD-{e.displayId}
              </span>
              {e.archivedAt ? (
                <span className={chipClass("warning", "xs")}>archived</span>
              ) : null}
            </div>
            <h1 className="mt-0.5 truncate text-xl font-semibold tracking-tight">
              {e.title}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            {data.deal ? (
              <Link
                to="/app/deals/$id"
                params={{ id: data.deal.id }}
                className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-input px-2.5 text-[0.8rem] font-medium transition-colors hover:bg-muted"
              >
                <CircleDollarSign className="size-4 text-success" />{" "}
                {data.deal.title}
              </Link>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDealOpen(true)}
              >
                <CircleDollarSign className="size-4" /> Convert to deal
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
                {e.archivedAt ? (
                  <DropdownMenuItem
                    onClick={() => restore.mutate({ id: e.id })}
                  >
                    <ArchiveRestore className="size-3.5" /> Restore
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onClick={() => archive.mutate({ id: e.id })}
                  >
                    <Archive className="size-3.5" /> Archive
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    if (
                      confirm(
                        `Permanently delete "${e.title}"? This cannot be undone.`,
                      )
                    )
                      hardDelete.mutate({ id: e.id });
                  }}
                >
                  <Trash2 className="size-3.5" /> Delete forever
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Stage stepper */}
      {pipeline ? (
        <div className="mb-5 flex items-center gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1.5">
          {pipeline.stages.map((s, i) => {
            const isCurrent = s.id === e.stageId;
            const currentIdx = pipeline.stages.findIndex(
              (x) => x.id === e.stageId,
            );
            const isPast = i < currentIdx;
            return (
              <Button
                key={s.id}
                type="button"
                variant="ghost"
                size="xs"
                disabled={isCurrent || moveStage.isPending}
                onClick={() => moveStage.mutate({ id: e.id, stageId: s.id })}
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
            <Field label="Stage">
              {stage ? (
                <span className={chipClass(stage.color)}>{stage.name}</span>
              ) : (
                "—"
              )}
            </Field>
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
            <Field label="Person">
              {data.person ? (
                <Link
                  to="/app/people/$id"
                  params={{ id: data.person.id }}
                  className="hover:underline"
                >
                  {data.person.name}
                </Link>
              ) : (
                "—"
              )}
            </Field>
            <Field label="Channel">{e.channel ?? "—"}</Field>
            <Field label="Source">{e.source ?? "—"}</Field>
            <Field label="Owner">{owner?.name ?? "—"}</Field>
            <Field label="Next action">
              {e.nextAction ?? "—"}
              {e.nextActionDue ? (
                <span className="ml-1.5 text-xs text-muted-foreground">
                  due {formatDate(e.nextActionDue)}
                </span>
              ) : null}
            </Field>
            <Field label="Last activity">
              {relativeTime(e.lastActivityAt)}
            </Field>
            <Field label="Created">{formatDate(e.createdAt)}</Field>
            <div className="mt-2 border-t border-border/60 pt-2.5">
              <TagChips
                entityType="engagement"
                entityId={e.id}
                tags={data.tags}
              />
            </div>
            <div className="mt-2 border-t border-border/60 pt-2.5">
              <ListChips
                entityType="engagement"
                entityId={e.id}
                lists={data.lists}
              />
            </div>
          </SectionCard>

          <CustomFieldsCard
            entityType="engagement"
            entityId={e.id}
            values={data.customFields}
          />

          <SectionCard title="Offerings">
            <OfferingLinks
              entityType="engagement"
              entityId={e.id}
              links={data.offerings}
            />
          </SectionCard>
        </div>

        <SectionCard title="Timeline">
          <ActivityFeed links={{ engagementId: e.id }} />
        </SectionCard>
      </div>

      <EditLeadModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        lead={e}
      />
      <ConvertDealModal
        open={dealOpen}
        onClose={() => setDealOpen(false)}
        lead={e}
        companyName={data.company?.name ?? null}
      />
    </div>
  );
}

function EditLeadModal({
  open,
  onClose,
  lead,
}: {
  open: boolean;
  onClose(): void;
  lead: Engagement;
}) {
  const [title, setTitle] = useState(lead.title);
  const [companyId, setCompanyId] = useState(lead.companyId);
  const [personId, setPersonId] = useState(lead.personId);
  const [channel, setChannel] = useState(lead.channel ?? "");
  const [source, setSource] = useState(lead.source ?? "");
  const [owner, setOwner] = useState(lead.ownerUserId);
  const [nextAction, setNextAction] = useState(lead.nextAction ?? "");
  const [nextActionDue, setNextActionDue] = useState(lead.nextActionDue ?? "");
  const update = useOp("engagement.update", {
    successToast: "Saved",
    onSuccess: onClose,
  });

  return (
    <Modal open={open} onClose={onClose} title={`Edit LEAD-${lead.displayId}`}>
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            Title
          </span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Company
            </span>
            <CompanyField value={companyId} onChange={setCompanyId} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Person
            </span>
            <PersonField value={personId} onChange={setPersonId} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Channel
            </span>
            <Input
              list="channel-hints-edit"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
            />
            <datalist id="channel-hints-edit">
              {CHANNEL_HINTS.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Source
            </span>
            <Input value={source} onChange={(e) => setSource(e.target.value)} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Owner
            </span>
            <OwnerSelect value={owner} onChange={setOwner} />
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
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            Next action
          </span>
          <Input
            placeholder="Follow up on proposal…"
            value={nextAction}
            onChange={(e) => setNextAction(e.target.value)}
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={update.isPending || !title.trim()}
            onClick={() =>
              update.mutate({
                id: lead.id,
                expectedVersion: lead.version,
                title: title.trim(),
                companyId,
                personId,
                channel: channel.trim() || null,
                source: source.trim() || null,
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

function ConvertDealModal({
  open,
  onClose,
  lead,
  companyName,
}: {
  open: boolean;
  onClose(): void;
  lead: Engagement;
  companyName: string | null;
}) {
  const navigate = useNavigate();
  const [title, setTitle] = useState(
    companyName ? `${companyName} deal` : lead.title,
  );
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("");
  const [closeDate, setCloseDate] = useState("");
  const create = useOp<Record<string, unknown>, { id: string }>("deal.create", {
    successToast: "Deal created",
    onSuccess: (d) => {
      onClose();
      navigate({ to: "/app/deals/$id", params: { id: d.id } });
    },
  });

  return (
    <Modal open={open} onClose={onClose} title="Convert to deal">
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            Deal title
          </span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="grid grid-cols-3 gap-3">
          <label className="col-span-2 block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Amount (major units, e.g. 5000)
            </span>
            <Input
              type="number"
              min="0"
              step="0.01"
              placeholder="Optional"
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
              placeholder="workspace default"
              maxLength={3}
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            Expected close date
          </span>
          <Input
            type="date"
            value={closeDate}
            onChange={(e) => setCloseDate(e.target.value)}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          The deal inherits this lead's company, person, owner and offerings,
          and the lead links to it automatically.
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={create.isPending || !title.trim()}
            onClick={() =>
              create.mutate({
                title: title.trim(),
                companyId: lead.companyId,
                primaryPersonId: lead.personId,
                engagementId: lead.id,
                ownerUserId: lead.ownerUserId,
                amountMinor: amount
                  ? Math.round(Number(amount) * 100)
                  : undefined,
                currency:
                  currency.trim().length === 3 ? currency.trim() : undefined,
                expectedCloseDate: closeDate || undefined,
              })
            }
          >
            {create.isPending ? <ButtonSpinner /> : null}
            Create deal
          </Button>
        </div>
      </div>
    </Modal>
  );
}
