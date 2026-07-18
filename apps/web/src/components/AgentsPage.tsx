import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Bot, Copy, Plus, ShieldOff } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { McpClient, User } from "@emcp/core/domain";
import {
  ROLE_GRANTABLE_SCOPES,
  TRUST_PROFILES,
  roleAtLeast,
  type McpScope,
  type Role,
} from "@emcp/core/policy";
import { opQuery, useOp } from "~/lib/api.ts";
import { chipClass } from "~/lib/colors.ts";
import { relativeTime } from "~/lib/format.ts";
import { whoamiQuery } from "~/routes/__root.tsx";
import {
  EmptyState,
  Field,
  Modal,
  PageHeader,
  SectionCard,
  Spinner,
} from "~/components/ui.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Checkbox } from "~/components/ui/checkbox.tsx";
import { Input } from "~/components/ui/input.tsx";
import { NativeSelect as Select } from "~/components/ui/native-select";

const TRUST_HINT: Record<string, string> = {
  review_risky_actions:
    "Safe ops run directly; risky ops (deletes, bulk, config) queue for human approval.",
  trusted_agent:
    "Bulk/data/config changes run directly; destructive and admin ops still queue for approval.",
  fully_authorized_agent:
    "Everything within the owner's own permissions runs directly. Use sparingly.",
};

/** Inline monospace token used in the connect prose. */
const CODE = "rounded bg-muted px-1 py-0.5 font-mono text-[11px]";

/** Copyable, multi-line code block with a copy button in the top-right. */
function Snippet({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-border bg-background p-3 pr-10 font-mono text-xs leading-relaxed text-foreground/90">
        {code}
      </pre>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Copy"
        className="absolute top-1.5 right-1.5"
        onClick={() => {
          navigator.clipboard.writeText(code);
          toast.success("Copied");
        }}
      >
        <Copy className="size-3.5" />
      </Button>
    </div>
  );
}

/** Readable stand-in shown in the on-page guide, replaced by the real key in the post-create modal. */
const KEY_PLACEHOLDER = "emcp_YOUR_API_KEY";

const DEFAULT_MCP_URL = "http://localhost:8765/mcp";

/** MCP HTTP endpoint for the snippets, derived from the current host (SSR-safe). */
function useMcpUrl() {
  return useMemo(() => {
    if (typeof window === "undefined") return DEFAULT_MCP_URL;
    return `http://${window.location.hostname}:8765/mcp`;
  }, []);
}

type Guide = { id: string; label: string; body: ReactNode };

/**
 * Per-client connection guides, shown one at a time via the dropdown. Every snippet has the
 * key inlined — pass the real key (post-create modal) or `KEY_PLACEHOLDER` (on-page card). No
 * shell env vars in the primary path: each block is paste-ready as-is.
 */
function connectGuides({
  key,
  mcpUrl,
}: {
  key: string;
  mcpUrl: string;
}): Guide[] {
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      body: (
        <>
          <p className="text-xs text-muted-foreground">
            One command registers this CRM as an HTTP MCP server:
          </p>
          <Snippet
            code={`claude mcp add --transport http emcp-crm ${mcpUrl} \\\n  --header "Authorization: Bearer ${key}"`}
          />
          <p className="text-[11px] text-muted-foreground/70">
            Developing inside this repo? The bundled{" "}
            <code className={CODE}>.mcp.json</code> wires Claude Code over stdio
            from <code className={CODE}>data/mcp.env</code> — see docs/mcp.md →
            “Advanced”.
          </p>
        </>
      ),
    },
    {
      id: "cursor",
      label: "Cursor",
      body: (
        <>
          <p className="text-xs text-muted-foreground">
            Add to <code className={CODE}>.cursor/mcp.json</code>:
          </p>
          <Snippet
            code={`{
  "mcpServers": {
    "emcp-crm": {
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer ${key}" }
    }
  }
}`}
          />
        </>
      ),
    },
    {
      id: "codex",
      label: "Codex (CLI / IDE / desktop)",
      body: (
        <>
          <p className="text-xs text-muted-foreground">
            Add to <code className={CODE}>~/.codex/config.toml</code> — the key
            rides along as a static header:
          </p>
          <Snippet
            code={`[mcp_servers.emcp-crm]\nurl = "${mcpUrl}"\nhttp_headers = { "Authorization" = "Bearer ${key}" }`}
          />
          <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>
              Codex cloud / ChatGPT web can't reach localhost — custom local MCP
              only works with Codex running on this machine.
            </span>
          </div>
        </>
      ),
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop / other stdio-only clients",
      body: (
        <>
          <p className="text-xs text-muted-foreground">
            No HTTP transport? Paste this into the{" "}
            <code className={CODE}>mcpServers</code> block of{" "}
            <code className={CODE}>claude_desktop_config.json</code> — it
            bridges stdio → HTTP with <code className={CODE}>mcp-remote</code>:
          </p>
          <Snippet
            code={`{
  "mcpServers": {
    "emcp-crm": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "${mcpUrl}",
        "--allow-http",
        "--header",
        "Authorization: Bearer ${key}"
      ]
    }
  }
}`}
          />
        </>
      ),
    },
    {
      id: "debug",
      label: "Anything else / debugging",
      body: (
        <>
          <p className="text-xs text-muted-foreground">
            Any HTTP client works. List the tools to confirm the key:
          </p>
          <Snippet
            code={`curl -X POST ${mcpUrl} \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`}
          />
        </>
      ),
    },
  ];
}

/** Client picker + the chosen guide, with `apiKey` inlined into every snippet. Shared by the card and the modal. */
function ConnectGuides({ apiKey }: { apiKey: string }) {
  const mcpUrl = useMcpUrl();
  const guides = useMemo(
    () => connectGuides({ key: apiKey, mcpUrl }),
    [apiKey, mcpUrl],
  );
  const [guideId, setGuideId] = useState(guides[0]!.id);
  const guide = guides.find((g) => g.id === guideId) ?? guides[0]!;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Show setup for
        </span>
        <Select
          size="xs"
          className="max-w-64"
          value={guideId}
          onChange={(e) => setGuideId(e.target.value)}
        >
          {guides.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">{guide.body}</div>
    </div>
  );
}

export function AgentsPage() {
  const auth = useQuery(whoamiQuery).data;
  const myRole = (auth?.role ?? "viewer") as Role;
  const isAdmin = roleAtLeast(myRole, "admin");
  const canCreate = roleAtLeast(myRole, "member");
  const clients = useQuery(opQuery<McpClient[]>("mcpClient.list"));
  // Admins see everyone's agents; resolve creators for labels + scope caps.
  const users = useQuery({ ...opQuery<User[]>("user.list"), enabled: isAdmin });
  const [createOpen, setCreateOpen] = useState(false);
  const [token, setToken] = useState<{ name: string; token: string } | null>(
    null,
  );
  const revoke = useOp("mcpClient.revoke", { successToast: "Client revoked" });
  const update = useOp("mcpClient.update", { successToast: "Client updated" });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Agents"
        subtitle="Connect Claude, Cursor, or any MCP client with scoped, revocable API keys. An agent acts on your behalf — it can never do more than you can."
        actions={
          canCreate ? (
            <Button
              size="sm"
              className="gap-1"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="size-4" /> New agent client
            </Button>
          ) : null
        }
      />

      {clients.isLoading ? (
        <Spinner />
      ) : (clients.data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={<Bot className="size-10 text-foreground/20" />}
          title="No agent clients yet"
          hint={
            canCreate
              ? "Create a client to let Claude (or any MCP agent) work this CRM with scoped, revocable access."
              : "Viewers cannot create agent clients."
          }
          action={
            canCreate ? (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" /> New agent client
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {clients.data!.map((c) => {
            const mine = c.createdByUserId === auth?.user?.id;
            const creator = mine
              ? undefined
              : users.data?.find((u) => u.id === c.createdByUserId);
            // Scopes are capped by the owning user's role, not the viewer's.
            const capRole = mine ? myRole : (creator?.role as Role | undefined);
            return (
              <ClientCard
                key={c.id}
                client={c}
                capRole={capRole}
                creatorLabel={mine ? null : (creator?.name ?? "unknown user")}
                canManage={mine || isAdmin}
                onRevoke={() => {
                  if (
                    confirm(
                      `Revoke "${c.name}"? Its API key stops working immediately.`,
                    )
                  )
                    revoke.mutate({ id: c.id });
                }}
                onUpdate={(patch) => update.mutate({ id: c.id, ...patch })}
              />
            );
          })}
        </div>
      )}

      <SectionCard
        title="Connecting an agent"
        subtitle="Every client needs a key — create one above, then paste the setup into your agent. Full guide: docs/mcp.md."
      >
        <div className="space-y-5">
          <ol className="space-y-1 text-sm text-muted-foreground">
            <li>
              <span className="mr-1.5 font-semibold text-foreground">1.</span>
              Create a client above — the key is shown once, with a paste-ready
              setup snippet for your agent.
            </li>
            <li>
              <span className="mr-1.5 font-semibold text-foreground">2.</span>
              Already have a key? Use the snippets below and swap{" "}
              <code className={CODE}>{KEY_PLACEHOLDER}</code> for it.
            </li>
          </ol>

          <ConnectGuides apiKey={KEY_PLACEHOLDER} />
        </div>
      </SectionCard>

      <CreateClientModal
        open={createOpen}
        role={myRole}
        onClose={() => setCreateOpen(false)}
        onCreated={setToken}
      />
      {token ? (
        <ConnectModal info={token} onClose={() => setToken(null)} />
      ) : null}
    </div>
  );
}

function ClientCard({
  client: c,
  capRole,
  creatorLabel,
  canManage,
  onRevoke,
  onUpdate,
}: {
  client: McpClient;
  capRole: Role | undefined;
  creatorLabel: string | null;
  canManage: boolean;
  onRevoke(): void;
  onUpdate(patch: { scopes?: string[]; trust?: string }): void;
}) {
  const cap = capRole
    ? ROLE_GRANTABLE_SCOPES[capRole]
    : ([] as readonly McpScope[]);
  // Stored scopes may predate a demotion; only the clamped set is effective.
  const effective = c.scopes.filter((s) => cap.includes(s));
  const orphaned = !capRole;
  return (
    <div
      className={`rounded-xl border border-border bg-card p-4 ${c.revokedAt ? "opacity-55" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-full bg-violet/15 text-violet">
          <Bot className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {c.name}
            {creatorLabel ? (
              <span className={`ml-2 ${chipClass("ghost", "xs")}`}>
                {creatorLabel}
              </span>
            ) : null}
            {c.revokedAt ? (
              <span className={`ml-2 ${chipClass("ghost", "xs")}`}>
                revoked
              </span>
            ) : null}
            {!c.revokedAt && orphaned ? (
              <span className={`ml-2 ${chipClass("warning", "xs")}`}>
                inert — owner missing
              </span>
            ) : null}
          </p>
          <p className="font-mono text-xs text-muted-foreground">
            {c.tokenPrefix}… ·{" "}
            {c.lastUsedAt
              ? `last used ${relativeTime(c.lastUsedAt)}`
              : "never used"}
          </p>
        </div>
        {!c.revokedAt && canManage ? (
          <Button
            variant="outline"
            size="xs"
            className="gap-1 border-destructive/40 text-destructive hover:bg-destructive/10"
            onClick={onRevoke}
          >
            <ShieldOff className="size-3.5" /> Revoke
          </Button>
        ) : null}
      </div>
      {!c.revokedAt && !orphaned ? (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Field label="Scopes">
            <div className="flex flex-wrap gap-2">
              {cap.map((s) => (
                <label
                  key={s}
                  className={`flex items-center gap-1.5 text-xs ${canManage ? "cursor-pointer" : ""}`}
                >
                  <Checkbox
                    disabled={!canManage}
                    checked={effective.includes(s)}
                    onCheckedChange={(checked) => {
                      const next =
                        checked === true
                          ? [...effective, s]
                          : effective.filter((x) => x !== s);
                      if (next.length === 0)
                        return toast.error("At least one scope required", {
                          duration: 6000,
                        });
                      onUpdate({ scopes: next });
                    }}
                  />
                  {s}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Trust profile" hint={TRUST_HINT[c.trust]}>
            <Select
              size="xs"
              className="max-w-56"
              value={c.trust}
              disabled={!canManage}
              onChange={(e) => onUpdate({ trust: e.target.value })}
            >
              {TRUST_PROFILES.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, " ")}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : null}
    </div>
  );
}

function CreateClientModal({
  open,
  role,
  onClose,
  onCreated,
}: {
  open: boolean;
  role: Role;
  onClose(): void;
  onCreated(info: { name: string; token: string }): void;
}) {
  const grantable = ROLE_GRANTABLE_SCOPES[role];
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(
    ["read", "write"].filter((s) => grantable.includes(s as McpScope)),
  );
  const [trust, setTrust] = useState<string>("review_risky_actions");
  const create = useOp("mcpClient.create");

  return (
    <Modal open={open} onClose={onClose} title="New agent client">
      <div className="space-y-3">
        <Field label="Name">
          <Input
            value={name}
            autoFocus
            placeholder="e.g. Claude Code — laptop"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="Scopes"
          hint={`The agent acts with your permissions (${role}) — it can never exceed them.`}
        >
          <div className="flex flex-wrap gap-3">
            {grantable.map((s) => (
              <label
                key={s}
                className="flex cursor-pointer items-center gap-1.5 text-sm"
              >
                <Checkbox
                  checked={scopes.includes(s)}
                  onCheckedChange={(checked) =>
                    setScopes((prev) =>
                      checked === true
                        ? [...prev, s]
                        : prev.filter((x) => x !== s),
                    )
                  }
                />
                {s}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Trust profile" hint={TRUST_HINT[trust]}>
          <Select value={trust} onChange={(e) => setTrust(e.target.value)}>
            {TRUST_PROFILES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!name.trim() || scopes.length === 0 || create.isPending}
          onClick={() =>
            create.mutate(
              { name: name.trim(), scopes, trust },
              {
                onSuccess: (r) => {
                  const res = r as { client: McpClient; token: string };
                  onClose();
                  onCreated({ name: res.client.name, token: res.token });
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

function ConnectModal({
  info,
  onClose,
}: {
  info: { name: string; token: string };
  onClose(): void;
}) {
  return (
    <Modal open onClose={onClose} title={`Connect ${info.name}`} wide>
      <p className="mb-2 text-sm text-muted-foreground">
        This key is shown{" "}
        <span className="font-semibold text-foreground">once</span>. Copy it,
        then pick your client below — the snippet already has the key filled in,
        ready to paste.
      </p>
      <div className="flex items-center gap-2 rounded-lg bg-muted p-3">
        <code className="flex-1 font-mono text-xs break-all">{info.token}</code>
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          onClick={() => {
            navigator.clipboard.writeText(info.token);
            toast.success("Copied");
          }}
        >
          <Copy className="size-3.5" />
        </Button>
      </div>
      <div className="mt-4">
        <ConnectGuides apiKey={info.token} />
      </div>
      <div className="mt-4 flex justify-end">
        <Button size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
