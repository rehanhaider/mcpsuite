import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Archive, ArchiveRestore, ArrowLeft, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
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
import { ListChips, OwnerSelect, TagChips } from "~/components/pickers.tsx";
import { ButtonSpinner, ExternalLink, Field, Modal, SectionCard, Spinner } from "~/components/ui.tsx";
import { Button } from "~/components/ui/button.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu.tsx";
import { Input } from "~/components/ui/input.tsx";

interface PersonContext {
  person: Person;
  companies: Array<CompanyPersonLink & { company: Company }>;
  tags: Tag[];
  lists: ContactList[];
  customFields: Record<string, CustomFieldValue>;
  engagements: Engagement[];
  deals: Deal[];
  recentActivities: Activity[];
  openTasks: Activity[];
}

export const Route = createFileRoute("/app/people/$id")({
  component: PersonDetailPage,
});

function PersonDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const ctx = useQuery(opQuery<PersonContext>("person.getContext", { id }));
  const users = useQuery(opQuery<User[]>("user.list"));
  const [editOpen, setEditOpen] = useState(false);

  const archive = useOp("person.archive", { successToast: "Archived" });
  const restore = useOp("person.restore", { successToast: "Restored" });
  const hardDelete = useOp("person.delete", { successToast: "Deleted", onSuccess: () => navigate({ to: "/app/people" }) });

  if (ctx.isLoading) return <Spinner label="Loading person…" />;
  const data = ctx.data;
  if (!data) return <p className="py-20 text-center text-sm text-muted-foreground">Person not found.</p>;

  const p = data.person;
  const owner = users.data?.find((u) => u.id === p.ownerUserId);

  return (
    <div>
      <div className="mb-4">
        <Link to="/app/people" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-foreground/70">
          <ArrowLeft className="size-3" /> People
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="tnum font-mono text-xs text-muted-foreground/70">PERSON-{p.displayId}</span>
              {p.archivedAt ? <span className={chipClass("warning", "xs")}>archived</span> : null}
            </div>
            <h1 className="mt-0.5 truncate text-xl font-semibold tracking-tight">{p.name}</h1>
            {p.title ? <p className="text-sm text-muted-foreground">{p.title}</p> : null}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setEditOpen(true)}>
              <Pencil className="size-3.5" /> Edit
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More actions" />}>
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {p.archivedAt ? (
                  <DropdownMenuItem onClick={() => restore.mutate({ id: p.id })}>
                    <ArchiveRestore className="size-3.5" /> Restore
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={() => archive.mutate({ id: p.id })}>
                    <Archive className="size-3.5" /> Archive
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    if (confirm(`Permanently delete "${p.name}"?`)) hardDelete.mutate({ id: p.id });
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
            <Field label="Email">
              {p.email ? (
                <a href={`mailto:${p.email}`} className="text-cyan hover:underline">
                  {p.email}
                </a>
              ) : (
                "—"
              )}
            </Field>
            <Field label="Phone">{p.phone ?? "—"}</Field>
            <Field label="LinkedIn">{p.linkedin ? <ExternalLink href={p.linkedin}>profile</ExternalLink> : "—"}</Field>
            <Field label="Location">{p.location ?? "—"}</Field>
            <Field label="Country">{p.country ?? "—"}</Field>
            <Field label="Owner">{owner?.name ?? "—"}</Field>
            <Field label="Created">{formatDate(p.createdAt)}</Field>
            <div className="mt-2 space-y-2 border-t border-border/60 pt-2.5">
              <TagChips entityType="person" entityId={p.id} tags={data.tags} />
              <ListChips entityType="person" entityId={p.id} lists={data.lists} />
            </div>
          </SectionCard>

          {data.companies.length > 0 ? (
            <SectionCard title="Companies">
              <ul className="space-y-1">
                {data.companies.map((link) => (
                  <li key={link.id}>
                    <Link
                      to="/app/companies/$id"
                      params={{ id: link.company.id }}
                      className="flex items-baseline justify-between gap-2 rounded-lg px-2 py-1 text-sm hover:bg-accent/50"
                    >
                      <span className="truncate font-medium">{link.company.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground/70">{link.roleTitle ?? "—"}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

          {data.engagements.length > 0 ? (
            <SectionCard title={`Leads (${data.engagements.length})`}>
              <ul className="space-y-1">
                {data.engagements.map((e) => (
                  <li key={e.id}>
                    <Link
                      to="/app/leads/$id"
                      params={{ id: e.id }}
                      className="flex items-baseline justify-between gap-2 rounded-lg px-2 py-1 text-sm hover:bg-accent/50"
                    >
                      <span className="truncate">{e.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground/70">{relativeTime(e.lastActivityAt ?? e.updatedAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

          {data.deals.length > 0 ? (
            <SectionCard title={`Deals (${data.deals.length})`}>
              <ul className="space-y-1">
                {data.deals.map((d) => (
                  <li key={d.id}>
                    <Link
                      to="/app/deals/$id"
                      params={{ id: d.id }}
                      className="flex items-baseline justify-between gap-2 rounded-lg px-2 py-1 text-sm hover:bg-accent/50"
                    >
                      <span className="truncate">{d.title}</span>
                      <span className="tnum shrink-0 font-mono text-xs text-muted-foreground">{formatMoneyMinor(d.amountMinor, d.currency)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

          <CustomFieldsCard entityType="person" entityId={p.id} values={data.customFields} />
        </div>

        <SectionCard title="Timeline">
          <ActivityFeed links={{ personId: p.id }} />
        </SectionCard>
      </div>

      <EditPersonModal open={editOpen} onClose={() => setEditOpen(false)} person={p} />
    </div>
  );
}

function EditPersonModal({ open, onClose, person: p }: { open: boolean; onClose(): void; person: Person }) {
  const [name, setName] = useState(p.name);
  const [title, setTitle] = useState(p.title ?? "");
  const [email, setEmail] = useState(p.email ?? "");
  const [phone, setPhone] = useState(p.phone ?? "");
  const [linkedin, setLinkedin] = useState(p.linkedin ?? "");
  const [location, setLocation] = useState(p.location ?? "");
  const [country, setCountry] = useState(p.country ?? "");
  const [owner, setOwner] = useState(p.ownerUserId);
  const update = useOp("person.update", { successToast: "Saved", onSuccess: onClose });

  return (
    <Modal open={open} onClose={onClose} title={`Edit ${p.name}`}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Name *</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Title</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Email</span>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Phone</span>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">LinkedIn</span>
            <Input value={linkedin} onChange={(e) => setLinkedin(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Location</span>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Country</span>
            <Input value={country} onChange={(e) => setCountry(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Owner</span>
            <OwnerSelect value={owner} onChange={setOwner} />
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={update.isPending || !name.trim()}
            onClick={() =>
              update.mutate({
                id: p.id,
                expectedVersion: p.version,
                name: name.trim(),
                title: title.trim() || null,
                email: email.trim() || null,
                phone: phone.trim() || null,
                linkedin: linkedin.trim() || null,
                location: location.trim() || null,
                country: country.trim() || null,
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
