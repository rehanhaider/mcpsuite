/**
 * Hosting-control's side of the product auth-code seams:
 *
 *   - `store.identity.issueCode(workspaceId, userId, purpose)` issues a
 *     REDEEMABLE single-use code (hash-at-rest, supersedes earlier codes;
 *     "reset" also ends the user's sessions). It joins the request's open
 *     transaction, so lifecycle code calls it inside the mutation transaction.
 *   - `deliverAuthCode({ email, code, purpose })` honors
 *     MCPSUITE_AUTH_DELIVERY_URL (hosted: POST as JSON, optional
 *     `Authorization: Bearer MCPSUITE_AUTH_DELIVERY_KEY`) and falls back to
 *     display mode when unset — the caller may then surface the code exactly
 *     once. Codes are never logged in either mode.
 *
 * This module adds the hosting-side outbox worker that makes hosted delivery
 * crash-safe: a committed outbox row (user reference + purpose — never an
 * email or a code) is the durable acknowledgement, and pending rows are
 * re-sent with a freshly issued code.
 */
import { deliverAuthCode, type HostingStore } from "@mcpsuite/db";

export type DeliveryMode = "hosted" | "display";

/** Hosted when a delivery URL is configured; display (show-once) otherwise. */
export function deliveryMode(): DeliveryMode {
  return process.env.MCPSUITE_AUTH_DELIVERY_URL?.trim() ? "hosted" : "display";
}

/**
 * Deliver every committed-but-unsent outbox row. Runs at server start (and is
 * exported for tests/operators) so an acknowledged `201`/`202` can never lose
 * its email to a process crash — the contract's outbox rule.
 *
 * Because raw codes never enter storage, a retried row gets a FRESH code at
 * send time (issued through the CRM code store, superseding the original).
 * The code is issued in its own transaction and delivered after it commits.
 * Display mode leaves rows pending (there is no channel to push to). Rows
 * whose user vanished or was disabled are abandoned. Never throws; never
 * logs codes.
 */
export async function retryPendingAuthDeliveries(store: HostingStore): Promise<{ attempted: number; sent: number }> {
  let attempted = 0;
  let sent = 0;
  if (deliveryMode() !== "hosted") return { attempted, sent };
  let rows;
  try {
    rows = await store.listPendingOutbox();
  } catch (err) {
    console.error("[hosting-control] could not read the auth-delivery outbox:", err);
    return { attempted, sent };
  }
  for (const row of rows) {
    attempted++;
    try {
      const issued = await store.withTransaction(async () => {
        const user = await store.memberForDelivery(row.workspaceId, row.userId);
        if (!user || user.disabledAt != null || user.status === "disabled") return null;
        const { code } = await store.identity.issueCode(row.workspaceId, row.userId, row.purpose);
        return { email: user.email, code };
      });
      if (!issued) {
        await store.markOutbox(row.id, "abandoned", "user unavailable");
        continue;
      }
      await deliverAuthCode({ email: issued.email, code: issued.code, purpose: row.purpose });
      await store.markOutbox(row.id, "sent");
      sent++;
    } catch (err) {
      try {
        await store.markOutbox(row.id, "pending", errorNote(err));
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
