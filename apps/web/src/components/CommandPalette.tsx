/** ⌘K palette: global search across records + quick navigation. */
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Building2,
  CircleDollarSign,
  FileSearch,
  Radar,
  User as UserIcon,
  CornerDownLeft,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SearchHit } from "@emcp/core/domain";
import { opQuery } from "~/lib/api.ts";
import { useUi } from "~/store/ui.ts";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Kbd } from "~/components/ui/kbd";

const TYPE_META: Record<
  string,
  { icon: ReactNode; label: string; to: (id: string) => string }
> = {
  company: {
    icon: <Building2 className="size-4" />,
    label: "Company",
    to: (id) => `/app/companies/${id}`,
  },
  person: {
    icon: <UserIcon className="size-4" />,
    label: "Person",
    to: (id) => `/app/people/${id}`,
  },
  engagement: {
    icon: <Radar className="size-4" />,
    label: "Lead",
    to: (id) => `/app/leads/${id}`,
  },
  deal: {
    icon: <CircleDollarSign className="size-4" />,
    label: "Deal",
    to: (id) => `/app/deals/${id}`,
  },
};

const NAV_ITEMS = [
  { label: "Home", to: "/app" },
  { label: "Leads", to: "/app/leads" },
  { label: "Companies", to: "/app/companies" },
  { label: "People", to: "/app/people" },
  { label: "Lists", to: "/app/lists" },
  { label: "Deals", to: "/app/deals" },
  { label: "Offerings", to: "/app/offerings" },
  { label: "Tasks", to: "/app/tasks" },
  { label: "Activity", to: "/app/activity" },
  { label: "Agents", to: "/app/agents" },
  { label: "Approvals", to: "/app/approvals" },
  { label: "Admin", to: "/app/admin" },
];

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!useUi.getState().paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const trimmed = query.trim();
  const search = useQuery({
    ...opQuery<SearchHit[]>("search.global", { query: trimmed, limit: 15 }),
    enabled: open && trimmed.length >= 2,
  });

  const hits: SearchHit[] = search.data ?? [];

  const navMatches = useMemo(
    () =>
      trimmed
        ? NAV_ITEMS.filter((n) =>
            n.label.toLowerCase().includes(trimmed.toLowerCase()),
          )
        : NAV_ITEMS,
    [trimmed],
  );

  type Item = {
    key: string;
    icon: ReactNode;
    label: string;
    sub?: string | null;
    go(): void;
  };
  const items: Item[] = useMemo(() => {
    const recordItems: Item[] = hits
      .filter((h) => TYPE_META[h.entityType])
      .map((h) => ({
        key: `${h.entityType}:${h.id}`,
        icon: TYPE_META[h.entityType]!.icon,
        label: h.title,
        sub:
          [h.ref, h.subtitle].filter(Boolean).join(" · ") ||
          TYPE_META[h.entityType]!.label,
        go: () => {
          navigate({ to: TYPE_META[h.entityType]!.to(h.id) });
          setOpen(false);
        },
      }));
    const navItems: Item[] = navMatches.map((n) => ({
      key: `nav:${n.to}`,
      icon: <FileSearch className="size-4" />,
      label: `Go to ${n.label}`,
      go: () => {
        navigate({ to: n.to });
        setOpen(false);
      },
    }));
    return trimmed.length >= 2 ? [...recordItems, ...navItems] : navItems;
  }, [hits, navMatches, navigate, setOpen, trimmed]);

  useEffect(() => setActive(0), [items.length, trimmed]);

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="top-[12vh] max-w-xl translate-y-0 bg-popover p-0"
      >
        <DialogTitle className="sr-only">Search emcp</DialogTitle>
        <Input
          autoFocus
          className="h-auto rounded-none border-x-0 border-t-0 bg-transparent px-4 py-3 shadow-none focus-visible:ring-0 dark:bg-transparent"
          placeholder="Search leads, companies, people, deals…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, items.length - 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            }
            if (e.key === "Enter") {
              e.preventDefault();
              items[active]?.go();
            }
          }}
        />
        <ul ref={listRef} className="max-h-80 overflow-y-auto p-1.5">
          {search.isFetching && trimmed.length >= 2 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              Searching…
            </li>
          ) : null}
          {items.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">
              No results
            </li>
          ) : null}
          {items.map((item, i) => (
            <li key={item.key}>
              <Button
                type="button"
                variant="ghost"
                className={`h-auto w-full justify-start gap-3 px-3 py-2 text-left ${
                  i === active
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/60"
                }`}
                onMouseEnter={() => setActive(i)}
                onClick={item.go}
              >
                <span className="text-muted-foreground">{item.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{item.label}</span>
                  {item.sub ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {item.sub}
                    </span>
                  ) : null}
                </span>
                {i === active ? (
                  <CornerDownLeft className="size-3.5 text-muted-foreground/70" />
                ) : null}
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> open
          </span>
          <span className="flex items-center gap-1">
            <Kbd>esc</Kbd> close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
