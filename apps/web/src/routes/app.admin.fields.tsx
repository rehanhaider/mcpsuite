import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import {
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_TYPES_ENTITIES,
  type CustomFieldDef,
  type CustomFieldEntity,
  type CustomFieldType,
} from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { chipClass } from "~/lib/colors.ts";
import { EmptyState, Field, Modal, Spinner } from "~/components/ui.tsx";
import { TABLE_CLASS, TableShell } from "~/components/TableShell.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Checkbox } from "~/components/ui/checkbox.tsx";
import { Input } from "~/components/ui/input.tsx";
import { NativeSelect as Select } from "~/components/ui/native-select";
import { Switch } from "~/components/ui/switch.tsx";

export const Route = createFileRoute("/app/admin/fields")({
  component: FieldsAdmin,
});

function FieldsAdmin() {
  const [entity, setEntity] = useState<CustomFieldEntity>("company");
  const [showArchived, setShowArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [edit, setEdit] = useState<CustomFieldDef | null>(null);
  const defs = useQuery(
    opQuery<CustomFieldDef[]>("customField.list", {
      entityType: entity,
      includeArchived: showArchived,
    }),
  );
  const archive = useOp("customField.archive", {
    successToast: "Field archived",
  });
  const restore = useOp("customField.restore", {
    successToast: "Field restored",
  });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-lg border border-border p-0.5">
          {CUSTOM_FIELD_TYPES_ENTITIES.map((e) => (
            <Button
              key={e}
              variant={entity === e ? "secondary" : "ghost"}
              size="xs"
              className="capitalize"
              onClick={() => setEntity(e)}
            >
              {e}
            </Button>
          ))}
        </div>
        <label className="ml-2 flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Switch checked={showArchived} onCheckedChange={setShowArchived} />
          archived
        </label>
        <div className="grow" />
        <Button size="sm" className="gap-1" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" /> New field
        </Button>
      </div>

      {defs.isLoading ? (
        <Spinner />
      ) : (defs.data?.length ?? 0) === 0 ? (
        <EmptyState
          title={`No custom fields on ${entity} yet`}
          hint="Typed fields agents can read and write safely."
        />
      ) : (
        <TableShell>
          <table className={TABLE_CLASS}>
            <thead>
              <tr className="border-b border-border text-left text-xs tracking-wider uppercase text-muted-foreground/70">
                <th className="px-3 py-2 font-medium">Label</th>
                <th className="px-3 py-2 font-medium">Key</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Options</th>
                <th className="px-3 py-2 font-medium">Required</th>
                <th className="w-24 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {defs.data!.map((d) => (
                <tr
                  key={d.id}
                  className={`border-b border-border/60 last:border-0 ${d.archivedAt ? "opacity-50" : ""}`}
                >
                  <td className="px-3 py-2 font-medium">{d.label}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {d.key}
                  </td>
                  <td className="px-3 py-2">
                    <span className={chipClass("ghost", "xs")}>{d.type}</span>
                  </td>
                  <td className="max-w-48 truncate px-3 py-2 text-xs text-muted-foreground">
                    {d.options?.join(", ") ?? "—"}
                  </td>
                  <td className="px-3 py-2">{d.required ? "yes" : "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setEdit(d)}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      {d.archivedAt ? (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => restore.mutate({ id: d.id })}
                        >
                          <ArchiveRestore className="size-3.5" />
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => archive.mutate({ id: d.id })}
                        >
                          <Archive className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      )}

      <CreateFieldModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        entity={entity}
      />
      {edit ? (
        <EditFieldModal def={edit} onClose={() => setEdit(null)} />
      ) : null}
    </div>
  );
}

function CreateFieldModal({
  open,
  onClose,
  entity,
}: {
  open: boolean;
  onClose(): void;
  entity: CustomFieldEntity;
}) {
  const [label, setLabel] = useState("");
  const [type, setType] = useState<CustomFieldType>("text");
  const [options, setOptions] = useState("");
  const [required, setRequired] = useState(false);
  const create = useOp("customField.create", {
    successToast: "Field created",
    onSuccess: onClose,
  });
  const needsOptions = type === "select" || type === "multi_select";

  return (
    <Modal open={open} onClose={onClose} title={`New ${entity} field`}>
      <div className="space-y-3">
        <Field label="Label">
          <Input
            value={label}
            autoFocus
            placeholder="e.g. Deal size band"
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Field label="Type" hint="Immutable after creation.">
          <Select
            value={type}
            onChange={(e) => setType(e.target.value as CustomFieldType)}
          >
            {CUSTOM_FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        {needsOptions ? (
          <Field label="Options" hint="Comma-separated.">
            <Input
              value={options}
              placeholder="Small, Medium, Large"
              onChange={(e) => setOptions(e.target.value)}
            />
          </Field>
        ) : null}
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={required}
            onCheckedChange={(checked) => setRequired(checked === true)}
          />
          Required
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={
            !label.trim() ||
            create.isPending ||
            (needsOptions && !options.trim())
          }
          onClick={() =>
            create.mutate({
              entityType: entity,
              label: label.trim(),
              type,
              options: needsOptions
                ? options
                    .split(",")
                    .map((o) => o.trim())
                    .filter(Boolean)
                : null,
              required,
            })
          }
        >
          Create
        </Button>
      </div>
    </Modal>
  );
}

function EditFieldModal({
  def,
  onClose,
}: {
  def: CustomFieldDef;
  onClose(): void;
}) {
  const [label, setLabel] = useState(def.label);
  const [options, setOptions] = useState(def.options?.join(", ") ?? "");
  const [required, setRequired] = useState(def.required);
  const update = useOp("customField.update", {
    successToast: "Field updated",
    onSuccess: onClose,
  });
  const needsOptions = def.type === "select" || def.type === "multi_select";

  return (
    <Modal open onClose={onClose} title={`Edit ${def.label}`}>
      <div className="space-y-3">
        <Field label="Label">
          <Input
            value={label}
            autoFocus
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        {needsOptions ? (
          <Field
            label="Options"
            hint="Comma-separated. Removing options does not clear stored values."
          >
            <Input
              value={options}
              onChange={(e) => setOptions(e.target.value)}
            />
          </Field>
        ) : null}
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={required}
            onCheckedChange={(checked) => setRequired(checked === true)}
          />
          Required
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!label.trim() || update.isPending}
          onClick={() =>
            update.mutate({
              id: def.id,
              label: label.trim(),
              ...(needsOptions
                ? {
                    options: options
                      .split(",")
                      .map((o) => o.trim())
                      .filter(Boolean),
                  }
                : {}),
              required,
            })
          }
        >
          Save
        </Button>
      </div>
    </Modal>
  );
}
