/**
 * Client data layer: one generic `callOp` + React Query helpers.
 * Query keys are ["op", name, input]; invalidation works by entity prefix
 * (e.g. changing a company invalidates every ["op", "company.*"] query plus
 * cross-cutting stats/search/activity keys).
 */
import { queryOptions, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { OpResult } from "@emcp/core";
import { toast } from "sonner";
import { op } from "~/server/fns.ts";

export class OpFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OpFailure";
  }
}

export async function callOp<T = unknown>(name: string, input: unknown = {}): Promise<T> {
  const result = JSON.parse(await op({ data: { name, input } })) as OpResult;
  if (result.status === "ok") return result.data as T;
  if (result.status === "pending_approval") {
    // Humans run ops directly; this only happens for exotic role setups.
    throw new OpFailure("pending_approval", result.message);
  }
  throw new OpFailure(result.error.code, result.error.message, result.error.details);
}

export function opQuery<T = unknown>(name: string, input: unknown = {}) {
  return queryOptions<T>({
    queryKey: ["op", name, input] as const,
    queryFn: () => callOp<T>(name, input),
    staleTime: 5_000,
  });
}

/** Entity prefix of an operation name: "company.create" → "company". */
function prefixOf(name: string): string {
  return name.split(".")[0] ?? name;
}

/** Which query prefixes must refetch after a mutation on `prefix`. */
const INVALIDATION_GRAPH: Record<string, string[]> = {
  company: ["company", "search", "stats", "audit", "activity", "tag", "list"],
  person: ["person", "company", "search", "stats", "audit", "activity", "tag", "list"],
  engagement: ["engagement", "company", "person", "search", "stats", "audit", "activity", "tag", "list"],
  deal: ["deal", "company", "person", "search", "stats", "audit", "activity", "tag", "list"],
  activity: ["activity", "engagement", "deal", "company", "person", "stats", "audit"],
  task: ["activity", "task", "stats", "audit"],
  offering: ["offering", "engagement", "deal", "audit"],
  pipeline: ["pipeline", "engagement", "deal", "stats", "audit"],
  stage: ["pipeline", "engagement", "deal", "stats", "audit"],
  tag: ["tag", "company", "person", "engagement", "deal", "audit"],
  list: ["list", "company", "person", "engagement", "deal", "audit"],
  customField: ["customField", "company", "person", "engagement", "deal", "audit"],
  savedView: ["savedView"],
  pendingAction: ["pendingAction", "stats", "audit", "company", "person", "engagement", "deal", "activity", "whoami"],
  bulk: ["company", "person", "engagement", "deal", "stats", "audit", "tag", "list"],
  import: ["company", "person", "engagement", "tag", "list", "stats", "audit"],
  user: ["user", "audit", "whoami"],
  mcpClient: ["mcpClient", "audit"],
  workspace: ["workspace", "whoami", "audit", "stats"],
  export: ["audit"],
  data: ["audit"],
  audit: [],
  search: [],
  stats: [],
};

export function invalidateAfter(queryClient: QueryClient, opName: string): void {
  const targets = new Set(INVALIDATION_GRAPH[prefixOf(opName)] ?? [prefixOf(opName)]);
  targets.add("stats"); // stats views are cheap and everywhere
  void queryClient.invalidateQueries({
    predicate: (query) => {
      const key = query.queryKey;
      if (key[0] === "whoami") return targets.has("whoami");
      if (key[0] !== "op" || typeof key[1] !== "string") return false;
      return targets.has(prefixOf(key[1]));
    },
  });
}

/** Standard mutation hook: runs an operation, invalidates, toasts errors. */
export function useOp<TInput = Record<string, unknown>, TOut = unknown>(
  name: string,
  opts: { onSuccess?: (data: TOut) => void; successToast?: string; silent?: boolean; invalidate?: boolean } = {},
) {
  const queryClient = useQueryClient();
  return useMutation<TOut, Error, TInput>({
    mutationFn: (input: TInput) => callOp<TOut>(name, input),
    onSuccess: (data) => {
      if (opts.invalidate !== false) invalidateAfter(queryClient, name);
      if (opts.successToast) toast.success(opts.successToast);
      opts.onSuccess?.(data);
    },
    onError: (error) => {
      if (!opts.silent) toast.error(error.message, { duration: 6000 });
    },
  });
}
