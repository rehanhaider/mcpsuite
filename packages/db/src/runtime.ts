/**
 * One-stop wiring for adapters (web server functions, MCP transports):
 * database + catalog + per-request ports.
 */
import {
  buildCatalog,
  runOperation,
  type Catalog,
  type OpResult,
  type Ports,
  type RequestContext,
} from "@emcp/core";
import { getDb, type Db } from "./connection.ts";
import { createPorts } from "./repositories.ts";
import { bootstrap, type BootstrapResult } from "./bootstrap.ts";
import { authServices, csvServices } from "./services.ts";

export interface Runtime {
  db: Db;
  catalog: Catalog;
  bootstrapResult: BootstrapResult;
  portsFor(workspaceId: string): Ports;
  run(ctx: RequestContext, operation: string, input: unknown): OpResult;
}

let singleton: Runtime | null = null;

export function createRuntime(db: Db = getDb()): Runtime {
  const catalog = buildCatalog({ auth: authServices, csv: csvServices });
  const bootstrapResult = bootstrap(db);
  if (bootstrapResult.ownerOneTimePassword) {
    // Shown once, on the very first boot against an empty database.
    console.log(
      `\n[emcp] Created owner account — email: ${process.env.EMCP_OWNER_EMAIL ?? "owner@emcp.local"} ` +
        `password: ${bootstrapResult.ownerOneTimePassword}\n[emcp] Change it after first login.\n`,
    );
  }
  return {
    db,
    catalog,
    bootstrapResult,
    portsFor: (workspaceId: string) => createPorts(db, workspaceId),
    run(ctx, operation, input) {
      return runOperation(catalog, this.portsFor(ctx.workspaceId), ctx, operation, input);
    },
  };
}

/** Process-wide runtime (web SSR / MCP server each hold one). */
export function getRuntime(): Runtime {
  if (!singleton) singleton = createRuntime();
  return singleton;
}
