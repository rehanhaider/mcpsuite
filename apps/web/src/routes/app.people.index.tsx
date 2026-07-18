import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { ColumnDef, RowSelectionState, SortingState } from "@tanstack/react-table";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { z } from "zod";
import type { ContactListWithCounts, Page, PersonListItem, Tag, User } from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { relativeTime } from "~/lib/format.ts";
import { BulkBar } from "~/components/BulkBar.tsx";
import { DataTable } from "~/components/DataTable.tsx";
import { DebouncedInput } from "~/components/filters.tsx";
import { ListCellChips, OwnerSelect } from "~/components/pickers.tsx";
import { CompanyField } from "~/routes/app.leads.index.tsx";
import { Avatar, ButtonSpinner, Modal, PageHeader } from "~/components/ui.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Input } from "~/components/ui/input.tsx";
import { NativeSelect as Select } from "~/components/ui/native-select";
import { Switch } from "~/components/ui/switch.tsx";

const PAGE_SIZE = 50;

const searchSchema = z.object({
  q: z.string().optional().catch(undefined),
  companyId: z.string().optional().catch(undefined),
  ownerUserId: z.string().optional().catch(undefined),
  listId: z.string().optional().catch(undefined),
  archived: z.boolean().optional().catch(undefined),
  sort: z.enum(["name", "createdAt", "updatedAt", "displayId"]).catch("updatedAt"),
  dir: z.enum(["asc", "desc"]).catch("desc"),
  page: z.number().int().min(0).catch(0),
});

export const Route = createFileRoute("/app/people/")({
  validateSearch: searchSchema,
  component: PeoplePage,
});

function PeoplePage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [createOpen, setCreateOpen] = useState(false);

  const people = useQuery(
    opQuery<Page<PersonListItem>>("person.list", {
      search: search.q || undefined,
      companyId: search.companyId,
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

  const columns = useMemo<ColumnDef<PersonListItem>[]>(
    () => [
      {
        id: "name",
        header: "Person",
        cell: ({ row }) => (
          <div className="flex max-w-72 items-center gap-2.5">
            <Avatar name={row.original.name} />
            <div className="min-w-0">
              <p className="truncate font-medium">{row.original.name}</p>
              <p className="truncate text-xs text-muted-foreground">{row.original.title ?? "—"}</p>
            </div>
          </div>
        ),
      },
      {
        id: "company",
        header: "Company",
        enableSorting: false,
        cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.primaryCompanyName ?? "—"}</span>,
      },
      {
        id: "lists",
        header: "Lists",
        enableSorting: false,
        cell: ({ row }) => <ListCellChips entityType="person" entityId={row.original.id} lists={row.original.lists} />,
      },
      {
        id: "email",
        header: "Email",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.email ? (
            <a href={`mailto:${row.original.email}`} className="text-xs text-cyan hover:underline" onClick={(e) => e.stopPropagation()}>
              {row.original.email}
            </a>
          ) : (
            <span className="text-muted-foreground/50">—</span>
          ),
      },
      {
        id: "location",
        header: "Location",
        enableSorting: false,
        cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.location ?? row.original.country ?? "—"}</span>,
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
        title="People"
        subtitle={people.data ? `${people.data.total} ${people.data.total === 1 ? "person" : "people"}` : "…"}
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> New person
          </Button>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <DebouncedInput value={search.q ?? ""} onDebounced={(v) => patch({ q: v || undefined })} placeholder="Filter people…" />
        <div className="w-52">
          <CompanyField value={search.companyId ?? null} onChange={(v) => patch({ companyId: v ?? undefined })} />
        </div>
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
              {l.name} ({l.people})
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
          entityType="person"
          ids={selectedIds}
          tags={tags.data ?? []}
          lists={lists.data ?? []}
          users={users.data ?? []}
          onDone={() => setSelection({})}
        />
      ) : null}

      <DataTable
        data={people.data?.items ?? []}
        columns={columns}
        total={people.data?.total ?? 0}
        loading={people.isLoading}
        sorting={sorting}
        onSortingChange={(updater) => {
          const next = typeof updater === "function" ? updater(sorting) : updater;
          const first = next[0];
          if (first) patch({ sort: first.id as typeof search.sort, dir: first.desc ? "desc" : "asc" });
        }}
        page={search.page}
        pageSize={PAGE_SIZE}
        onPageChange={(page) => navigate({ search: (prev) => ({ ...prev, page }), replace: true })}
        onRowClick={(row) => navigate({ to: "/app/people/$id", params: { id: row.id } })}
        getRowId={(row) => row.id}
        rowSelection={selection}
        onRowSelectionChange={setSelection}
        empty={{
          title: search.q ? "No people match" : "No people yet",
          action: (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" /> New person
            </Button>
          ),
        }}
      />

      <CreatePersonModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function CreatePersonModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [linkedin, setLinkedin] = useState("");
  const [location, setLocation] = useState("");
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const createCompany = useOp<{ name: string }, { id: string }>("company.create", {
    onSuccess: (c) => setCompanyId(c.id),
    successToast: "Company created",
  });
  const create = useOp<Record<string, unknown>, { id: string }>("person.create", {
    successToast: "Person created",
    onSuccess: (p) => {
      onClose();
      navigate({ to: "/app/people/$id", params: { id: p.id } });
    },
  });

  return (
    <Modal open={open} onClose={onClose} title="New person">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Name *</span>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Title</span>
            <Input placeholder="CTO, Founder…" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">Company</span>
          <CompanyField value={companyId} onChange={setCompanyId} onCreate={(n) => createCompany.mutate({ name: n })} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Email</span>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Phone</span>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">LinkedIn</span>
            <Input value={linkedin} onChange={(e) => setLinkedin(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Location</span>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} />
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
                title: title.trim() || undefined,
                email: email.trim() || undefined,
                phone: phone.trim() || undefined,
                linkedin: linkedin.trim() || undefined,
                location: location.trim() || undefined,
                companyId,
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
