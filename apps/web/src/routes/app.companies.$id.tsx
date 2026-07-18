import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Unlink,
} from "lucide-react";
import { useState } from "react";
import type {
  Activity,
  Company,
  CompanyPersonLink,
  ContactList,
  CustomFieldValue,
  Deal,
  Engagement,
  Person,
  Tag,
  User,
} from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { chipClass } from "~/lib/colors.ts";
import { formatDate, formatMoneyMinor, relativeTime } from "~/lib/format.ts";
import { ActivityFeed } from "~/components/ActivityFeed.tsx";
import { CustomFieldsCard } from "~/components/CustomFields.tsx";
import { PersonField } from "~/routes/app.leads.index.tsx";
import { ListChips, OwnerSelect, TagChips } from "~/components/pickers.tsx";
import {
  ButtonSpinner,
  ExternalLink,
  Field,
  Modal,
  SectionCard,
  Spinner,
  Avatar,
} from "~/components/ui.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Checkbox } from "~/components/ui/checkbox.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu.tsx";
import { Input } from "~/components/ui/input.tsx";
import { Textarea } from "~/components/ui/textarea.tsx";

interface CompanyContext {
  company: Company;
  people: Array<CompanyPersonLink & { person: Person }>;
  tags: Tag[];
  lists: ContactList[];
  customFields: Record<string, CustomFieldValue>;
  engagements: Engagement[];
  deals: Deal[];
  recentActivities: Activity[];
  openTasks: Activity[];
}

export const Route = createFileRoute("/app/companies/$id")({
  component: CompanyDetailPage,
});

function CompanyDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const ctx = useQuery(opQuery<CompanyContext>("company.getContext", { id }));
  const users = useQuery(opQuery<User[]>("user.list"));
  const [editOpen, setEditOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  const archive = useOp("company.archive", { successToast: "Archived" });
  const restore = useOp("company.restore", { successToast: "Restored" });
  const hardDelete = useOp("company.delete", {
    successToast: "Deleted",
    onSuccess: () => navigate({ to: "/app/companies" }),
  });
  const unlink = useOp("company.unlinkPerson", { successToast: "Unlinked" });

  if (ctx.isLoading) return <Spinner label="Loading company…" />;
  const data = ctx.data;
  if (!data)
    return (
      <p className="py-20 text-center text-sm text-muted-foreground">
        Company not found.
      </p>
    );

  const c = data.company;
  const owner = users.data?.find((u) => u.id === c.ownerUserId);

  return (
    <div>
      <div className="mb-4">
        <Link
          to="/app/companies"
          className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-foreground/70"
        >
          <ArrowLeft className="size-3" /> Companies
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="tnum font-mono text-xs text-muted-foreground/70">
                COMPANY-{c.displayId}
              </span>
              {c.archivedAt ? (
                <span className={chipClass("warning", "xs")}>archived</span>
              ) : null}
            </div>
            <h1 className="mt-0.5 truncate text-xl font-semibold tracking-tight">
              {c.name}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setEditOpen(true)}>
              <Pencil className="size-3.5" /> Edit
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="More actions"
                  />
                }
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {c.archivedAt ? (
                  <DropdownMenuItem
                    onClick={() => restore.mutate({ id: c.id })}
                  >
                    <ArchiveRestore className="size-3.5" /> Restore
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onClick={() => archive.mutate({ id: c.id })}
                  >
                    <Archive className="size-3.5" /> Archive
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    if (
                      confirm(
                        `Permanently delete "${c.name}"? Links to people and records are removed.`,
                      )
                    )
                      hardDelete.mutate({ id: c.id });
                  }}
                >
                  <Trash2 className="size-3.5" /> Delete forever
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="space-y-4">
          <SectionCard title="Details">
            <Field label="Website">
              {c.website ? <ExternalLink href={c.website} /> : "—"}
            </Field>
            <Field label="LinkedIn">
              {c.linkedin ? (
                <ExternalLink href={c.linkedin}>profile</ExternalLink>
              ) : (
                "—"
              )}
            </Field>
            <Field label="Industry">{c.industry ?? "—"}</Field>
            <Field label="HQ">{c.hq ?? "—"}</Field>
            <Field label="Country">{c.country ?? "—"}</Field>
            <Field label="Owner">{owner?.name ?? "—"}</Field>
            <Field label="Created">{formatDate(c.createdAt)}</Field>
            {c.description ? (
              <p className="mt-2 border-t border-border/60 pt-2 text-sm whitespace-pre-wrap text-foreground/70">
                {c.description}
              </p>
            ) : null}
            <div className="mt-2 space-y-2 border-t border-border/60 pt-2.5">
              <TagChips entityType="company" entityId={c.id} tags={data.tags} />
              <ListChips
                entityType="company"
                entityId={c.id}
                lists={data.lists}
              />
            </div>
          </SectionCard>

          <SectionCard
            title={`People (${data.people.length})`}
            actions={
              <Button
                variant="ghost"
                size="xs"
                className="gap-1"
                onClick={() => setLinkOpen(true)}
              >
                <Plus className="size-3" /> link
              </Button>
            }
          >
            {data.people.length === 0 ? (
              <p className="py-3 text-center text-sm text-muted-foreground">
                No people linked.
              </p>
            ) : (
              <ul className="space-y-1">
                {data.people.map((link) => (
                  <li
                    key={link.id}
                    className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-accent/50"
                  >
                    <Avatar name={link.person.name} />
                    <div className="min-w-0 flex-1">
                      <Link
                        to="/app/people/$id"
                        params={{ id: link.person.id }}
                        className="block truncate text-sm font-medium hover:underline"
                      >
                        {link.person.name}
                        {link.isPrimary ? (
                          <span
                            className={`ml-1.5 ${chipClass("ghost", "xs")}`}
                          >
                            primary
                          </span>
                        ) : null}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground">
                        {link.roleTitle ?? link.person.title ?? "—"}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="opacity-0 group-hover:opacity-100"
                      title="Unlink"
                      onClick={() =>
                        unlink.mutate({
                          companyId: c.id,
                          personId: link.person.id,
                        })
                      }
                    >
                      <Unlink className="size-3" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title={`Leads (${data.engagements.length})`}>
            {data.engagements.length === 0 ? (
              <p className="py-3 text-center text-sm text-muted-foreground">
                No engagements.
              </p>
            ) : (
              <ul className="space-y-1">
                {data.engagements.map((e) => (
                  <li key={e.id}>
                    <Link
                      to="/app/leads/$id"
                      params={{ id: e.id }}
                      className="flex items-baseline justify-between gap-2 rounded-lg px-2 py-1 text-sm hover:bg-accent/50"
                    >
                      <span className="truncate">{e.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground/70">
                        {relativeTime(e.lastActivityAt ?? e.updatedAt)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title={`Deals (${data.deals.length})`}>
            {data.deals.length === 0 ? (
              <p className="py-3 text-center text-sm text-muted-foreground">
                No deals.
              </p>
            ) : (
              <ul className="space-y-1">
                {data.deals.map((d) => (
                  <li key={d.id}>
                    <Link
                      to="/app/deals/$id"
                      params={{ id: d.id }}
                      className="flex items-baseline justify-between gap-2 rounded-lg px-2 py-1 text-sm hover:bg-accent/50"
                    >
                      <span className="truncate">
                        {d.title}
                        <span
                          className={`ml-1.5 ${chipClass(d.status === "won" ? "success" : d.status === "lost" ? "error" : "ghost", "xs")}`}
                        >
                          {d.status}
                        </span>
                      </span>
                      <span className="tnum shrink-0 font-mono text-xs text-muted-foreground">
                        {formatMoneyMinor(d.amountMinor, d.currency)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <CustomFieldsCard
            entityType="company"
            entityId={c.id}
            values={data.customFields}
          />
        </div>

        <SectionCard title="Timeline">
          <ActivityFeed links={{ companyId: c.id }} />
        </SectionCard>
      </div>

      <EditCompanyModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        company={c}
      />
      <LinkPersonModal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        companyId={c.id}
      />
    </div>
  );
}

function EditCompanyModal({
  open,
  onClose,
  company: c,
}: {
  open: boolean;
  onClose(): void;
  company: Company;
}) {
  const [name, setName] = useState(c.name);
  const [website, setWebsite] = useState(c.website ?? "");
  const [linkedin, setLinkedin] = useState(c.linkedin ?? "");
  const [industry, setIndustry] = useState(c.industry ?? "");
  const [hq, setHq] = useState(c.hq ?? "");
  const [country, setCountry] = useState(c.country ?? "");
  const [description, setDescription] = useState(c.description ?? "");
  const [owner, setOwner] = useState(c.ownerUserId);
  const update = useOp("company.update", {
    successToast: "Saved",
    onSuccess: onClose,
  });

  return (
    <Modal open={open} onClose={onClose} title={`Edit ${c.name}`}>
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            Name *
          </span>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Website
            </span>
            <Input
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              LinkedIn
            </span>
            <Input
              value={linkedin}
              onChange={(e) => setLinkedin(e.target.value)}
            />
          </label>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Industry
            </span>
            <Input
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">HQ</span>
            <Input value={hq} onChange={(e) => setHq(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Country
            </span>
            <Input
              value={country}
              onChange={(e) => setCountry(e.target.value)}
            />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            Description
          </span>
          <Textarea
            className="min-h-20"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            Owner
          </span>
          <OwnerSelect value={owner} onChange={setOwner} />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={update.isPending || !name.trim()}
            onClick={() =>
              update.mutate({
                id: c.id,
                expectedVersion: c.version,
                name: name.trim(),
                website: website.trim() || null,
                linkedin: linkedin.trim() || null,
                industry: industry.trim() || null,
                hq: hq.trim() || null,
                country: country.trim() || null,
                description: description.trim() || null,
                ownerUserId: owner,
              })
            }
          >
            {update.isPending ? <ButtonSpinner /> : null}
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function LinkPersonModal({
  open,
  onClose,
  companyId,
}: {
  open: boolean;
  onClose(): void;
  companyId: string;
}) {
  const [personId, setPersonId] = useState<string | null>(null);
  const [role, setRole] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const createPerson = useOp<
    { name: string; companyId: string },
    { id: string }
  >("person.create", {
    successToast: "Person created & linked",
    onSuccess: onClose,
  });
  const link = useOp("company.linkPerson", {
    successToast: "Linked",
    onSuccess: onClose,
  });

  return (
    <Modal open={open} onClose={onClose} title="Link a person">
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            Person
          </span>
          <PersonField
            value={personId}
            onChange={setPersonId}
            onCreate={(name) => createPerson.mutate({ name, companyId })}
          />
        </label>
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Role at company
            </span>
            <Input
              placeholder="CTO, Head of Sales…"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            />
          </label>
          <label className="flex cursor-pointer items-center gap-2 pb-1.5 text-xs">
            <Checkbox
              checked={isPrimary}
              onCheckedChange={(checked) => setIsPrimary(checked === true)}
            />
            primary contact
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!personId || link.isPending}
            onClick={() =>
              link.mutate({
                companyId,
                personId,
                roleTitle: role.trim() || undefined,
                isPrimary,
              })
            }
          >
            Link
          </Button>
        </div>
      </div>
    </Modal>
  );
}
