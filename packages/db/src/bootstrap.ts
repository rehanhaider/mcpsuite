/**
 * First-run seeding: one workspace, one PENDING owner user, and default
 * pipelines. Idempotent — safe to run on every process start.
 *
 * The owner is created without any credential (docs/issues/0022): bootstrap
 * issues a one-time SETUP CODE (returned once, printed by the caller) with
 * which the owner sets their own password at /set-password. There is no
 * generated password and no EMCP_OWNER_PASSWORD support — an owner password
 * must never transit environment variables.
 */
import { eq } from "drizzle-orm";
import { newId, nowIso, DEFAULT_WORKSPACE_SETTINGS, type SemanticColor } from "@emcp/core";
import type { Db } from "./connection.ts";
import * as t from "./schema.ts";
import { issueAuthCodeSync } from "./openauth.ts";

export interface BootstrapResult {
  workspaceId: string;
  ownerUserId: string;
  /**
   * Set ONLY when the owner user was created this run: the one-time setup
   * code for /set-password. Surfaced exactly once by the caller's printer and
   * regenerable via `pnpm --filter @emcp/db reset-owner`. Bootstrap never
   * creates or prints a password (docs/issues/0022).
   */
  ownerSetupCode: string | null;
  createdWorkspace: boolean;
  /** True when the owner user was created this run. */
  createdOwner: boolean;
  /** The owner's login email when created this run, else null. */
  ownerEmail: string | null;
}

interface StageSeed {
  name: string;
  color: SemanticColor;
  probability?: number;
  outcome?: "won" | "lost";
}

export const DEFAULT_ENGAGEMENT_STAGES: StageSeed[] = [
  { name: "New", color: "ghost" },
  { name: "Invited", color: "info" },
  { name: "Responded", color: "warning" },
  { name: "Engaged", color: "primary" },
  { name: "Qualified", color: "success" },
  { name: "On Hold", color: "neutral" },
  { name: "Declined", color: "error", outcome: "lost" },
];

export const DEFAULT_DEAL_STAGES: StageSeed[] = [
  { name: "Discovery", color: "info", probability: 10 },
  { name: "Scoping", color: "primary", probability: 25 },
  { name: "Proposal", color: "secondary", probability: 40 },
  { name: "Negotiation", color: "warning", probability: 60 },
  { name: "Verbal Yes", color: "accent", probability: 80 },
  { name: "Won", color: "success", probability: 100, outcome: "won" },
  { name: "Lost", color: "error", probability: 0, outcome: "lost" },
];

export interface BootstrapOptions {
  workspaceName?: string;
  ownerEmail?: string;
  ownerName?: string;
  defaultCurrency?: string;
  timezone?: string;
}

export function bootstrap(db: Db, opts: BootstrapOptions = {}): BootstrapResult {
  const now = nowIso();

  let createdWorkspace = false;
  let workspace = db.select().from(t.workspaces).get();
  if (!workspace) {
    const id = newId();
    db.insert(t.workspaces)
      .values({
        id,
        name: opts.workspaceName ?? process.env.EMCP_WORKSPACE_NAME ?? "EMCP",
        defaultCurrency: opts.defaultCurrency ?? "USD",
        timezone: opts.timezone ?? process.env.TZ ?? "Asia/Kolkata",
        settings: JSON.stringify(DEFAULT_WORKSPACE_SETTINGS),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    workspace = db.select().from(t.workspaces).where(eq(t.workspaces.id, id)).get()!;
    createdWorkspace = true;
  }
  const workspaceId = workspace.id;

  // Owner user: created PENDING with a one-time setup code, never a password.
  let ownerSetupCode: string | null = null;
  let createdOwner = false;
  let ownerEmail: string | null = null;
  let owner = db
    .select({ userId: t.memberships.userId })
    .from(t.memberships)
    .where(eq(t.memberships.role, "owner"))
    .get();
  if (!owner) {
    const userId = newId();
    const email = (opts.ownerEmail ?? process.env.EMCP_OWNER_EMAIL ?? "owner@emcp.local").toLowerCase();
    const name = opts.ownerName ?? process.env.EMCP_OWNER_NAME ?? "Owner";
    createdOwner = true;
    ownerEmail = email;
    db.insert(t.users)
      .values({ id: userId, email, name, passwordHash: null, status: "pending", createdAt: now, updatedAt: now })
      .run();
    db.insert(t.memberships).values({ id: newId(), workspaceId, userId, role: "owner", createdAt: now }).run();
    owner = { userId };
    ownerSetupCode = issueAuthCodeSync(db, { userId, purpose: "setup" }).code;
  }

  // Default pipelines
  const seedPipeline = (type: "engagement" | "deal", name: string, stages: StageSeed[]): void => {
    const existing = db.select().from(t.pipelines).where(eq(t.pipelines.type, type)).get();
    if (existing) return;
    const pipelineId = newId();
    db.insert(t.pipelines)
      .values({ id: pipelineId, workspaceId, type, name, isDefault: 1, position: 0, createdAt: nowIso() })
      .run();
    stages.forEach((s, i) => {
      db.insert(t.stages)
        .values({
          id: newId(),
          workspaceId,
          pipelineId,
          name: s.name,
          color: s.color,
          position: i,
          probability: s.probability ?? null,
          outcome: s.outcome ?? null,
        })
        .run();
    });
  };
  seedPipeline("engagement", "Outreach", DEFAULT_ENGAGEMENT_STAGES);
  seedPipeline("deal", "Sales", DEFAULT_DEAL_STAGES);

  return { workspaceId, ownerUserId: owner.userId, ownerSetupCode, createdWorkspace, createdOwner, ownerEmail };
}
