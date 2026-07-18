/** Entity pickers: async combobox over list ops + owner select + tag/list chips. */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Check,
  ChevronsUpDown,
  Layers,
  Plus,
  Settings2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Company,
  ContactList,
  ContactListWithCounts,
  EngagementListItem,
  DealListItem,
  ListableType,
  Offering,
  OfferingLink,
  Person,
  Tag,
  User,
} from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { chipClass, dotClass } from "~/lib/colors.ts";
import { useIsAdmin } from "~/lib/use-is-admin.ts";
import type { Page } from "@emcp/core/domain";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { NativeSelect as Select } from "~/components/ui/native-select";

interface PickerOption {
  id: string;
  label: string;
  sublabel?: string | null;
}

function useDebounced(value: string, ms = 200): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Generic async combobox. Value is an id (or null). */
export function EntityPicker(props: {
  value: string | null;
  onChange(id: string | null): void;
  /** Fetch options for a search term. */
  useOptions(search: string): { options: PickerOption[]; loading: boolean };
  placeholder: string;
  /** Resolve the label of the current value (when not in options). */
  currentLabel?: string | null;
  allowClear?: boolean;
  onCreate?(name: string): void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const { options, loading } = props.useOptions(search);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const selected = options.find((o) => o.id === props.value);
  const display = selected?.label ?? props.currentLabel ?? null;

  return (
    <div className="relative" ref={rootRef}>
      <Button
        type="button"
        variant="outline"
        disabled={props.disabled}
        className={`w-full justify-between bg-transparent px-2.5 text-left font-normal dark:bg-input/20 ${props.allowClear && props.value ? "pr-14" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`truncate ${display ? "" : "text-muted-foreground"}`}>
          {display ?? props.placeholder}
        </span>
        <ChevronsUpDown className="size-3.5 text-muted-foreground" />
      </Button>
      {props.allowClear && props.value ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={props.disabled}
          className="absolute top-1 right-7 z-10 text-muted-foreground hover:bg-transparent hover:text-foreground"
          aria-label="Clear selection"
          onClick={() => props.onChange(null)}
        >
          <X className="size-3.5" />
        </Button>
      ) : null}
      {open ? (
        <div className="animate-pop absolute z-30 mt-1 w-full min-w-56 rounded-xl border border-border bg-popover shadow-xl">
          <Input
            autoFocus
            className="h-auto rounded-none border-x-0 border-t-0 bg-transparent px-3 py-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "Enter") {
                e.preventDefault();
                const first = options[0];
                if (first) {
                  props.onChange(first.id);
                  setOpen(false);
                }
              }
            }}
          />
          <ul className="max-h-64 overflow-y-auto p-1">
            {loading ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">
                Searching…
              </li>
            ) : options.length === 0 ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">
                No matches
              </li>
            ) : (
              options.map((o) => (
                <li key={o.id}>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-auto w-full justify-between px-2.5 py-1.5 text-left"
                    onClick={() => {
                      props.onChange(o.id);
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{o.label}</span>
                      {o.sublabel ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {o.sublabel}
                        </span>
                      ) : null}
                    </span>
                    {o.id === props.value ? (
                      <Check className="size-3.5 text-primary" />
                    ) : null}
                  </Button>
                </li>
              ))
            )}
            {props.onCreate && search.trim() ? (
              <li className="border-t border-border/60 pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-start gap-1.5 px-2.5 py-1.5 text-left text-primary"
                  onClick={() => {
                    props.onCreate?.(search.trim());
                    setOpen(false);
                  }}
                >
                  <Plus className="size-3.5" /> Create “{search.trim()}”
                </Button>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function useCompanyOptions(search: string) {
  const q = useDebounced(search);
  const query = useQuery(
    opQuery<Page<Company>>("company.list", {
      search: q || undefined,
      limit: 20,
      sort: "name",
      dir: "asc",
    }),
  );
  return {
    options: (query.data?.items ?? []).map((c) => ({
      id: c.id,
      label: c.name,
      sublabel: c.industry,
    })),
    loading: query.isLoading,
  };
}

export function usePersonOptions(search: string, companyId?: string | null) {
  const q = useDebounced(search);
  const query = useQuery(
    opQuery<Page<Person>>("person.list", {
      search: q || undefined,
      companyId: companyId || undefined,
      limit: 20,
      sort: "name",
      dir: "asc",
    }),
  );
  return {
    options: (query.data?.items ?? []).map((p) => ({
      id: p.id,
      label: p.name,
      sublabel: p.title,
    })),
    loading: query.isLoading,
  };
}

export function useEngagementOptions(search: string) {
  const q = useDebounced(search);
  const query = useQuery(
    opQuery<Page<EngagementListItem>>("engagement.list", {
      search: q || undefined,
      limit: 20,
      sort: "updatedAt",
      dir: "desc",
    }),
  );
  return {
    options: (query.data?.items ?? []).map((e) => ({
      id: e.id,
      label: e.title,
      sublabel: e.companyName,
    })),
    loading: query.isLoading,
  };
}

export function useDealOptions(search: string) {
  const q = useDebounced(search);
  const query = useQuery(
    opQuery<Page<DealListItem>>("deal.list", {
      search: q || undefined,
      limit: 20,
      sort: "updatedAt",
      dir: "desc",
    }),
  );
  return {
    options: (query.data?.items ?? []).map((d) => ({
      id: d.id,
      label: d.title,
      sublabel: d.companyName,
    })),
    loading: query.isLoading,
  };
}

export function OwnerSelect(props: {
  value: string | null;
  onChange(v: string | null): void;
  allowNone?: boolean;
}) {
  const users = useQuery(opQuery<User[]>("user.list"));
  return (
    <Select
      value={props.value ?? ""}
      onChange={(e) => props.onChange(e.target.value || null)}
    >
      <option value="">
        {props.allowNone === false ? "Select owner…" : "Unassigned"}
      </option>
      {(users.data ?? [])
        .filter((u) => !u.disabledAt)
        .map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
    </Select>
  );
}

/** Tag chips with inline add/remove for one entity. */
export function TagChips(props: {
  entityType: "company" | "person" | "engagement" | "deal";
  entityId: string;
  tags: Tag[];
}) {
  const [adding, setAdding] = useState(false);
  const isAdmin = useIsAdmin();
  const allTags = useQuery({
    ...opQuery<Array<Tag & { usage: number }>>("tag.list"),
    enabled: adding,
  });
  const apply = useOp("tag.apply");
  const removeTag = useOp("tag.remove");
  const createTag = useOp<{ name: string }, Tag>("tag.create", {
    onSuccess: (tag) =>
      apply.mutate({
        tagId: tag.id,
        entityType: props.entityType,
        entityId: props.entityId,
      }),
  });
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!adding) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setAdding(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [adding]);

  const attached = new Set(props.tags.map((t) => t.id));
  const candidates = useMemo(
    () =>
      (allTags.data ?? [])
        .filter((t) => !attached.has(t.id))
        .filter((t) => t.name.toLowerCase().includes(search.toLowerCase()))
        .slice(0, 12),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allTags.data, search, props.tags],
  );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {props.tags.map((tag) => (
        <span key={tag.id} className={chipClass(tag.color)}>
          {tag.name}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-4 rounded-full opacity-60 hover:bg-transparent hover:opacity-100"
            aria-label={`Remove ${tag.name}`}
            onClick={() =>
              removeTag.mutate({
                tagId: tag.id,
                entityType: props.entityType,
                entityId: props.entityId,
              })
            }
          >
            <X className="size-2.5" />
          </Button>
        </span>
      ))}
      <div className="relative" ref={rootRef}>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-5 rounded-full px-1.5"
          onClick={() => setAdding((a) => !a)}
        >
          <Plus className="size-3" /> tag
        </Button>
        {adding ? (
          <div className="animate-pop absolute left-0 z-30 mt-1 w-52 rounded-xl border border-border bg-popover shadow-xl">
            <Input
              autoFocus
              className="h-auto rounded-none border-x-0 border-t-0 bg-transparent px-3 py-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
              placeholder="Add tag…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setAdding(false);
                if (e.key === "Enter" && search.trim()) {
                  e.preventDefault();
                  const exact = candidates.find(
                    (t) => t.name.toLowerCase() === search.trim().toLowerCase(),
                  );
                  if (exact)
                    apply.mutate({
                      tagId: exact.id,
                      entityType: props.entityType,
                      entityId: props.entityId,
                    });
                  else createTag.mutate({ name: search.trim() });
                  setSearch("");
                  setAdding(false);
                }
              }}
            />
            <ul className="max-h-48 overflow-y-auto p-1">
              {candidates.map((t) => (
                <li key={t.id}>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-auto w-full justify-start gap-2 px-2.5 py-1.5 text-left"
                    onClick={() => {
                      apply.mutate({
                        tagId: t.id,
                        entityType: props.entityType,
                        entityId: props.entityId,
                      });
                      setAdding(false);
                      setSearch("");
                    }}
                  >
                    <span
                      className={`size-2 rounded-full ${dotClass(t.color)}`}
                    />
                    {t.name}
                  </Button>
                </li>
              ))}
              {search.trim() &&
              !candidates.some(
                (t) => t.name.toLowerCase() === search.trim().toLowerCase(),
              ) ? (
                <li>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-auto w-full justify-start gap-1.5 px-2.5 py-1.5 text-left text-primary"
                    onClick={() => {
                      createTag.mutate({ name: search.trim() });
                      setAdding(false);
                      setSearch("");
                    }}
                  >
                    <Plus className="size-3" /> Create “{search.trim()}”
                  </Button>
                </li>
              ) : null}
              {isAdmin ? (
                <li className="border-t border-border/60 pt-1">
                  <Link
                    to="/app/admin/tags"
                    className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <Settings2 className="size-3" /> Manage tags
                  </Link>
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * List-membership hooks + panel, shared by every "put this contact on a list"
 * surface: detail-page chips, table cells and (via its own markup) the bulk
 * bar. The panel toggles membership — attached lists show a check and click
 * off — and can create a list inline. It stays open for multi-toggling;
 * Escape/outside closes.
 */
function useListMembership(entityType: ListableType, entityId: string) {
  const add = useOp("list.addMembers");
  const remove = useOp("list.removeMembers");
  const createList = useOp<
    { name: string; entityType?: ListableType },
    ContactList
  >("list.create", {
    onSuccess: (list) =>
      add.mutate({ listId: list.id, entityType, entityIds: [entityId] }),
  });
  return {
    toggle: (list: ContactList, isAttached: boolean) => {
      const input = { listId: list.id, entityType, entityIds: [entityId] };
      if (isAttached) remove.mutate(input);
      else add.mutate(input);
    },
    create: (name: string) => createList.mutate({ name, entityType }),
    detach: (list: ContactList) =>
      remove.mutate({ listId: list.id, entityType, entityIds: [entityId] }),
  };
}

function listMemberCount(l: ContactListWithCounts): number {
  return l.people + l.companies + l.engagements + l.deals;
}

export function ListPanel(props: {
  surfaceType: ListableType;
  attachedIds: ReadonlySet<string>;
  onToggle(list: ContactList, isAttached: boolean): void;
  onCreate(name: string): void;
}) {
  const all = useQuery(opQuery<ContactListWithCounts[]>("list.list"));
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (all.data ?? [])
      .filter((l) => l.entityType == null || l.entityType === props.surfaceType)
      .filter((l) => l.name.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          Number(props.attachedIds.has(b.id)) -
            Number(props.attachedIds.has(a.id)) || a.name.localeCompare(b.name),
      )
      .slice(0, 12);
  }, [all.data, search, props.attachedIds, props.surfaceType]);

  const exactMatch = rows.some(
    (l) => l.name.toLowerCase() === search.trim().toLowerCase(),
  );

  return (
    <div className="w-60">
      <Input
        autoFocus
        className="h-auto rounded-none border-x-0 border-t-0 bg-transparent px-3 py-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
        placeholder="Add to list…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && search.trim()) {
            e.preventDefault();
            const first = rows[0];
            if (first && exactMatch)
              props.onToggle(first, props.attachedIds.has(first.id));
            else props.onCreate(search.trim());
            setSearch("");
          }
        }}
      />
      <ul className="max-h-56 overflow-y-auto p-1">
        {all.isLoading ? (
          <li className="px-2.5 py-2 text-xs text-muted-foreground">
            Loading…
          </li>
        ) : rows.length === 0 && !search.trim() ? (
          <li className="px-2.5 py-2 text-xs text-muted-foreground">
            No lists yet — type a name to create one.
          </li>
        ) : (
          rows.map((l) => {
            const attached = props.attachedIds.has(l.id);
            return (
              <li key={l.id}>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-start gap-2 px-2.5 py-1.5 text-left"
                  onClick={() => props.onToggle(l, attached)}
                >
                  <span
                    className={`size-2 shrink-0 rounded-full ${dotClass(l.color)}`}
                  />
                  <span className="min-w-0 truncate">{l.name}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground tnum">
                      {listMemberCount(l)}
                    </span>
                    {attached ? (
                      <Check className="size-3.5 text-primary" />
                    ) : null}
                  </span>
                </Button>
              </li>
            );
          })
        )}
        {search.trim() && !exactMatch ? (
          <li>
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-start gap-1.5 px-2.5 py-1.5 text-left text-primary"
              onClick={() => {
                props.onCreate(search.trim());
                setSearch("");
              }}
            >
              <Plus className="size-3" /> Create “{search.trim()}”
            </Button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/**
 * Contact-list chips with inline add/remove for one contact (detail pages).
 * Lists carry a Layers glyph so segments read differently from loose tags.
 */
export function ListChips(props: {
  entityType: ListableType;
  entityId: string;
  lists: ContactList[];
}) {
  const membership = useListMembership(props.entityType, props.entityId);
  const attachedIds = new Set(props.lists.map((l) => l.id));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {props.lists.map((list) => (
        <span key={list.id} className={chipClass(list.color)}>
          <Layers className="size-2.5 opacity-70" />
          {list.name}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-4 rounded-full opacity-60 hover:bg-transparent hover:opacity-100"
            aria-label={`Remove from ${list.name}`}
            onClick={() => membership.detach(list)}
          >
            <X className="size-2.5" />
          </Button>
        </span>
      ))}
      <Popover>
        <PopoverTrigger className="inline-flex h-5 cursor-pointer items-center gap-1 rounded-full px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
          <Plus className="size-3" /> list
        </PopoverTrigger>
        <PopoverContent>
          <ListPanel
            surfaceType={props.entityType}
            attachedIds={attachedIds}
            onToggle={membership.toggle}
            onCreate={membership.create}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * Linked offerings for a lead or deal: what you're pitching/selling on this
 * record. Rows show fit/note/primary metadata with remove-on-hover; the
 * popover picks from the workspace's active offerings.
 */
export function OfferingLinks(props: {
  entityType: "engagement" | "deal";
  entityId: string;
  links: Array<OfferingLink & { offering: Offering }>;
}) {
  const all = useQuery(opQuery<Offering[]>("offering.list"));
  const link = useOp("offering.link");
  const unlink = useOp("offering.unlink");
  const [search, setSearch] = useState("");

  const linkedIds = new Set(props.links.map((l) => l.offeringId));
  const candidates = (all.data ?? [])
    .filter((o) => o.active && !linkedIds.has(o.id))
    .filter((o) => o.name.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 12);

  return (
    <div className="space-y-2">
      {props.links.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nothing linked — what are you selling here?
        </p>
      ) : (
        <ul className="space-y-1.5">
          {props.links.map((l) => (
            <li key={l.id} className="group flex items-baseline gap-2 text-sm">
              <span className="font-medium">{l.offering.name}</span>
              {l.isPrimary ? (
                <span className={chipClass("ghost", "xs")}>primary</span>
              ) : null}
              {l.fit ? (
                <span className={chipClass("ghost", "xs")}>{l.fit}</span>
              ) : null}
              {l.note ? (
                <span className="truncate text-xs text-muted-foreground">
                  {l.note}
                </span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="size-5 self-center rounded-full text-muted-foreground/60 opacity-0 group-hover:opacity-100 hover:bg-transparent"
                aria-label={`Unlink ${l.offering.name}`}
                onClick={() =>
                  unlink.mutate({
                    offeringId: l.offeringId,
                    entityType: props.entityType,
                    entityId: props.entityId,
                  })
                }
              >
                <X className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Popover>
        <PopoverTrigger className="inline-flex h-5 cursor-pointer items-center gap-1 rounded-full px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
          <Plus className="size-3" /> offering
        </PopoverTrigger>
        <PopoverContent>
          <div className="w-60">
            <Input
              autoFocus
              className="h-auto rounded-none border-x-0 border-t-0 bg-transparent px-3 py-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
              placeholder="Link offering…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <ul className="max-h-56 overflow-y-auto p-1">
              {all.isLoading ? (
                <li className="px-2.5 py-2 text-xs text-muted-foreground">
                  Loading…
                </li>
              ) : candidates.length === 0 ? (
                <li className="px-2.5 py-2 text-xs text-muted-foreground">
                  {search.trim()
                    ? "No matches"
                    : "No offerings to link — create one under Offerings."}
                </li>
              ) : (
                candidates.map((o) => (
                  <li key={o.id}>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto w-full justify-between gap-2 px-2.5 py-1.5 text-left"
                      onClick={() => {
                        link.mutate({
                          offeringId: o.id,
                          entityType: props.entityType,
                          entityId: props.entityId,
                        });
                        setSearch("");
                      }}
                    >
                      <span className="min-w-0 truncate">{o.name}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {o.type}
                      </span>
                    </Button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * Compact list-membership cell for the People/Companies tables: up to two
 * chips, an overflow count, and a quick add/remove popover — membership is
 * visible and editable without opening the contact.
 */
export function ListCellChips(props: {
  entityType: ListableType;
  entityId: string;
  lists: ContactList[];
}) {
  const membership = useListMembership(props.entityType, props.entityId);
  const attachedIds = new Set(props.lists.map((l) => l.id));
  const shown = props.lists.slice(0, 2);
  const overflow = props.lists.length - shown.length;

  return (
    // Membership edits shouldn't trigger the row's click-through navigation.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div
      className="flex items-center gap-1"
      onClick={(e) => e.stopPropagation()}
    >
      {shown.map((l) => (
        <span
          key={l.id}
          className={`${chipClass(l.color, "xs")} max-w-28`}
          title={l.name}
        >
          <span className="truncate">{l.name}</span>
        </span>
      ))}
      {overflow > 0 ? (
        <span
          className={chipClass("ghost", "xs")}
          title={props.lists
            .slice(2)
            .map((l) => l.name)
            .join(", ")}
        >
          +{overflow}
        </span>
      ) : null}
      <Popover>
        <PopoverTrigger
          aria-label="Add to list"
          title="Add to list"
          className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-3" />
        </PopoverTrigger>
        <PopoverContent>
          <ListPanel
            surfaceType={props.entityType}
            attachedIds={attachedIds}
            onToggle={membership.toggle}
            onCreate={membership.create}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
