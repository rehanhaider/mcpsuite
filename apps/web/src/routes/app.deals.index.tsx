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
  DealListItem,
  Offering,
  Page,
  Pipeline,
  Tag,
  User,
} from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { chipClass } from "~/lib/colors.ts";
import { daysUntil, formatMoneyMinor, relativeTime } from "~/lib/format.ts";
import { useIsAdmin } from "~/lib/use-is-admin.ts";
import { BulkBar } from "~/components/BulkBar.tsx";
import { DataTable } from "~/components/DataTable.tsx";
import { DebouncedInput } from "~/components/filters.tsx";
import { Kanban } from "~/components/Kanban.tsx";
import { ListCellChips, OwnerSelect } from "~/components/pickers.tsx";
import { CompanyField, PersonField } from "~/routes/app.leads.index.tsx";
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
  status: z.enum(["open", "won", "lost"]).optional().catch(undefined),
  ownerUserId: z.string().optional().catch(undefined),
  listId: z.string().optional().catch(undefined),
  offeringId: z.string().optional().catch(undefined),
  archived: z.boolean().optional().catch(undefined),
  sort: z
    .enum([
      "displayId",
      "title",
      "amountMinor",
      "expectedCloseDate",
      "createdAt",
      "updatedAt",
      "lastActivityAt",
    ])
    .catch("updatedAt"),
  dir: z.enum(["asc", "desc"]).catch("desc"),
  page: z.number().int().min(0).catch(0),
});

export const Route = createFileRoute("/app/deals/")({
  validateSearch: searchSchema,
  component: DealsPage,
});

function DealsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const isAdmin = useIsAdmin();
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [createOpen, setCreateOpen] = useState(false);

  const pipelines = useQuery(
    opQuery<Pipeline[]>("pipeline.list", { type: "deal" }),
  );
  const pipeline =
    pipelines.data?.find((p) => p.id === search.pipelineId) ??
    pipelines.data?.find((p) => p.isDefault) ??
    pipelines.data?.[0];

  const deals = useQuery(
    opQuery<Page<DealListItem>>("deal.list", {
      search: search.q || undefined,
      pipelineId: search.view === "board" ? pipeline?.id : search.pipelineId,
      stageId: search.stageId,
      status: search.status,
      ownerUserId: search.ownerUserId,
      listId: search.listId,
      offeringId: search.offeringId,
      includeArchived: search.archived ?? false,
      sort: search.sort,
      dir: search.dir,
      limit: search.view === "board" ? 500 : PAGE_SIZE,
      offset: search.view === "board" ? 0 : search.page * PAGE_SIZE,
    }),
  );
  const users = useQuery(opQuery<User[]>("user.list"));
  const tags = useQuery(opQuery<Array<Tag & { usage: number }>>("tag.list"));
  const lists = useQuery(opQuery<ContactListWithCounts[]>("list.list"));
  const offerings = useQuery(opQuery<Offering[]>("offering.list"));
  const moveStage = useOp("deal.updateStage");

  const patch = (p: Partial<z.infer<typeof searchSchema>>) =>
    navigate({ search: (prev) => ({ ...prev, page: 0, ...p }), replace: true });

  const sorting: SortingState = [
    { id: search.sort, desc: search.dir === "desc" },
  ];
  const userName = (id: string | null) =>
    users.data?.find((u) => u.id === id)?.name ?? null;
  const stageOf = (stageId: string) =>
    pipelines.data?.flatMap((p) => p.stages).find((s) => s.id === stageId);

  const columns = useMemo<ColumnDef<DealListItem>[]>(
    () => [
      {
        id: "displayId",
        header: "Ref",
        size: 70,
        cell: ({ row }) => (
          <span className="tnum font-mono text-xs text-muted-foreground/70">
            DEAL-{row.original.displayId}
          </span>
        ),
      },
      {
        id: "title",
        header: "Deal",
        cell: ({ row }) => (
          <div className="max-w-72">
            <p className="truncate font-medium">{row.original.title}</p>
            {row.original.companyName || row.original.primaryPersonName ? (
              <p className="truncate text-xs text-muted-foreground">
                {[row.original.companyName, row.original.primaryPersonName]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        id: "amountMinor",
        header: "Value",
        cell: ({ row }) => (
          <span className="tnum font-mono text-xs">
            {formatMoneyMinor(row.original.amountMinor, row.original.currency)}
          </span>
        ),
      },
      {
        id: "stage",
        header: "Stage",
        enableSorting: false,
        cell: ({ row }) => {
          const stage = stageOf(row.original.stageId);
          const status = row.original.status;
          if (status === "won")
            return <span className={chipClass("success")}>won</span>;
          if (status === "lost")
            return <span className={chipClass("error")}>lost</span>;
          return stage ? (
            <span className={chipClass(stage.color)}>{stage.name}</span>
          ) : null;
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
        id: "lists",
        header: "Lists",
        enableSorting: false,
        cell: ({ row }) => (
          <ListCellChips
            entityType="deal"
            entityId={row.original.id}
            lists={row.original.lists}
          />
        ),
      },
      {
        id: "probability",
        header: "Prob.",
        enableSorting: false,
        size: 60,
        cell: ({ row }) =>
          row.original.probability != null ? (
            <span className="tnum font-mono text-xs text-muted-foreground">
              {row.original.probability}%
            </span>
          ) : (
            <span className="text-muted-foreground/50">—</span>
          ),
      },
      {
        id: "expectedCloseDate",
        header: "Close",
        cell: ({ row }) => {
          const d = row.original.expectedCloseDate;
          if (!d) return <span className="text-muted-foreground/50">—</span>;
          const days = daysUntil(d);
          const late =
            days != null && days < 0 && row.original.status === "open";
          return (
            <span
              className={`text-xs ${late ? "text-destructive" : "text-muted-foreground"}`}
            >
              {d}
            </span>
          );
        },
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
        title="Deals"
        subtitle={
          deals.data
            ? `${deals.data.total} deal${deals.data.total === 1 ? "" : "s"}`
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
              <Plus className="size-4" /> New deal
            </Button>
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <DebouncedInput
          value={search.q ?? ""}
          onDebounced={(v) => patch({ q: v || undefined })}
          placeholder="Filter deals…"
        />
        <Select
          className="w-auto"
          value={search.status ?? ""}
          onChange={(e) =>
            patch({
              status: (e.target.value || undefined) as
                "open" | "won" | "lost" | undefined,
            })
          }
        >
          <option value="">Any status</option>
          <option value="open">Open</option>
          <option value="won">Won</option>
          <option value="lost">Lost</option>
        </Select>
        <Select
          className="w-auto"
          value={search.stageId ?? ""}
          onChange={(e) => patch({ stageId: e.target.value || undefined })}
        >
          <option value="">All stages</option>
          {(pipeline?.stages ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
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
              {l.name} ({l.deals})
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
          entityType="deal"
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
          cards={(deals.data?.items ?? []).map((d) => ({
            id: d.id,
            stageId: d.stageId,
            node: <DealCard deal={d} />,
          }))}
          onMove={(id, stageId) => moveStage.mutate({ id, stageId })}
          columnFooter={(stage) => {
            const inStage = (deals.data?.items ?? []).filter(
              (d) => d.stageId === stage.id && d.amountMinor != null,
            );
            const byCcy: Record<string, number> = {};
            for (const d of inStage)
              byCcy[d.currency] =
                (byCcy[d.currency] ?? 0) + (d.amountMinor ?? 0);
            const label = Object.entries(byCcy)
              .map(([ccy, minor]) => formatMoneyMinor(minor, ccy))
              .join(" + ");
            return (
              <p className="tnum text-center font-mono text-[11px] text-muted-foreground/70">
                {label || "—"}
              </p>
            );
          }}
        />
      ) : (
        <DataTable
          data={deals.data?.items ?? []}
          columns={columns}
          total={deals.data?.total ?? 0}
          loading={deals.isLoading}
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
            navigate({ to: "/app/deals/$id", params: { id: row.id } })
          }
          getRowId={(row) => row.id}
          rowSelection={selection}
          onRowSelectionChange={setSelection}
          empty={{
            title: search.q ? "No deals match" : "No deals yet",
            hint: "Convert a lead or create a deal directly.",
            action: (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" /> New deal
              </Button>
            ),
          }}
        />
      )}

      <CreateDealModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        pipelines={pipelines.data ?? []}
      />
    </div>
  );
}

function DealCard({ deal }: { deal: DealListItem }) {
  const navigate = useNavigate();
  const days = daysUntil(deal.expectedCloseDate);
  return (
    <Button
      type="button"
      variant="outline"
      className="h-auto w-full justify-start whitespace-normal p-2.5 text-left hover:border-foreground/25 hover:bg-background"
      onClick={() =>
        navigate({ to: "/app/deals/$id", params: { id: deal.id } })
      }
    >
      <p className="truncate text-sm font-medium">{deal.title}</p>
      {deal.companyName ? (
        <p className="truncate text-xs text-muted-foreground">
          {deal.companyName}
        </p>
      ) : null}
      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground/70">
        <span className="tnum font-mono font-semibold text-foreground/70">
          {formatMoneyMinor(deal.amountMinor, deal.currency)}
        </span>
        {deal.probability != null ? (
          <span className="tnum font-mono">{deal.probability}%</span>
        ) : null}
        {deal.expectedCloseDate ? (
          <span
            className={`ml-auto ${days != null && days < 0 && deal.status === "open" ? "text-destructive" : ""}`}
          >
            {deal.expectedCloseDate.slice(5)}
          </span>
        ) : null}
      </div>
    </Button>
  );
}

function CreateDealModal({
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
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("");
  const [closeDate, setCloseDate] = useState("");
  const [stageId, setStageId] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
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
  const create = useOp<Record<string, unknown>, { id: string }>("deal.create", {
    successToast: "Deal created",
    onSuccess: (d) => {
      onClose();
      navigate({ to: "/app/deals/$id", params: { id: d.id } });
    },
  });

  return (
    <Modal open={open} onClose={onClose} title="New deal">
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            Title *
          </span>
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
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
              Company
            </span>
            <CompanyField
              value={companyId}
              onChange={setCompanyId}
              onCreate={(n) => createCompany.mutate({ name: n })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Primary contact
            </span>
            <PersonField value={personId} onChange={setPersonId} />
          </label>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <label className="col-span-2 block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Amount (major units)
            </span>
            <Input
              type="number"
              min="0"
              step="0.01"
              placeholder="5000"
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
              placeholder="default"
              maxLength={3}
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </label>
        </div>
        <div className="grid grid-cols-3 gap-3">
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
                companyId,
                primaryPersonId: personId,
                amountMinor: amount
                  ? Math.round(Number(amount) * 100)
                  : undefined,
                currency:
                  currency.trim().length === 3 ? currency.trim() : undefined,
                expectedCloseDate: closeDate || undefined,
                stageId: stageId ?? undefined,
                ownerUserId: owner,
                offeringId: offeringId || undefined,
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
