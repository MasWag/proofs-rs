import { Env, batch, now, one, stmt } from "./core";
import { failureAlertEvent, enqueueFailureAlert } from "./zulip-failures";

const CHECK_AFTER_MS = 15 * 60 * 1000;

// Persist the scheduled check in the same transaction as the source event.
export function deliveryCheckEvent(
  env: Env,
  eventId: string,
  createdAt: string,
) {
  const dueAt = new Date(Date.parse(createdAt) + CHECK_AFTER_MS).toISOString();
  return stmt(
    env.DB,
    `INSERT INTO outbox_events(id,type,aggregate_id,dedupe_key,payload,created_at)
    VALUES(?,'zulip_check',?,?,?,?)`,
    `zulip-check:${eventId}`,
    eventId,
    `zulip-check:${eventId}`,
    JSON.stringify({ due_at: dueAt }),
    createdAt,
  );
}

export function deliveryCheckDelay(event: { payload: string }) {
  const dueAt = Date.parse(JSON.parse(event.payload).due_at);
  if (!Number.isFinite(dueAt)) throw Error("Invalid Zulip check deadline");
  return Math.min(900, Math.max(0, Math.ceil((dueAt - Date.now()) / 1000)));
}

// One logical check per event. Duplicate queue deliveries are harmless.
export async function checkZulipDelivery(
  env: Env,
  event: any,
): Promise<number | undefined> {
  const db = env.DB;
  const complete = () =>
    stmt(
      db,
      "UPDATE outbox_events SET completed_at=? WHERE id=?",
      now(),
      event.id,
    ).run();
  if (env.ENVIRONMENT !== "production" || env.ZULIP_ENABLED !== "true") {
    await complete();
    return;
  }
  const delay = deliveryCheckDelay(event);
  if (delay) return delay;
  const source = await one(
    db,
    `SELECT e.*,d.status delivery_status,d.alert_sent_at FROM outbox_events e
     LEFT JOIN zulip_deliveries d ON d.event_id=e.id WHERE e.id=? AND e.type='zulip'`,
    event.aggregate_id,
  );
  if (
    !source ||
    source.alert_sent_at ||
    ["sent", "cancelled"].includes(source.delivery_status)
  ) {
    await complete();
    return;
  }
  const payload = JSON.parse(source.payload);
  const visible = await one(
    db,
    payload.kind === "comment"
      ? `SELECT 1 FROM report_comments cm JOIN reports p ON p.id=cm.report_id
       WHERE cm.id=? AND p.visibility='public' AND cm.visibility='public' AND cm.deleted_at IS NULL`
      : "SELECT 1 FROM reports WHERE id=? AND visibility='public'",
    source.aggregate_id,
  );
  if (!visible) {
    await complete();
    return;
  }
  await batch(db, [
    stmt(
      db,
      "INSERT INTO zulip_deliveries(event_id) VALUES(?) ON CONFLICT DO NOTHING",
      source.id,
    ),
    failureAlertEvent(env, source.id, true),
    stmt(
      db,
      "UPDATE outbox_events SET completed_at=? WHERE id=?",
      now(),
      event.id,
    ),
  ]);
  // This job is independent of the source delivery; it may still succeed later.
  await enqueueFailureAlert(env, source.id);
}
