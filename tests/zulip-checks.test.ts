import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, reportInput } from "./support/service-fixture";
import { dispatch, queue } from "../src/jobs";
import { deliverZulip } from "../src/zulip";
import { checkZulipDelivery } from "../src/zulip-checks";
import { deliverFailureAlert } from "../src/zulip-failures";

async function setup() {
  const f = await fixture();
  Object.assign(f.env, {
    ENVIRONMENT: "production",
    ZULIP_ENABLED: "true",
    EMAIL_DISABLED: "true",
    ZULIP_SITE: "https://zulip.example",
    ZULIP_CHANNEL_ID: "12",
    ZULIP_BOT_EMAIL: "bot@example.test",
    ZULIP_API_KEY: "dummy",
    ZULIP_FAILURE_WEBHOOK_URL: "https://discord.com/api/webhooks/123/dummy",
  });
  const key = { "Idempotency-Key": crypto.randomUUID() };
  assert.equal(
    (await f.request("/reports", "POST", reportInput, "alice", key)).status,
    201,
  );
  await f.request("/reports", "POST", reportInput, "alice", key);
  const event = f.db
    .prepare("SELECT * FROM outbox_events WHERE type='zulip'")
    .get()!;
  const check = f.db
    .prepare("SELECT * FROM outbox_events WHERE type='zulip_check'")
    .get()!;
  assert.ok(check);
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) n FROM outbox_events WHERE type='zulip_check'")
      .get()!.n,
    1,
  );
  assert.equal(check.aggregate_id, event.id);
  const dueAt = Date.parse(JSON.parse(check.payload as string).due_at);
  assert.equal(dueAt - Date.parse(event.created_at as string), 900000);
  const queued: { id: string; delay?: number }[] = [];
  Object.assign(f.env, {
    JOBS: {
      send: async (
        body: { event_id: string },
        options?: { delaySeconds: number },
      ) => {
        queued.push({ id: body.event_id, delay: options?.delaySeconds });
      },
    },
  });
  return { ...f, event, check, dueAt, queued };
}

async function consume(env: any, id: any) {
  let acked = 0;
  const retries: number[] = [];
  await queue(
    {
      messages: [
        {
          body: { event_id: id },
          ack() {
            acked++;
          },
          retry(options: { delaySeconds: number }) {
            retries.push(options.delaySeconds);
          },
        },
      ],
    } as any,
    env,
  );
  return { acked, retries };
}

test("Zulip check is scheduled for creation plus 15 minutes, without periodic rechecking", async (t) => {
  const { db, env, event, check, dueAt, queued } = await setup();
  t.mock.timers.enable({ apis: ["Date"], now: dueAt - 900000 });
  await dispatch(env);
  assert.deepEqual(
    queued.find((x) => x.id === check.id),
    { id: check.id, delay: 900 },
  );
  queued.length = 0;
  t.mock.timers.tick(11 * 60000);
  await dispatch(env);
  assert.ok(!queued.some((x) => x.id === check.id));
  assert.equal(
    db
      .prepare("SELECT completed_at FROM outbox_events WHERE id=?")
      .get(check.id as string)!.completed_at,
    null,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM zulip_deliveries").get()!.n,
    0,
  );
  // Early delivery is delayed for the remaining time, not evaluated or acknowledged.
  assert.deepEqual(await consume(env, check.id), { acked: 0, retries: [240] });
  t.mock.timers.tick(4 * 60000);
  assert.deepEqual(await consume(env, check.id), { acked: 1, retries: [] });
  assert.ok(
    db
      .prepare("SELECT completed_at FROM outbox_events WHERE id=?")
      .get(check.id as string)!.completed_at,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM outbox_events WHERE type='zulip_failure'",
      )
      .get()!.n,
    1,
  );
  assert.ok(queued.some((x) => x.id === `zulip-failure:${event.id}`));
  await consume(env, check.id);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM outbox_events WHERE type='zulip_failure'",
      )
      .get()!.n,
    1,
  );
});

test("Zulip check retries a failed enqueue using the remaining time", async (t) => {
  const { env, check, dueAt, queued } = await setup();
  t.mock.timers.enable({ apis: ["Date"], now: dueAt - 900000 });
  Object.assign(env, {
    JOBS: {
      send: async () => {
        throw Error("queue unavailable");
      },
    },
  });
  await assert.rejects(dispatch(env));
  t.mock.timers.tick(5 * 60000);
  Object.assign(env, {
    JOBS: {
      send: async (
        body: { event_id: string },
        options?: { delaySeconds: number },
      ) => {
        queued.push({ id: body.event_id, delay: options?.delaySeconds });
      },
    },
  });
  await dispatch(env);
  assert.deepEqual(
    queued.find((x) => x.id === check.id),
    { id: check.id, delay: 600 },
  );
});

test("Zulip overdue alert sends once and shares deduplication with permanent failure", async (t) => {
  const { db, env, event, check, dueAt } = await setup();
  t.mock.timers.enable({ apis: ["Date"], now: dueAt });
  // No delivery row: catches events whose normal delivery never started.
  await consume(env, check.id);
  const alert = db
    .prepare("SELECT * FROM outbox_events WHERE type='zulip_failure'")
    .get()!;
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async (_url: any, init: any) => {
      calls++;
      assert.match(
        JSON.parse(init.body).content,
        /still unsent after 15 minutes/,
      );
      return Response.json({ id: "999" });
    }) as typeof fetch;
    await deliverFailureAlert(env, alert);
    await deliverFailureAlert(env, alert);
    assert.equal(calls, 1);
    assert.equal(
      db.prepare("SELECT status FROM zulip_deliveries").get()!.status,
      "pending",
    );
    globalThis.fetch = (async () =>
      new Response("{}", { status: 401 })) as typeof fetch;
    await deliverZulip(env, event);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) n FROM outbox_events WHERE type='zulip_failure'",
        )
        .get()!.n,
      1,
    );
    await consume(env, alert.id);
    assert.equal(
      db.prepare("SELECT alert_attempts FROM zulip_deliveries").get()!
        .alert_attempts,
      1,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Zulip failed alert arriving before the deadline suppresses the delayed alert", async (t) => {
  const { db, env, event, check, dueAt } = await setup();
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 401 })) as typeof fetch;
    await deliverZulip(env, event);
    const alert = db
      .prepare("SELECT * FROM outbox_events WHERE type='zulip_failure'")
      .get()!;
    globalThis.fetch = (async () =>
      Response.json({ id: "999" })) as typeof fetch;
    await deliverFailureAlert(env, alert);
    t.mock.timers.enable({ apis: ["Date"], now: dueAt });
    await consume(env, check.id);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) n FROM outbox_events WHERE type='zulip_failure'",
        )
        .get()!.n,
      1,
    );
    assert.equal(
      db.prepare("SELECT alert_attempts FROM zulip_deliveries").get()!
        .alert_attempts,
      1,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Zulip sent, cancelled, hidden, disabled and staging checks do not alert", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  for (const state of ["sent", "cancelled", "hidden", "disabled", "staging"]) {
    const { db, env, event, check, dueAt } = await setup();
    t.mock.timers.setTime(dueAt);
    if (state === "sent" || state === "cancelled")
      db.prepare(
        "INSERT INTO zulip_deliveries(event_id,status) VALUES(?,?)",
      ).run(event.id as string, state);
    if (state === "hidden")
      db.prepare("UPDATE reports SET visibility='hidden'").run();
    if (state === "disabled") env.ZULIP_ENABLED = "false";
    if (state === "staging") env.ENVIRONMENT = "staging";
    await consume(env, check.id);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) n FROM outbox_events WHERE type='zulip_failure'",
        )
        .get()!.n,
      0,
      state,
    );
    assert.ok(
      db
        .prepare("SELECT completed_at FROM outbox_events WHERE id=?")
        .get(check.id as string)!.completed_at,
      state,
    );
  }
});

test("Zulip recovery before Discord delivery cancels the overdue alert", async (t) => {
  const { db, env, event, check, dueAt } = await setup();
  t.mock.timers.enable({ apis: ["Date"], now: dueAt });
  await checkZulipDelivery(env, check);
  db.prepare("UPDATE zulip_deliveries SET status='sent'").run();
  const alert = db
    .prepare("SELECT * FROM outbox_events WHERE type='zulip_failure'")
    .get()!;
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
});

test("Zulip event and delayed check commit atomically", async () => {
  const f = await fixture();
  Object.assign(f.env, { ENVIRONMENT: "production", ZULIP_ENABLED: "true" });
  f.db.exec(
    "CREATE TRIGGER reject_check BEFORE INSERT ON outbox_events WHEN NEW.type='zulip_check' BEGIN SELECT RAISE(ABORT,'test rollback'); END",
  );
  const before = f.db.prepare("SELECT COUNT(*) n FROM reports").get()!.n;
  assert.notEqual(
    (await f.request("/reports", "POST", reportInput)).status,
    201,
  );
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM reports").get()!.n, before);
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) n FROM outbox_events WHERE type='zulip'")
      .get()!.n,
    0,
  );
});

test("Zulip overdue uncompleted check can be redriven after recovery grace", async (t) => {
  const { env, check, dueAt, queued } = await setup();
  t.mock.timers.enable({ apis: ["Date"], now: dueAt - 900000 });
  await dispatch(env);
  queued.length = 0;
  t.mock.timers.tick(26 * 60000);
  await dispatch(env);
  assert.deepEqual(
    queued.find((x) => x.id === check.id),
    { id: check.id, delay: 0 },
  );
});

test("Zulip check completion and overdue alert are atomic", async (t) => {
  const { db, env, check, dueAt } = await setup();
  t.mock.timers.enable({ apis: ["Date"], now: dueAt });
  db.exec(
    "CREATE TRIGGER reject_overdue BEFORE INSERT ON outbox_events WHEN NEW.type='zulip_failure' BEGIN SELECT RAISE(ABORT,'test rollback'); END",
  );
  assert.deepEqual(await consume(env, check.id), { acked: 0, retries: [60] });
  assert.equal(
    db
      .prepare("SELECT completed_at FROM outbox_events WHERE id=?")
      .get(check.id as string)!.completed_at,
    null,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM zulip_deliveries").get()!.n,
    0,
  );
  db.exec("DROP TRIGGER reject_overdue");
  assert.deepEqual(await consume(env, check.id), { acked: 1, retries: [] });
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM outbox_events WHERE type='zulip_failure'",
      )
      .get()!.n,
    1,
  );
});
