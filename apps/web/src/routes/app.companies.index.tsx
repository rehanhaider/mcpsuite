import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { ColumnDef, RowSelectionState, SortingState } from "@tanstack/react-table";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { z } from "zod";
import type { CompanyListItem, ContactListWithCounts, Page, Tag, User } from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { relativeTime } from "~/lib/format.ts";
import { BulkBar } from "~/components/BulkBar.tsx";
import { DataTable } from "~/components/DataTable.tsx";
import { DebouncedInput } from "~/components/filters.tsx";
import { ListCellChips, OwnerSelect } from "~/components/pickers.tsx";
import { ButtonSpinner, Modal, PageHeader } from "~/components/ui.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Input } from "~/components/ui/input.tsx";
import { NativeSelect as Select } from "~/components/ui/native-select";
import { Switch } from "~/components/ui/switch.tsx";

const PAGE_SIZE = 50;

const searchSchema = z.object({
  q: z.string().optional().catch(undefined),
  ownerUserId: z.string().optional().catch(undefined),
  listId: z.string().optional().catch(undefined),
  archived: z.boolean().optional().catch(undefined),
  sort: z.enum(["name", "createdAt", "updatedAt", "displayId"]).catch("updatedAt"),
  dir: z.enum(["asc", "desc"]).catch("desc"),
  page: z.number().int().min(0).catch(0),
});

export const Route = createFileRoute("/app/companies/")({
  validateSearch: searchSchema,
  component: CompaniesPage,
});

function CompaniesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [createOpen, setCreateOpen] = useState(false);

  const companies = useQuery(
    opQuery<Page<CompanyListItem>>("company.list", {
      search: search.q || undefined,
      ownerUserId: search.ownerUserId,
      listId: search.listId,
      includeArchived: search.archived ?? false,
      sort: search.sort,
      dir: search.dir,
      limit: PAGE_SIZE,
      offset: search.page * PAGE_SIZE,
    }),
  );
  const users = useQuery(opQuery<User[]>("user.list"));
  const tags = useQuery(opQuery<Array<Tag & { usage: number }>>("tag.list"));
  const lists = useQuery(opQuery<ContactListWithCounts[]>("list.list"));

  const patch = (p: Partial<z.infer<typeof searchSchema>>) => navigate({ search: (prev) => ({ ...prev, page: 0, ...p }), replace: true });

  const sorting: SortingState = [{ id: search.sort, desc: search.dir === "desc" }];
  const userName = (id: string | null) => users.data?.find((u) => u.id === id)?.name ?? null;

  const columns = useMemo<ColumnDef<CompanyListItem>[]>(
    () => [
      {
        id: "displayId",
        header: "Ref",
        size: 90,
        cell: ({ row }) => <span className="tnum font-mono text-xs text-muted-foreground/70">COMPANY-{row.original.displayId}</span>,
      },
      {
        id: "name",
        header: "Company",
        cell: ({ row }) => (
          <div className="max-w-72">
            <p className="truncate font-medium">{row.original.name}</p>
            {row.original.website ? (
              <p className="truncate text-xs text-muted-foreground/70">{row.original.website.replace(/^https?:\/\//, "")}</p>
            ) : null}
          </div>
        ),
      },
      {
        id: "industry",
        header: "Industry",
        enableSorting: false,
        cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.industry ?? "—"}</span>,
      },
      {
        id: "lists",
        header: "Lists",
        enableSorting: false,
        cell: ({ row }) => <ListCellChips entityType="company" entityId={row.original.id} lists={row.original.lists} />,
      },
      {
        id: "hq",
        header: "HQ",
        enableSorting: false,
        cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.hq ?? row.original.country ?? "—"}</span>,
      },
      {
        id: "owner",
        header: "Owner",
        enableSorting: false,
        cell: ({ row }) => <span className="text-xs text-muted-foreground">{userName(row.original.ownerUserId) ?? "—"}</span>,
      },
      {
        id: "updatedAt",
        header: "Updated",
        cell: ({ row }) => <span className="text-xs text-muted-foreground">{relativeTime(row.original.updatedAt)}</span>,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [users.data],
  );

  const selectedIds = Object.keys(selection).filter((k) => selection[k]);

  return (
    <div>
      <PageHeader
        title="Companies"
        subtitle={companies.data ? `${companies.data.total} compan${companies.data.total === 1 ? "y" : "ies"}` : "…"}
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> New company
          </Button>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <DebouncedInput value={search.q ?? ""} onDebounced={(v) => patch({ q: v || undefined })} placeholder="Filter companies…" />
        <Select className="w-auto" value={search.ownerUserId ?? ""} onChange={(e) => patch({ ownerUserId: e.target.value || undefined })}>
          <option value="">Any owner</option>
          {(users.data ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
        <Select className="w-auto" value={search.listId ?? ""} onChange={(e) => patch({ listId: e.target.value || undefined })}>
          <option value="">Any list</option>
          {(lists.data ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.companies})
            </option>
          ))}
        </Select>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Switch checked={search.archived ?? false} onCheckedChange={(checked) => patch({ archived: checked || undefined })} />
          archived
        </label>
      </div>

      {selectedIds.length > 0 ? (
        <BulkBar
          entityType="company"
          ids={selectedIds}
          tags={tags.data ?? []}
          lists={lists.data ?? []}
          users={users.data ?? []}
          onDone={() => setSelection({})}
        />
      ) : null}

      <DataTable
        data={companies.data?.items ?? []}
        columns={columns}
        total={companies.data?.total ?? 0}
        loading={companies.isLoading}
        sorting={sorting}
        onSortingChange={(updater) => {
          const next = typeof updater === "function" ? updater(sorting) : updater;
          const first = next[0];
          if (first) patch({ sort: first.id as typeof search.sort, dir: first.desc ? "desc" : "asc" });
        }}
        page={search.page}
        pageSize={PAGE_SIZE}
        onPageChange={(page) => navigate({ search: (prev) => ({ ...prev, page }), replace: true })}
        onRowClick={(row) => navigate({ to: "/app/companies/$id", params: { id: row.id } })}
        getRowId={(row) => row.id}
        rowSelection={selection}
        onRowSelectionChange={setSelection}
        empty={{
          title: search.q ? "No companies match" : "No companies yet",
          action: (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" /> New company
            </Button>
          ),
        }}
      />

      <CreateCompanyModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function CreateCompanyModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [industry, setIndustry] = useState("");
  const [hq, setHq] = useState("");
  const [country, setCountry] = useState("");
  const [linkedin, setLinkedin] = useState("");
  const [owner, setOwner] = useState<string | null>(null);
  const create = useOp<Record<string, unknown>, { id: string }>("company.create", {
    successToast: "Company created",
    onSuccess: (c) => {
      onClose();
      navigate({ to: "/app/companies/$id", params: { id: c.id } });
    },
  });

  return (
    <Modal open={open} onClose={onClose} title="New company">
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">Name *</span>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Website</span>
            <Input placeholder="acme.com" value={website} onChange={(e) => setWebsite(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">LinkedIn</span>
            <Input value={linkedin} onChange={(e) => setLinkedin(e.target.value)} />
          </label>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Industry</span>
            <Input value={industry} onChange={(e) => setIndustry(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">HQ</span>
            <Input value={hq} onChange={(e) => setHq(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Country</span>
            <Input value={country} onChange={(e) => setCountry(e.target.value)} />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">Owner</span>
          <OwnerSelect value={owner} onChange={setOwner} />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={create.isPending || !name.trim()}
            onClick={() =>
              create.mutate({
                name: name.trim(),
                website: website.trim() || undefined,
                linkedin: linkedin.trim() || undefined,
                industry: industry.trim() || undefined,
                hq: hq.trim() || undefined,
                country: country.trim() || undefined,
                ownerUserId: owner,
              })
            }
          >
            {create.isPending ? <ButtonSpinner /> : null}
            Create
          </Button>
        </div>
      </div>
    </Modal>
  );
}
