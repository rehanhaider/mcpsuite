/**
 * Hosted (Postgres) runtime. Unlike the SQLite `createRuntime`, this factory
 * is async (pool + driver load) and performs NO bootstrap: hosted workspaces
 * are provisioned exclusively through the hosting-control API
 * (`provisionPgWorkspace`), never on process boot — a fresh hosted deployment
 * legitimately starts with zero workspaces.
 */
import {
  buildCatalog,
  runOperation,
  type Catalog,
  type OpResult,
  type Ports,
  type RequestContext,
} from "@emcp/core";
import { authServices, csvServices } from "../services.ts";
import {
  connectPg,
  createPgPorts,
  type PgConnectOptions,
  type PgHandle,
} from "./repositories.ts";

export interface PgRuntime {
  handle: PgHandle;
  catalog: Catalog;
  portsFor(workspaceId: string): Ports;
  run(ctx: RequestContext, operation: string, input: unknown): Promise<OpResult>;
  close(): Promise<void>;
}

export async function createPgRuntime(options: PgConnectOptions): Promise<PgRuntime> {
  const handle = await connectPg(options);
  const catalog = buildCatalog({ auth: authServices, csv: csvServices });
  // PgPorts is structurally assignable to the async Ports contract.
  const portsFor = (workspaceId: string) => createPgPorts(handle.db, workspaceId) as unknown as Ports;
  return {
    handle,
    catalog,
    portsFor,
    run: (ctx, operation, input) => runOperation(catalog, portsFor(ctx.workspaceId), ctx, operation, input),
    close: () => handle.close(),
  };
}
