import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Copy, Crown, KeyRound, Plus, RotateCw, Trash2, UserX } from "lucide-react";
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

const STATUS_TONE: Record<string, string> = {
  active: "success",
  pending: "warning",
  disabled: "ghost",
};

/** One-time code handed to the admin exactly once (setup or reset). */
interface CodeInfo {
  email: string;
  code: string;
  kind: "setup" | "reset";
}

function UsersAdmin() {
  const users = useQuery(opQuery<User[]>("user.list"));
  const auth = useQuery(whoamiQuery).data;
  const isOwner = auth?.role === "owner";
  const [createOpen, setCreateOpen] = useState(false);
  const [codeInfo, setCodeInfo] = useState<CodeInfo | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const [transferring, setTransferring] = useState<User | null>(null);
  const update = useOp("user.update", { successToast: "User updated" });
  const reset = useOp("user.resetPassword");
  const regenerate = useOp("user.regenerateSetupCode");

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
                <th className="w-48 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {(users.data ?? []).map((u) => (
                <tr key={u.id} className={`border-b border-border/60 last:border-0 ${u.status === "disabled" ? "opacity-50" : ""}`}>
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
                    <span className={chipClass(STATUS_TONE[u.status] ?? "ghost", "xs")}>{u.status}</span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      {u.status === "pending" ? (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          title="Show setup code (regenerates — earlier codes stop working)"
                          onClick={() =>
                            regenerate.mutate(
                              { id: u.id },
                              {
                                onSuccess: (r) =>
                                  setCodeInfo({ email: u.email, code: (r as { setupCode: string }).setupCode, kind: "setup" }),
                              },
                            )
                          }
                        >
                          <RotateCw className="size-3.5" />
                        </Button>
                      ) : u.role !== "owner" || isOwner ? (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          title="Reset password (signs the user out everywhere)"
                          onClick={() =>
                            reset.mutate(
                              { id: u.id },
                              {
                                onSuccess: (r) =>
                                  setCodeInfo({ email: u.email, code: (r as { resetCode: string }).resetCode, kind: "reset" }),
                              },
                            )
                          }
                        >
                          <KeyRound className="size-3.5" />
                        </Button>
                      ) : null}
                      {isOwner && u.role !== "owner" && u.status === "active" ? (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          title="Transfer ownership to this user"
                          onClick={() => setTransferring(u)}
                        >
                          <Crown className="size-3.5" />
                        </Button>
                      ) : null}
                      {u.role !== "owner" && u.status !== "pending" ? (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className={u.status === "disabled" ? "" : "text-destructive"}
                          title={u.status === "disabled" ? "Re-enable login" : "Disable login"}
                          onClick={() => update.mutate({ id: u.id, disabled: u.status !== "disabled" })}
                        >
                          <UserX className="size-3.5" />
                        </Button>
                      ) : null}
                      {u.role !== "owner" ? (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="text-destructive"
                          title="Delete permanently"
                          onClick={() => setDeleting(u)}
                        >
                          <Trash2 className="size-3.5" />
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

      <InviteModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={setCodeInfo} />
      {codeInfo ? <CodeModal info={codeInfo} onClose={() => setCodeInfo(null)} /> : null}
      {deleting ? <DeleteUserModal user={deleting} onClose={() => setDeleting(null)} /> : null}
      {transferring ? <TransferOwnershipModal user={transferring} onClose={() => setTransferring(null)} /> : null}
    </div>
  );
}

function InviteModal({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(info: CodeInfo): void }) {
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
        <p className="text-xs text-muted-foreground">
          They get a one-time setup code to choose their own password — no passwords change hands.
        </p>
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
                  const res = r as { user: User; setupCode: string };
                  onClose();
                  setName("");
                  setEmail("");
                  setRole("member");
                  onCreated({ email: res.user.email, code: res.setupCode, kind: "setup" });
                },
              },
            )
          }
        >
          Invite
        </Button>
      </div>
    </Modal>
  );
}

/** Display-once modal for setup/reset codes (mirrors the old password modal). */
function CodeModal({ info, onClose }: { info: CodeInfo; onClose(): void }) {
  return (
    <Modal open onClose={onClose} title={info.kind === "setup" ? "One-time setup code" : "One-time reset code"}>
      <p className="mb-3 text-sm text-muted-foreground">
        Share this code with <span className="font-medium text-foreground">{info.email}</span>. It is shown once and works once — they
        use it to {info.kind === "setup" ? "set their password and activate their account" : "choose a new password"}.
        {info.kind === "reset" ? " They have been signed out everywhere." : " Any earlier code no longer works."}
      </p>
      <div className="flex items-center gap-2 rounded-lg bg-muted p-3">
        <code className="flex-1 font-mono text-sm">{info.code}</code>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => {
            navigator.clipboard.writeText(info.code);
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

function DeleteUserModal({ user, onClose }: { user: User; onClose(): void }) {
  const [confirmText, setConfirmText] = useState("");
  const del = useOp("user.delete", { successToast: "User permanently deleted", onSuccess: onClose });
  const confirmed = confirmText.trim().toLowerCase() === user.email.toLowerCase();

  return (
    <Modal open onClose={onClose} title="Delete user permanently">
      <p className="text-sm text-muted-foreground">
        This permanently deletes <span className="font-medium text-foreground">{user.name}</span> ({user.email}): their login, sessions,
        agent keys and private views are removed. Records they worked on remain and show{" "}
        <span className="font-medium text-foreground">Deleted user</span>. This cannot be undone.
      </p>
      <div className="mt-3">
        <Field label="Confirm" hint={`Type ${user.email} to confirm`}>
          <Input value={confirmText} autoFocus placeholder={user.email} onChange={(e) => setConfirmText(e.target.value)} />
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="destructive" size="sm" disabled={!confirmed || del.isPending} onClick={() => del.mutate({ id: user.id })}>
          Delete permanently
        </Button>
      </div>
    </Modal>
  );
}

function TransferOwnershipModal({ user, onClose }: { user: User; onClose(): void }) {
  const transfer = useOp("user.transferOwnership", { successToast: "Ownership transferred", onSuccess: onClose });

  return (
    <Modal open onClose={onClose} title="Transfer ownership">
      <p className="text-sm text-muted-foreground">
        Make <span className="font-medium text-foreground">{user.name}</span> ({user.email}) the workspace owner. Both changes happen
        together: they become <span className="font-medium text-foreground">owner</span> and you become{" "}
        <span className="font-medium text-foreground">admin</span>. Only the new owner can transfer ownership back.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" disabled={transfer.isPending} onClick={() => transfer.mutate({ toUserId: user.id })}>
          <Crown className="size-3.5" /> Transfer ownership
        </Button>
      </div>
    </Modal>
  );
}
