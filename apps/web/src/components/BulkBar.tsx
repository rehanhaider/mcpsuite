/** Floating action bar for selected rows: stage, owner, tag, list, archive. */
import { Archive, ArrowRightLeft, Layers, Tags, UserRound, X } from "lucide-react";
import type { ContactListWithCounts, ListableType, Stage, Tag, User } from "@emcp/core/domain";
import { useOp } from "~/lib/api.ts";
import { dotClass } from "~/lib/colors.ts";
import { ButtonSpinner } from "./ui.tsx";
import { Button } from "~/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";

export function BulkBar(props: {
  entityType: ListableType;
  ids: string[];
  stages?: Stage[];
  tags: Array<Tag & { usage: number }>;
  lists?: ContactListWithCounts[];
  users: User[];
  onDone(): void;
}) {
  const done = { onSuccess: () => props.onDone() };
  const moveStage = useOp("bulk.updateStage", { successToast: "Moved", ...done });
  const assignOwner = useOp("bulk.assignOwner", { successToast: "Owner assigned", ...done });
  const addTag = useOp("bulk.addTag", { successToast: "Tagged", ...done });
  const addToList = useOp("list.addMembers", { successToast: "Added to list", ...done });
  const archive = useOp("bulk.archive", { successToast: "Archived", ...done });
  const busy = moveStage.isPending || assignOwner.isPending || addTag.isPending || addToList.isPending || archive.isPending;

  const stageable = props.entityType === "engagement" || props.entityType === "deal";
  const eligibleLists = (props.lists ?? []).filter((l) => l.entityType == null || l.entityType === props.entityType);

  return (
    <div className="sticky top-14 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-popover px-3 py-2 shadow-lg">
      <span className="text-sm">
        <span className="tnum font-mono font-semibold text-primary">{props.ids.length}</span> selected
      </span>
      <div className="mx-1 h-4 w-px bg-border" />

      {stageable && props.stages && props.stages.length > 0 ? (
        <PickMenu
          label="Stage"
          icon={<ArrowRightLeft className="size-3.5" />}
          disabled={busy}
          items={props.stages.map((s) => ({ id: s.id, label: s.name, dot: dotClass(s.color) }))}
          onPick={(stageId) => moveStage.mutate({ entityType: props.entityType, ids: props.ids, stageId })}
        />
      ) : null}

      <PickMenu
        label="Owner"
        icon={<UserRound className="size-3.5" />}
        disabled={busy}
        items={[{ id: "__none", label: "Unassigned" }, ...props.users.filter((u) => !u.disabledAt).map((u) => ({ id: u.id, label: u.name }))]}
        onPick={(ownerUserId) =>
          assignOwner.mutate({ entityType: props.entityType, ids: props.ids, ownerUserId: ownerUserId === "__none" ? null : ownerUserId })
        }
      />

      <PickMenu
        label="Tag"
        icon={<Tags className="size-3.5" />}
        disabled={busy}
        items={props.tags.map((t) => ({ id: t.id, label: t.name, dot: dotClass(t.color) }))}
        onPick={(tagId) => addTag.mutate({ entityType: props.entityType, ids: props.ids, tagId })}
      />

      {eligibleLists.length > 0 ? (
        <PickMenu
          label="List"
          icon={<Layers className="size-3.5" />}
          disabled={busy}
          items={eligibleLists.map((l) => ({ id: l.id, label: l.name, dot: dotClass(l.color) }))}
          onPick={(listId) => addToList.mutate({ listId, entityType: props.entityType, entityIds: props.ids })}
        />
      ) : null}

      <Button
        variant="ghost"
        size="xs"
        className="gap-1 text-warning hover:text-warning"
        disabled={busy}
        onClick={() => archive.mutate({ entityType: props.entityType, ids: props.ids })}
      >
        <Archive className="size-3.5" /> Archive
      </Button>

      <span className="grow" />
      {busy ? <ButtonSpinner /> : null}
      <Button variant="ghost" size="icon-xs" onClick={props.onDone} aria-label="Clear selection">
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

function PickMenu(props: {
  label: string;
  icon: React.ReactNode;
  items: Array<{ id: string; label: string; dot?: string }>;
  onPick(id: string): void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="xs" className="gap-1" disabled={props.disabled} />}>
        {props.icon} {props.label}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-64 w-52 overflow-y-auto">
        {props.items.length === 0 ? <div className="px-3 py-2 text-xs text-muted-foreground">Nothing available</div> : null}
        {props.items.map((item) => (
          <DropdownMenuItem key={item.id} onClick={() => props.onPick(item.id)}>
            {item.dot ? <span className={`size-2 rounded-full ${item.dot}`} /> : null}
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
