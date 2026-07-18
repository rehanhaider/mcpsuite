import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type {
  ColumnDef,
  RowSelectionState,
  SortingState,
} from "@tanstack/react-table";
import { Kanban as KanbanIcon, Plus, Rows3, Settings2 } from "lucide-react";
import { useMemo, useState } from "react";
import { z } from "zod";
import type {
  ContactListWithCounts,
  EngagementListItem,
  Offering,
  Page,
  Pipeline,
  Tag,
  User,
} from "@emcp/core/domain";
import { CHANNEL_HINTS } from "~/lib/channels.ts";
import { opQuery, useOp } from "~/lib/api.ts";
import { chipClass } from "~/lib/colors.ts";
import { daysUntil, relativeTime } from "~/lib/format.ts";
import { useIsAdmin } from "~/lib/use-is-admin.ts";
import { DataTable } from "~/components/DataTable.tsx";
import { DebouncedInput } from "~/components/filters.tsx";
import { Kanban } from "~/components/Kanban.tsx";
import { BulkBar } from "~/components/BulkBar.tsx";
import {
  EntityPicker,
  ListCellChips,
  OwnerSelect,
  useCompanyOptions,
  usePersonOptions,
} from "~/components/pickers.tsx";
import { ButtonSpinner, Modal, PageHeader } from "~/components/ui.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Input } from "~/components/ui/input.tsx";
import { NativeSelect as Select } from "~/components/ui/native-select";
import { Switch } from "~/components/ui/switch.tsx";

const PAGE_SIZE = 50;

const searchSchema = z.object({
  q: z.string().optional().catch(undefined),
  view: z.enum(["table", "board"]).catch("table"),
  pipelineId: z.string().optional().catch(undefined),
  stageId: z.string().optional().catch(undefined),
  ownerUserId: z.string().optional().catch(undefined),
  listId: z.string().optional().catch(undefined),
  offeringId: z.string().optional().catch(undefined),
  stale: z.boolean().optional().catch(undefined),
  archived: z.boolean().optional().catch(undefined),
  sort: z
    .enum([
      "displayId",
      "title",
      "createdAt",
      "updatedAt",
      "lastActivityAt",
      "nextActionDue",
    ])
    .catch("updatedAt"),
  dir: z.enum(["asc", "desc"]).catch("desc"),
  page: z.number().int().min(0).catch(0),
});

export const Route = createFileRoute("/app/leads/")({
  validateSearch: searchSchema,
  component: LeadsPage,
});

function LeadsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const isAdmin = useIsAdmin();
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [createOpen, setCreateOpen] = useState(false);

  const pipelines = useQuery(
    opQuery<Pipeline[]>("pipeline.list", { type: "engagement" }),
  );
  const pipeline =
    pipelines.data?.find((p) => p.id === search.pipelineId) ??
    pipelines.data?.find((p) => p.isDefault) ??
    pipelines.data?.[0];

  const filter = {
    search: search.q || undefined,
    pipelineId: search.view === "board" ? pipeline?.id : search.pipelineId,
    stageId: search.stageId,
    ownerUserId: search.ownerUserId,
    listId: search.listId,
    offeringId: search.offeringId,
    stale: search.stale || undefined,
    includeArchived: search.archived ?? false,
    sort: search.sort,
    dir: search.dir,
    limit: search.view === "board" ? 500 : PAGE_SIZE,
    offset: search.view === "board" ? 0 : search.page * PAGE_SIZE,
  };
  const leads = useQuery(
    opQuery<Page<EngagementListItem>>("engagement.list", filter),
  );
  const users = useQuery(opQuery<User[]>("user.list"));
  const tags = useQuery(opQuery<Array<Tag & { usage: number }>>("tag.list"));
  const lists = useQuery(opQuery<ContactListWithCounts[]>("list.list"));
  const offerings = useQuery(opQuery<Offering[]>("offering.list"));

  const moveStage = useOp("engagement.updateStage");

  const patch = (p: Partial<z.infer<typeof searchSchema>>) =>
    navigate({ search: (prev) => ({ ...prev, page: 0, ...p }), replace: true });

  const sorting: SortingState = [
    { id: search.sort, desc: search.dir === "desc" },
  ];

  const userName = (id: string | null) =>
    users.data?.find((u) => u.id === id)?.name ?? null;
  const stageOf = (stageId: string) =>
    pipelines.data?.flatMap((p) => p.stages).find((s) => s.id === stageId);

  const columns = useMemo<ColumnDef<EngagementListItem>[]>(
    () => [
      {
        id: "displayId",
        header: "Ref",
        size: 70,
        cell: ({ row }) => (
          <span className="tnum font-mono text-xs text-muted-foreground/70">
            LEAD-{row.original.displayId}
          </span>
        ),
      },
      {
        id: "title",
        header: "Lead",
        cell: ({ row }) => (
          <div className="max-w-72">
            <p className="truncate font-medium">{row.original.title}</p>
            {row.original.companyName || row.original.personName ? (
              <p className="truncate text-xs text-muted-foreground">
                {[row.original.personName, row.original.companyName]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        id: "stage",
        header: "Stage",
        enableSorting: false,
        cell: ({ row }) => {
          const stage = stageOf(row.original.stageId);
          return stage ? (
            <span className={chipClass(stage.color)}>{stage.name}</span>
          ) : (
            <span className={chipClass("ghost")}>?</span>
          );
        },
      },
      {
        id: "offering",
        header: "Offering",
        enableSorting: false,
        cell: ({ row }) => {
          const o = row.original.offerings;
          const primary = o.find((x) => x.isPrimary) ?? o[0];
          return primary ? (
            <span className="flex items-center gap-1 text-sm">
              <span className="truncate">{primary.name}</span>
              {o.length > 1 ? (
                <span className={chipClass("ghost", "xs")}>
                  +{o.length - 1}
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-muted-foreground/50">—</span>
          );
        },
      },
      {
        id: "channel",
        header: "Channel",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.channel ?? "—"}
          </span>
        ),
      },
      {
        id: "lists",
        header: "Lists",
        enableSorting: false,
        cell: ({ row }) => (
          <ListCellChips
            entityType="engagement"
            entityId={row.original.id}
            lists={row.original.lists}
          />
        ),
      },
      {
        id: "owner",
        header: "Owner",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {userName(row.original.ownerUserId) ?? "—"}
          </span>
        ),
      },
      {
        id: "nextActionDue",
        header: "Next action",
        cell: ({ row }) => {
          const e = row.original;
          if (!e.nextAction && !e.nextActionDue)
            return <span className="text-muted-foreground/50">—</span>;
          const days = daysUntil(e.nextActionDue);
          return (
            <div className="max-w-52">
              <p className="truncate text-xs">{e.nextAction ?? "—"}</p>
              {e.nextActionDue ? (
                <p
                  className={`text-[11px] ${days != null && days < 0 ? "text-destructive" : "text-muted-foreground/70"}`}
                >
                  {e.nextActionDue}
                  {days != null && days < 0 ? " · overdue" : ""}
                </p>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "lastActivityAt",
        header: "Activity",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {relativeTime(row.original.lastActivityAt)}
          </span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [users.data, pipelines.data],
  );

  const selectedIds = Object.keys(selection).filter((k) => selection[k]);

  return (
    <div>
      <PageHeader
        title="Leads"
        subtitle={
          leads.data
            ? `${leads.data.total} engagement${leads.data.total === 1 ? "" : "s"}`
            : "…"
        }
        actions={
          <>
            <div className="flex items-center rounded-lg border border-border p-0.5">
              <Button
                variant={search.view === "table" ? "secondary" : "ghost"}
                size="icon-sm"
                onClick={() => patch({ view: "table" })}
                aria-label="Table view"
              >
                <Rows3 className="size-4" />
              </Button>
              <Button
                variant={search.view === "board" ? "secondary" : "ghost"}
                size="icon-sm"
                onClick={() => patch({ view: "board" })}
                aria-label="Board view"
              >
                <KanbanIcon className="size-4" />
              </Button>
            </div>
            {isAdmin ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Manage pipelines & stages"
                render={<Link to="/app/admin/pipelines" />}
              >
                <Settings2 className="size-4" />
              </Button>
            ) : null}
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" /> New lead
            </Button>
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <DebouncedInput
          value={search.q ?? ""}
          onDebounced={(v) => patch({ q: v || undefined })}
          placeholder="Filter leads…"
        />
        {(pipelines.data?.length ?? 0) > 1 ? (
          <Select
            className="w-auto"
            value={search.pipelineId ?? ""}
            onChange={(e) =>
              patch({
                pipelineId: e.target.value || undefined,
                stageId: undefined,
              })
            }
          >
            <option value="">All pipelines</option>
            {pipelines.data!.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        ) : null}
        <Select
          className="w-auto"
          value={search.stageId ?? ""}
          onChange={(e) => patch({ stageId: e.target.value || undefined })}
        >
          <option value="">All stages</option>
          {(search.pipelineId
            ? (pipelines.data?.filter((p) => p.id === search.pipelineId) ?? [])
            : (pipelines.data ?? [])
          ).flatMap((p) =>
            p.stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            )),
          )}
        </Select>
        <Select
          className="w-auto"
          value={search.ownerUserId ?? ""}
          onChange={(e) => patch({ ownerUserId: e.target.value || undefined })}
        >
          <option value="">Any owner</option>
          {(users.data ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
        <Select
          className="w-auto"
          value={search.listId ?? ""}
          onChange={(e) => patch({ listId: e.target.value || undefined })}
        >
          <option value="">Any list</option>
          {(lists.data ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.engagements})
            </option>
          ))}
        </Select>
        <Select
          className="w-auto"
          value={search.offeringId ?? ""}
          onChange={(e) => patch({ offeringId: e.target.value || undefined })}
        >
          <option value="">Any offering</option>
          {(offerings.data ?? [])
            .filter((o) => o.active)
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
        </Select>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            checked={search.stale ?? false}
            onCheckedChange={(checked) =>
              patch({ stale: checked || undefined })
            }
          />
          stale only
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            checked={search.archived ?? false}
            onCheckedChange={(checked) =>
              patch({ archived: checked || undefined })
            }
          />
          archived
        </label>
      </div>

      {selectedIds.length > 0 ? (
        <BulkBar
          entityType="engagement"
          ids={selectedIds}
          stages={pipeline?.stages ?? []}
          tags={tags.data ?? []}
          lists={lists.data ?? []}
          users={users.data ?? []}
          onDone={() => setSelection({})}
        />
      ) : null}

      {search.view === "board" ? (
        <Kanban
          stages={pipeline?.stages ?? []}
          cards={(leads.data?.items ?? []).map((e) => ({
            id: e.id,
            stageId: e.stageId,
            node: <LeadCard lead={e} />,
          }))}
          onMove={(id, stageId) => moveStage.mutate({ id, stageId })}
        />
      ) : (
        <DataTable
          data={leads.data?.items ?? []}
          columns={columns}
          total={leads.data?.total ?? 0}
          loading={leads.isLoading}
          sorting={sorting}
          onSortingChange={(updater) => {
            const next =
              typeof updater === "function" ? updater(sorting) : updater;
            const first = next[0];
            if (first)
              patch({
                sort: first.id as typeof search.sort,
                dir: first.desc ? "desc" : "asc",
              });
          }}
          page={search.page}
          pageSize={PAGE_SIZE}
          onPageChange={(page) =>
            navigate({ search: (prev) => ({ ...prev, page }), replace: true })
          }
          onRowClick={(row) =>
            navigate({ to: "/app/leads/$id", params: { id: row.id } })
          }
          getRowId={(row) => row.id}
          rowSelection={selection}
          onRowSelectionChange={setSelection}
          empty={{
            title: search.q ? "No leads match" : "No leads yet",
            hint: search.q
              ? "Try a different search or clear filters."
              : "Create your first lead or import a CSV from Admin → Data.",
            action: (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" /> New lead
              </Button>
            ),
          }}
        />
      )}

      <CreateLeadModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        pipelines={pipelines.data ?? []}
      />
    </div>
  );
}

function LeadCard({ lead }: { lead: EngagementListItem }) {
  const navigate = useNavigate();
  const days = daysUntil(lead.nextActionDue);
  const primaryOffering =
    lead.offerings.find((x) => x.isPrimary) ?? lead.offerings[0];
  return (
    <Button
      type="button"
      variant="outline"
      className="h-auto w-full justify-start whitespace-normal p-2.5 text-left hover:border-foreground/25 hover:bg-background"
      onClick={() =>
        navigate({ to: "/app/leads/$id", params: { id: lead.id } })
      }
    >
      <p className="truncate text-sm font-medium">{lead.title}</p>
      {lead.companyName || lead.personName ? (
        <p className="truncate text-xs text-muted-foreground">
          {[lead.personName, lead.companyName].filter(Boolean).join(" · ")}
        </p>
      ) : null}
      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground/70">
        <span className="tnum font-mono">LEAD-{lead.displayId}</span>
        {lead.channel ? <span className="truncate">{lead.channel}</span> : null}
        {primaryOffering ? (
          <span className={chipClass("ghost", "xs")}>
            {primaryOffering.name}
          </span>
        ) : null}
        {lead.nextActionDue ? (
          <span
            className={`ml-auto ${days != null && days < 0 ? "text-destructive" : ""}`}
          >
            {lead.nextActionDue.slice(5)}
          </span>
        ) : (
          <span className="ml-auto">{relativeTime(lead.lastActivityAt)}</span>
        )}
      </div>
    </Button>
  );
}

function CreateLeadModal({
  open,
  onClose,
  pipelines,
}: {
  open: boolean;
  onClose(): void;
  pipelines: Pipeline[];
}) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [personId, setPersonId] = useState<string | null>(null);
  const [channel, setChannel] = useState("");
  const [source, setSource] = useState("");
  const [owner, setOwner] = useState<string | null>(null);
  const [stageId, setStageId] = useState<string | null>(null);
  const [offeringId, setOfferingId] = useState("");
  const pipeline = pipelines.find((p) => p.isDefault) ?? pipelines[0];
  const offerings = useQuery(opQuery<Offering[]>("offering.list"));

  const createCompany = useOp<{ name: string }, { id: string }>(
    "company.create",
    {
      onSuccess: (c) => setCompanyId(c.id),
      successToast: "Company created",
    },
  );
  const createPerson = useOp<{ name: string }, { id: string }>(
    "person.create",
    {
      onSuccess: (p) => setPersonId(p.id),
      successToast: "Person created",
    },
  );
  const create = useOp<Record<string, unknown>, { id: string }>(
    "engagement.create",
    {
      successToast: "Lead created",
      onSuccess: (e) => {
        onClose();
        reset();
        navigate({ to: "/app/leads/$id", params: { id: e.id } });
      },
    },
  );

  function reset() {
    setTitle("");
    setCompanyId(null);
    setPersonId(null);
    setChannel("");
    setSource("");
    setOwner(null);
    setStageId(null);
    setOfferingId("");
  }

  return (
    <Modal open={open} onClose={onClose} title="New lead">
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            Title
          </span>
          <Input
            placeholder="Defaults to “Person @ Company”"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Company
            </span>
            <CompanyField
              value={companyId}
              onChange={setCompanyId}
              onCreate={(name) => createCompany.mutate({ name })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Person
            </span>
            <PersonField
              value={personId}
              onChange={setPersonId}
              onCreate={(name) => createPerson.mutate({ name })}
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Channel
            </span>
            <Input
              list="channel-hints"
              placeholder="LinkedIn Invite, Email…"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
            />
            <datalist id="channel-hints">
              {CHANNEL_HINTS.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Source
            </span>
            <Input
              placeholder="Campaign, referral…"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            Offering
          </span>
          <Select
            value={offeringId}
            onChange={(e) => setOfferingId(e.target.value)}
          >
            <option value="">None</option>
            {(offerings.data ?? [])
              .filter((o) => o.active)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
          </Select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Stage
            </span>
            <Select
              value={stageId ?? ""}
              onChange={(e) => setStageId(e.target.value || null)}
            >
              {(pipeline?.stages ?? []).map((s, i) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {i === 0 ? " (default)" : ""}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Owner
            </span>
            <OwnerSelect value={owner} onChange={setOwner} />
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={
              create.isPending || (!title.trim() && !companyId && !personId)
            }
            onClick={() =>
              create.mutate({
                title: title.trim() || undefined,
                companyId,
                personId,
                channel: channel.trim() || undefined,
                source: source.trim() || undefined,
                ownerUserId: owner,
                stageId: stageId ?? undefined,
                offeringId: offeringId || undefined,
              })
            }
          >
            {create.isPending ? <ButtonSpinner /> : null}
            Create lead
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function CompanyField(props: {
  value: string | null;
  onChange(v: string | null): void;
  onCreate?(name: string): void;
}) {
  return (
    <EntityPicker
      value={props.value}
      onChange={props.onChange}
      useOptions={useCompanyOptions}
      placeholder="Search companies…"
      allowClear
      onCreate={props.onCreate}
    />
  );
}

export function PersonField(props: {
  value: string | null;
  onChange(v: string | null): void;
  onCreate?(name: string): void;
}) {
  return (
    <EntityPicker
      value={props.value}
      onChange={props.onChange}
      useOptions={usePersonOptions}
      placeholder="Search people…"
      allowClear
      onCreate={props.onCreate}
    />
  );
}
