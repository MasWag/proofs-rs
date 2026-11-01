import { Env, batch, now, one, stmt, uid } from "./core";

// Commit the alert with the failed delivery, before acknowledging the original job.
export function failureAlertEvent(env: Env, eventId: string, overdue = false) {
  return stmt(
    env.DB,
    `INSERT INTO outbox_events(id,type,aggregate_id,dedupe_key,payload,created_at)
    SELECT ?,'zulip_failure',event_id,?,?,? FROM zulip_deliveries
    WHERE event_id=? AND (status='failed' OR (?=1 AND status IN ('pending','retry','sending'))) ON CONFLICT DO NOTHING`,
    `zulip-failure:${eventId}`,
    `zulip-failure:${eventId}`,
    JSON.stringify(overdue ? { reason: "overdue" } : {}),
    now(),
    eventId,
    overdue ? 1 : 0,
  );
}

export async function enqueueFailureAlert(env: Env, eventId: string) {
  try {
    await env.JOBS.send({ event_id: `zulip-failure:${eventId}` });
  } catch {
    // The durable outbox lets the existing dispatcher recover a failed enqueue.
    console.error(
      JSON.stringify({
        event_id: eventId,
        result: "zulip_alert_enqueue_failed",
      }),
    );
  }
}

export async function deliverFailureAlert(env: Env, event: any) {
  const db = env.DB;
  const complete = () =>
    stmt(
      db,
      "UPDATE outbox_events SET completed_at=? WHERE id=?",
      now(),
      event.id,
    ).run();
  // Alerting does not depend on ZULIP_ENABLED: disabling Zulip must not hide a failure.
  if (env.ENVIRONMENT !== "production") {
    await complete();
    return;
  }
  const source = await one(
    db,
    `SELECT e.aggregate_id,e.payload,d.* FROM outbox_events e
    JOIN zulip_deliveries d ON d.event_id=e.id WHERE e.id=?`,
    event.aggregate_id,
  );
  const overdue = JSON.parse(event.payload).reason === "overdue";
  if (
    !source ||
    source.alert_sent_at ||
    (overdue
      ? env.ZULIP_ENABLED !== "true" ||
        !["pending", "retry", "sending", "failed"].includes(source.status)
      : source.status !== "failed")
  ) {
    await complete();
    return;
  }
  const token = uid();
  const claim = await stmt(
    db,
    `UPDATE zulip_deliveries SET alert_attempts=alert_attempts+1,alert_token=?,alert_lease_until=?
    WHERE event_id=? AND (status='failed' OR (?=1 AND status IN ('pending','retry','sending')))
    AND alert_sent_at IS NULL AND alert_attempts<8
    AND (alert_lease_until IS NULL OR alert_lease_until<=?)
    AND (alert_next_attempt_at IS NULL OR alert_next_attempt_at<=?) RETURNING alert_attempts`,
    token,
    new Date(Date.now() + 60000).toISOString(),
    event.aggregate_id,
    overdue ? 1 : 0,
    now(),
    now(),
  ).first<{ alert_attempts: number }>();
  if (!claim) {
    if (
      source.alert_attempts >= 8 &&
      (!source.alert_lease_until || source.alert_lease_until <= now())
    ) {
      await complete();
      console.error(
        JSON.stringify({
          event_id: event.aggregate_id,
          result: "zulip_alert_failed",
          error: source.alert_error || "lease_expired",
        }),
      );
    }
    return;
  }
  let error = "configuration",
    retry = false,
    delay = 60000 * 2 ** (claim.alert_attempts - 1);
  try {
    const url = new URL(env.ZULIP_FAILURE_WEBHOOK_URL || "");
    if (
      url.origin !== "https://discord.com" ||
      url.username ||
      url.password ||
      !/^\/api\/webhooks\/\d+\/[\w-]+$/.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw Error("configuration");
    url.searchParams.set("wait", "true");
    const payload = JSON.parse(source.payload);
    const reportId =
      payload.kind === "report"
        ? Number(source.aggregate_id)
        : (
            await one(
              db,
              "SELECT report_id FROM report_comments WHERE id=?",
              source.aggregate_id,
            )
          )?.report_id;
    const safeError =
      /^(configuration|network|invalid_response|persistence|lease_expired|http_\d{3})$/.test(
        source.last_error || "",
      )
        ? source.last_error
        : "unknown";
    const content = [
      overdue && source.status !== "failed"
        ? "Zulip delivery still unsent after 15 minutes"
        : "Zulip delivery failed",
      `Event: ${source.event_id}`,
      `Kind: ${payload.kind === "comment" ? "comment" : "report"}`,
      ...(reportId ? [`Report: ${env.APP_ORIGIN}/report/${reportId}`] : []),
      ...(Number.isInteger(payload.revision)
        ? [`Revision: ${payload.revision}`]
        : []),
      `Attempts: ${source.attempts}`,
      `Error: ${safeError}`,
    ].join("\n");
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowed_mentions: { parse: [] }, content }),
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
    if (typeof result.id !== "string" || !/^\d+$/.test(result.id))
      throw Error(error);
    error = "persistence";
    await batch(db, [
      stmt(
        db,
        `UPDATE zulip_deliveries SET alert_sent_at=?,alert_lease_until=NULL,alert_error=NULL
      WHERE event_id=? AND alert_token=?`,
        now(),
        event.aggregate_id,
        token,
      ),
      stmt(
        db,
        `UPDATE outbox_events SET completed_at=? WHERE id=? AND EXISTS
        (SELECT 1 FROM zulip_deliveries WHERE event_id=? AND alert_token=? AND alert_sent_at IS NOT NULL)`,
        now(),
        event.id,
        event.aggregate_id,
        token,
      ),
    ]);
    console.log(
      JSON.stringify({
        event_id: event.aggregate_id,
        result: "zulip_alert_sent",
      }),
    );
  } catch {
    const terminal = !retry || claim.alert_attempts >= 8;
    await batch(db, [
      stmt(
        db,
        `UPDATE zulip_deliveries SET alert_lease_until=NULL,alert_next_attempt_at=?,alert_error=?
      WHERE event_id=? AND alert_token=?`,
        new Date(Date.now() + delay).toISOString(),
        error,
        event.aggregate_id,
        token,
      ),
      ...(terminal
        ? [
            stmt(
              db,
              `UPDATE outbox_events SET completed_at=? WHERE id=? AND EXISTS
        (SELECT 1 FROM zulip_deliveries WHERE event_id=? AND alert_token=?)`,
              now(),
              event.id,
              event.aggregate_id,
              token,
            ),
          ]
        : []),
    ]);
    // Do not log exceptions: fetch errors can contain the secret webhook URL.
    console.error(
      JSON.stringify({
        event_id: event.aggregate_id,
        result: terminal ? "zulip_alert_failed" : "zulip_alert_retry",
        error,
      }),
    );
  }
}
