import { useQuery } from "@tanstack/react-query";
import { type Auth, whoamiQuery } from "~/routes/__root.tsx";

export function useIsAdmin(): boolean {
  const auth = useQuery(whoamiQuery).data as Auth | undefined;
  return auth?.role === "owner" || auth?.role === "admin";
}
