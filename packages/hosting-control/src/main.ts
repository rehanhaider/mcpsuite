/**
 * Boot the hosting control API from the environment.
 *
 *   HC_SERVICE_KEY            required, >= 32 chars — no keyless mode
 *   HC_SERVICE_KEY_SECONDARY  optional second key for overlapping rotation
 *   HC_HOST                   default 127.0.0.1 (keep it on the private network)
 *   HC_PORT                   default 8787
 *   DB_PATH                   the shared CRM SQLite file (mise sets it)
 *
 * Normal self-hosted installations do not start this process.
 */
import { getDb } from "@emcp/db";
import { createHostingControlServer } from "./server.ts";

const primary = process.env.HC_SERVICE_KEY?.trim();
if (!primary || primary.length < 32) {
  console.error(
    "[hosting-control] HC_SERVICE_KEY is required (at least 32 characters of random data). " +
      "There is no keyless mode. Refusing to start.",
  );
  process.exit(1);
}
const serviceKeys = [primary];
const secondary = process.env.HC_SERVICE_KEY_SECONDARY?.trim();
if (secondary && secondary.length >= 32) serviceKeys.push(secondary);

const host = process.env.HC_HOST ?? "127.0.0.1";
const port = Number(process.env.HC_PORT ?? 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`[hosting-control] invalid HC_PORT: ${process.env.HC_PORT}`);
  process.exit(1);
}

const hc = createHostingControlServer({ db: getDb(), serviceKeys, host, port });
const address = await hc.listen();
console.log(
  `[hosting-control] listening on http://${address.host}:${address.port}/api/v1 ` +
    "(private network only — never route this from the public domain)",
);
