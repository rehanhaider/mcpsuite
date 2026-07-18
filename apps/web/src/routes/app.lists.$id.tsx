/**
 * One contact list: header (name/color/description, edit + delete) and the
 * membership manager — up to four entity panels (or one for typed lists) with
 * search-pickers to add members and per-row remove.
 */
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Building2,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Pencil,
  Radar,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import type {
  CompanyListItem,
  ContactListWithCounts,
  DealListItem,
  EngagementListItem,
  ListableType,
  Page,
  PersonListItem,
} from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { dotClass } from "~/lib/colors.ts";
import { EntityPicker, useCompanyOptions, useDealOptions, useEngagementOptions, usePersonOptions } from "~/components/pickers.tsx";
import { Avatar, EmptyState, PageHeader, SectionCard, Spinner } from "~/components/ui.tsx";
import { Button } from "~/components/ui/button.tsx";
import { ListModal } from "~/routes/app.lists.index.tsx";

const MEMBER_PAGE = 25;

export const Route = createFileRoute("/app/lists/$id")({ component: ListDetailPage });

interface MembersResult {
  list: ContactListWithCounts;
  people: Page<PersonListItem> | null;
  companies: Page<CompanyListItem> | null;
  engagements: Page<EngagementListItem> | null;
  deals: Page<DealListItem> | null;
}

const PANEL_META: Record<
  ListableType,
  { label: string; icon: ReactNode; total: (l: ContactListWithCounts) => number; placeholder: string; empty: string; to: string }
> = {
  person: {
    label: "People",
    icon: <UsersRound className="size-3.5" />,
    total: (l) => l.people,
    placeholder: "Add a person — search by name…",
    empty: "No people on this list yet — search above to add.",
    to: "/app/people/$id",
  },
  company: {
    label: "Companies",
    icon: <Building2 className="size-3.5" />,
    total: (l) => l.companies,
    placeholder: "Add a company — search by name…",
    empty: "No companies on this list yet — search above to add.",
    to: "/app/companies/$id",
  },
  engagement: {
    label: "Leads",
    icon: <Radar className="size-3.5" />,
    total: (l) => l.engagements,
    placeholder: "Add a lead — search by title…",
    empty: "No leads on this list yet — search above to add.",
    to: "/app/leads/$id",
  },
  deal: {
    label: "Deals",
    icon: <CircleDollarSign className="size-3.5" />,
    total: (l) => l.deals,
    placeholder: "Add a deal — search by title…",
    empty: "No deals on this list yet — search above to add.",
    to: "/app/deals/$id",
  },
};

function memberTotal(l: ContactListWithCounts): number {
  return l.people + l.companies + l.engagements + l.deals;
}

function ListDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const [editOpen, setEditOpen] = useState(false);

  const list = useQuery(opQuery<ContactListWithCounts>("list.get", { id }));
  const del = useOp("list.delete", {
    successToast: "List deleted",
    onSuccess: () => navigate({ to: "/app/lists" }),
  });

  if (list.isLoading) return <Spinner label="Loading list…" />;
  const l = list.data;
  if (!l) return <EmptyState title="List not found" action={<Link to="/app/lists">Back to lists</Link>} />;

  const panelTypes: ListableType[] = l.entityType ? [l.entityType] : ["person", "company", "engagement", "deal"];

  return (
    <div>
      <Link
        to="/app/lists"
        className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3" /> All lists
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className={`size-3 shrink-0 rounded-full ${dotClass(l.color)}`} />
            {l.name}
          </span>
        }
        subtitle={l.description ?? "No description — add one so agents and teammates know what belongs here."}
        actions={
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              <Pencil className="size-3.5" /> Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive"
              onClick={() => {
                if (confirm(`Delete list "${l.name}"? ${memberTotal(l)} members will be detached (records are kept).`))
                  del.mutate({ id: l.id });
              }}
            >
              <Trash2 className="size-3.5" /> Delete
            </Button>
          </div>
        }
      />

      <div className={`grid items-start gap-4 ${l.entityType ? "" : "sm:grid-cols-2"}`}>
        {panelTypes.map((entityType) => (
          <MembersPanel key={`${id}-${entityType}`} listId={id} list={l} entityType={entityType} fullWidth={!!l.entityType} />
        ))}
      </div>

      {editOpen ? <ListModal open onClose={() => setEditOpen(false)} list={l} /> : null}
    </div>
  );
}

function MembersPanel({
  listId,
  list,
  entityType,
  fullWidth,
}: {
  listId: string;
  list: ContactListWithCounts;
  entityType: ListableType;
  fullWidth?: boolean;
}) {
  const meta = PANEL_META[entityType];
  const [page, setPage] = useState(0);

  const members = useQuery(
    opQuery<MembersResult>("list.members", { id: listId, entityType, limit: MEMBER_PAGE, offset: page * MEMBER_PAGE }),
  );
  const add = useOp("list.addMembers", { successToast: `Added to list` });
  const remove = useOp("list.removeMembers");

  const pageData =
    entityType === "person"
      ? members.data?.people
      : entityType === "company"
        ? members.data?.companies
        : entityType === "engagement"
          ? members.data?.engagements
          : members.data?.deals;

  const items: Array<{ id: string; name: string; sub: string | null }> =
    entityType === "person"
      ? (members.data?.people?.items ?? []).map((p) => ({ id: p.id, name: p.name, sub: p.title ?? p.primaryCompanyName }))
      : entityType === "company"
        ? (members.data?.companies?.items ?? []).map((c) => ({ id: c.id, name: c.name, sub: c.industry }))
        : entityType === "engagement"
          ? (members.data?.engagements?.items ?? []).map((e) => ({
              id: e.id,
              name: e.title,
              sub: [e.personName, e.companyName].filter(Boolean).join(" · ") || null,
            }))
          : (members.data?.deals?.items ?? []).map((d) => ({ id: d.id, name: d.title, sub: d.companyName }));

  const memberTotalCount = pageData?.total ?? meta.total(list);
  const pageCount = Math.max(1, Math.ceil(memberTotalCount / MEMBER_PAGE));

  return (
    <SectionCard
      className={fullWidth ? "col-span-full" : undefined}
      title={
        <span className="flex items-center gap-1.5">
          {meta.icon}
          {meta.label}
          <span className="tnum font-normal text-muted-foreground">({memberTotalCount})</span>
        </span>
      }
    >
      <div className="mb-2">
        <AddMemberPicker
          entityType={entityType}
          placeholder={meta.placeholder}
          onPick={(entityId) => add.mutate({ listId, entityType, entityIds: [entityId] })}
        />
      </div>

      {members.isLoading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">{meta.empty}</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {items.map((m) => (
            <li key={m.id} className="group flex items-center gap-2.5 py-1.5">
              {entityType === "person" ? (
                <Avatar name={m.name} />
              ) : entityType === "company" ? (
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted">
                  <Building2 className="size-3.5 text-muted-foreground" />
                </span>
              ) : entityType === "engagement" ? (
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted">
                  <Radar className="size-3.5 text-muted-foreground" />
                </span>
              ) : (
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted">
                  <CircleDollarSign className="size-3.5 text-muted-foreground" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <Link to={meta.to} params={{ id: m.id }} className="block truncate text-sm font-medium hover:underline">
                  {m.name}
                </Link>
                {m.sub ? <p className="truncate text-xs text-muted-foreground">{m.sub}</p> : null}
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${m.name} from list`}
                className="text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                onClick={() => remove.mutate({ listId, entityType, entityIds: [m.id] })}
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {memberTotalCount > MEMBER_PAGE ? (
        <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-xs text-muted-foreground">
          <span className="tnum">
            {page * MEMBER_PAGE + 1}–{Math.min(memberTotalCount, (page + 1) * MEMBER_PAGE)} of {memberTotalCount}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-xs" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous page">
              <ChevronLeft className="size-3.5" />
            </Button>
            <span className="tnum px-1">
              {page + 1}/{pageCount}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={page + 1 >= pageCount}
              onClick={() => setPage(page + 1)}
              aria-label="Next page"
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}

function AddMemberPicker({
  entityType,
  placeholder,
  onPick,
}: {
  entityType: ListableType;
  placeholder: string;
  onPick(id: string): void;
}) {
  const useOptions =
    entityType === "person"
      ? usePersonOptions
      : entityType === "company"
        ? useCompanyOptions
        : entityType === "engagement"
          ? useEngagementOptions
          : useDealOptions;

  return (
    <EntityPicker
      value={null}
      onChange={(id) => {
        if (id) onPick(id);
      }}
      useOptions={useOptions}
      placeholder={placeholder}
    />
  );
}
