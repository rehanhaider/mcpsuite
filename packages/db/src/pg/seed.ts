/**
 * Seed one PostgreSQL workspace with a signed-out owner, through the real
 * adapter path only — no hand-written SQL. PostgreSQL has no first-boot
 * setup (hosted workspaces come from hosting control, #5), so this is how a
 * test or a development database gets its first user until then:
 *
 *   1. provisionPgWorkspace — inserts only the workspaces row;
 *   2. ports.users.create    — the owner, role owner, with its membership;
 *   3. identity.issueCode     — a setup code for the owner.
 *
 * `users.create` inserts an ACTIVE user with no sign-in identity linked, so
 * redeeming the code and signing in exercises the owner-recovery path
 * (activation by `resolveAuthSuccess`), not first-time setup of a pending
 * owner.
 */
import { connectPg, createPgPorts, provisionPgWorkspace } from "./repositories.ts";
import { createPgIdentity } from "./identity.ts";

export interface SeededPgWorkspace {
  workspaceId: string;
  userId: string;
  email: string;
  setupCode: string;
}

export async function seedPgWorkspaceWithOwner(
  databaseUrl: string,
  input: { workspaceName: string; ownerEmail: string; ownerName: string },
): Promise<SeededPgWorkspace> {
  const handle = await connectPg({ databaseUrl, max: 1 });
  try {
    const workspaceId = await provisionPgWorkspace(handle.db, { name: input.workspaceName });
    const owner = await createPgPorts(handle.db, workspaceId).users.create({
      name: input.ownerName,
      email: input.ownerEmail,
      role: "owner",
      passwordHash: null,
    });
    const { code } = await createPgIdentity(handle.db).issueCode(workspaceId, owner.id, "setup");
    return { workspaceId, userId: owner.id, email: owner.email, setupCode: code };
  } finally {
    await handle.close();
  }
}
