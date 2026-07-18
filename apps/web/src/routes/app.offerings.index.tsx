/**
 * Offerings — the products/services/packages you pitch. Small catalog, so no
 * pagination: one table + create/edit modals. Links (where an offering is
 * attached) are shown inside the edit modal.
 */
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Package, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Offering, OfferingLink, OfferingType, User } from "@emcp/core/domain";
import { OFFERING_TYPES } from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { chipClass, type Tone } from "~/lib/colors.ts";
import { relativeTime } from "~/lib/format.ts";
import { OwnerSelect } from "~/components/pickers.tsx";
import { ButtonSpinner, EmptyState, Modal, PageHeader, Spinner } from "~/components/ui.tsx";
import { TABLE_CLASS, TableShell } from "~/components/TableShell.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Input } from "~/components/ui/input.tsx";
import { NativeSelect as Select } from "~/components/ui/native-select";
import { Switch } from "~/components/ui/switch.tsx";
import { Textarea } from "~/components/ui/textarea.tsx";

export const Route = createFileRoute("/app/offerings/")({
  component: OfferingsPage,
});

const TYPE_TONE: Record<OfferingType, Tone> = {
  product: "info",
  service: "primary",
  package: "secondary",
  other: "ghost",
};

function OfferingsPage() {
  const [showArchived, setShowArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Offering | null>(null);

  const offerings = useQuery(opQuery<Offering[]>("offering.list", { includeArchived: showArchived }));
  const users = useQuery(opQuery<User[]>("user.list"));
  const userName = (id: string | null) => users.data?.find((u) => u.id === id)?.name ?? null;

  const rows = offerings.data ?? [];

  return (
    <div>
      <PageHeader
        title="Offerings"
        subtitle={offerings.data ? `${rows.length} offering${rows.length === 1 ? "" : "s"}` : "…"}
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> New offering
          </Button>
        }
      />

      <div className="mb-3 flex items-center gap-2">
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Switch checked={showArchived} onCheckedChange={setShowArchived} />
          archived
        </label>
      </div>

      {offerings.isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title={showArchived ? "No offerings" : "No offerings yet"}
          hint="Offerings are what you sell — link them to leads and deals to track what you're pitching where."
          icon={<Package className="size-10 text-foreground/25" strokeWidth={1.25} />}
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" /> New offering
            </Button>
          }
        />
      ) : (
        <TableShell>
          <table className={TABLE_CLASS}>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Offering</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr
                  key={o.id}
                  className={`cursor-pointer border-b border-border/60 last:border-0 hover:bg-accent/40 ${o.archivedAt ? "opacity-50" : ""}`}
                  onClick={() => setEditing(o)}
                >
                  <td className="max-w-80 px-3 py-2">
                    <p className="truncate font-medium">{o.name}</p>
                    {o.description ? <p className="truncate text-xs text-muted-foreground/70">{o.description}</p> : null}
                  </td>
                  <td className="px-3 py-2">
                    <span className={chipClass(TYPE_TONE[o.type])}>{o.type}</span>
                  </td>
                  <td className="px-3 py-2">
                    {o.archivedAt ? (
                      <span className={chipClass("ghost")}>archived</span>
                    ) : o.active ? (
                      <span className={chipClass("success")}>active</span>
                    ) : (
                      <span className={chipClass("ghost")}>inactive</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{userName(o.ownerUserId) ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{relativeTime(o.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      )}

      <OfferingModal open={createOpen} offering={null} onClose={() => setCreateOpen(false)} />
      <OfferingModal open={editing !== null} offering={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

/** Create when `offering` is null, otherwise edit (with links + lifecycle actions). */
function OfferingModal({ open, offering, onClose }: { open: boolean; offering: Offering | null; onClose(): void }) {
  return (
    <Modal open={open} onClose={onClose} title={offering ? `Edit ${offering.name}` : "New offering"}>
      {open ? <OfferingForm offering={offering} onClose={onClose} /> : null}
    </Modal>
  );
}

function OfferingForm({ offering, onClose }: { offering: Offering | null; onClose(): void }) {
  const [name, setName] = useState(offering?.name ?? "");
  const [type, setType] = useState<OfferingType>(offering?.type ?? "service");
  const [description, setDescription] = useState(offering?.description ?? "");
  const [active, setActive] = useState(offering?.active ?? true);
  const [owner, setOwner] = useState<string | null>(offering?.ownerUserId ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const detail = useQuery({
    ...opQuery<Offering & { links: OfferingLink[] }>("offering.get", { id: offering?.id }),
    enabled: offering !== null,
  });

  const create = useOp("offering.create", { successToast: "Offering created", onSuccess: onClose });
  const update = useOp("offering.update", { successToast: "Offering updated", onSuccess: onClose });
  const archive = useOp("offering.archive", { successToast: "Offering archived", onSuccess: onClose });
  const restore = useOp("offering.restore", { successToast: "Offering restored", onSuccess: onClose });
  const del = useOp("offering.delete", { successToast: "Offering deleted", onSuccess: onClose });

  const busy = create.isPending || update.isPending || archive.isPending || restore.isPending || del.isPending;
  const links = detail.data?.links ?? [];

  const submit = () => {
    const fields = {
      name: name.trim(),
      type,
      description: description.trim() || null,
      active,
      ownerUserId: owner,
    };
    if (offering) update.mutate({ id: offering.id, expectedVersion: detail.data?.version ?? offering.version, ...fields });
    else create.mutate(fields);
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[1fr_140px] gap-3">
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">Name *</span>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">Type</span>
          <Select value={type} onChange={(e) => setType(e.target.value as OfferingType)}>
            {OFFERING_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-xs text-muted-foreground">Description</span>
        <Textarea className="min-h-20" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="grid grid-cols-2 items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">Owner</span>
          <OwnerSelect value={owner} onChange={setOwner} />
        </label>
        <label className="flex cursor-pointer items-center gap-2 pb-1.5 text-sm">
          <Switch checked={active} onCheckedChange={setActive} />
          <span className="text-xs text-muted-foreground">Actively offered</span>
        </label>
      </div>

      {offering ? (
        <div className="rounded-lg border border-border bg-background/50 px-3 py-2">
          <p className="pb-1 text-xs font-medium text-muted-foreground">
            Linked to {detail.isLoading ? "…" : `${links.length} record${links.length === 1 ? "" : "s"}`}
          </p>
          {links.length > 0 ? (
            <ul className="max-h-32 space-y-1 overflow-y-auto">
              {links.map((l) => (
                <li key={l.id} className="flex items-center gap-2 text-xs">
                  <span className={chipClass("ghost", "xs")}>{l.entityType === "engagement" ? "lead" : "deal"}</span>
                  <Link
                    to={l.entityType === "engagement" ? "/app/leads/$id" : "/app/deals/$id"}
                    params={{ id: l.entityId }}
                    className="text-cyan hover:underline"
                    onClick={onClose}
                  >
                    open record
                  </Link>
                  {l.isPrimary ? <span className={chipClass("primary", "xs")}>primary</span> : null}
                  {l.fit ? <span className="truncate text-muted-foreground">fit: {l.fit}</span> : null}
                </li>
              ))}
            </ul>
          ) : detail.isLoading ? null : (
            <p className="text-xs text-muted-foreground/70">Not linked to any lead or deal yet.</p>
          )}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 pt-2">
        <div className="flex items-center gap-1">
          {offering && !offering.archivedAt ? (
            <Button variant="ghost" size="xs" className="gap-1 text-muted-foreground" disabled={busy} onClick={() => archive.mutate({ id: offering.id })}>
              <Archive className="size-3.5" /> Archive
            </Button>
          ) : null}
          {offering?.archivedAt ? (
            <>
              <Button
                variant="ghost"
                size="xs"
                className="gap-1 text-muted-foreground"
                disabled={busy}
                onClick={() => restore.mutate({ id: offering.id })}
              >
                <ArchiveRestore className="size-3.5" /> Restore
              </Button>
              {confirmDelete ? (
                <Button variant="destructive" size="xs" className="gap-1" disabled={busy} onClick={() => del.mutate({ id: offering.id })}>
                  <Trash2 className="size-3.5" /> Really delete?
                </Button>
              ) : (
                <Button variant="ghost" size="xs" className="gap-1 text-destructive/70" disabled={busy} onClick={() => setConfirmDelete(true)}>
                  <Trash2 className="size-3.5" /> Delete
                </Button>
              )}
            </>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy || !name.trim()} onClick={submit}>
            {busy ? <ButtonSpinner /> : null}
            {offering ? "Save" : "Create"}
          </Button>
        </div>
      </div>
    </div>
  );
}
