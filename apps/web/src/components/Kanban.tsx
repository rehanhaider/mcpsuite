/** Minimal HTML5 drag-and-drop board keyed by stage. Used by Leads and Deals. */
import { useState, type ReactNode } from "react";
import type { Stage } from "@emcp/core/domain";
import { dotClass } from "~/lib/colors.ts";

export interface KanbanCard {
  id: string;
  stageId: string;
  node: ReactNode;
}

export function Kanban(props: {
  stages: Stage[];
  cards: KanbanCard[];
  onMove(cardId: string, toStageId: string): void;
  /** Total per stage when the card list is truncated. */
  totals?: Record<string, number>;
  columnFooter?(stage: Stage): ReactNode;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);

  return (
    <div className="flex gap-3 overflow-x-auto pb-3">
      {props.stages.map((stage) => {
        const cards = props.cards.filter((c) => c.stageId === stage.id);
        const total = props.totals?.[stage.id] ?? cards.length;
        return (
          <div
            key={stage.id}
            className={`flex w-64 shrink-0 flex-col rounded-xl border bg-card transition-colors ${
              overStage === stage.id && dragId ? "border-primary/60 bg-primary/5" : "border-border"
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setOverStage(stage.id);
            }}
            onDragLeave={() => setOverStage((s) => (s === stage.id ? null : s))}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/plain") || dragId;
              setOverStage(null);
              setDragId(null);
              if (id) props.onMove(id, stage.id);
            }}
          >
            <div className="flex items-center gap-2 px-3 py-2.5">
              <span className={`size-2 rounded-full ${dotClass(stage.color)}`} />
              <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">{stage.name}</span>
              <span className="tnum ml-auto font-mono text-xs text-muted-foreground/70">{total}</span>
            </div>
            <div className="scroll-fade-y flex max-h-[65vh] min-h-16 flex-col gap-2 overflow-y-auto px-2 pb-2">
              {cards.map((card) => (
                <div
                  key={card.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", card.id);
                    e.dataTransfer.effectAllowed = "move";
                    setDragId(card.id);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setOverStage(null);
                  }}
                  className={`cursor-grab active:cursor-grabbing ${dragId === card.id ? "opacity-40" : ""}`}
                >
                  {card.node}
                </div>
              ))}
              {cards.length === 0 ? (
                <div className="flex h-16 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground/60">
                  empty
                </div>
              ) : null}
              {total > cards.length ? <p className="px-1 text-center text-[11px] text-muted-foreground/70">+{total - cards.length} more</p> : null}
            </div>
            {props.columnFooter ? <div className="border-t border-border/70 px-2 py-1.5">{props.columnFooter(stage)}</div> : null}
          </div>
        );
      })}
    </div>
  );
}
