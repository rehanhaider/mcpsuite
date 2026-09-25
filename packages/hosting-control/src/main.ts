/**
 * Boot the hosting control API from the environment.
 *
 *   HC_SERVICE_KEY            required, >= 32 chars — no keyless mode
 *   HC_SERVICE_KEY_SECONDARY  optional second key for overlapping rotation
 *   HC_HOST                   default 127.0.0.1 (keep it on the private network)
 *   HC_PORT                   default 8787
 *   DATABASE_URL              postgresql://… → the PostgreSQL adapter, connected
 *                             with hosting control's OWN crm_operator credential
 *                             (never crm_app, never a superuser); unset or file: →
 *                             the shared CRM SQLite file (DB_PATH, mise sets it)
 *   MCPSUITE_AUTH_DELIVERY_URL    hosted mode: setup/reset codes POST here and
 *                             never appear in responses or logs; unset =
 *                             display mode (the response may show a code once)
 *   MCPSUITE_AUTH_DELIVERY_KEY    optional bearer key for the delivery endpoint
 *
 * Normal self-hosted installations do not start this process.
 */
import { createHostingStoreFromEnv } from "@mcpsuite/db";
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

const { store } = await createHostingStoreFromEnv(process.env);
const hc = createHostingControlServer({ store, serviceKeys, host, port });
const address = await hc.listen();
console.log(
  `[hosting-control] listening on http://${address.host}:${address.port}/api/v1 ` +
    `(${store.adapter}; private network only — never route this from the public domain)`,
);
