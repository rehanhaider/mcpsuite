import type { ActorType, User } from "@mcpsuite/core/domain";

export function actorUserName(
  actorType: ActorType,
  id: string | null,
  users: Pick<User, "id" | "name">[] | undefined,
): string | null {
  if (users === undefined) return null;
  if (id == null) return actorType === "human" || actorType === "agent" ? "Deleted user" : null;
  return users.find((user) => user.id === id)?.name ?? "Deleted user";
}
