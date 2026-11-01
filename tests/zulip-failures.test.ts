import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, reportInput } from "./support/service-fixture";
import { deliverZulip } from "../src/zulip";
import { deliverFailureAlert } from "../src/zulip-failures";
import { queue, dispatch } from "../src/jobs";

async function setup() {
  const f = await fixture();
  const queued: string[] = [];
  Object.assign(f.env, {
    ENVIRONMENT: "production",
    ZULIP_ENABLED: "true",
    EMAIL_DISABLED: "true",
    ZULIP_SITE: "https://zulip.example",
    ZULIP_CHANNEL_ID: "12",
    ZULIP_BOT_EMAIL: "bot@example.test",
    ZULIP_API_KEY: "zulip-secret",
    ZULIP_FAILURE_WEBHOOK_URL:
      "https://discord.com/api/webhooks/123/discord-secret",
  });
  assert.equal((await f.request("/reports", "POST", reportInput)).status, 201);
  Object.assign(f.env, {
    JOBS: {
      send: async (body: { event_id: string }) => {
        queued.push(body.event_id);
      },
    },
  });
  const event = f.db
    .prepare("SELECT * FROM outbox_events WHERE type='zulip'")
    .get()!;
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 401 })) as typeof fetch;
    await deliverZulip(f.env, event);
  } finally {
    globalThis.fetch = original;
  }
  const alert = f.db
    .prepare("SELECT * FROM outbox_events WHERE type='zulip_failure'")
    .get()!;
  assert.ok(alert);
  assert.equal(
    f.db.prepare("SELECT status FROM zulip_deliveries").get()!.status,
    "failed",
  );
  assert.ok(queued.includes(alert.id as string));
  return { ...f, event, alert, queued };
}

test("Zulip failed delivery queues one durable Discord alert, sent once through the queue", async () => {
  const { db, env, event, alert } = await setup();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    calls++;
    assert.equal(
      String(url),
      "https://discord.com/api/webhooks/123/discord-secret?wait=true",
    );
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.Authorization, undefined);
    const body = JSON.parse(init.body);
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.match(body.content, /Zulip delivery failed/);
    assert.match(body.content, /Revision: 1/);
    assert.match(body.content, /Attempts: 1/);
    assert.match(body.content, /Error: http_401/);
    assert.ok(body.content.includes(event.id));
    assert.ok(body.content.includes("/report/"));
    assert.ok(!body.content.includes("secret"));
    return Response.json({ id: "999" });
  }) as typeof fetch;
  try {
    // A duplicate delivery of the failed source does not create another alert.
    await deliverZulip(env, event);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) n FROM outbox_events WHERE type='zulip_failure'",
        )
        .get()!.n,
      1,
    );
    let acked = 0;
    await queue(
      {
        messages: [
          {
            body: { event_id: alert.id },
            ack() {
              acked++;
            },
            retry() {
              assert.fail("unexpected retry");
            },
          },
        ],
      } as any,
      env,
    );
    assert.equal(acked, 1);
    await deliverFailureAlert(env, alert);
    assert.equal(calls, 1);
    const delivery = db.prepare("SELECT * FROM zulip_deliveries").get()!;
    assert.ok(delivery.alert_sent_at);
    assert.equal(delivery.status, "failed");
    assert.equal(delivery.last_error, "http_401");
    assert.ok(
      db
        .prepare("SELECT completed_at FROM outbox_events WHERE id=?")
        .get(alert.id as string)!.completed_at,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Zulip Discord alert retries independently, respects leases and Retry-After", async () => {
  const { db, env, alert, queued } = await setup();
  const original = globalThis.fetch;
  let calls = 0,
    status = 429;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json(
      { id: "999" },
      { status, headers: { "Retry-After": "1200" } },
    );
  }) as typeof fetch;
  try {
    await deliverFailureAlert(env, alert);
    let delivery = db.prepare("SELECT * FROM zulip_deliveries").get()!;
    assert.equal(delivery.alert_error, "http_429");
    assert.ok(
      Date.parse(delivery.alert_next_attempt_at as string) >
        Date.now() + 1190000,
    );
    assert.equal(delivery.status, "failed");
    assert.equal(
      db
        .prepare("SELECT completed_at FROM outbox_events WHERE id=?")
        .get(alert.id as string)!.completed_at,
      null,
    );
    await deliverFailureAlert(env, alert);
    assert.equal(calls, 1);
    queued.length = 0;
    await dispatch(env);
    assert.ok(queued.includes(alert.id as string));
    db.prepare(
      "UPDATE zulip_deliveries SET alert_next_attempt_at=NULL,alert_lease_until=?",
    ).run(new Date(Date.now() + 60000).toISOString());
    await deliverFailureAlert(env, alert);
    assert.equal(calls, 1);
    db.prepare("UPDATE zulip_deliveries SET alert_lease_until=NULL").run();
    status = 200;
    env.ZULIP_ENABLED = "false";
    await deliverFailureAlert(env, alert);
    assert.equal(calls, 2);
    delivery = db.prepare("SELECT * FROM zulip_deliveries").get()!;
    assert.ok(delivery.alert_sent_at);
    assert.equal(delivery.alert_attempts, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("Zulip failure alerts sanitize exceptions and stop after exhaustion or permanent errors", async () => {
  const { db, env, alert } = await setup();
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw Error("secret https://discord.com/api/webhooks/123/discord-secret");
  }) as typeof fetch;
  try {
    await deliverFailureAlert(env, alert);
    assert.equal(
      db.prepare("SELECT alert_error FROM zulip_deliveries").get()!.alert_error,
      "network",
    );
    db.prepare(
      "UPDATE zulip_deliveries SET alert_attempts=7,alert_next_attempt_at=NULL",
    ).run();
    await deliverFailureAlert(env, alert);
    assert.equal(
      db.prepare("SELECT alert_attempts FROM zulip_deliveries").get()!
        .alert_attempts,
      8,
    );
    assert.ok(
      db
        .prepare("SELECT completed_at FROM outbox_events WHERE id=?")
        .get(alert.id as string)!.completed_at,
    );
    db.prepare(
      "UPDATE zulip_deliveries SET alert_attempts=0,alert_next_attempt_at=NULL",
    ).run();
    db.prepare("UPDATE outbox_events SET completed_at=NULL WHERE id=?").run(
      alert.id as string,
    );
    globalThis.fetch = (async () =>
      new Response("", {
        status: 302,
        headers: { Location: "https://other.example/" },
      })) as typeof fetch;
    await deliverFailureAlert(env, alert);
    assert.equal(
      db.prepare("SELECT alert_error FROM zulip_deliveries").get()!.alert_error,
      "http_302",
    );
    assert.ok(
      db
        .prepare("SELECT completed_at FROM outbox_events WHERE id=?")
        .get(alert.id as string)!.completed_at,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Zulip failed status and failure alert commit atomically", async () => {
  const { db, env, event, alert } = await setup();
  db.prepare("DELETE FROM outbox_events WHERE id=?").run(alert.id as string);
  db.prepare(
    "UPDATE zulip_deliveries SET status='pending',attempts=0,next_attempt_at=NULL",
  ).run();
  db.prepare("UPDATE outbox_events SET completed_at=NULL WHERE id=?").run(
    event.id as string,
  );
  db.exec(
    "CREATE TRIGGER reject_alert BEFORE INSERT ON outbox_events WHEN NEW.type='zulip_failure' BEGIN SELECT RAISE(ABORT,'test rollback'); END",
  );
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 401 })) as typeof fetch;
    await assert.rejects(deliverZulip(env, event));
    assert.equal(
      db.prepare("SELECT status FROM zulip_deliveries").get()!.status,
      "sending",
    );
    assert.equal(
      db
        .prepare("SELECT completed_at FROM outbox_events WHERE id=?")
        .get(event.id as string)!.completed_at,
      null,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Zulip exhausted delivery lease also creates an alert", async () => {
  const { db, env, event, alert } = await setup();
  db.prepare("DELETE FROM outbox_events WHERE id=?").run(alert.id as string);
  db.prepare(
    "UPDATE zulip_deliveries SET status='sending',attempts=8,lease_until='2000'",
  ).run();
  db.prepare("UPDATE outbox_events SET completed_at=NULL WHERE id=?").run(
    event.id as string,
  );
  await deliverZulip(env, event);
  assert.equal(
    db.prepare("SELECT status FROM zulip_deliveries").get()!.status,
    "failed",
  );
  assert.equal(
    db.prepare("SELECT last_error FROM zulip_deliveries").get()!.last_error,
    "lease_expired",
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM outbox_events WHERE type='zulip_failure'",
      )
      .get()!.n,
    1,
  );
});

test("Zulip failure alert enqueue failure preserves its durable outbox event", async () => {
  const { db, env, event, alert, queued } = await setup();
  db.prepare("DELETE FROM outbox_events WHERE id=?").run(alert.id as string);
  db.prepare(
    "UPDATE zulip_deliveries SET status='sending',attempts=8,lease_until='2000'",
  ).run();
  Object.assign(env, {
    JOBS: {
      send: async () => {
        throw Error("queue unavailable");
      },
    },
  });
  await deliverZulip(env, event);
  const persisted = db
    .prepare("SELECT * FROM outbox_events WHERE type='zulip_failure'")
    .get()!;
  assert.ok(persisted);
  assert.equal(persisted.completed_at, null);
  assert.equal(persisted.enqueued_at, null);
  Object.assign(env, {
    JOBS: {
      send: async (body: { event_id: string }) => {
        queued.push(body.event_id);
      },
    },
  });
  queued.length = 0;
  await dispatch(env);
  assert.ok(queued.includes(persisted.id as string));
});

test("Zulip failure alerts are suppressed in staging and after source recovery", async () => {
  for (const staging of [true, false]) {
    const { db, env, alert } = await setup();
    if (staging) env.ENVIRONMENT = "staging";
    else db.prepare("UPDATE zulip_deliveries SET status='sent'").run();
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        assert.fail("no alert expected");
      }) as typeof fetch;
      await deliverFailureAlert(env, alert);
      assert.equal(
        db.prepare("SELECT alert_attempts FROM zulip_deliveries").get()!
          .alert_attempts,
        0,
      );
      assert.ok(
        db
          .prepare("SELECT completed_at FROM outbox_events WHERE id=?")
          .get(alert.id as string)!.completed_at,
      );
    } finally {
      globalThis.fetch = original;
    }
  }
});
