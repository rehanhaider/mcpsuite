/** Custom field editor card for a record; saves per field via customField.setValues. */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Settings2 } from "lucide-react";
import { useState } from "react";
import type { CustomFieldDef, CustomFieldValue } from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { useIsAdmin } from "~/lib/use-is-admin.ts";
import { SectionCard } from "./ui.tsx";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect as Select } from "~/components/ui/native-select";
import { Switch } from "~/components/ui/switch";
import { chipClass } from "~/lib/colors.ts";

export function CustomFieldsCard(props: {
  entityType: "company" | "person" | "engagement" | "deal" | "offering";
  entityId: string;
  values: Record<string, CustomFieldValue>;
}) {
  const isAdmin = useIsAdmin();
  const defs = useQuery(
    opQuery<CustomFieldDef[]>("customField.list", {
      entityType: props.entityType,
    }),
  );
  const setValues = useOp("customField.setValues");
  if (!defs.data || defs.data.length === 0) return null;

  return (
    <SectionCard
      title="Custom fields"
      actions={
        isAdmin ? (
          <Link
            to="/app/admin/fields"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Settings2 className="size-3" /> Manage fields
          </Link>
        ) : null
      }
    >
      <div className="space-y-2.5">
        {defs.data.map((def) => (
          <FieldEditor
            key={def.id}
            def={def}
            value={props.values[def.key] ?? null}
            onSave={(value) =>
              setValues.mutate({
                entityType: props.entityType,
                entityId: props.entityId,
                values: { [def.key]: value },
              })
            }
          />
        ))}
      </div>
    </SectionCard>
  );
}

function FieldEditor({
  def,
  value,
  onSave,
}: {
  def: CustomFieldDef;
  value: CustomFieldValue;
  onSave(value: CustomFieldValue): void;
}) {
  const [draft, setDraft] = useState<string>(
    value == null ? "" : Array.isArray(value) ? "" : String(value),
  );
  const label = (
    <span className="w-32 shrink-0 pt-1.5 text-xs text-muted-foreground">
      {def.label}
      {def.required ? <span className="text-destructive"> *</span> : null}
    </span>
  );

  switch (def.type) {
    case "boolean":
      return (
        <div className="flex items-start gap-2">
          {label}
          <Switch
            className="mt-1.5"
            checked={value === true}
            onCheckedChange={(checked) => onSave(checked)}
          />
        </div>
      );
    case "select":
      return (
        <div className="flex items-start gap-2">
          {label}
          <Select
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onSave(e.target.value || null)}
          >
            <option value="">—</option>
            {(def.options ?? []).map((o) => (
              <option key={o}>{o}</option>
            ))}
          </Select>
        </div>
      );
    case "multi_select": {
      const current = Array.isArray(value) ? value : [];
      return (
        <div className="flex items-start gap-2">
          {label}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {(def.options ?? []).map((o) => {
              const on = current.includes(o);
              return (
                <Button
                  key={o}
                  type="button"
                  variant="ghost"
                  size="xs"
                  className={`cursor-pointer ${chipClass(on ? "primary" : "ghost")}`}
                  onClick={() =>
                    onSave(
                      on ? current.filter((x) => x !== o) : [...current, o],
                    )
                  }
                >
                  {o}
                </Button>
              );
            })}
          </div>
        </div>
      );
    }
    case "date":
      return (
        <div className="flex items-start gap-2">
          {label}
          <Input
            type="date"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onSave(e.target.value || null)}
          />
        </div>
      );
    case "number":
      return (
        <div className="flex items-start gap-2">
          {label}
          <Input
            type="number"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft === "") return onSave(null);
              const n = Number(draft);
              if (Number.isFinite(n)) onSave(n);
            }}
          />
        </div>
      );
    default:
      // text / url / email
      return (
        <div className="flex items-start gap-2">
          {label}
          <Input
            type={def.type === "email" ? "email" : "text"}
            value={draft}
            placeholder="—"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              const v = draft.trim();
              if (v === (value ?? "")) return;
              onSave(v || null);
            }}
          />
        </div>
      );
  }
}
