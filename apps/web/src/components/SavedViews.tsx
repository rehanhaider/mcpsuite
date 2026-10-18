/**
 * Saved views on list pages: rerun, save, share, and delete filter presets.
 * A view stores the list operation's filter shape; the page keeps its filters
 * in URL search params, so the helpers below translate between the two.
 */
import { useQuery } from "@tanstack/react-query";
import { Bookmark, Check, Lock, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { SavedView, SavedViewEntity } from "@mcpsuite/core/domain";
import { canManageSavedView, roleAtLeast } from "@mcpsuite/core/policy";
import { opQuery, useOp } from "~/lib/api.ts";
import { chipClass } from "~/lib/colors.ts";
import { whoamiQuery } from "~/routes/__root.tsx";
import { ButtonSpinner } from "~/components/ui.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Input } from "~/components/ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover.tsx";
import { Switch } from "~/components/ui/switch.tsx";

/** URL search keys whose list-filter name differs. */
const URL_TO_FILTER: Record<string, string> = { q: "search", archived: "includeArchived" };
const FILTER_TO_URL = Object.fromEntries(Object.entries(URL_TO_FILTER).map(([url, filter]) => [filter, url]));
/** Paging belongs to the page, not the view. */
const PAGING_KEYS = new Set(["limit", "offset"]);

const isEmpty = (value: unknown) =>
  value === undefined || value === null || value === "" || value === false || (Array.isArray(value) && value.length === 0);

/** The page's current URL filters as a list-operation filter. */
export function searchToFilters(search: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  for (const key of keys) {
    if (!isEmpty(search[key])) filters[URL_TO_FILTER[key] ?? key] = search[key];
  }
  return filters;
}

/**
 * A view's filters as URL search params for the page. Every page key is set,
 * so applying a view clears filters it does not name. `unsupported` lists
 * filters the page has no control for; such a view cannot run here faithfully.
 */
export function filtersToSearch(
  filters: Record<string, unknown>,
  keys: readonly string[],
): { search: Record<string, unknown>; unsupported: string[] } {
  const search: Record<string, unknown> = Object.fromEntries(keys.map((key) => [key, undefined]));
  const unsupported: string[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (PAGING_KEYS.has(key) || isEmpty(value)) continue;
    const urlKey = FILTER_TO_URL[key] ?? key;
    if (keys.includes(urlKey)) search[urlKey] = value;
    else unsupported.push(key);
  }
  return { search, unsupported };
}

const canonical = (filters: Record<string, unknown>) =>
  JSON.stringify(Object.keys(filters).sort().map((key) => [key, filters[key]]));

export function SavedViewsMenu(props: {
  entityType: SavedViewEntity;
  /** The page's validated URL search state. */
  search: Record<string, unknown>;
  /** URL search keys this page treats as filters (sort and dir included). */
  keys: readonly string[];
  onApply(search: Record<string, unknown>): void;
}) {
  const auth = useQuery(whoamiQuery).data;
  const views = useQuery(opQuery<SavedView[]>("savedView.list"));
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);

  const create = useOp<Record<string, unknown>, SavedView>("savedView.create", {
    successToast: "View saved",
    onSuccess: () => {
      setName("");
      setShared(false);
    },
  });
  const update = useOp<{ id: string; visibility: "private" | "shared" }, SavedView>("savedView.update", {
    onSuccess: (view) =>
      toast.success(view.visibility === "shared" ? `"${view.name}" is shared with the workspace` : `"${view.name}" is private`),
  });
  const remove = useOp<{ id: string }>("savedView.delete", { successToast: "View deleted" });

  const current = searchToFilters(props.search, props.keys);
  const currentKey = canonical(current);
  const rows = (views.data ?? [])
    .filter((view) => view.entityType === props.entityType)
    .map((view) => {
      const { search, unsupported } = filtersToSearch(view.filters, props.keys);
      const active = unsupported.length === 0 && canonical(searchToFilters(search, props.keys)) === currentKey;
      return { view, search, unsupported, active };
    });
  const activeRow = rows.find((row) => row.active);
  const canSave = !!auth && roleAtLeast(auth.role, "member");
  const canManage = (view: SavedView) => !!auth && canManageSavedView({ role: auth.role, userId: auth.user.id }, view);

  const save = () => {
    if (!name.trim()) return;
    create.mutate({ name: name.trim(), entityType: props.entityType, filters: current, visibility: shared ? "shared" : "private" });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" className="max-w-56" />}>
        <Bookmark className="size-3.5" />
        <span className="truncate">{activeRow ? activeRow.view.name : "Views"}</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <p className="px-1 text-xs font-medium text-muted-foreground">Saved views</p>
        {views.isLoading ? (
          <p className="px-1 text-xs text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">No saved views yet. Set filters, then save them below.</p>
        ) : (
          <ul className="-mx-1 max-h-72 space-y-0.5 overflow-y-auto">
            {rows.map(({ view, search, unsupported, active }) => (
              <li key={view.id} className="flex items-center gap-1 rounded-md pr-1 hover:bg-muted has-focus-visible:bg-muted">
                <button
                  type="button"
                  disabled={unsupported.length > 0}
                  title={unsupported.length > 0 ? `Uses filters this page cannot show: ${unsupported.join(", ")}` : undefined}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => {
                    props.onApply(search);
                    setOpen(false);
                  }}
                >
                  <Check className={`size-3.5 shrink-0 ${active ? "" : "invisible"}`} />
                  <span className="truncate">{view.name}</span>
                  {view.visibility !== "private" ? (
                    <span className={chipClass("ghost", "xs")}>{view.visibility}</span>
                  ) : null}
                </button>
                {canManage(view) ? (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground"
                      aria-label={view.visibility === "shared" ? `Make "${view.name}" private` : `Share "${view.name}" with the workspace`}
                      title={view.visibility === "shared" ? "Make private" : "Share with the workspace"}
                      disabled={update.isPending}
                      onClick={() => update.mutate({ id: view.id, visibility: view.visibility === "shared" ? "private" : "shared" })}
                    >
                      {view.visibility === "shared" ? <Lock /> : <Users />}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Delete "${view.name}"`}
                      title="Delete"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (confirm(`Delete the saved view "${view.name}"?`)) remove.mutate({ id: view.id });
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canSave ? (
          <form
            className="space-y-2 border-t border-border pt-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <p className="px-1 text-xs font-medium text-muted-foreground">Save current filters</p>
            <Input placeholder="View name" aria-label="View name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            <div className="flex items-center justify-between gap-2">
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <Switch checked={shared} onCheckedChange={setShared} />
                Share with the workspace
              </label>
              <Button type="submit" size="sm" disabled={create.isPending || !name.trim()}>
                {create.isPending ? <ButtonSpinner /> : null}
                Save view
              </Button>
            </div>
          </form>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
