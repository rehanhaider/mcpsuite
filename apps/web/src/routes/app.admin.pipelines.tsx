import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  SEMANTIC_COLORS,
  type Pipeline,
  type SemanticColor,
  type Stage,
} from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { chipClass, dotClass } from "~/lib/colors.ts";
import { Field, Modal, SectionCard, Spinner } from "~/components/ui.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Input } from "~/components/ui/input.tsx";
import { NativeSelect as Select } from "~/components/ui/native-select";

export const Route = createFileRoute("/app/admin/pipelines")({
  component: PipelinesAdmin,
});

function PipelinesAdmin() {
  const pipelines = useQuery(opQuery<Pipeline[]>("pipeline.list"));
  const [createOpen, setCreateOpen] = useState(false);

  if (pipelines.isLoading) return <Spinner />;
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" className="gap-1" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" /> New pipeline
        </Button>
      </div>
      {(pipelines.data ?? []).map((p) => (
        <PipelineCard key={p.id} pipeline={p} />
      ))}
      <CreatePipelineModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}

function PipelineCard({ pipeline }: { pipeline: Pipeline }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(pipeline.name);
  const [addOpen, setAddOpen] = useState(false);
  const [editStage, setEditStage] = useState<Stage | null>(null);
  const rename = useOp("pipeline.rename", {
    successToast: "Renamed",
    onSuccess: () => setRenaming(false),
  });
  const setDefault = useOp("pipeline.setDefault", {
    successToast: "Default updated",
  });
  const del = useOp("pipeline.delete", { successToast: "Pipeline deleted" });
  const reorder = useOp("stage.reorder");

  function move(idx: number, dir: -1 | 1) {
    const ids = pipeline.stages.map((s) => s.id);
    const target = idx + dir;
    if (target < 0 || target >= ids.length) return;
    const a = ids[idx]!;
    ids[idx] = ids[target]!;
    ids[target] = a;
    reorder.mutate({ pipelineId: pipeline.id, stageIds: ids });
  }

  return (
    <SectionCard
      title={
        renaming ? (
          <span className="flex items-center gap-2">
            <Input
              className="h-6 w-48 text-xs"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim())
                  rename.mutate({ id: pipeline.id, name: name.trim() });
                if (e.key === "Escape") setRenaming(false);
              }}
            />
            <Button
              size="xs"
              onClick={() =>
                name.trim() &&
                rename.mutate({ id: pipeline.id, name: name.trim() })
              }
            >
              Save
            </Button>
          </span>
        ) : (
          <span className="flex items-center gap-2">
            {pipeline.name}
            <span className={`capitalize ${chipClass("ghost", "xs")}`}>
              {pipeline.type}
            </span>
            {pipeline.isDefault ? (
              <span className={chipClass("primary", "xs")}>default</span>
            ) : null}
          </span>
        )
      }
      actions={
        <div className="flex gap-1">
          {!pipeline.isDefault ? (
            <Button
              variant="ghost"
              size="xs"
              className="gap-1"
              title="Make default for this type"
              onClick={() => setDefault.mutate({ id: pipeline.id })}
            >
              <Star className="size-3.5" /> default
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setRenaming((r) => !r)}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-destructive"
            onClick={() => {
              if (
                confirm(
                  `Delete pipeline "${pipeline.name}"? Blocked if records reference it.`,
                )
              )
                del.mutate({ id: pipeline.id });
            }}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      }
    >
      <ul className="divide-y divide-border/60">
        {pipeline.stages.map((s, i) => (
          <li key={s.id} className="flex items-center gap-3 py-2">
            <span className={`size-2.5 rounded-full ${dotClass(s.color)}`} />
            <span className="min-w-0 flex-1 text-sm">
              {s.name}
              {s.outcome ? (
                <span className={`ml-2 capitalize ${chipClass("ghost", "xs")}`}>
                  {s.outcome}
                </span>
              ) : null}
              {s.probability != null ? (
                <span className="ml-2 font-mono text-xs text-muted-foreground/70">
                  {s.probability}%
                </span>
              ) : null}
            </span>
            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={i === pipeline.stages.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setEditStage(s)}
              >
                <Pencil className="size-3.5" />
              </Button>
              <DeleteStageButton stage={s} />
            </div>
          </li>
        ))}
      </ul>
      <Button
        variant="ghost"
        size="xs"
        className="mt-2 gap-1"
        onClick={() => setAddOpen(true)}
      >
        <Plus className="size-3.5" /> Add stage
      </Button>
      <AddStageModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        pipeline={pipeline}
      />
      {editStage ? (
        <EditStageModal
          stage={editStage}
          pipeline={pipeline}
          onClose={() => setEditStage(null)}
        />
      ) : null}
    </SectionCard>
  );
}

function DeleteStageButton({ stage }: { stage: Stage }) {
  const del = useOp("stage.delete", { successToast: "Stage deleted" });
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="text-destructive"
      onClick={() => {
        if (
          confirm(`Delete stage "${stage.name}"? Blocked if records sit in it.`)
        )
          del.mutate({ id: stage.id });
      }}
    >
      <Trash2 className="size-3.5" />
    </Button>
  );
}

function ColorPicker({
  value,
  onChange,
}: {
  value: SemanticColor;
  onChange(c: SemanticColor): void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {SEMANTIC_COLORS.map((c) => (
        <Button
          key={c}
          type="button"
          variant="ghost"
          size="icon-xs"
          title={c}
          className={`rounded-full border-2 hover:bg-transparent ${dotClass(c)} ${value === c ? "border-foreground" : "border-transparent opacity-60 hover:opacity-100"}`}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}

function StageFields(props: {
  isDeal: boolean;
  name: string;
  setName(v: string): void;
  color: SemanticColor;
  setColor(v: SemanticColor): void;
  probability: string;
  setProbability(v: string): void;
  outcome: string;
  setOutcome(v: string): void;
}) {
  return (
    <div className="space-y-3">
      <Field label="Name">
        <Input
          value={props.name}
          autoFocus
          onChange={(e) => props.setName(e.target.value)}
        />
      </Field>
      <Field label="Color">
        <ColorPicker value={props.color} onChange={props.setColor} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        {props.isDeal ? (
          <Field label="Probability %" hint="Default win chance">
            <Input
              type="number"
              min={0}
              max={100}
              value={props.probability}
              onChange={(e) => props.setProbability(e.target.value)}
            />
          </Field>
        ) : null}
        <Field label="Outcome" hint="Terminal stages only">
          <Select
            value={props.outcome}
            onChange={(e) => props.setOutcome(e.target.value)}
          >
            <option value="">none</option>
            {props.isDeal ? (
              <>
                <option value="won">won</option>
                <option value="lost">lost</option>
              </>
            ) : (
              <>
                <option value="done">done</option>
                <option value="dropped">dropped</option>
              </>
            )}
          </Select>
        </Field>
      </div>
    </div>
  );
}

function AddStageModal({
  open,
  onClose,
  pipeline,
}: {
  open: boolean;
  onClose(): void;
  pipeline: Pipeline;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<SemanticColor>("neutral");
  const [probability, setProbability] = useState("");
  const [outcome, setOutcome] = useState("");
  const add = useOp("stage.add", {
    successToast: "Stage added",
    onSuccess: onClose,
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Add stage to ${pipeline.name}`}
    >
      <StageFields
        isDeal={pipeline.type === "deal"}
        {...{
          name,
          setName,
          color,
          setColor,
          probability,
          setProbability,
          outcome,
          setOutcome,
        }}
      />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!name.trim() || add.isPending}
          onClick={() =>
            add.mutate({
              pipelineId: pipeline.id,
              name: name.trim(),
              color,
              probability: probability === "" ? null : Number(probability),
              outcome: outcome || null,
            })
          }
        >
          Add
        </Button>
      </div>
    </Modal>
  );
}

function EditStageModal({
  stage,
  pipeline,
  onClose,
}: {
  stage: Stage;
  pipeline: Pipeline;
  onClose(): void;
}) {
  const [name, setName] = useState(stage.name);
  const [color, setColor] = useState<SemanticColor>(stage.color);
  const [probability, setProbability] = useState(
    stage.probability == null ? "" : String(stage.probability),
  );
  const [outcome, setOutcome] = useState(stage.outcome ?? "");
  const update = useOp("stage.update", {
    successToast: "Stage updated",
    onSuccess: onClose,
  });
  return (
    <Modal open onClose={onClose} title={`Edit ${stage.name}`}>
      <StageFields
        isDeal={pipeline.type === "deal"}
        {...{
          name,
          setName,
          color,
          setColor,
          probability,
          setProbability,
          outcome,
          setOutcome,
        }}
      />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!name.trim() || update.isPending}
          onClick={() =>
            update.mutate({
              id: stage.id,
              name: name.trim(),
              color,
              probability: probability === "" ? null : Number(probability),
              outcome: outcome || null,
            })
          }
        >
          Save
        </Button>
      </div>
    </Modal>
  );
}

const STAGE_TEMPLATES: Record<
  string,
  Array<{
    name: string;
    color: SemanticColor;
    probability?: number;
    outcome?: string;
  }>
> = {
  engagement: [
    { name: "New", color: "neutral" },
    { name: "Contacted", color: "info" },
    { name: "Responded", color: "primary" },
    { name: "Engaged", color: "secondary" },
    { name: "Qualified", color: "success", outcome: "done" },
    { name: "Dropped", color: "error", outcome: "dropped" },
  ],
  deal: [
    { name: "Discovery", color: "info", probability: 20 },
    { name: "Proposal", color: "primary", probability: 45 },
    { name: "Negotiation", color: "secondary", probability: 70 },
    { name: "Won", color: "success", probability: 100, outcome: "won" },
    { name: "Lost", color: "error", probability: 0, outcome: "lost" },
  ],
};

function CreatePipelineModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose(): void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"engagement" | "deal">("engagement");
  const create = useOp("pipeline.create", {
    successToast: "Pipeline created",
    onSuccess: onClose,
  });
  return (
    <Modal open={open} onClose={onClose} title="New pipeline">
      <div className="space-y-3">
        <Field label="Name">
          <Input
            value={name}
            autoFocus
            placeholder="e.g. Partnerships"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="Type"
          hint="Starts from a sensible stage template you can edit after."
        >
          <div className="flex w-fit items-center rounded-lg border border-border p-0.5">
            {(["engagement", "deal"] as const).map((t) => (
              <Button
                key={t}
                variant={type === t ? "secondary" : "ghost"}
                size="sm"
                className="capitalize"
                onClick={() => setType(t)}
              >
                {t === "engagement" ? "Leads" : "Deals"}
              </Button>
            ))}
          </div>
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!name.trim() || create.isPending}
          onClick={() =>
            create.mutate({
              name: name.trim(),
              type,
              stages: STAGE_TEMPLATES[type],
            })
          }
        >
          Create
        </Button>
      </div>
    </Modal>
  );
}
