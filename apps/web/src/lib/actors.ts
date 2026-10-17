import type { User } from "@mcpsuite/core/domain";

export function actorUserName(
  id: string | null,
  users: Pick<User, "id" | "name">[] | undefined,
): string | null {
  if (id == null || users === undefined) return null;
  return users.find((user) => user.id === id)?.name ?? "Deleted user";
}
