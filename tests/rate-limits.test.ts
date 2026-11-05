import { test } from "node:test";
import assert from "node:assert/strict";
import { batch, quota } from "../src/core";
import { database, fixture, reportInput } from "./support/service-fixture";

test("publishing resumes from an exhausted old daily limit and enforces the raised limit", async () => {
  const { db, request } = await fixture();
  const bucket = new Date().toISOString().slice(0, 10);
  db.prepare("INSERT INTO rate_limits VALUES(?,?,?,?,?)").run(
    "alice",
    "report",
    bucket,
    20,
    20,
  );
  assert.equal((await request("/reports", "POST", reportInput)).status, 201);
  const row = db
    .prepare("SELECT used,lim FROM rate_limits WHERE subject=? AND kind=?")
    .get("alice", "report")!;
  assert.equal(row.used, 21);
  assert.equal(row.lim, 200);
  db.prepare("UPDATE rate_limits SET used=lim WHERE subject=? AND kind=?").run(
    "alice",
    "report",
  );
  assert.equal((await request("/reports", "POST", reportInput)).status, 429);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reports").get()!.n, 1);
});

test("quota updates preserve usage and roll back a rejected increment", async () => {
  const { db, binding } = database();
  await batch(binding, [quota(binding, "alice", "import", 1)]);
  await batch(binding, [quota(binding, "alice", "import", 2)]);
  await assert.rejects(
    batch(binding, [quota(binding, "alice", "import", 2)]),
    (error: any) => error.status === 429,
  );
  assert.equal(db.prepare("SELECT used FROM rate_limits").get()!.used, 2);
  await batch(binding, [quota(binding, "bob", "import", 2)]);
});
