import { deliveryCheckEvent } from "./zulip-checks";
import { failureAlertEvent, enqueueFailureAlert } from "./zulip-failures";
import { Env, now, uid, stmt, one, batch } from "./core";

export function zulipEnabled(env: Env) {
  return env.ENVIRONMENT === "production" && env.ZULIP_ENABLED === "true";
}
export function zulipEvent(
  env: Env,
  kind: "report" | "comment",
  id: string | number,
  revision?: number,
  byKey = false,
): D1PreparedStatement[] {
  if (!zulipEnabled(env)) return [];
  const eventId = uid();
  const createdAt = now();
  const ref = byKey ? "(SELECT id FROM reports WHERE create_key=?)" : "?";
  return [
    stmt(
      env.DB,
      `INSERT INTO outbox_events(id,type,aggregate_id,dedupe_key,payload,created_at)
     SELECT ?,'zulip',CAST(target AS TEXT),? || CAST(target AS TEXT) || ?,?,?
     FROM (SELECT ${ref} target)`,
      eventId,
      `zulip:${kind}:`,
      kind === "report" ? `:${revision}` : "",
      JSON.stringify({ kind, revision }),
      createdAt,
      id,
    ),
    deliveryCheckEvent(env, eventId, createdAt),
  ];
}
// Inline code suppresses Zulip Markdown and mention interpretation.
export function zulipText(value: string) {
  return (
    "`" +
    value
      .replace(/[\r\n\t]/g, " ")
      .replace(/`/g, "ˋ")
      .replace(/@/g, "＠") +
    "`"
  );
}
export async function deliverZulip(env: Env, event: any) {
  const db = env.DB;
  await stmt(
    db,
    "INSERT INTO zulip_deliveries(event_id) VALUES(?) ON CONFLICT DO NOTHING",
    event.id,
  ).run();
  const finish = async (status: string) =>
    batch(db, [
      stmt(
        db,
        "UPDATE zulip_deliveries SET status=?,lease_until=NULL WHERE event_id=?",
        status,
        event.id,
      ),
      stmt(
        db,
        "UPDATE outbox_events SET completed_at=? WHERE id=?",
        now(),
        event.id,
      ),
    ]);
  if (!zulipEnabled(env)) {
    await finish("cancelled");
    return;
  }
  const payload = JSON.parse(event.payload);
  const isComment = payload.kind === "comment";
  const row = await one(
    db,
    isComment
      ? `SELECT p.id,p.visibility,rr.title,cm.revision_no,cm.visibility comment_visibility,cm.deleted_at,u.username,cr.name crate,rel.version FROM report_comments cm JOIN reports p ON p.id=cm.report_id JOIN report_revisions rr ON rr.report_id=p.id AND rr.revision_no=cm.revision_no JOIN releases rel ON rel.id=p.release_id JOIN crates cr ON cr.id=rel.crate_id LEFT JOIN users u ON u.id=cm.author_id WHERE cm.id=?`
      : `SELECT p.id,p.visibility,rr.title,rr.revision_no,u.username,cr.name crate,rel.version FROM reports p JOIN report_revisions rr ON rr.report_id=p.id AND rr.revision_no=? JOIN releases rel ON rel.id=p.release_id JOIN crates cr ON cr.id=rel.crate_id LEFT JOIN users u ON u.id=p.author_id WHERE p.id=?`,
    ...(isComment
      ? [event.aggregate_id]
      : [payload.revision, event.aggregate_id]),
  );
  if (
    !row ||
    row.visibility !== "public" ||
    (isComment && (row.comment_visibility !== "public" || row.deleted_at))
  ) {
    await finish("cancelled");
    return;
  }
  const token = uid();
  const delivery = await stmt(
    db,
    `UPDATE zulip_deliveries SET status='sending',attempts=attempts+1,attempt_token=?,lease_until=? WHERE event_id=? AND attempts<8 AND (status IN ('pending','retry') OR (status='sending' AND lease_until<=?)) AND (next_attempt_at IS NULL OR next_attempt_at<=?) RETURNING attempts`,
    token,
    new Date(Date.now() + 60000).toISOString(),
    event.id,
    now(),
    now(),
  ).first<{ attempts: number }>();
  if (!delivery) {
    const old = await one(
      db,
      "SELECT * FROM zulip_deliveries WHERE event_id=?",
      event.id,
    );
    if (
      old.status === "sending" &&
      old.lease_until <= now() &&
      old.attempts >= 8
    ) {
      await batch(db, [
        stmt(
          db,
          "UPDATE zulip_deliveries SET status='failed',lease_until=NULL,last_error='lease_expired' WHERE event_id=? AND status='sending' AND lease_until<=? AND attempts>=8",
          event.id,
          now(),
        ),
        stmt(
          db,
          "UPDATE outbox_events SET completed_at=? WHERE id=? AND EXISTS(SELECT 1 FROM zulip_deliveries WHERE event_id=? AND status='failed')",
          now(),
          event.id,
          event.id,
        ),
        failureAlertEvent(env, event.id),
      ]);
      await enqueueFailureAlert(env, event.id);
    }
    return;
  }
  let error = "configuration",
    retry = false,
    delay = 60000 * 2 ** (delivery.attempts - 1);
  try {
    const site = new URL(env.ZULIP_SITE || "");
    if (
      site.protocol !== "https:" ||
      site.username ||
      site.password ||
      site.pathname !== "/" ||
      site.search ||
      site.hash ||
      !/^[1-9]\d*$/.test(env.ZULIP_CHANNEL_ID || "") ||
      !env.ZULIP_BOT_EMAIL ||
      !env.ZULIP_API_KEY
    )
      throw Error("configuration");
    const link = `${env.APP_ORIGIN}/report/${row.id}?${isComment ? `comment=${encodeURIComponent(event.aggregate_id)}` : `v=${row.revision_no}`}`;
    const action = isComment
      ? "New comment"
      : row.revision_no === 1
        ? "New report"
        : "Report updated";
    let response: Response;
    try {
      response = await fetch(new URL("/api/v1/messages", site), {
        method: "POST",
        // Workers supports manual/follow only; reject 3xx below without forwarding credentials.
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Basic ${btoa(`${env.ZULIP_BOT_EMAIL}:${env.ZULIP_API_KEY}`)}`,
        },
        body: new URLSearchParams({
          type: "stream",
          to: env.ZULIP_CHANNEL_ID!,
          topic: `Report #${row.id}`,
          content: `${action} by ${zulipText(row.username || "ghost")}: ${zulipText(row.title)}\n${zulipText(row.crate)} ${zulipText(row.version)} · revision ${row.revision_no}\n[View ${isComment ? "comment" : "report"}](${link})`,
        }),
      });
    } catch {
      retry = true;
      error = "network";
      throw Error(error);
    }
    error = `http_${response.status}`;
    retry = response.status === 429 || response.status >= 500;
    const after = response.headers.get("Retry-After");
    if (after) {
      const ms = /^\d+(\.\d+)?$/.test(after)
        ? Number(after) * 1000
        : Date.parse(after) - Date.now();
      if (Number.isFinite(ms)) delay = Math.max(delay, ms);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(error);
    }
    retry = true;
    error = "invalid_response";
    const result: any = await response.json();
    if (result.result !== "success" || !Number.isInteger(result.id))
      throw Error(error);
    error = "persistence";
    await batch(db, [
      stmt(
        db,
        "UPDATE zulip_deliveries SET status='sent',message_id=?,lease_until=NULL,last_error=NULL WHERE event_id=? AND attempt_token=?",
        result.id,
        event.id,
        token,
      ),
      stmt(
        db,
        "UPDATE outbox_events SET completed_at=? WHERE id=?",
        now(),
        event.id,
      ),
    ]);
    console.log(
      JSON.stringify({
        event_id: event.id,
        attempt: delivery.attempts,
        result: "zulip_sent",
      }),
    );
    return;
  } catch {
    const status = retry && delivery.attempts < 8 ? "retry" : "failed";
    await batch(db, [
      stmt(
        db,
        "UPDATE zulip_deliveries SET status=?,next_attempt_at=?,lease_until=NULL,last_error=? WHERE event_id=? AND attempt_token=?",
        status,
        new Date(Date.now() + delay).toISOString(),
        error,
        event.id,
        token,
      ),
      ...(status === "failed"
        ? [
            failureAlertEvent(env, event.id),
            stmt(
              db,
              "UPDATE outbox_events SET completed_at=? WHERE id=?",
              now(),
              event.id,
            ),
          ]
        : []),
    ]);
    console.log(
      JSON.stringify({
        event_id: event.id,
        attempt: delivery.attempts,
        result: `zulip_${status}`,
        error,
      }),
    );
    if (status === "failed") await enqueueFailureAlert(env, event.id);
  }
}
