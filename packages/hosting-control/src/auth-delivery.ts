/**
 * Hosting-control's side of the product auth-code seams (@emcp/db openauth):
 *
 *   - `issueAuthCodeSync(db, { userId, purpose })` issues a REDEEMABLE
 *     single-use code (hash-at-rest, supersedes earlier codes; "reset" also
 *     ends the user's sessions). It joins an open transaction via a
 *     savepoint, so lifecycle code calls it inside the mutation transaction.
 *   - `deliverAuthCode({ email, code, purpose })` honors
 *     EMCP_AUTH_DELIVERY_URL (hosted: POST as JSON, optional
 *     `Authorization: Bearer EMCP_AUTH_DELIVERY_KEY`) and falls back to
 *     display mode when unset — the caller may then surface the code exactly
 *     once. Codes are never logged in either mode.
 *
 * This module adds the hosting-side outbox worker that makes hosted delivery
 * crash-safe: a committed `hc_auth_delivery_outbox` row (user reference +
 * purpose — never an email or a code) is the durable acknowledgement, and
 * pending rows are re-sent with a freshly issued code.
 */
import { deliverAuthCode, issueAuthCodeSync, type Db } from "@emcp/db";
import { listPendingOutbox, markOutbox } from "./hc-store.ts";

export type DeliveryMode = "hosted" | "display";

/** Hosted when a delivery URL is configured; display (show-once) otherwise. */
export function deliveryMode(): DeliveryMode {
  return process.env.EMCP_AUTH_DELIVERY_URL?.trim() ? "hosted" : "display";
}

interface OutboxUserRow {
  email: string;
  disabled_at: string | null;
  status?: string;
}

/**
 * Deliver every committed-but-unsent outbox row. Runs at server start (and is
 * exported for tests/operators) so an acknowledged `201`/`202` can never lose
 * its email to a process crash — the contract's outbox rule.
 *
 * Because raw codes never enter storage, a retried row gets a FRESH code at
 * send time (issued through the CRM code store, superseding the original).
 * Display mode leaves rows pending (there is no channel to push to). Rows
 * whose user vanished or was disabled are abandoned. Never throws; never
 * logs codes.
 */
export async function retryPendingAuthDeliveries(db: Db): Promise<{ attempted: number; sent: number }> {
  let attempted = 0;
  let sent = 0;
  if (deliveryMode() !== "hosted") return { attempted, sent };
  let rows;
  try {
    rows = listPendingOutbox(db);
  } catch (err) {
    console.error("[hosting-control] could not read the auth-delivery outbox:", err);
    return { attempted, sent };
  }
  for (const row of rows) {
    attempted++;
    try {
      const user = db.$client
        .prepare("SELECT * FROM users WHERE id = ?")
        .get(row.userId) as OutboxUserRow | undefined;
      if (!user || user.disabled_at != null || user.status === "disabled") {
        markOutbox(db, row.id, "abandoned", "user unavailable");
        continue;
      }
      const { code } = issueAuthCodeSync(db, { userId: row.userId, purpose: row.purpose });
      await deliverAuthCode({ email: user.email, code, purpose: row.purpose });
      markOutbox(db, row.id, "sent");
      sent++;
    } catch (err) {
      try {
        markOutbox(db, row.id, "pending", errorNote(err));
      } catch {
        /* keep sweeping */
      }
    }
  }
  return { attempted, sent };
}

/** Bounded, secret-free note for the outbox row. */
export function errorNote(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 200);
}
