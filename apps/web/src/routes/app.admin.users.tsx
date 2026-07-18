import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Copy, KeyRound, Plus, UserX } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { User } from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { chipClass } from "~/lib/colors.ts";
import { formatDate } from "~/lib/format.ts";
import { Avatar, Field, Modal, Spinner } from "~/components/ui.tsx";
import { TABLE_CLASS, TableShell } from "~/components/TableShell.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Input } from "~/components/ui/input.tsx";
import { NativeSelect as Select } from "~/components/ui/native-select";
import { whoamiQuery } from "~/routes/__root.tsx";

export const Route = createFileRoute("/app/admin/users")({ component: UsersAdmin });

const ROLE_HINT: Record<string, string> = {
  owner: "Full control, cannot be demoted",
  admin: "Everything incl. team, agents, config",
  member: "Day-to-day CRM work",
  viewer: "Read-only",
};

function UsersAdmin() {
  const users = useQuery(opQuery<User[]>("user.list"));
  const auth = useQuery(whoamiQuery).data;
  const [createOpen, setCreateOpen] = useState(false);
  const [oneTime, setOneTime] = useState<{ email: string; password: string } | null>(null);
  const update = useOp("user.update", { successToast: "User updated" });
  const reset = useOp("user.resetPassword");

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button size="sm" className="gap-1" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" /> Invite user
        </Button>
      </div>

      {users.isLoading ? (
        <Spinner />
      ) : (
        <TableShell>
          <table className={TABLE_CLASS}>
            <thead>
              <tr className="border-b border-border text-left text-xs tracking-wider uppercase text-muted-foreground/70">
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Since</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="w-40 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {(users.data ?? []).map((u) => (
                <tr key={u.id} className={`border-b border-border/60 last:border-0 ${u.disabledAt ? "opacity-50" : ""}`}>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={u.name} />
                      <div>
                        <p className="text-sm font-medium">
                          {u.name}
                          {u.id === auth?.user.id ? <span className="ml-1.5 text-xs text-muted-foreground/70">(you)</span> : null}
                        </p>
                        <p className="text-xs text-muted-foreground">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {u.role === "owner" ? (
                      <span className={chipClass("primary")}>owner</span>
                    ) : (
                      <Select
                        size="xs"
                        className="w-auto"
                        value={u.role}
                        title={ROLE_HINT[u.role]}
                        onChange={(e) => update.mutate({ id: u.id, role: e.target.value })}
                      >
                        <option value="admin">admin</option>
                        <option value="member">member</option>
                        <option value="viewer">viewer</option>
                      </Select>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(u.createdAt)}</td>
                  <td className="px-3 py-2">
                    {u.disabledAt ? <span className={chipClass("ghost", "xs")}>disabled</span> : <span className={chipClass("success", "xs")}>active</span>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        title="Reset password"
                        onClick={() =>
                          reset.mutate(
                            { id: u.id },
                            {
                              onSuccess: (r) => setOneTime({ email: u.email, password: (r as { oneTimePassword: string }).oneTimePassword }),
                            },
                          )
                        }
                      >
                        <KeyRound className="size-3.5" />
                      </Button>
                      {u.role !== "owner" ? (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className={u.disabledAt ? "" : "text-destructive"}
                          title={u.disabledAt ? "Re-enable login" : "Disable login"}
                          onClick={() => update.mutate({ id: u.id, disabled: !u.disabledAt })}
                        >
                          <UserX className="size-3.5" />
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      )}

      <InviteModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={setOneTime} />
      {oneTime ? <OneTimePasswordModal info={oneTime} onClose={() => setOneTime(null)} /> : null}
    </div>
  );
}

function InviteModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose(): void;
  onCreated(info: { email: string; password: string }): void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const create = useOp("user.create");

  return (
    <Modal open={open} onClose={onClose} title="Invite user">
      <div className="space-y-3">
        <Field label="Name">
          <Input value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Role" hint={ROLE_HINT[role]}>
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="admin">admin</option>
            <option value="member">member</option>
            <option value="viewer">viewer</option>
          </Select>
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!name.trim() || !email.includes("@") || create.isPending}
          onClick={() =>
            create.mutate(
              { name: name.trim(), email: email.trim(), role },
              {
                onSuccess: (r) => {
                  const res = r as { user: User; oneTimePassword: string };
                  onClose();
                  onCreated({ email: res.user.email, password: res.oneTimePassword });
                },
              },
            )
          }
        >
          Create
        </Button>
      </div>
    </Modal>
  );
}

function OneTimePasswordModal({ info, onClose }: { info: { email: string; password: string }; onClose(): void }) {
  return (
    <Modal open onClose={onClose} title="One-time password">
      <p className="mb-3 text-sm text-muted-foreground">
        Share this with <span className="font-medium text-foreground">{info.email}</span>. It is shown once — they should change it after
        signing in.
      </p>
      <div className="flex items-center gap-2 rounded-lg bg-muted p-3">
        <code className="flex-1 font-mono text-sm">{info.password}</code>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => {
            navigator.clipboard.writeText(info.password);
            toast.success("Copied");
          }}
        >
          <Copy className="size-3.5" />
        </Button>
      </div>
      <div className="mt-4 flex justify-end">
        <Button size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
