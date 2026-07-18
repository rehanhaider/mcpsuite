import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  SEMANTIC_COLORS,
  type SemanticColor,
  type Tag,
} from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { chipClass, dotClass } from "~/lib/colors.ts";
import { EmptyState, Modal, Spinner } from "~/components/ui.tsx";
import { TABLE_CLASS, TableShell } from "~/components/TableShell.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Input } from "~/components/ui/input.tsx";

export const Route = createFileRoute("/app/admin/tags")({
  component: TagsAdmin,
});

type TagWithUsage = Tag & { usage: number };

function TagsAdmin() {
  const tags = useQuery(opQuery<TagWithUsage[]>("tag.list"));
  const [edit, setEdit] = useState<TagWithUsage | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const del = useOp("tag.delete", { successToast: "Tag deleted" });

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button size="sm" className="gap-1" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" /> New tag
        </Button>
      </div>
      {tags.isLoading ? (
        <Spinner />
      ) : (tags.data?.length ?? 0) === 0 ? (
        <EmptyState
          title="No tags yet"
          hint="Tags are loose labels for grouping companies, people, leads and deals."
        />
      ) : (
        <TableShell>
          <table className={TABLE_CLASS}>
            <thead>
              <tr className="border-b border-border text-left text-xs tracking-wider uppercase text-muted-foreground/70">
                <th className="px-3 py-2 font-medium">Tag</th>
                <th className="px-3 py-2 font-medium">Used on</th>
                <th className="w-24 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {tags.data!.map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-border/60 last:border-0"
                >
                  <td className="px-3 py-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className={chipClass(t.color)}
                      onClick={() => setEdit(t)}
                    >
                      {t.name}
                    </Button>
                  </td>
                  <td className="px-3 py-2 text-sm text-muted-foreground">
                    {t.usage} records
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="text-destructive"
                        onClick={() => {
                          if (
                            confirm(
                              `Delete tag "${t.name}"? It will be removed from ${t.usage} records.`,
                            )
                          )
                            del.mutate({ id: t.id });
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
      <TagModal open={createOpen} onClose={() => setCreateOpen(false)} />
      {edit ? <TagModal open onClose={() => setEdit(null)} tag={edit} /> : null}
    </div>
  );
}

function TagModal({
  open,
  onClose,
  tag,
}: {
  open: boolean;
  onClose(): void;
  tag?: TagWithUsage;
}) {
  const [name, setName] = useState(tag?.name ?? "");
  const [color, setColor] = useState<SemanticColor>(tag?.color ?? "neutral");
  const create = useOp("tag.create", {
    successToast: "Tag created",
    onSuccess: onClose,
  });
  const update = useOp("tag.update", {
    successToast: "Tag updated",
    onSuccess: onClose,
  });
  const pending = create.isPending || update.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tag ? `Edit ${tag.name}` : "New tag"}
    >
      <div className="space-y-3">
        <Input
          value={name}
          autoFocus
          placeholder="Tag name"
          onChange={(e) => setName(e.target.value)}
        />
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
            if (tag) update.mutate({ id: tag.id, name: name.trim(), color });
            else create.mutate({ name: name.trim(), color });
          }}
        >
          {tag ? "Save" : "Create"}
        </Button>
      </div>
    </Modal>
  );
}
