import { checkZulipDelivery, deliveryCheckDelay } from "./zulip-checks";
import { deliverFailureAlert } from "./zulip-failures";
import { deliverZulip } from "./zulip";
import { Env, now, uid, one, rows, stmt, batch, signToken } from "./core";
import { importJob } from "./imports";
export async function dispatch(env: Env) {
  const db = env.DB;
  const events = await rows(
    db,
    `SELECT id,type,payload FROM outbox_events WHERE completed_at IS NULL
      AND (enqueued_at IS NULL OR (enqueued_at<? AND
        (type!='zulip_check' OR json_extract(payload,'$.due_at')<?)))
      ORDER BY created_at LIMIT 40`,
    new Date(Date.now() - 600000).toISOString(),
    new Date(Date.now() - 600000).toISOString(),
  );
  for (const e of events) {
    await env.JOBS.send(
      { event_id: e.id },
      e.type === "zulip_check"
        ? { delaySeconds: deliveryCheckDelay(e) }
        : undefined,
    );
    await stmt(
      db,
      "UPDATE outbox_events SET enqueued_at=? WHERE id=?",
      now(),
      e.id,
    ).run();
  }
  await stmt(
    db,
    "UPDATE email_deliveries SET status='unknown' WHERE status='sending' AND sending_at<?",
    new Date(Date.now() - 300000).toISOString(),
  ).run();
  if (env.EMAIL_DISABLED === "true")
    await stmt(
      db,
      "UPDATE email_deliveries SET status='cancelled' WHERE status IN ('pending','retry')",
    ).run();
  const sends = await rows(
    db,
    "SELECT id FROM email_deliveries WHERE status IN ('pending','retry') AND (next_attempt_at IS NULL OR next_attempt_at<=?) LIMIT 40",
    now(),
  );
  for (const d of sends) await env.JOBS.send({ delivery_id: d.id });
  await reconcile(env);
  if (await one(db, "SELECT 1 FROM settings WHERE key='export_bookmark'"))
    await backup(env);
  await db.batch([
    stmt(db, "DELETE FROM sessions WHERE expires_at<?", now()),
    stmt(db, "DELETE FROM oauth_flows WHERE expires_at<?", now()),
    stmt(db, "DELETE FROM pending_signups WHERE expires_at<?", now()),
    stmt(
      db,
      "DELETE FROM rate_limits WHERE bucket<?",
      new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
    ),
  ]);
}
async function createNotifications(env: Env, event: any) {
  if (env.EMAIL_DISABLED === "true") {
    await stmt(
      env.DB,
      "UPDATE outbox_events SET completed_at=? WHERE id=?",
      now(),
      event.id,
    ).run();
    return;
  }
  const db = env.DB,
    cm = await one(
      db,
      `SELECT cm.*,c.author_id report_author,c.visibility report_visibility,p.author_id reply_author FROM report_comments cm JOIN reports c ON c.id=cm.report_id LEFT JOIN report_comments p ON p.id=cm.reply_to_id WHERE cm.id=?`,
      event.aggregate_id,
    );
  const recipients = new Map<string, string[]>();
  if (
    cm &&
    cm.visibility === "public" &&
    cm.report_visibility === "public" &&
    !cm.deleted_at
  ) {
    for (const [id, category] of [
      [cm.reply_author, "replies"],
      [cm.report_author, "report_comments"],
    ])
      if (id && id !== cm.author_id) {
        const pref = await one(
          db,
          `SELECT p.* FROM notification_preferences p JOIN users u ON u.id=p.user_id WHERE p.user_id=? AND u.status='active'`,
          id,
        );
        if (pref?.[category])
          recipients.set(id, [...(recipients.get(id) || []), category]);
      }
  }
  const ss = [];
  for (const [user, cats] of recipients)
    ss.push(
      stmt(
        db,
        "INSERT INTO email_deliveries(id,event_id,user_id,category,created_at) VALUES(?,?,?,?,?) ON CONFLICT(event_id,user_id) DO NOTHING",
        uid(),
        event.id,
        user,
        cats.join(","),
        now(),
      ),
    );
  ss.push(
    stmt(
      db,
      "UPDATE outbox_events SET completed_at=? WHERE id=?",
      now(),
      event.id,
    ),
  );
  await batch(db, ss);
}
async function deliver(env: Env, id: string) {
  if (env.EMAIL_DISABLED === "true") {
    await stmt(
      env.DB,
      "UPDATE email_deliveries SET status='cancelled' WHERE id=? AND status IN ('pending','retry')",
      id,
    ).run();
    return;
  }
  const db = env.DB;
  const d = await one(
    db,
    `SELECT d.*,e.aggregate_id FROM email_deliveries d JOIN outbox_events e ON e.id=d.event_id WHERE d.id=?`,
    id,
  );
  if (
    !d ||
    !["pending", "retry"].includes(d.status) ||
    (d.next_attempt_at && d.next_attempt_at > now())
  )
    return;
  const cm = await one(
    db,
    `SELECT cm.*,c.visibility report_visibility,u.username FROM report_comments cm JOIN reports c ON c.id=cm.report_id LEFT JOIN users u ON u.id=cm.author_id WHERE cm.id=?`,
    d.aggregate_id,
  );
  const contact = await one(
    db,
    `SELECT ec.*,p.replies,p.report_comments,u.status user_status FROM email_contacts ec JOIN notification_preferences p ON p.user_id=ec.user_id JOIN users u ON u.id=ec.user_id WHERE ec.user_id=?`,
    d.user_id,
  );
  const skip =
    !cm ||
    cm.deleted_at ||
    cm.visibility !== "public" ||
    cm.report_visibility !== "public" ||
    !contact ||
    contact.user_status !== "active" ||
    !contact.address ||
    !d.category.split(",").some((k: string) => contact[k]) ||
    (await one(
      db,
      "SELECT 1 FROM email_suppressions WHERE address=?",
      contact?.address || "",
    ));
  if (skip) {
    await stmt(
      db,
      "UPDATE email_deliveries SET status='cancelled' WHERE id=? AND status IN ('pending','retry')",
      id,
    ).run();
    return;
  }
  const allowed = env.EMAIL_ALLOWLIST.split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (
    !env.EMAIL ||
    !env.EMAIL_FROM ||
    !env.TOKEN_SECRET ||
    (env.ENVIRONMENT === "staging" &&
      !allowed.includes(contact.address.toLowerCase())) ||
    (await one(db, "SELECT value FROM settings WHERE key='email_paused'"))
      ?.value === "1"
  ) {
    await stmt(
      db,
      "UPDATE email_deliveries SET next_attempt_at=? WHERE id=?",
      new Date(Date.now() + 3600000).toISOString(),
      id,
    ).run();
    return;
  }
  const unsubscribe =
    env.APP_ORIGIN +
    "/unsubscribe?user=" +
    encodeURIComponent(d.user_id) +
    "&signature=" +
    (await signToken(env, "unsubscribe:" + d.user_id));
  const token = uid();
  const acquired = await stmt(
    db,
    "UPDATE email_deliveries SET status='sending',attempts=attempts+1,attempt_token=?,sending_at=?,sent_address=? WHERE id=? AND status IN ('pending','retry') RETURNING id",
    token,
    now(),
    contact.address,
    id,
  ).first();
  if (!acquired) return;
  try {
    const result = await env.EMAIL.send({
      from: env.EMAIL_FROM,
      to: contact.address,
      subject: `New comment on proofs.rs report #${cm.report_id}`,
      text: `${cm.username || "ghost"} posted a comment.\n\n${env.APP_ORIGIN}/report/${cm.report_id}?comment=${cm.id}\n\nEmail settings: ${env.APP_ORIGIN}/settings\nUnsubscribe: ${unsubscribe}`,
    });
    await stmt(
      db,
      "UPDATE email_deliveries SET status='accepted',provider_id=? WHERE id=? AND attempt_token=? AND status='sending'",
      result.messageId,
      id,
      token,
    ).run();
  } catch (e: any) {
    const retry = ["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED"].includes(
      e.code,
    );
    const rejected = [
      "E_VALIDATION_ERROR",
      "E_FIELD_MISSING",
      "E_SENDER_NOT_VERIFIED",
      "E_RECIPIENT_NOT_ALLOWED",
      "E_RECIPIENT_SUPPRESSED",
      "E_SENDER_DOMAIN_NOT_AVAILABLE",
      "E_CONTENT_TOO_LARGE",
    ].includes(e.code);
    await stmt(
      db,
      "UPDATE email_deliveries SET status=?,next_attempt_at=? WHERE id=? AND attempt_token=?",
      retry && d.attempts < 5
        ? "retry"
        : rejected
          ? "rejected"
          : retry
            ? "failed"
            : "unknown",
      new Date(
        Date.now() + Math.min(86400000, 60000 * 2 ** d.attempts),
      ).toISOString(),
      id,
      token,
    ).run();
  }
}
const eventStatus: Record<string, string> = {
  "message.delivered": "delivered",
  "message.deferred": "deferred",
  "message.bounced": "bounced",
  "message.failed": "failed",
  "message.rejected": "rejected",
  "message.complained": "complained",
};
async function emailEvent(env: Env, b: any) {
  if (
    !env.EMAIL_EVENT_SUBSCRIPTION ||
    b.metadata?.eventSubscriptionId !== env.EMAIL_EVENT_SUBSCRIPTION ||
    b.metadata?.accountId !== env.CLOUDFLARE_ACCOUNT_ID ||
    b.source?.domain !== env.EMAIL_DOMAIN
  )
    throw Error("Email event source mismatch");
  const type = String(b.type).replace("cf.email.sending.", "");
  if (!eventStatus[type] || !b.payload?.eventId || !b.payload?.messageId)
    return;
  await stmt(
    env.DB,
    "INSERT INTO email_delivery_events(event_id,provider_id,type,event_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
    b.payload.eventId,
    b.payload.messageId,
    type,
    b.metadata.eventTimestamp || now(),
  ).run();
  await reconcile(env);
}
async function reconcile(env: Env) {
  const pending = await rows(
    env.DB,
    "SELECT e.*,d.id did,d.sent_address FROM email_delivery_events e JOIN email_deliveries d ON d.provider_id=e.provider_id WHERE e.processed_at IS NULL LIMIT 50",
  );
  for (const e of pending) {
    const status = eventStatus[e.type];
    const terminal = ["complained", "bounced", "rejected", "failed"].includes(
      status,
    );
    const ss = [
      stmt(
        env.DB,
        `UPDATE email_deliveries SET status=? WHERE id=? AND (status IN ('accepted','deferred') OR (? IN ('bounced','complained') AND status='delivered') OR ?='complained')`,
        status,
        e.did,
        status,
        status,
      ),
      stmt(
        env.DB,
        "UPDATE email_delivery_events SET processed_at=?,delivery_id=? WHERE event_id=?",
        now(),
        e.did,
        e.event_id,
      ),
    ];
    if (
      terminal &&
      ["complained", "bounced"].includes(status) &&
      e.sent_address
    )
      ss.push(
        stmt(
          env.DB,
          "INSERT INTO email_suppressions VALUES(?,?) ON CONFLICT DO NOTHING",
          e.sent_address,
          now(),
        ),
      );
    await batch(env.DB, ss);
  }
}
export async function queue(batchMessages: MessageBatch<any>, env: Env) {
  for (const m of batchMessages.messages) {
    try {
      const b = m.body;
      if (b.event_id) {
        const event = await one(
          env.DB,
          "SELECT * FROM outbox_events WHERE id=?",
          b.event_id,
        );
        if (event && !event.completed_at) {
          if (event.type === "import") {
            const complete = await importJob(env, event.aggregate_id);
            if (complete)
              await stmt(
                env.DB,
                "UPDATE outbox_events SET completed_at=? WHERE id=?",
                now(),
                event.id,
              ).run();
            else
              await stmt(
                env.DB,
                "UPDATE outbox_events SET enqueued_at=NULL WHERE id=?",
                event.id,
              ).run();
          } else if (event.type === "zulip") await deliverZulip(env, event);
          else if (event.type === "zulip_check") {
            const delay = await checkZulipDelivery(env, event);
            if (delay) {
              m.retry({ delaySeconds: delay });
              continue;
            }
          } else if (event.type === "zulip_failure")
            await deliverFailureAlert(env, event);
          else if (event.type === "comment")
            await createNotifications(env, event);
        }
      } else if (b.delivery_id) await deliver(env, b.delivery_id);
      else if (b.type?.startsWith("cf.email.sending."))
        await emailEvent(env, b);
      else throw Error("Unknown queue message");
      m.ack();
    } catch {
      m.retry({ delaySeconds: 60 });
    }
  }
}
export async function backup(env: Env) {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_D1_TOKEN || !env.DB_ID) {
    console.error("backup_not_configured");
    return;
  }
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.DB_ID}/export`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_D1_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        output_format: "polling",
        ...((
          await one(
            env.DB,
            "SELECT value FROM settings WHERE key='export_bookmark'",
          )
        )?.value
          ? {
              current_bookmark: (await one(
                env.DB,
                "SELECT value FROM settings WHERE key='export_bookmark'",
              ))!.value,
            }
          : {}),
      }),
    },
  );
  const data: any = await response.json();
  if (!data.success) throw Error("Backup export failed");
  const r = data.result;
  if (r.status === "complete" && r.result?.signed_url) {
    const dump = await fetch(r.result.signed_url);
    if (!dump.ok) throw Error("Backup download failed");
    await env.ARCHIVE.put("backups/" + now() + ".sql", dump.body);
    await stmt(
      env.DB,
      "DELETE FROM settings WHERE key='export_bookmark'",
    ).run();
    const list = await env.ARCHIVE.list({ prefix: "backups/" });
    const keys = list.objects
      .map((o) => o.key)
      .sort()
      .reverse()
      .slice(30);
    if (keys.length) await env.ARCHIVE.delete(keys);
  } else if (r.at_bookmark)
    await stmt(
      env.DB,
      "INSERT INTO settings VALUES('export_bookmark',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      r.at_bookmark,
    ).run();
}
