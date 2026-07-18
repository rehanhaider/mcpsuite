/**
 * Lists hub — the home of contact lists (audiences/segments). First-class nav
 * destination: see every list with live membership counts, create/edit/delete,
 * and click through to a list's page to manage members.
 */
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  LISTABLE_TYPES,
  SEMANTIC_COLORS,
  type ContactListWithCounts,
  type ListableType,
  type SemanticColor,
} from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { chipClass, dotClass } from "~/lib/colors.ts";
import { relativeTime } from "~/lib/format.ts";
import { EmptyState, Modal, PageHeader, Spinner } from "~/components/ui.tsx";
import { TABLE_CLASS, TableShell } from "~/components/TableShell.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Input } from "~/components/ui/input.tsx";
import { NativeSelect as Select } from "~/components/ui/native-select";

const HOLDS_LABELS: Record<ListableType, string> = {
  person: "people",
  company: "companies",
  engagement: "leads",
  deal: "deals",
};

function holdsLabel(l: ContactListWithCounts): string {
  return l.entityType ? HOLDS_LABELS[l.entityType] : "mixed";
}

function memberTotal(l: ContactListWithCounts): number {
  return l.people + l.companies + l.engagements + l.deals;
}

export const Route = createFileRoute("/app/lists/")({ component: ListsPage });

function ListsPage() {
  const navigate = useNavigate();
  const lists = useQuery(opQuery<ContactListWithCounts[]>("list.list"));
  const [edit, setEdit] = useState<ContactListWithCounts | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const del = useOp("list.delete", { successToast: "List deleted" });

  const total = lists.data?.length ?? 0;

  return (
    <div>
      <PageHeader
        title="Lists"
        subtitle={
          lists.data
            ? `${total} list${total === 1 ? "" : "s"} — segment contacts, leads and deals into audiences`
            : "…"
        }
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> New list
          </Button>
        }
      />

      {lists.isLoading ? (
        <Spinner />
      ) : total === 0 ? (
        <EmptyState
          title="No lists yet"
          hint='Lists split your CRM into audiences — "Job search", "Product X prospects", "Q3 pipeline focus". Members show up as chips on tables, and agents can manage lists over MCP.'
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" /> Create your first list
            </Button>
          }
        />
      ) : (
        <TableShell>
          <table className={TABLE_CLASS}>
            <thead className="text-[11px] tracking-wider text-muted-foreground uppercase">
              <tr className="border-b border-border">
                <th className="px-3 py-2 text-left font-medium">List</th>
                <th className="px-3 py-2 text-left font-medium">Holds</th>
                <th className="px-3 py-2 text-left font-medium">Description</th>
                <th className="px-3 py-2 text-left font-medium">People</th>
                <th className="px-3 py-2 text-left font-medium">Companies</th>
                <th className="px-3 py-2 text-left font-medium">Leads</th>
                <th className="px-3 py-2 text-left font-medium">Deals</th>
                <th className="px-3 py-2 text-left font-medium">Created</th>
                <th className="w-20 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {lists.data!.map((l) => (
                <tr
                  key={l.id}
                  className="cursor-pointer border-b border-border/50 transition-colors last:border-0 hover:bg-foreground/[0.03]"
                  onClick={() =>
                    navigate({ to: "/app/lists/$id", params: { id: l.id } })
                  }
                >
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-2 font-medium">
                      <span
                        className={`size-2 shrink-0 rounded-full ${dotClass(l.color)}`}
                      />
                      {l.name}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={chipClass("ghost", "xs")}>
                      {holdsLabel(l)}
                    </span>
                  </td>
                  <td className="max-w-80 truncate px-3 py-2.5 text-muted-foreground">
                    {l.description ?? "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="tnum text-muted-foreground">
                      {l.people}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="tnum text-muted-foreground">
                      {l.companies}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="tnum text-muted-foreground">
                      {l.engagements}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="tnum text-muted-foreground">
                      {l.deals}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {relativeTime(l.createdAt)}
                  </td>
                  {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events */}
                  <td
                    className="px-3 py-2.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex justify-end gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Edit ${l.name}`}
                        onClick={() => setEdit(l)}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="text-destructive"
                        aria-label={`Delete ${l.name}`}
                        onClick={() => {
                          if (
                            confirm(
                              `Delete list "${l.name}"? ${memberTotal(l)} members will be detached (records are kept).`,
                            )
                          )
                            del.mutate({ id: l.id });
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      )}

      {total > 0 ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground/70">
          <Layers className="size-3.5" />
          Tip: bulk-add from the{" "}
          <Link to="/app/people" className="underline hover:text-foreground">
            People
          </Link>
          ,{" "}
          <Link to="/app/companies" className="underline hover:text-foreground">
            Companies
          </Link>
          ,{" "}
          <Link to="/app/leads" className="underline hover:text-foreground">
            Leads
          </Link>{" "}
          or{" "}
          <Link to="/app/deals" className="underline hover:text-foreground">
            Deals
          </Link>{" "}
          tables — select rows, then “List”.
        </p>
      ) : null}

      <ListModal open={createOpen} onClose={() => setCreateOpen(false)} />
      {edit ? (
        <ListModal open onClose={() => setEdit(null)} list={edit} />
      ) : null}
    </div>
  );
}

export function ListModal({
  open,
  onClose,
  list,
}: {
  open: boolean;
  onClose(): void;
  list?: ContactListWithCounts;
}) {
  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  const [color, setColor] = useState<SemanticColor>(list?.color ?? "neutral");
  const [entityType, setEntityType] = useState<string>(list?.entityType ?? "");
  const create = useOp("list.create", {
    successToast: "List created",
    onSuccess: onClose,
  });
  const update = useOp("list.update", {
    successToast: "List updated",
    onSuccess: onClose,
  });
  const pending = create.isPending || update.isPending;

  const typeDisabled = (type: ListableType) => {
    if (!list) return false;
    const counts: Record<ListableType, number> = {
      person: list.people,
      company: list.companies,
      engagement: list.engagements,
      deal: list.deals,
    };
    return LISTABLE_TYPES.some((t) => t !== type && counts[t] > 0);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={list ? `Edit ${list.name}` : "New list"}
    >
      <div className="space-y-3">
        <Input
          value={name}
          autoFocus
          placeholder='List name — "Job search", "Product X prospects"…'
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          value={description}
          placeholder="Description (optional)"
          onChange={(e) => setDescription(e.target.value)}
        />
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            Holds
          </span>
          <Select
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
          >
            <option value="">Mixed (any entity type)</option>
            <option value="person" disabled={typeDisabled("person")}>
              People
            </option>
            <option value="company" disabled={typeDisabled("company")}>
              Companies
            </option>
            <option value="engagement" disabled={typeDisabled("engagement")}>
              Leads
            </option>
            <option value="deal" disabled={typeDisabled("deal")}>
              Deals
            </option>
          </Select>
        </label>
        <div className="flex flex-wrap gap-1.5">
          {SEMANTIC_COLORS.map((c) => (
            <Button
              key={c}
              type="button"
              variant="ghost"
              size="icon-xs"
              title={c}
              className={`rounded-full border-2 hover:bg-transparent ${dotClass(c)} ${color === c ? "border-foreground" : "border-transparent opacity-60 hover:opacity-100"}`}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!name.trim() || pending}
          onClick={() => {
            const typePatch = entityType ? (entityType as ListableType) : null;
            if (list)
              update.mutate({
                id: list.id,
                name: name.trim(),
                description: description.trim() || null,
                color,
                entityType: typePatch,
              });
            else
              create.mutate({
                name: name.trim(),
                description: description.trim() || null,
                color,
                entityType: typePatch ?? undefined,
              });
          }}
        >
          {list ? "Save" : "Create"}
        </Button>
      </div>
    </Modal>
  );
}
