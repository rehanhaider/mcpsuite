import { useQuery } from "@tanstack/react-query";
import { type Auth, whoamiQuery } from "~/routes/__root.tsx";

/**
 * Whether the signed-in user's role may run a catalog operation. The list
 * comes from `whoami`, computed from the catalog's role floors, so controls
 * follow the server rule instead of a copy of it.
 */
export function useCanRun(): (operation: string) => boolean {
  const auth = useQuery(whoamiQuery).data as Auth | undefined;
  const allowed = new Set(auth?.operations ?? []);
  return (operation) => allowed.has(operation);
}
