import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { app } from "../src/worker";
import { hash, Env } from "../src/core";
import {
  CATALOG_EXTRACTOR_VERSION,
  extractAPIs,
  importJob,
  refreshCatalog,
} from "../src/imports";
import { cleanupRunUploads, readRecord } from "../src/runs";
import {
  fixture,
  reportInput,
  recordedSarif,
  database,
} from "./support/service-fixture";
export { fixture, reportInput } from "./support/service-fixture";

for (const command of [
  ["cargo", "kani"],
  ["python3", "verify-core.py"],
  ["./verify-core"],
]) {
  test(`recorded runs (${command.join(" ")}): immutable artifacts, ownership, publication gating and visibility`, async () => {
    const { db, env, request } = await fixture();
    const objects = new Map<string, Uint8Array>();
    env.ARCHIVE = {
      put: async (k: string, b: ArrayBuffer) => {
        objects.set(k, new Uint8Array(b));
      },
      get: async (k: string) => {
        const b = objects.get(k);
        return b
          ? {
              json: async () => JSON.parse(new TextDecoder().decode(b)),
              body: new Response(new Uint8Array(b)).body,
            }
          : null;
      },
    } as any;
    const rid = "22222222-2222-4222-8222-222222222222";
    const sarif = recordedSarif(rid, command);
    const upload = async (kind: string, bytes: Uint8Array, user = "alice") => {
      const r = await app.request(
        `https://example.test/api/v1/runs/${rid}/${kind}`,
        {
          method: "POST",
          headers: {
            Origin: env.APP_ORIGIN,
            Cookie: "__Host-proofsr_session=" + user,
            "X-CSRF-Token": "csrf",
            "Content-Type": "application/octet-stream",
          },
          body: new Uint8Array(bytes),
        },
        env,
      );
      return { status: r.status, body: (await r.json()) as any };
    };
    const encode = (s: any) => new TextEncoder().encode(JSON.stringify(s));
    for (const mutate of [
      (s: any) => {
        s.runs[0].invocations[0].workingDirectory.uri = "../escape/";
      },
      (s: any) => {
        s.runs[0].properties.proofs.contracts[0].harness = "unexecuted";
      },
      (s: any) => {
        s.runs[0].invocations[0].executionSuccessful = false;
      },
      (s: any) => {
        s.runs[0].invocations[0].executableLocation.uri = "";
      },
      (s: any) => {
        s.runs[0].artifacts.push({ contents: { text: "source" } });
      },
      (s: any) => {
        s.runs[0].versionControlProvenance[0].revisionId = "main";
      },
    ]) {
      const changed = structuredClone(sarif);
      mutate(changed);
      assert.equal((await upload("sarif", encode(changed))).status, 400);
      assert.equal(objects.size, 0, "invalid requests must not store objects");
    }
    const uploaded = await upload("sarif", encode(sarif));
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded));
    assert.equal((await upload("sarif", encode(sarif))).status, 200);
    assert.equal(objects.size, 1);
    assert.equal(
      (await upload("sarif", new TextEncoder().encode("changed"))).status,
      409,
    );
    assert.equal((await upload("sarif", encode(sarif), "bob")).status, 409);
    assert.equal((await request(`/runs/${rid}`, "POST", {})).status, 404);
    for (const removed of [
      "source",
      "logs",
      "artifacts/source",
      "artifacts/logs",
      "artifacts/sarif",
    ]) {
      assert.equal(
        (await upload(removed, new TextEncoder().encode("unused"))).status,
        404,
      );
      assert.equal(
        (await request(`/runs/${rid}/${removed}`, "GET")).status,
        404,
      );
    }
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name='run_sarif'").get(),
      undefined,
    );
    assert.equal(
      (await request("/runs/" + rid, "GET", undefined, "bob")).status,
      404,
    );
    assert.equal(
      (await request("/reports", "POST", { ...reportInput, run_ids: [] }))
        .status,
      400,
    );
    assert.equal(
      (
        await request(
          "/reports",
          "POST",
          { ...reportInput, run_ids: [rid] },
          "bob",
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/reports", "POST", {
          ...reportInput,
          run_ids: [rid],
          claims: [{ ...reportInput.claims[0], precondition: "unrecorded" }],
        })
      ).status,
      400,
    );
    const made = await request("/reports", "POST", {
      ...reportInput,
      run_ids: [rid],
    });
    assert.equal(made.status, 201, JSON.stringify(made));
    assert.deepEqual((await request("/reports/" + made.body.id)).body.run_ids, [
      rid,
    ]);
    assert.equal(
      (await request("/runs/" + rid, "GET", undefined, "")).status,
      200,
    );
    const downloaded = await app.request(
      "https://example.test/api/v1/runs/" + rid + "/sarif",
      {},
      env,
    );
    assert.equal(downloaded.status, 200);
    assert.equal(
      ((await downloaded.json()) as any).runs[0].artifacts[0].contents.text,
      "SUCCESS",
    );
    assert.match(downloaded.headers.get("Content-Disposition")!, /attachment/);
    db.prepare("UPDATE reports SET visibility='hidden' WHERE id=?").run(
      made.body.id,
    );
    assert.equal(
      (await request("/runs/" + rid, "GET", undefined, "bob")).status,
      404,
    );
  });
}
test("atomic reports, stable claims, immutable targets, revision conflicts and permanent stars", async () => {
  const { request, db } = await fixture();
  let v = await request("/reports/validate", "POST", reportInput);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(
    v.body.claims[0].title,
    "Verification of sample::safe (with Kani 0.68.0)",
  );
  const key = { "Idempotency-Key": "report-create-key-123" };
  const made = await request("/reports", "POST", reportInput, "alice", key);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.id;
  assert.equal(
    (await request("/reports", "POST", reportInput, "alice", key)).body.id,
    id,
  );
  assert.equal(
    (
      await request(
        "/reports",
        "POST",
        { ...reportInput, title: "changed" },
        "alice",
        key,
      )
    ).status,
    409,
  );
  let r = (await request("/reports/" + id)).body;
  const claimID = r.claims[0].id;
  assert.equal(
    (await request(`/reports/${id}/star`, "PUT", {}, "alice")).status,
    200,
  );
  assert.equal((await request("/users/alice")).body.karma, 0);
  await request(`/reports/${id}/star`, "PUT", {}, "bob");
  await request(`/claims/${claimID}/star`, "PUT", {}, "bob");
  assert.equal((await request("/users/alice")).body.karma, 1);
  const rev = {
    ...reportInput,
    title: "Revised",
    expected_revision: 1,
    claims: [
      { ...reportInput.claims[0], id: claimID, explanation: "New content" },
      { ...reportInput.claims[0], title: "Another scope" },
    ],
  };
  assert.equal(
    (await request(`/reports/${id}/revisions`, "POST", rev, "bob")).status,
    403,
  );
  v = await request(`/reports/${id}/revisions`, "POST", rev);
  assert.equal(v.status, 201, JSON.stringify(v.body));
  assert.equal(
    (await request(`/reports/${id}/revisions`, "POST", rev)).status,
    409,
  );
  r = (await request("/reports/" + id)).body;
  assert.equal(r.star_count, 2);
  assert.equal(r.claims[0].id, claimID);
  assert.equal(r.claims[0].star_count, 1);
  assert.equal(
    (await request(`/claims/${claimID}?report_revision=1`)).body.explanation,
    "",
  );
  assert.equal(
    (
      await request(`/reports/${id}/revisions`, "POST", {
        ...rev,
        expected_revision: 2,
        claims: [
          {
            ...rev.claims[0],
            api_item_id: "unsafe",
            precondition: "true",
          },
        ],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/reports/${id}/revisions`, "POST", {
        ...rev,
        expected_revision: 2,
        claims: [r.claims[1]],
      })
    ).status,
    201,
  );
  let removed = (await request("/claims/" + claimID)).body;
  assert.equal(removed.in_current_report, 0);
  assert.equal(removed.star_count, 1);
  assert.equal((await request("/apis/safe/claims")).body.items.length, 1);
  assert.equal(
    (await request("/me/starred-claims", "GET", undefined, "bob")).body.items[0]
      .id,
    claimID,
  );
  assert.equal(
    (await request("/me/starred-reports", "GET", undefined, "bob")).body
      .items[0].id,
    id,
  );
  assert.throws(
    () => db.prepare("UPDATE report_revisions SET title=?").run("bad"),
    /immutable/,
  );
  assert.equal(
    (await request(`/reports/${id}/withdrawal`, "PUT", {})).status,
    200,
  );
  assert.equal((await request("/apis/safe/claims")).body.items.length, 0);
  assert.equal((await request("/users/alice")).body.karma, 0);
});
test("whole-report validation, membership, required evidence, no partial writes and removed endpoints", async () => {
  const { request, db } = await fixture();
  for (const input of [
    { ...reportInput, title: "" },
    { ...reportInput, claims: [] },
    { ...reportInput, evidence_url: "" },
    {
      ...reportInput,
      claims: [
        ...reportInput.claims,
        { api_item_id: "unsafe", precondition: "" },
      ],
    },
    { ...reportInput, claims: [{ ...reportInput.claims[0], id: "fake" }] },
  ]) {
    assert.equal((await request("/reports", "POST", input)).status, 400);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM reports").get()?.n, 0);
  }
  const a = await request("/reports", "POST", reportInput);
  const c = (await request("/reports/" + a.body.id)).body.claims[0];
  const b = await request("/reports", "POST", {
    ...reportInput,
    evidence_url: "",
    claims: [
      {
        ...reportInput.claims[0],
        evidence_url: "https://example.test/individual",
      },
    ],
  });
  assert.equal(b.status, 201);
  assert.equal(
    (
      await request(`/reports/${b.body.id}/revisions`, "POST", {
        ...reportInput,
        expected_revision: 1,
        claims: [c],
      })
    ).status,
    400,
  );
  for (const [method, path] of [
    ["POST", "/claims"],
    ["POST", "/claims/validate"],
    ["POST", "/claims/1/revisions"],
    ["GET", "/claims/1/revisions/1"],
    ["PUT", "/claims/1/withdrawal"],
    ["GET", "/claims/1/comments"],
    ["POST", "/claims/1/comments"],
    ["PUT", "/claims/1/revisions/1/accept"],
    ["GET", "/claims/1/revisions/1/accepts"],
    ["GET", "/me/accepts"],
    ["GET", "/me/claims"],
    ["GET", "/users/alice/claims"],
  ])
    assert.equal(
      (await request(path, method, method === "GET" ? undefined : {})).status,
      404,
      method + " " + path,
    );
});
test("report-only nested comments, history, tombstones, activity and moderation", async () => {
  const { request, db } = await fixture();
  const id = (await request("/reports", "POST", reportInput)).body.id;
  let r = await request(
    `/reports/${id}/comments`,
    "POST",
    { body: "First", revision_no: 1 },
    "bob",
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const root = r.body.id;
  const child = (
    await request(`/reports/${id}/comments`, "POST", {
      body: "Reply",
      revision_no: 1,
      reply_to_id: root,
    })
  ).body.id;
  await request(
    `/reports/${id}/comments`,
    "POST",
    { body: "Third level", revision_no: 1, reply_to_id: child },
    "bob",
  );
  assert.equal((await request("/comments/" + child)).body.ancestors.length, 2);
  await request(
    "/comments/" + root,
    "PATCH",
    { body: "Edited", edit_version: 1 },
    "bob",
  );
  await request("/comments/" + root, "DELETE", { edit_version: 2 }, "bob");
  assert.equal(
    (await request(`/reports/${id}/comments`)).body.items[0].body,
    null,
  );
  assert.equal((await request("/users/bob/comments")).body.items.length, 1);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM report_comment_history WHERE comment_id=?",
      )
      .get(root)?.n,
    3,
  );
  assert.equal((await request("/reports/" + id)).body.comment_count, 2);
  assert.equal(
    (
      await request(
        "/admin/action",
        "POST",
        {
          action: "report_visibility",
          target: String(id),
          value: "hidden",
          reason: "test",
        },
        "admin",
      )
    ).status,
    200,
  );
  assert.equal((await request("/comments/" + child)).status, 404);
  assert.equal((await request("/reports/" + id)).status, 404);
});
test("CSRF, terms and publication scope remain enforced", async () => {
  const { request, db } = await fixture();
  assert.equal(
    (
      await request("/reports", "POST", reportInput, "alice", {
        "X-CSRF-Token": "wrong",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/reports", "POST", reportInput, "alice", {
        Origin: "https://other.test",
      })
    ).status,
    403,
  );
  db.prepare(
    "UPDATE users SET accepted_terms_version='old' WHERE id='alice'",
  ).run();
  assert.equal((await request("/reports", "POST", reportInput)).status, 428);
  assert.equal(
    (await request("/me/terms-acceptance", "POST", { version: "test" })).status,
    200,
  );
  assert.equal((await request("/reports", "POST", reportInput)).status, 201);
});
test("rustdoc fixture: public functions and concrete methods, reexports; unknown formats fail", () => {
  const fn = {
    header: { is_unsafe: false, abi: "Rust" },
    generics: { params: [], where_predicates: [] },
    sig: { inputs: [], output: null },
  };
  const doc: any = {
    format_version: 61,
    root: 0,
    crate_version: "1.0.0",
    index: {
      0: { name: "sample", inner: { module: { items: [1, 2, 3, 6] } } },
      1: { name: "safe", visibility: "public", inner: { function: fn } },
      2: { name: "private", visibility: "default", inner: { function: fn } },
      3: {
        name: "Thing",
        visibility: "public",
        inner: { struct: { impls: [4, 7] } },
      },
      4: {
        inner: {
          impl: {
            for: { resolved_path: { path: "Thing" } },
            items: [5],
            generics: {},
          },
        },
      },
      5: {
        name: "run",
        visibility: "public",
        inner: {
          function: { ...fn, header: { is_unsafe: true, abi: "Rust" } },
        },
      },
      6: {
        name: "renamed",
        visibility: "public",
        inner: { use: { id: 1, name: "renamed", is_glob: false } },
      },
      7: {
        inner: {
          impl: {
            for: { resolved_path: { path: "sample::Thing" } },
            trait: { path: "sample::Debug" },
            generics: {},
            items: [8],
          },
        },
      },
      8: { name: "fmt", visibility: "default", inner: { function: fn } },
    },
  };
  const apis = extractAPIs(doc, "sample", "1.0.0");
  assert.deepEqual(
    apis.map((a) => a.display_path),
    [
      "sample::safe",
      "sample::Thing::run",
      "sample::renamed",
      "<sample::Thing as sample::Debug>::fmt",
    ],
  );
  assert.equal(apis[1].is_unsafe, 1);
  assert.equal(apis[3].kind, "method");
  assert.match(apis[3].signature, /^impl sample::Debug for sample::Thing\n/);
  assert.throws(() =>
    extractAPIs({ ...doc, format_version: 999 }, "sample", "1.0.0"),
  );
});

test("docs.rs hex 0.4.3 format 60 imports codec APIs and associated types", () => {
  const doc = JSON.parse(
    readFileSync(
      new URL("../fixtures/hex-0.4.3-rustdoc-60.json", import.meta.url),
      "utf8",
    ),
  );
  const apis = extractAPIs(doc, "hex", "0.4.3");
  assert.deepEqual(
    apis,
    JSON.parse(
      readFileSync(
        new URL("../fixtures/hex-0.4.3-legacy-apis.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const encode = apis.find((a) => a.canonical_key === "hex::encode_to_slice")!;
  const decode = apis.find((a) => a.canonical_key === "hex::decode_to_slice")!;
  assert.equal(
    encode.signature,
    "pub fn encode_to_slice<T: AsRef<[u8]>>(input: T, output: &mut [u8]) -> Result<(), FromHexError>",
  );
  assert.equal(
    decode.signature,
    "pub fn decode_to_slice<T: AsRef<[u8]>>(data: T, out: &mut [u8]) -> Result<(), FromHexError>",
  );
  assert.equal(encode.is_unsafe, 0);
  assert.equal(decode.is_unsafe, 0);
  assert.equal(
    encode.upstream_url,
    "https://docs.rs/hex/0.4.3/hex/fn.encode_to_slice.html",
  );
  assert.match(
    apis.find((a) => a.canonical_key === "hex::serialize")!.signature,
    /<S as serde_core::ser::Serializer>::Ok/,
  );
  assert.throws(
    () => extractAPIs({ ...doc, paths: {} }, "hex", "0.4.3"),
    /unresolved_rustdoc_path/,
  );
  assert.throws(
    () => extractAPIs({ ...doc, format_version: 999 }, "hex", "0.4.3"),
    /unsupported_rustdoc_format/,
  );
});

test("catalog refresh adds concrete trait methods without changing existing API IDs", async () => {
  const { db, env } = await fixture();
  const fn = {
    header: { is_unsafe: false, abi: "Rust" },
    generics: { params: [], where_predicates: [] },
    sig: { inputs: [], output: null },
  };
  const doc = {
    format_version: 61,
    crate_version: "1.0.0",
    root: 0,
    index: {
      0: { name: "sample", inner: { module: { items: [1, 2] } } },
      1: { name: "safe", visibility: "public", inner: { function: fn } },
      2: {
        name: "Thing",
        visibility: "public",
        inner: { struct: { impls: [3] } },
      },
      3: {
        inner: {
          impl: {
            for: { resolved_path: { path: "sample::Thing" } },
            trait: { path: "sample::Trait" },
            generics: {},
            items: [4],
          },
        },
      },
      4: { name: "method", visibility: "default", inner: { function: fn } },
    },
  };
  (env as any).ARCHIVE.get = async () => ({
    text: async () => JSON.stringify(doc),
  });
  assert.deepEqual(await refreshCatalog(env, 1), { indexed: 2, added: 1 });
  assert.deepEqual(await refreshCatalog(env, 1), { indexed: 2, added: 0 });
  assert.equal(
    db
      .prepare("SELECT id FROM api_items WHERE canonical_key='sample::safe'")
      .get()?.id,
    "safe",
  );
  assert.equal(
    db
      .prepare(
        "SELECT kind FROM api_items WHERE canonical_key='<sample::Thing as sample::Trait>::method'",
      )
      .get()?.kind,
    "method",
  );
});

test("catalog uses public trait and type aliases without exposing private paths", () => {
  const fn = {
    header: { is_unsafe: false, abi: "Rust" },
    generics: { params: [], where_predicates: [] },
    sig: { inputs: [], output: null },
  };
  const doc = {
    format_version: 61,
    crate_version: "1.0.0",
    root: 0,
    index: {
      0: { name: "sample", inner: { module: { items: [1, 2, 3] } } },
      1: {
        name: "hidden",
        visibility: "default",
        inner: { module: { items: [4, 5] } },
      },
      2: {
        name: "Alias",
        visibility: "public",
        inner: { use: { id: 4, name: "Alias", is_glob: false } },
      },
      3: {
        name: "PublicTrait",
        visibility: "public",
        inner: { use: { id: 5, name: "PublicTrait", is_glob: false } },
      },
      4: { name: "S", visibility: "public", inner: { struct: { impls: [6] } } },
      5: { name: "T", visibility: "public", inner: { trait: { items: [7] } } },
      6: {
        inner: {
          impl: {
            for: { resolved_path: { path: "sample::hidden::S" } },
            trait: { path: "sample::hidden::T", id: 5 },
            generics: {},
            items: [8],
          },
        },
      },
      7: { name: "m", visibility: "public", inner: { function: fn } },
      8: { name: "m", visibility: "default", inner: { function: fn } },
    },
  };
  assert.deepEqual(
    extractAPIs(doc, "sample", "1.0.0").map((a) => a.canonical_key),
    ["sample::PublicTrait::m", "<sample::Alias as sample::PublicTrait>::m"],
  );
});

test("Aeneas registration is usable through API and HTML, with a matching Book guide", async () => {
  const { env, request } = await fixture(false);
  const catalogue = await request("/tools");
  const tool = catalogue.body.items.find((t: any) => t.id === "aeneas");
  assert.equal(tool.active, 1);
  const version = catalogue.body.versions.find(
    (v: any) => v.tool_id === "aeneas",
  );
  assert.match(version.version, /^[a-f0-9]{40}$/);
  assert.equal(version.selectable, 1);
  assert.match(version.limitations, /extraction is not rerun/);
  const detail = await request("/tools/aeneas");
  assert.equal(detail.body.versions[0].id, version.id);
  assert.equal((await request(`/tool-versions/${version.id}`)).status, 200);
  for (const path of [
    "/tools",
    "/tool/aeneas",
    `/tool-version/${version.id}`,
  ]) {
    const response = await app.request("https://example.test" + path, {}, env);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Aeneas/);
    if (path === "/tool/aeneas")
      assert.match(html, /href="\/book\/aeneas.html"/);
  }
  const guide = readFileSync(
    new URL("../book/src/aeneas.md", import.meta.url),
    "utf8",
  );
  assert.ok(
    guide.includes(version.version),
    "Book must use a registered revision",
  );
  assert.ok(
    readFileSync(
      new URL("../book/src/SUMMARY.md", import.meta.url),
      "utf8",
    ).includes("(aeneas.md)"),
  );
});

test("Aeneas migration is additive and preserves curated metadata and retirement", () => {
  const { db } = database();
  db.exec(
    "UPDATE tools SET description='Curated description',active=0 WHERE id='aeneas'",
  );
  db.exec(
    "UPDATE tool_versions SET limitations='Curated limitations',selectable=0 WHERE tool_id='aeneas'",
  );
  db.exec(
    readFileSync(
      new URL("../migrations/0009_aeneas_catalog.sql", import.meta.url),
      "utf8",
    ),
  );
  const tool = db.prepare("SELECT * FROM tools WHERE id='aeneas'").get()!;
  assert.equal(tool.description, "Curated description");
  assert.equal(tool.active, 0);
  const versions = db
    .prepare("SELECT * FROM tool_versions WHERE tool_id='aeneas'")
    .all();
  assert.equal(versions.length, 1);
  assert.equal(versions[0].limitations, "Curated limitations");
  assert.equal(versions[0].selectable, 0);
});

test("catalogue with registered Aeneas can be managed through the authenticated admin API", async () => {
  const { request } = await fixture(false);
  const baseline = await request("/tools");
  assert.deepEqual(
    baseline.body.items.map((t: any) => t.id),
    ["aeneas"],
  );
  assert.equal(baseline.body.versions.length, 1);
  const tool = {
    action: "tool",
    target: "test-verifier",
    name: "Test verifier",
    description: "A configurable tool",
    url: "https://example.test/verifier",
    reason: "Register tool",
  };
  assert.equal((await request("/admin/action", "POST", tool)).status, 403);
  assert.equal(
    (await request("/admin/action", "POST", tool, "admin")).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/admin/action",
        "POST",
        {
          action: "tool_version",
          target: "test-verifier-1",
          tool_id: tool.target,
          version: "1.0",
          reason: "Register version",
        },
        "admin",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/admin/action",
        "POST",
        { ...tool, name: "Updated verifier" },
        "admin",
      )
    ).status,
    200,
  );
  const catalogue = await request("/tools");
  assert.equal(catalogue.body.items.length, 2);
  assert.equal(
    catalogue.body.items.find((t: any) => t.id === tool.target).name,
    "Updated verifier",
  );
  assert.equal(
    catalogue.body.versions.find((v: any) => v.tool_id === tool.target).version,
    "1.0",
  );
});

test("device expiry, token expiry, suspension, quotas, and user erasure", async () => {
  const { env, db, request } = await fixture();
  const token = "a".repeat(64),
    h = await hash(token),
    future = new Date(Date.now() + 86400000).toISOString();
  db.prepare(
    "INSERT INTO api_tokens(id,user_id,token_hash,scope,created_at,expires_at) VALUES('token','alice',?,'publish',?,?)",
  ).run(h, new Date().toISOString(), future);
  const headers = { Authorization: "Bearer " + token };
  db.exec("UPDATE api_tokens SET expires_at='2000-01-01'");
  assert.equal(
    (await request("/me", "GET", undefined, "", headers)).status,
    401,
  );
  db.prepare("UPDATE api_tokens SET expires_at=?").run(future);
  await request(
    "/admin/action",
    "POST",
    { action: "suspend", target: "alice", reason: "Test" },
    "admin",
  );
  await request(
    "/admin/action",
    "POST",
    { action: "restore_user", target: "alice", reason: "Test" },
    "admin",
  );
  assert.equal(
    (await request("/me", "GET", undefined, "", headers)).status,
    401,
  );
  const r = await app.request(
    "https://example.test/auth/device/code",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "client_id=proofs-cli",
    },
    env,
  );
  const start = (await r.json()) as any;
  assert.equal(r.status, 200);
  db.exec("UPDATE device_authorizations SET expires_at='2000-01-01'");
  const poll = await app.request(
    "https://example.test/auth/device/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: "proofs-cli",
        device_code: start.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    },
    env,
  );
  assert.equal(((await poll.json()) as any).error, "expired_token");
  db.exec("UPDATE rate_limits SET used=lim WHERE kind='device_start'");
  const limited = await app.request(
    "https://example.test/auth/device/code",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "proofs-cli" }),
    },
    env,
  );
  assert.equal(limited.status, 429);
  assert.equal(
    (
      await request(
        "/admin/action",
        "POST",
        { action: "delete_user", target: "alice", reason: "Test" },
        "admin",
      )
    ).status,
    200,
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM api_tokens").get()!.n, 0);
});

test("OpenAPI covers non-admin routes and excludes administrative schemas", async () => {
  const { env } = await fixture();
  const response = await app.request(
    "https://example.test/openapi.json",
    {},
    env,
  );
  assert.equal(response.status, 200);
  const spec: any = await response.json();
  const actual = new Set(
    app.routes
      .filter(
        (r) =>
          r.method !== "ALL" &&
          !r.path.includes("*") &&
          !r.path.startsWith("/api/v1/admin/") &&
          !r.path.startsWith("/api/docs") &&
          (r.path.startsWith("/api/") || r.path.startsWith("/auth/")),
      )
      .map(
        (r) =>
          r.method.toLowerCase() +
          " " +
          r.path.replace(/:([a-zA-Z_]+)/g, "{$1}"),
      ),
  );
  const documented = new Set(
    Object.entries(spec.paths).flatMap(([p, methods]) =>
      Object.keys(methods as any).map((m) => m + " " + p),
    ),
  );
  assert.deepEqual(documented, actual);
  assert.doesNotMatch(
    JSON.stringify(spec),
    /Administration|\/admin\/|comment_history|audit_events/,
  );
  function walk(v: any) {
    if (!v || typeof v !== "object") return;
    if (v.$ref) {
      assert.ok(v.$ref.startsWith("#/components/"));
      assert.ok(spec.components[v.$ref.split("/")[2]][v.$ref.split("/").pop()]);
    }
    Object.values(v).forEach(walk);
  }
  walk(spec);
});

test("device login, one-time exchange, scope isolation, ownership and revocation", async () => {
  const { env, db, request } = await fixture();
  async function auth(
    path: string,
    body: any,
    browser = false,
    headers: Record<string, string> = {},
  ) {
    const r = await app.request(
      "https://example.test/auth/device/" + path,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(browser
            ? {
                Origin: env.APP_ORIGIN,
                Cookie: "__Host-proofsr_session=alice",
                "X-CSRF-Token": "csrf",
              }
            : {}),
          ...headers,
        },
        body: JSON.stringify(body),
      },
      env,
    );
    return { status: r.status, body: (await r.json()) as any };
  }
  const start = await auth("code", { client_id: "proofs-cli" });
  assert.equal(start.status, 200);
  const poll = {
    client_id: "proofs-cli",
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: start.body.device_code,
  };
  assert.equal((await auth("token", poll)).body.error, "authorization_pending");
  assert.equal((await auth("token", poll)).body.error, "slow_down");
  assert.equal(
    (await auth("approve", { user_code: start.body.user_code })).status,
    403,
  );
  assert.equal(
    (
      await auth("approve", { user_code: start.body.user_code }, true, {
        "X-CSRF-Token": "wrong",
      })
    ).status,
    403,
  );
  assert.equal(
    (await auth("inspect", { user_code: start.body.user_code }, true)).body
      .state,
    "pending",
  );
  assert.equal(
    (await auth("approve", { user_code: start.body.user_code }, true)).status,
    200,
  );
  assert.equal(
    (await auth("approve", { user_code: start.body.user_code }, true)).status,
    409,
  );
  db.exec("UPDATE device_authorizations SET next_poll_at='2000-01-01'");
  const issued = await auth("token", poll);
  assert.equal(issued.status, 200);
  assert.ok(issued.body.access_token);
  assert.equal((await auth("token", poll)).body.error, "invalid_grant");
  const stored = db.prepare("SELECT * FROM api_tokens").get() as any;
  assert.equal(stored.token_hash, await hash(issued.body.access_token));
  assert.equal(stored.name, undefined);
  const headers = {
    Authorization: "Bearer " + issued.body.access_token,
    Origin: "",
    "X-CSRF-Token": "",
    Cookie: "",
  };
  assert.equal(
    (await request("/reports", "POST", reportInput, "", headers)).status,
    201,
  );
  assert.equal(
    (
      await request(
        "/reports/1/revisions",
        "POST",
        { ...reportInput, expected_revision: 1, title: "Updated" },
        "",
        headers,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await request(
        "/publish/prepare",
        "POST",
        { crate: "sample", version: "1.0.0" },
        "",
        headers,
      )
    ).body.status,
    "pending",
  );
  assert.equal(
    (await request("/admin/audit", "GET", undefined, "", headers)).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/reports/1/comments",
        "POST",
        { body: "hello", revision_no: 1 },
        "",
        headers,
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("/me/tokens", "GET", undefined, "", headers)).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/me/terms-acceptance",
        "POST",
        { version: "test" },
        "",
        headers,
      )
    ).status,
    403,
  );
  const listed = (await request("/me/tokens")).body.items;
  assert.equal(listed[0].id, issued.body.token_id);
  assert.ok(!("token_hash" in listed[0]));
  await request(
    "/me/tokens/" + issued.body.token_id,
    "DELETE",
    undefined,
    "bob",
  );
  assert.equal(
    (await request("/me", "GET", undefined, "", headers)).status,
    200,
  );
  db.exec("UPDATE users SET accepted_terms_version='old' WHERE id='alice'");
  assert.equal(
    (await request("/reports", "POST", reportInput, "", headers)).status,
    428,
  );
  assert.equal(
    (await request("/tokens/revoke", "POST", {}, "", headers)).status,
    200,
  );
  assert.equal(
    (await request("/me", "GET", undefined, "", headers)).status,
    401,
  );
  // Invalid Bearer must not fall back to the valid browser session.
  assert.equal(
    (
      await request("/me", "GET", undefined, "alice", {
        Authorization: "Bearer bad",
      })
    ).status,
    401,
  );
});

test("moderation redacts shared and individual revision text and user erasure removes stars", async () => {
  const { request, db } = await fixture();
  const made = await request("/reports", "POST", reportInput);
  const id = made.body.id;
  const claimID = (await request("/reports/" + id)).body.claims[0].id;
  await request(`/reports/${id}/star`, "PUT", {}, "bob");
  await request(`/claims/${claimID}/star`, "PUT", {}, "bob");
  const redacted = await request(
    "/admin/action",
    "POST",
    {
      action: "redact_revision",
      target: id,
      revision_no: 1,
      reason: "Remove private text",
    },
    "admin",
  );
  assert.equal(redacted.status, 200, JSON.stringify(redacted.body));
  const r = (await request("/reports/" + id)).body;
  assert.equal(r.title, "[Redacted]");
  assert.equal(r.claims[0].title, "[Redacted]");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM maintenance").get()!.n, 0);
  assert.throws(
    () => db.exec("UPDATE report_revisions SET title='illegal'"),
    /immutable_revision/,
  );
  assert.equal(
    (
      await request(
        "/admin/action",
        "POST",
        { action: "delete_user", target: "bob", reason: "User request" },
        "admin",
      )
    ).status,
    200,
  );
  assert.equal((await request("/reports/" + id)).body.star_count, 0);
  assert.equal((await request("/claims/" + claimID)).body.star_count, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("staging fixture is repeatable and exposes report catalogue without imported snapshots", async () => {
  const { request, db } = await fixture();
  const sql = readFileSync(
    new URL("../fixtures/staging-demo.sql", import.meta.url),
    "utf8",
  );
  db.exec(sql);
  db.exec(sql);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reports").get()!.n, 13);
  const layout = db
    .prepare("SELECT id FROM reports WHERE create_key='staging-layout-v1-full'")
    .get()!;
  const layoutReport = (await request("/reports/" + layout.id)).body;
  assert.equal(layoutReport.revision_no, 55);
  assert.equal(layoutReport.claims.length, 8);
  assert.equal(layoutReport.run_ids.length, 2);
  assert.equal(layoutReport.comment_count, 55);
  assert.deepEqual(
    [...new Set(layoutReport.claims.map((c: any) => c.category))].sort(),
    ["associated", "function", "method", "trait"],
  );
  const envOnly = db
    .prepare(
      "SELECT id FROM reports WHERE create_key='staging-layout-v1-environment-only'",
    )
    .get()!;
  const envReport = (await request("/reports/" + envOnly.id)).body;
  assert.equal(envReport.run_ids.length, 0);
  assert.ok(envReport.environment);

  const home = await request("/home");
  assert.equal(home.status, 200, JSON.stringify(home.body));
  assert.equal(home.body.reports.length, 11);
  assert.equal("crates" in home.body, false);
  const allCrates = await request("/crates");
  assert.equal(allCrates.status, 200, JSON.stringify(allCrates.body));
  assert.equal(allCrates.body.total_count, 8);
  assert.equal(allCrates.body.matching_count, 8);
  const found = await request("/crates?q=array");
  assert.equal(found.body.total_count, 8);
  assert.equal(found.body.matching_count, 1);
  assert.equal(found.body.items[0].api_count, 6);
  assert.equal(found.body.items[0].report_count, 2);
  assert.equal(found.body.items[0].claim_count, 7);
  assert.equal((await request("/crates?q=%25")).body.matching_count, 0);

  const list = await request("/crates/arrayvec/0.7.6-demo.1/apis");
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.items.length, 6);
  const first = home.body.reports.find(
    (x: any) => x.crate === "arrayvec" && x.tool === "Kani (demo)",
  );
  const detail = await request("/reports/" + first.id);
  assert.equal(detail.body.claims.length, 5);
  const reports = await request("/crates/arrayvec/0.7.6-demo.1/reports");
  assert.equal(reports.status, 200, JSON.stringify(reports.body));
  assert.equal(reports.body.items.length, 2);
  assert.ok(
    reports.body.items.every(
      (r: any) => r.crate === "arrayvec" && r.version === "0.7.6-demo.1",
    ),
  );
  assert.equal(
    (await request("/crates/arrayvec/0.7.5/reports")).body.items.length,
    0,
  );

  const traitReport = home.body.reports.find(
    (r: any) => r.crate === "trait-demo",
  );
  const traitDetail = await request("/reports/" + traitReport.id);
  assert.equal(traitDetail.body.claims.length, 3);
  const traitAPIs = await request("/crates/trait-demo/0.1.0-demo.1/apis");
  assert.deepEqual(
    traitAPIs.body.items.map((a: any) => a.display_path).sort(),
    [
      "<trait_demo::Buffer as trait_demo::Inspect>::read",
      "<trait_demo::Buffer as trait_demo::Read>::read",
      "trait_demo::Buffer::read",
    ],
  );
  assert.ok(traitAPIs.body.items.every((a: any) => a.kind === "method"));

  const comments = await request("/reports/" + first.id + "/comments");
  assert.equal(comments.status, 200);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("report list filters by keyword, tool and author", async () => {
  const { JSDOM } = await import("jsdom");
  const { db, env, request } = await fixture();
  db.exec(
    readFileSync(
      new URL("../fixtures/staging-demo.sql", import.meta.url),
      "utf8",
    ),
  );
  const ids = async (query: string) => {
    const response = await request("/reports?" + query);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.items.map((r: any) => r.id);
  };
  // Withdrawn reports 7 and 13 stay hidden under every filter.
  assert.deepEqual(await ids(""), [12, 11, 10, 9, 8, 6, 5, 4, 3, 2, 1]);
  assert.deepEqual(await ids("q=with+Miri"), [3, 2]);
  assert.deepEqual(await ids("q=report-layout"), [12, 11, 10]);
  assert.deepEqual(await ids("q=%25"), []);
  assert.deepEqual(await ids("q=_"), []);
  assert.deepEqual(await ids("tool=demo-kani"), [9, 8, 5, 4, 1]);
  assert.deepEqual(await ids("author=DEMO_MIRA"), [12, 11, 10, 9, 4, 1]);
  assert.deepEqual(await ids("tool=demo-kani&author=demo_mira"), [9, 4, 1]);
  assert.deepEqual(await ids("q=arrayvec&tool=demo-miri"), [2]);
  assert.deepEqual(await ids("q=+&tool=&author="), await ids(""));
  const cursor = Buffer.from("[5]").toString("base64url");
  assert.deepEqual(await ids(`tool=demo-kani&cursor=${cursor}`), [4, 1]);

  const page = async (path: string) =>
    new JSDOM(
      await (await app.request("https://example.test" + path, {}, env)).text(),
    ).window.document;
  let d = await page("/reports");
  assert.equal(d.querySelectorAll("article.claim-item").length, 11);
  assert.equal(d.querySelector(".report-filters a"), null);
  assert.equal(d.querySelector(".report-filters option[selected]"), null);
  const filterDOM = new JSDOM(d.documentElement.outerHTML, {
    url: "https://example.test/reports?cursor=old",
    runScripts: "outside-only",
  });
  filterDOM.window.eval(
    readFileSync(new URL("../public/site.js", import.meta.url), "utf8"),
  );
  const form =
    filterDOM.window.document.querySelector<HTMLFormElement>(
      ".report-filters",
    )!;
  const toolSelect = form.querySelector('select[name="tool"]')! as unknown as {
    value: string;
    dispatchEvent(event: Event): boolean;
  };
  form.querySelector<HTMLInputElement>('[name="q"]')!.value = "verification";
  form.querySelector<HTMLInputElement>('[name="author"]')!.value = "demo_mira";
  const submissions: string[] = [];
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submissions.push(
      new URLSearchParams(
        new filterDOM.window.FormData(form) as any,
      ).toString(),
    );
  });
  toolSelect.value = "demo-kani";
  toolSelect.dispatchEvent(
    new filterDOM.window.Event("change", { bubbles: true }),
  );
  toolSelect.value = "";
  toolSelect.dispatchEvent(
    new filterDOM.window.Event("change", { bubbles: true }),
  );
  assert.deepEqual(submissions, [
    "q=verification&tool=demo-kani&author=demo_mira",
    "q=verification&tool=&author=demo_mira",
  ]);
  filterDOM.window.close();
  d = await page(
    `/reports?q=verification&tool=demo-kani&author=demo_mira&cursor=${cursor}`,
  );
  assert.deepEqual(
    [...d.querySelectorAll("article.claim-item > a:first-child")].map(
      (a) => a.textContent,
    ),
    ["#4 bytes verification with Kani", "#1 arrayvec verification with Kani"],
  );
  assert.equal(
    d.querySelector<HTMLInputElement>('.report-filters [name="q"]')!.value,
    "verification",
  );
  assert.equal(
    d.querySelector(".report-filters option[selected]")?.getAttribute("value"),
    "demo-kani",
  );
  assert.equal(
    d.querySelector<HTMLInputElement>('.report-filters [name="author"]')!.value,
    "demo_mira",
  );
  assert.equal(
    d.querySelector(".report-filters a")?.getAttribute("href"),
    "/reports",
  );
  assert.equal(
    d.querySelector(".pagination a")?.getAttribute("href"),
    "/reports?q=verification&tool=demo-kani&author=demo_mira",
  );
  d = await page("/reports?author=nobody");
  assert.equal(
    d.querySelector("main p:last-child")?.textContent,
    "No matching reports.",
  );
});

test("import stores normalized crate description using the existing metadata request", async (t) => {
  const { db, env } = await fixture();
  db.exec(
    "DELETE FROM doc_snapshots; INSERT INTO import_jobs(id,release_id,status,created_at) VALUES('description-import',1,'pending','2026-09-21T00:00:00.000Z')",
  );
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: any) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith("https://crates.io/"))
      return Response.json({
        version: {
          num: "1.0.0",
          checksum: "checksum",
          yanked: false,
          description: "A crate.\n  Short description.",
        },
      });
    if (url.startsWith("https://docs.rs/"))
      return Response.json({
        format_version: 61,
        root: 0,
        crate_version: "1.0.0",
        index: {
          0: { name: "sample", inner: { module: { items: [1] } } },
          1: {
            name: "safe",
            visibility: "public",
            inner: {
              function: {
                header: { is_unsafe: false, abi: "Rust" },
                generics: { params: [], where_predicates: [] },
                sig: { inputs: [], output: null },
              },
            },
          },
        },
      });
    throw Error("Unexpected request: " + url);
  });
  assert.equal(await importJob(env, "description-import"), true);
  assert.equal(
    db
      .prepare(
        "SELECT extractor_version FROM catalog_versions WHERE release_id=1",
      )
      .get()!.extractor_version,
    CATALOG_EXTRACTOR_VERSION,
  );
  assert.equal(
    db
      .prepare(
        "SELECT status,error_code FROM import_jobs WHERE id='description-import'",
      )
      .get()!.status,
    "ready",
  );
  assert.equal(
    db.prepare("SELECT description FROM crates WHERE name='sample'").get()!
      .description,
    "A crate. Short description.",
  );
  assert.equal(urls.length, 2);
});

test("public stargazers paginate without duplicates and respect target visibility", async () => {
  const { request, db } = await fixture();
  const id = (await request("/reports", "POST", reportInput)).body.id;
  const claim = (await request(`/reports/${id}`)).body.claims[0].id;
  for (let n = 0; n < 35; n++) {
    const uid = `star-user-${String(n).padStart(2, "0")}`;
    db.prepare(
      "INSERT INTO users(id,github_id,username,created_at,accepted_terms_version,terms_accepted_at) VALUES(?,?,?,?,'test','2026-01-01')",
    ).run(uid, 100 + n, uid, "2026-01-01");
    db.prepare("INSERT INTO report_stars VALUES(?,?,?)").run(
      id,
      uid,
      "2026-01-01",
    );
    db.prepare("INSERT INTO claim_stars VALUES(?,?,?)").run(
      claim,
      uid,
      "2026-01-01",
    );
  }
  for (const path of [`/reports/${id}/stars`, `/claims/${claim}/stars`]) {
    const first = await request(path, "GET", undefined, "");
    assert.equal(first.status, 200);
    assert.equal(first.body.items.length, 30);
    assert.deepEqual(Object.keys(first.body.items[0]).sort(), [
      "created_at",
      "id",
      "username",
    ]);
    const second = await request(
      path + "?cursor=" + encodeURIComponent(first.body.next_cursor),
      "GET",
      undefined,
      "",
    );
    assert.equal(second.body.items.length, 5);
    assert.equal(second.body.next_cursor, null);
    assert.equal(
      new Set([...first.body.items, ...second.body.items].map((x: any) => x.id))
        .size,
      35,
    );
  }
  db.prepare("UPDATE reports SET visibility='hidden' WHERE id=?").run(id);
  assert.equal(
    (await request(`/reports/${id}/stars`, "GET", undefined, "")).status,
    404,
  );
  assert.equal(
    (await request(`/claims/${claim}/stars`, "GET", undefined, "")).status,
    404,
  );
});

test("first GitHub login requires explicit signup; existing login bypasses it", async (t) => {
  const { env, db } = await fixture();
  env.GITHUB_CLIENT_ID = "test";
  env.GITHUB_CLIENT_SECRET = "test";
  env.ADMIN_GITHUB_IDS = "540144";
  let githubID = 999;
  t.mock.method(globalThis, "fetch", async (input: any) => {
    const path = String(input);
    if (path.includes("access_token"))
      return Response.json({ access_token: "test" });
    if (path.endsWith("/user/emails"))
      return Response.json([
        { email: "test@example.test", primary: true, verified: true },
      ]);
    return Response.json({
      id: githubID,
      login: githubID === 999 ? "new-user" : "alice",
    });
  });
  const call = (
    path: string,
    cookie: string,
    method = "GET",
    body?: any,
    csrf = "",
    origin = env.APP_ORIGIN,
  ) =>
    app.request(
      env.APP_ORIGIN + path,
      {
        method,
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      env,
    );
  const cookies = (r: Response) =>
    r.headers
      .getSetCookie()
      .map((x) => x.split(";")[0])
      .join("; ");
  async function oauth() {
    const start = await call(
      "/auth/github?return_to=" + encodeURIComponent("/device?code=ABCD-EFGH"),
      "",
    );
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state",
    );
    return call(
      "/auth/github/callback?code=test&state=" + state,
      cookies(start),
    );
  }
  const callback = await oauth();
  assert.equal(callback.headers.get("location"), "/signup");
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM users WHERE github_id=999").get()!.n,
    0,
  );
  const cookie = cookies(callback);
  const pending = (await (await call("/auth/signup", cookie)).json()) as any;
  assert.equal(pending.username, "new-user");
  const b = { terms_version: "test" };
  assert.equal(
    (await call("/auth/signup", cookie, "POST", b, "wrong")).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/auth/signup",
        cookie,
        "POST",
        b,
        pending.csrf,
        "https://evil.test",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/auth/signup",
        cookie,
        "POST",
        { terms_version: "old" },
        pending.csrf,
      )
    ).status,
    409,
  );
  const signed = await call("/auth/signup", cookie, "POST", b, pending.csrf);
  assert.equal(signed.status, 200, await signed.clone().text());
  assert.equal(
    ((await signed.json()) as any).return_to,
    "/device?code=ABCD-EFGH",
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM users WHERE github_id=999").get()!.n,
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM pending_signups").get()!.n,
    0,
  );
  assert.match(cookies(signed), /__Host-proofsr_session=/);
  assert.equal(
    (await call("/auth/signup", cookie, "POST", b, pending.csrf)).status,
    401,
  );
  githubID = 1;
  const existing = await oauth();
  assert.equal(existing.headers.get("location"), "/device?code=ABCD-EFGH");
  assert.match(cookies(existing), /__Host-proofsr_session=/);
  // Abandoned registrations expire and cannot be confirmed.
  githubID = 1000;
  const abandoned = await oauth();
  const abandonedCookie = cookies(abandoned);
  db.exec("UPDATE pending_signups SET expires_at='2000-01-01'");
  assert.equal((await call("/auth/signup", abandonedCookie)).status, 401);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM users WHERE github_id=1000").get()!.n,
    0,
  );
  const switchAccount = await call(
    "/auth/github?switch_account=1&return_to=https://evil.test",
    abandonedCookie,
  );
  assert.equal(
    new URL(switchAccount.headers.get("location")!).searchParams.get("prompt"),
    "select_account",
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM pending_signups").get()!.n,
    0,
  );
});

test("tool version limitations are operator-maintained, live on old reports, and version-scoped", async () => {
  const { request, db } = await fixture();
  const version = "/tool-versions/kani-0.68.0";
  const made = await request("/reports", "POST", reportInput);
  const id = made.body.id;
  const before = (await request(`/reports/${id}`)).body;
  assert.equal(before.tool_limitations, "");
  assert.equal(before.tool_limitations_updated_at, null);
  const action = {
    action: "tool_version_limitations",
    target: "kani-0.68.0",
    limitations: "Bounded harnesses only.\n<script>example</script>",
    reason: "Document known limitations",
  };
  assert.equal((await request("/admin/action", "POST", action)).status, 403);
  assert.equal(
    (await request("/admin/action", "POST", action, "admin")).status,
    200,
  );
  const v = (await request(version, "GET", undefined, "")).body;
  assert.equal(v.limitations, action.limitations);
  assert.ok(v.limitations_updated_at);
  const report = (await request(`/reports/${id}?v=1`)).body;
  const claim = (
    await request(`/claims/${before.claims[0].id}?report_revision=1`)
  ).body;
  for (const item of [report, claim]) {
    assert.equal(item.tool_limitations, action.limitations);
    assert.equal(item.tool_limitations_updated_at, v.limitations_updated_at);
  }
  assert.equal(report.revision_no, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM report_revisions").get()!.n,
    1,
  );
  assert.equal((await request(version + "/reports")).body.items[0].id, id);
  db.exec(
    "INSERT INTO tool_versions(id,tool_id,version) VALUES('other-version','kani','other')",
  );
  assert.equal(
    (await request("/tool-versions/other-version/reports")).body.items.length,
    0,
  );
  db.exec(`UPDATE reports SET visibility='hidden' WHERE id=${id}`);
  assert.equal((await request(version + "/reports")).body.items.length, 0);
  assert.equal((await request("/tool-versions/missing")).status, 404);
  assert.equal((await request("/tool-versions/missing/reports")).status, 404);
  assert.equal(
    (
      await request(
        "/admin/action",
        "POST",
        { ...action, target: "missing" },
        "admin",
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        "/admin/action",
        "POST",
        { ...action, limitations: "x".repeat(10001) },
        "admin",
      )
    ).status,
    400,
  );
  await request(
    "/admin/action",
    "POST",
    {
      action: "tool_version",
      target: action.target,
      tool_id: "kani",
      version: "0.68.0",
      selectable: false,
      reason: "Retire",
    },
    "admin",
  );
  assert.equal((await request(version)).body.limitations, action.limitations);
  await request(
    "/admin/action",
    "POST",
    { ...action, limitations: "" },
    "admin",
  );
  assert.equal((await request(version)).body.limitations, "");
});

test("existing bearer tokens use current admin IDs with audit and authentication guards", async () => {
  const { env, db } = await fixture(false);
  const token = "c".repeat(64);
  db.prepare(
    "INSERT INTO api_tokens(id,user_id,token_hash,scope,created_at,expires_at) VALUES('admin-token','admin',?,'publish',?,?)",
  ).run(
    await hash(token),
    new Date().toISOString(),
    new Date(Date.now() + 86400000).toISOString(),
  );
  const action = {
    action: "tool",
    target: "kani",
    name: "kani",
    description: "Verifier",
    url: "https://model-checking.github.io/kani/",
    active: true,
    reason: "Register verifier",
  };
  // Deliberately omit cookies, Origin and CSRF, exactly as a curl client would.
  const call = async (path: string, body?: unknown, credential = token) => {
    const res = await app.request(
      "https://example.test/api/v1" + path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: "Bearer " + credential,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  // A stale stored role does not prevent access for a currently configured admin.
  db.exec("UPDATE users SET role='user' WHERE id='admin'");
  env.ADMIN_GITHUB_IDS = "99, 3 ";
  assert.equal((await call("/admin/action", action)).status, 200);
  assert.equal(
    (
      await call("/admin/action", {
        action: "tool_version",
        target: "kani-0.68.0",
        tool_id: "kani",
        version: "0.68.0",
        selectable: true,
        reason: "Register release",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/admin/action", {
        action: "tool_version_limitations",
        target: "kani-0.68.0",
        limitations: "Test limitations",
        reason: "Document limitations",
      })
    ).status,
    200,
  );
  assert.equal(
    db
      .prepare("SELECT limitations FROM tool_versions WHERE id='kani-0.68.0'")
      .get()!.limitations,
    "Test limitations",
  );
  const audit = await call("/admin/audit");
  assert.equal(audit.status, 200);
  assert.equal(audit.body.items.length, 3);
  assert.ok(audit.body.items.every((item: any) => item.actor_id === "admin"));
  assert.equal((await call("/admin/deliveries")).status, 200);
  assert.equal((await call("/admin/comments/missing/history")).status, 200);
  // The exception is limited to admin routes, not other browser-only endpoints.
  assert.equal((await call("/me/tokens")).body.error, "insufficient_scope");
  assert.equal(
    (await call("/admin/action", { ...action, reason: "" })).status,
    400,
  );

  db.exec("UPDATE users SET role='admin' WHERE id='admin'");
  for (const ids of ["", "33", "1,2"]) {
    env.ADMIN_GITHUB_IDS = ids;
    assert.equal((await call("/admin/audit")).body.error, "admin_required");
    assert.equal(
      (await call("/admin/action", action)).body.error,
      "admin_required",
    );
  }
  env.ADMIN_GITHUB_IDS = "3";
  db.exec("UPDATE api_tokens SET user_id='alice'");
  assert.equal((await call("/admin/audit")).body.error, "admin_required");
  assert.equal(
    (await call("/admin/action", action)).body.error,
    "admin_required",
  );
  db.exec("UPDATE api_tokens SET user_id='admin'");
  db.exec("UPDATE users SET accepted_terms_version='old' WHERE id='admin'");
  assert.equal((await call("/admin/action", action)).status, 428);
  db.exec(
    "UPDATE users SET accepted_terms_version='test',status='suspended' WHERE id='admin'",
  );
  assert.equal((await call("/admin/audit")).body.error, "account_suspended");
  db.exec("UPDATE users SET status='active' WHERE id='admin'");
  db.exec("UPDATE api_tokens SET revoked_at='2026-01-01'");
  assert.equal(
    (await call("/admin/action", action)).body.error,
    "invalid_token",
  );
  db.exec("UPDATE api_tokens SET revoked_at=NULL,expires_at='2000-01-01'");
  assert.equal((await call("/admin/audit")).body.error, "invalid_token");
  assert.equal(
    (await call("/admin/audit", undefined, "bad")).body.error,
    "invalid_token",
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events").get()!.n, 4);
});

test("browser admin requests retain CSRF and origin checks and follow current admin IDs", async () => {
  const { env, request } = await fixture();
  const action = {
    action: "pause",
    target: "imports_paused",
    value: true,
    reason: "Test",
  };
  assert.equal(
    (
      await request("/admin/action", "POST", action, "admin", {
        "X-CSRF-Token": "wrong",
      })
    ).body.error,
    "invalid_csrf",
  );
  assert.equal(
    (
      await request("/admin/action", "POST", action, "admin", {
        Origin: "https://other.test",
      })
    ).body.error,
    "invalid_origin",
  );
  env.ADMIN_GITHUB_IDS = "";
  assert.equal(
    (await request("/admin/audit", "GET", undefined, "admin")).body.error,
    "admin_required",
  );
});

test("single-request run registration compensates failures and reclaims only crash leftovers", async () => {
  const { env, db } = await fixture();
  const objects = new Map<string, { bytes: Uint8Array; uploaded: Date }>();
  env.ARCHIVE = {
    put: async (key: string, bytes: ArrayBuffer) => {
      objects.set(key, { bytes: new Uint8Array(bytes), uploaded: new Date() });
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
    list: async () => ({
      objects: [...objects].map(([key, o]) => ({ key, uploaded: o.uploaded })),
      truncated: false,
    }),
  } as any;
  const rid = "33333333-3333-4333-8333-333333333333";
  const upload = () =>
    app.request(
      `https://example.test/api/v1/runs/${rid}/sarif`,
      {
        method: "POST",
        headers: {
          Origin: env.APP_ORIGIN,
          Cookie: "__Host-proofsr_session=alice",
          "X-CSRF-Token": "csrf",
        },
        body: JSON.stringify(recordedSarif(rid)),
      },
      env,
    );
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = async () => {
    throw Error("simulated DB failure");
  };
  assert.equal((await upload()).status, 500);
  assert.equal(
    objects.size,
    0,
    "failed DB registration must remove its upload",
  );
  assert.equal(
    db.prepare("SELECT id FROM verification_runs WHERE id=?").get(rid),
    undefined,
  );
  env.DB.batch = async (statements: any) => {
    await batch(statements);
    throw Error("lost committed response");
  };
  assert.equal((await upload()).status, 200);
  assert.equal(
    objects.size,
    1,
    "lost response must not delete committed evidence",
  );
  env.DB.batch = batch;
  const old = new Date(Date.now() - 2 * 86400000);
  for (const o of objects.values()) o.uploaded = old;
  objects.set("runs/orphan/old", { bytes: new Uint8Array(), uploaded: old });
  objects.set("runs/orphan/recent", {
    bytes: new Uint8Array(),
    uploaded: new Date(),
  });
  await cleanupRunUploads(env);
  assert.equal(objects.has("runs/orphan/old"), false);
  assert.equal(objects.has("runs/orphan/recent"), true);
  assert.equal(objects.size, 2, "keep committed evidence regardless of age");
});

test("new trait-driven structural paths match cargo-proofs fixtures", () => {
  const cases = JSON.parse(
    readFileSync(
      new URL(
        "../cli/tests/fixtures/canonical-trait-paths.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const c of cases) {
    const doc = traitImplFixture(c.type);
    doc.paths = c.paths || {};
    const apis = extractAPIs(doc, "sample", "1.0.0");
    assert.deepEqual(
      apis.map((a) => a.canonical_key),
      ["sample::T::m", `<${c.key} as sample::T>::m`],
      c.source,
    );
    assert.equal(
      apis.find((a) => a.canonical_key === `<${c.key} as sample::T>::m`)!
        .upstream_url,
      "https://docs.rs/sample/1.0.0/sample/trait.T.html#tymethod.m",
    );
  }
});

function traitImplFixture(selfType: any): any {
  const fn = {
    header: { is_unsafe: false, abi: "Rust" },
    generics: {},
    sig: { inputs: [], output: null },
    has_body: false,
  };
  return {
    format_version: 61,
    crate_version: "1.0.0",
    root: 0,
    index: {
      0: { crate_id: 0, name: "sample", inner: { module: { items: [1] } } },
      1: {
        crate_id: 0,
        name: "T",
        visibility: "public",
        inner: { trait: { items: [2], implementations: [3] } },
      },
      2: { name: "m", inner: { function: fn } },
      3: {
        crate_id: 0,
        inner: {
          impl: {
            for: selfType,
            trait: { path: "T", id: 1 },
            generics: {},
            items: [4],
          },
        },
      },
      4: {
        name: "m",
        visibility: "default",
        inner: { function: { ...fn, has_body: true } },
      },
    },
  };
}

test("trait traversal preserves legacy entries and all public aliases without duplicates", () => {
  const doc = traitImplFixture({ resolved_path: { path: "S", id: 5 } });
  doc.index[0].inner.module.items.push(5, 6, 7);
  doc.index[5] = {
    crate_id: 0,
    name: "S",
    visibility: "public",
    inner: { struct: { impls: [3] } },
  };
  doc.index[6] = {
    visibility: "public",
    inner: { use: { id: 1, name: "Alias", is_glob: false } },
  };
  doc.index[7] = {
    visibility: "public",
    inner: { use: { id: 5, name: "Other", is_glob: false } },
  };
  doc.index[1].inner.trait.implementations = [];
  const legacy = extractAPIs(doc, "sample", "1.0.0");
  doc.index[1].inner.trait.implementations = [3, 3];
  assert.deepEqual(extractAPIs(doc, "sample", "1.0.0"), legacy);
  assert.equal(legacy.length, 6);
  doc.index[3].inner.impl.for = { primitive: "u8" };
  doc.index[5].inner.struct.impls = [];
  assert.deepEqual(
    extractAPIs(doc, "sample", "1.0.0").map((a) => a.canonical_key),
    [
      "sample::T::m",
      "sample::Alias::m",
      "<u8 as sample::T>::m",
      "<u8 as sample::Alias>::m",
    ],
  );
  doc.index[1].visibility = "default";
  doc.index[0].inner.module.items = [1];
  assert.deepEqual(extractAPIs(doc, "sample", "1.0.0"), []);
});

test("trait traversal excludes synthetic, negative, external and private nominal impls", () => {
  for (const change of [
    (d: any) => {
      d.index[3].inner.impl.is_synthetic = true;
    },
    (d: any) => {
      d.index[3].inner.impl.is_negative = true;
    },
    (d: any) => {
      d.index[3].crate_id = 1;
    },
    (d: any) => {
      d.index[1].crate_id = 1;
    },
    (d: any) => {
      d.index[3].inner.impl.for = { resolved_path: { path: "Private", id: 5 } };
      d.index[5] = { crate_id: 0, inner: { struct: { impls: [3] } } };
    },
  ]) {
    const doc = traitImplFixture({ primitive: "u8" });
    change(doc);
    assert.deepEqual(
      extractAPIs(doc, "sample", "1.0.0").map((a) => a.canonical_key),
      ["sample::T::m"],
    );
  }
  const doc = traitImplFixture({ primitive: "u8" });
  delete doc.index[3];
  assert.throws(
    () => extractAPIs(doc, "sample", "1.0.0"),
    /invalid_rustdoc_impl/,
  );
});

test("hex trait fixture includes every macro array impl, Vec and generic ToHex", () => {
  const doc = JSON.parse(
    readFileSync(
      new URL("../fixtures/hex-0.4.3-trait-impls.json", import.meta.url),
      "utf8",
    ),
  );
  const apis = extractAPIs(doc, "hex", "0.4.3");
  assert.equal(apis.length, 165);
  const keys = new Set(apis.map((a) => a.canonical_key));
  assert(keys.has("<alloc::vec::Vec<u8> as hex::FromHex>::from_hex"));
  assert(keys.has("<T as hex::ToHex>::encode_hex"));
  assert(keys.has("<T as hex::ToHex>::encode_hex_upper"));
  const arrays = doc.index[85].inner.trait.implementations
    .map((id: number) => doc.index[id].inner.impl.for.array)
    .filter(Boolean);
  assert.equal(arrays.length, 159);
  for (const a of arrays)
    assert(keys.has(`<\u005bu8; ${a.len}] as hex::FromHex>::from_hex`));
  assert(
    apis.every((a) =>
      /trait\.(FromHex|ToHex)\.html#tymethod\./.test(a.upstream_url),
    ),
  );
});

test("structural trait arguments distinguish impls and refresh preserves reports and IDs", async () => {
  const { db, env, request } = await fixture();
  const report = await request("/reports", "POST", reportInput);
  assert.equal(report.status, 201);
  const before = db.prepare("SELECT * FROM api_items ORDER BY id").all();
  const reports = db.prepare("SELECT * FROM reports ORDER BY id").all();
  const claims = db.prepare("SELECT * FROM claims ORDER BY id").all();
  const doc = traitImplFixture({ primitive: "u8" });
  const first = doc.index[3].inner.impl;
  first.trait.args = {
    angle_bracketed: { args: [{ type: { primitive: "u16" } }] },
  };
  doc.index[5] = structuredClone(doc.index[3]);
  doc.index[5].inner.impl.trait.args.angle_bracketed.args[0].type.primitive =
    "u32";
  doc.index[1].inner.trait.implementations.push(5);
  (env as any).ARCHIVE.get = async () => ({
    text: async () => JSON.stringify(doc),
  });
  assert.deepEqual(await refreshCatalog(env, 1), { indexed: 3, added: 3 });
  assert.deepEqual(await refreshCatalog(env, 1), { indexed: 3, added: 0 });
  assert.deepEqual(
    db
      .prepare(
        "SELECT * FROM api_items WHERE id IN ('safe','unsafe') ORDER BY id",
      )
      .all(),
    before,
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM reports ORDER BY id").all(),
    reports,
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM claims ORDER BY id").all(),
    claims,
  );
  for (const arg of ["u16", "u32"]) {
    const path = `<u8 as sample::T<${arg}>>::m`;
    const resolved = await request(
      `/resolve-api?crate=sample&version=1.0.0&path=${encodeURIComponent(path)}`,
    );
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.id, await hash("1:" + path));
  }
});

test("nested local type references use public aliases in structural keys", () => {
  const doc = traitImplFixture({
    resolved_path: {
      path: "Vec",
      id: 20,
      args: {
        angle_bracketed: {
          args: [{ type: { resolved_path: { path: "hidden::S", id: 5 } } }],
        },
      },
    },
  });
  doc.paths = { 20: { path: ["alloc", "vec", "Vec"] } };
  doc.index[5] = {
    crate_id: 0,
    name: "S",
    visibility: "public",
    inner: { struct: { impls: [] } },
  };
  doc.index[6] = {
    visibility: "public",
    inner: { use: { id: 5, name: "Alias", is_glob: false } },
  };
  doc.index[0].inner.module.items.push(6);
  assert.equal(
    extractAPIs(doc, "sample", "1.0.0")[1].canonical_key,
    "<alloc::vec::Vec<sample::Alias> as sample::T>::m",
  );
});

test("report reads use one D1 batch, preserve revision/star semantics and reject hidden reports", async () => {
  const { env, db, request } = await fixture();
  const created = await request("/reports", "POST", reportInput);
  assert.equal(created.status, 201);
  const id = created.body.id;
  const first = (await request(`/reports/${id}`)).body;
  const claim = first.claims[0].id;
  await request(`/reports/${id}/star`, "PUT", {}, "bob");
  await request(`/claims/${claim}/star`, "PUT", {}, "bob");
  const revised = await request(`/reports/${id}/revisions`, "POST", {
    ...reportInput,
    expected_revision: 1,
    title: "Revision two",
    claims: [{ ...reportInput.claims[0], id: claim }],
  });
  assert.equal(revised.status, 201);
  const original = env.DB;
  let calls = 0;
  env.DB = {
    prepare(sql: string) {
      const q = original.prepare(sql);
      const wrap = (s: any): any => ({
        bind: (...values: any[]) => wrap(s.bind(...values)),
        first: (...args: any[]) => {
          calls++;
          return s.first(...args);
        },
        all: (...args: any[]) => {
          calls++;
          return s.all(...args);
        },
        run: (...args: any[]) => {
          calls++;
          return s.run(...args);
        },
      });
      return wrap(q);
    },
    async batch(statements: any[]) {
      // The fixture executes each statement via run(); count only the outer call.
      const before = calls;
      const result = await original.batch(statements);
      calls = before + 1;
      return result;
    },
  } as any;
  for (const user of ["", "bob"]) {
    for (const suffix of ["", "/revisions/1"]) {
      calls = 0;
      const r = await request(
        `/reports/${id}${suffix}`,
        "GET",
        undefined,
        user,
      );
      assert.equal(r.status, 200);
      assert.equal(calls, user ? 2 : 1); // session authentication + one read batch
      assert.equal(r.body.revision_no, suffix ? 1 : 2);
      assert.equal(r.body.latest_revision_no, 2);
      assert.equal(r.body.my_star, !!user);
      assert.equal(r.body.claims[0].my_star, !!user);
      assert.deepEqual(r.body.run_ids, reportInput.run_ids);
    }
  }
  assert.equal(
    (await request(`/reports/${id}/revisions/99`)).body.error,
    "revision_not_found",
  );
  db.prepare("UPDATE reports SET withdrawn_at=? WHERE id=?").run(
    new Date().toISOString(),
    id,
  );
  assert.equal((await request(`/reports/${id}`)).status, 200);
  db.prepare("UPDATE reports SET visibility='hidden' WHERE id=?").run(id);
  for (const suffix of ["", "/revisions/1", "/revisions/99"]) {
    const r = await request(`/reports/${id}${suffix}`);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "report_not_found");
    assert.equal(r.body.claims, undefined);
  }
});

test("claim numbers follow each report revision while UUID identity and old numbers survive", async () => {
  const { request } = await fixture();
  const input = {
    ...reportInput,
    claims: [1, 2, 3].map((n) => ({
      ...reportInput.claims[0],
      title: `Scope ${n}`,
      claim_number: 99,
    })),
  };
  const made = await request("/reports", "POST", input);
  assert.equal(made.status, 201);
  const id = made.body.id;
  const original = (await request(`/reports/${id}`)).body.claims;
  assert.deepEqual(
    original.map((c: any) => c.claim_number),
    [1, 2, 3],
  );
  const revision = {
    ...reportInput,
    expected_revision: 1,
    claims: [
      original[2],
      original[0],
      { ...reportInput.claims[0], title: "Added" },
    ],
  };
  assert.equal(
    (await request(`/reports/${id}/revisions`, "POST", revision)).status,
    201,
  );
  const current = (await request(`/reports/${id}`)).body.claims;
  assert.deepEqual(
    current.map((c: any) => c.claim_number),
    [1, 2, 3],
  );
  assert.equal(current[0].id, original[2].id);
  assert.equal(current[1].id, original[0].id);
  assert.deepEqual(
    (await request(`/reports/${id}/revisions/1`)).body.claims.map(
      (c: any) => c.claim_number,
    ),
    [1, 2, 3],
  );
  assert.equal(
    (await request(`/claims/${original[2].id}?report_revision=1`)).body
      .claim_number,
    3,
  );
  assert.equal(
    (await request(`/claims/${original[2].id}`)).body.claim_number,
    1,
  );
  const removed = (await request(`/claims/${original[1].id}`)).body;
  assert.equal(removed.claim_number, 2);
  assert.equal(removed.report_revision, 1);
  assert.equal(removed.in_current_report, 0);
  assert.equal(
    (
      await request(`/reports/${id}/revisions`, "POST", {
        ...reportInput,
        expected_revision: 2,
        claims: [original[1]],
      })
    ).status,
    201,
  );
  assert.equal(
    (await request(`/claims/${original[1].id}`)).body.claim_number,
    1,
  );
  const another = (await request("/reports", "POST", reportInput)).body.id;
  assert.equal(
    (await request(`/reports/${another}`)).body.claims[0].claim_number,
    1,
  );
});

test("catalogue, crate and comment reads batch database round trips without changing API semantics", async () => {
  const { env, db, request } = await fixture();
  const made = await request("/reports", "POST", reportInput);
  assert.equal(made.status, 201);
  const id = made.body.id;
  for (let n = 1; n <= 35; n++) {
    db.prepare(
      "INSERT INTO report_comments(id,report_id,sequence_no,revision_no,author_id,body,created_at) VALUES(?,?,?,1,'alice',?,'2026-01-01')",
    ).run(`comment-${n}`, id, n, `Body ${n}`);
  }
  db.prepare(
    "UPDATE report_comments SET visibility='hidden' WHERE id='comment-2'",
  ).run();
  db.prepare(
    "UPDATE report_comments SET deleted_at='2026-01-02' WHERE id='comment-3'",
  ).run();
  db.prepare(
    "INSERT INTO tool_versions(id,tool_id,version,selectable) VALUES('kani-retired','kani','0.1',0)",
  ).run();
  db.prepare(
    "INSERT INTO tools VALUES('empty','Empty','No versions','https://example.test',1)",
  ).run();
  const original = env.DB;
  let calls = 0;
  env.DB = {
    prepare(sql: string) {
      const q = original.prepare(sql);
      const wrap = (s: any): any => ({
        bind: (...values: any[]) => wrap(s.bind(...values)),
        first: (...args: any[]) => {
          calls++;
          return s.first(...args);
        },
        all: (...args: any[]) => {
          calls++;
          return s.all(...args);
        },
        run: (...args: any[]) => {
          calls++;
          return s.run(...args);
        },
      });
      return wrap(q);
    },
    async batch(statements: any[]) {
      // The fixture executes each statement via run(); count only the outer call.
      const before = calls;
      const result = await original.batch(statements);
      calls = before + 1;
      return result;
    },
  } as any;

  async function read(path: string, user = "") {
    calls = 0;
    const r = await request(path, "GET", undefined, user);
    assert.equal(calls, user ? 2 : 1, path); // authentication stays separate
    return r;
  }
  for (const user of ["", "bob"]) {
    const tools = await read("/tools", user);
    assert.deepEqual(
      tools.body.items.map((x: any) => x.id),
      ["aeneas", "empty", "kani"],
    );
    assert.deepEqual(
      tools.body.versions.map((x: any) => x.id),
      [
        "aeneas-be86ab0f1989d04944292b345b24c435be3ad10a",
        "kani-retired",
        "kani-0.68.0",
      ],
    );
    const detail = await read("/tools/kani", user);
    assert.equal(detail.body.id, "kani");
    assert.equal(detail.body.versions.length, 2);
    assert.deepEqual((await read("/tools/empty", user)).body.versions, []);
    assert.equal(
      (await read("/tools/missing", user)).body.error,
      "tool_not_found",
    );
    const crates = await read("/crates?q=sample", user);
    assert.equal(crates.body.total_count, 1);
    assert.equal(crates.body.matching_count, 1);
    assert.deepEqual(
      crates.body.items.map((x: any) => x.name),
      ["sample"],
    );
    const empty = await read("/crates?q=%25", user);
    assert.equal(empty.body.total_count, 1);
    assert.equal(empty.body.matching_count, 0);
    assert.deepEqual(empty.body.items, []);
    const reports = await read("/tool-versions/kani-0.68.0/reports", user);
    assert.deepEqual(
      reports.body.items.map((x: any) => x.id),
      [id],
    );
    assert.deepEqual(
      (await read("/tool-versions/kani-retired/reports", user)).body.items,
      [],
    );
    const first = await read(`/reports/${id}/comments`, user);
    assert.equal(first.body.items.length, 30);
    assert.equal(first.body.items[1].body, null);
    assert.equal(first.body.items[1].username, null);
    assert.equal(first.body.items[2].body, null);
    const second = await read(
      `/reports/${id}/comments?cursor=${encodeURIComponent(first.body.next_cursor)}`,
      user,
    );
    assert.equal(second.body.items.length, 5);
    assert.equal(second.body.next_cursor, null);
    assert.deepEqual(
      [...first.body.items, ...second.body.items].map(
        (x: any) => x.sequence_no,
      ),
      Array.from({ length: 35 }, (_, i) => i + 1),
    );
    assert.deepEqual(
      (await read(`/reports/${id}/comments?parent_id=comment-1`, user)).body
        .items,
      [],
    );
  }
  for (const path of [
    "/crates",
    `/reports/${id}/comments`,
    "/tool-versions/kani-0.68.0/reports",
  ]) {
    const r = await read(path + "?cursor=!");
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_cursor");
  }
  db.prepare("UPDATE reports SET visibility='hidden' WHERE id=?").run(id);
  for (const path of [
    `/reports/${id}/comments`,
    "/reports/999/comments",
    "/tool-versions/missing/reports",
  ]) {
    for (const query of ["", "?cursor=!"]) {
      const r = await read(path + query);
      assert.equal(r.status, 404);
      assert.equal(
        r.body.error,
        path.startsWith("/reports/")
          ? "report_not_found"
          : "tool_version_not_found",
      );
      assert.equal(r.body.items, undefined);
    }
  }
  assert.deepEqual(
    (await read("/tool-versions/kani-0.68.0/reports")).body.items,
    [],
  );
  assert.equal((await read("/crates")).body.total_count, 0);
});

test("public request schemas reject malformed bodies without changing transport and auth guards", async () => {
  const { env, db } = await fixture();
  const call = (
    body: string,
    contentType = "application/json",
    csrf = "csrf",
  ) =>
    app.request(
      "https://example.test/api/v1/me/notification-preferences",
      {
        method: "PATCH",
        headers: {
          Origin: env.APP_ORIGIN,
          Cookie: "__Host-proofsr_session=alice",
          "X-CSRF-Token": csrf,
          "Content-Type": contentType,
        },
        body,
      },
      env,
    );
  for (const [body, contentType, status, error] of [
    ["{", "application/json", 400, "invalid_json"],
    ["[]", "application/json", 400, "invalid_json"],
    ["{}", "text/plain", 415, "json_required"],
    [
      JSON.stringify({ replies: "yes", report_comments: false }),
      "application/json",
      400,
      "invalid_field",
    ],
    ["x".repeat(131073), "application/json", 413, "payload_too_large"],
  ] as const) {
    const r = await call(body, contentType);
    assert.equal(r.status, status);
    assert.equal(((await r.json()) as any).error, error);
  }
  const denied = await call("{}", "application/json", "wrong");
  assert.equal(denied.status, 403);
  assert.equal(((await denied.json()) as any).error, "invalid_csrf");
  assert.equal(
    db
      .prepare(
        "SELECT replies FROM notification_preferences WHERE user_id='alice'",
      )
      .get()!.replies,
    1,
  );
  assert.equal(
    (await call(JSON.stringify({ replies: false, report_comments: true })))
      .status,
    200,
  );
  assert.equal(
    db
      .prepare(
        "SELECT replies FROM notification_preferences WHERE user_id='alice'",
      )
      .get()!.replies,
    0,
  );
});

test("crate API catalogue returns all entries and counts active claims", async () => {
  const { db, request } = await fixture();
  for (let n = 0; n < 40; n++)
    db.prepare("INSERT INTO api_items VALUES(?,?,?,?,?,?,?,?)").run(
      `extra-${n}`,
      1,
      `sample::extra${n}`,
      `sample::extra${n}`,
      "function",
      0,
      "pub fn extra()",
      "https://docs.rs",
    );
  const published = await request("/reports", "POST", reportInput);
  assert.equal(published.status, 201);
  const read = () => request("/crates/sample/1.0.0/apis", "GET", undefined, "");
  const result = await read();
  assert.equal(result.body.items.length, 42);
  assert.equal(result.body.next_cursor, null);
  const safe = result.body.items.find((a: any) => a.id === "safe");
  assert.equal(safe.claim_count, 1);
  db.prepare("UPDATE reports SET visibility='hidden' WHERE id=?").run(
    published.body.id,
  );
  assert.equal(
    (await read()).body.items.find((a: any) => a.id === "safe").claim_count,
    0,
  );
  assert.equal(
    (await request("/crates/sample/1.0.0/apis?q=extra", "GET", undefined, ""))
      .body.items.length,
    40,
  );
});

test("UI visibility configuration defaults off and exposes independent flags without changing stored reactions", async () => {
  const { env, request } = await fixture();
  for (const value of [undefined, "false", "TRUE", "1"]) {
    env.SHOW_STAR_KARMA = value;
    env.SHOW_HOME_DISCUSSION = value;
    const { body } = await request("/config");
    assert.equal(body.show_star_karma, false);
    assert.equal(body.show_home_discussion, false);
  }
  for (const star of [false, true])
    for (const discussion of [false, true]) {
      env.SHOW_STAR_KARMA = String(star);
      env.SHOW_HOME_DISCUSSION = String(discussion);
      const { body } = await request("/config");
      assert.equal(body.show_star_karma, star);
      assert.equal(body.show_home_discussion, discussion);
    }
});

test("dependency reviews pin public evidence to the selected registry snapshot", async () => {
  const { db, request } = await fixture();
  const evidence = await request("/reports", "POST", reportInput);
  assert.equal(evidence.status, 201);
  const dependencies = [
    { crate: "sample", report: evidence.body.id, revision: 1 },
  ];
  assert.equal(
    (
      await request("/reports/validate", "POST", {
        ...reportInput,
        dependencies,
      })
    ).status,
    400,
  );
  db.prepare("INSERT INTO run_dependencies VALUES(?,?,?,?)").run(
    reportInput.run_ids[0],
    "sample",
    "1.0.0",
    "git+https://example.test/source",
  );
  assert.equal(
    (
      await request("/reports/validate", "POST", {
        ...reportInput,
        dependencies,
      })
    ).status,
    400,
  );
  db.prepare("INSERT INTO run_dependencies VALUES(?,?,?,?)").run(
    reportInput.run_ids[0],
    "sample",
    "1.0.0",
    "registry+https://github.com/rust-lang/crates.io-index",
  );
  const made = await request("/reports", "POST", {
    ...reportInput,
    dependencies,
  });
  assert.equal(made.status, 201);
  const detail = await request("/reports/" + made.body.id);
  assert.deepEqual(detail.body.dependencies, [
    { ...dependencies[0], version: "1.0.0", withdrawn: false },
  ]);
  assert.equal(detail.body.dependency_count, 1);
  assert.equal(
    (
      await request("/reports/validate", "POST", {
        ...reportInput,
        dependencies: [...dependencies, ...dependencies],
      })
    ).status,
    400,
  );
  const revised = await request(`/reports/${made.body.id}/revisions`, "POST", {
    ...reportInput,
    expected_revision: 1,
  });
  assert.equal(revised.status, 201);
  assert.equal(
    (await request(`/reports/${made.body.id}`)).body.dependencies.length,
    1,
  );
  db.prepare("UPDATE reports SET withdrawn_at=? WHERE id=?").run(
    new Date().toISOString(),
    evidence.body.id,
  );
  assert.deepEqual(
    (await request(`/reports/${made.body.id}`)).body.dependencies,
    [{ ...dependencies[0], version: "1.0.0", withdrawn: true }],
  );
  assert.equal(
    (
      await request(`/reports/${made.body.id}/revisions`, "POST", {
        ...reportInput,
        expected_revision: 2,
      })
    ).status,
    400,
  );
  db.prepare("UPDATE reports SET visibility='hidden' WHERE id=?").run(
    evidence.body.id,
  );
  assert.deepEqual(
    (await request(`/reports/${made.body.id}`)).body.dependencies,
    [
      {
        crate: "sample",
        version: "1.0.0",
        report: null,
        revision: null,
        withdrawn: true,
      },
    ],
  );
  assert.equal(
    (
      await request(`/reports/${made.body.id}/revisions`, "POST", {
        ...reportInput,
        expected_revision: 2,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/reports/${made.body.id}/revisions`, "POST", {
        ...reportInput,
        expected_revision: 2,
        dependencies: [],
      })
    ).status,
    201,
  );
  assert.deepEqual(
    (await request(`/reports/${made.body.id}`)).body.dependencies,
    [],
  );
});

test("SARIF v2 requires an explicit dependency snapshot and rejects legacy records", () => {
  const sarif = recordedSarif(reportInput.run_ids[0]);
  const proofs = sarif.runs[0].properties.proofs as any;
  const dependency = {
    crate: "dep",
    version: "2.3.4",
    source: "registry+https://github.com/rust-lang/crates.io-index",
  };
  proofs.dependencies = [dependency];
  assert.deepEqual(readRecord(sarif).dependencies, [dependency]);
  proofs.dependencies = [dependency, dependency];
  assert.throws(() => readRecord(sarif));
  delete proofs.dependencies;
  assert.throws(() => readRecord(sarif));
  proofs.dependencies = [];
  proofs.schemaVersion = 1;
  assert.throws(() => readRecord(sarif));
});

test("dependency evidence failures and races never create partial reports", async () => {
  const { db, env, request } = await fixture();
  const evidence = await request("/reports", "POST", reportInput);
  const dep = { crate: "sample", report: evidence.body.id, revision: 1 };
  db.prepare("INSERT INTO run_dependencies VALUES(?,?,?,?)").run(
    reportInput.run_ids[0],
    "sample",
    "2.0.0",
    "registry+https://github.com/rust-lang/crates.io-index",
  );
  const publish = (dependency: any) =>
    request("/reports", "POST", { ...reportInput, dependencies: [dependency] });
  assert.equal((await publish(dep)).status, 400);
  db.prepare("INSERT INTO run_dependencies VALUES(?,?,?,?)").run(
    reportInput.run_ids[0],
    "sample",
    "1.0.0",
    "registry+https://github.com/rust-lang/crates.io-index",
  );
  for (const invalid of [
    { ...dep, report: 99999 },
    { ...dep, revision: 99999 },
    { ...dep, crate: "missing" },
    { ...dep, version: "2.0.0" },
    { ...dep, rationale: "wrong field" },
  ]) {
    assert.equal((await publish(invalid)).status, 400);
  }
  db.prepare("UPDATE reports SET visibility='hidden' WHERE id=?").run(
    evidence.body.id,
  );
  assert.equal((await publish(dep)).status, 400);
  db.prepare("UPDATE reports SET visibility='public' WHERE id=?").run(
    evidence.body.id,
  );
  const savedBatch = env.DB.batch.bind(env.DB);
  env.DB.batch = async (statements: any) => {
    db.prepare("UPDATE reports SET withdrawn_at=? WHERE id=?").run(
      new Date().toISOString(),
      evidence.body.id,
    );
    return savedBatch(statements);
  };
  assert.equal((await publish(dep)).status, 409);
  env.DB.batch = savedBatch;
  assert.equal(
    (db.prepare("SELECT COUNT(*) n FROM reports").get() as any).n,
    1,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) n FROM report_dependencies").get() as any).n,
    0,
  );
  db.prepare("UPDATE reports SET withdrawn_at=NULL WHERE id=?").run(
    evidence.body.id,
  );
  const made = await publish(dep);
  assert.equal(made.status, 201);
  assert.equal(
    (await request(`/reports/${made.body.id}`)).body.dependencies[0].version,
    "1.0.0",
  );
  assert.throws(() =>
    db.prepare("UPDATE report_dependencies SET version='2.0.0'").run(),
  );
  assert.throws(() => db.prepare("DELETE FROM report_dependencies").run());
  assert.throws(() =>
    db.prepare("UPDATE run_dependencies SET version='9.0.0'").run(),
  );
  assert.throws(() => db.prepare("DELETE FROM run_dependencies").run());
  const run = "22222222-2222-4222-8222-222222222222";
  db.prepare(
    "INSERT INTO verification_runs(id,author_id,crate,version,tool_version_id,sha256,size,r2_key,created_at) SELECT ?,author_id,crate,version,tool_version_id,sha256,size,?,created_at FROM verification_runs WHERE id=?",
  ).run(run, "second-run-key", reportInput.run_ids[0]);
  (env.ARCHIVE as any).get = async () => ({
    json: async () => recordedSarif(run),
  });
  const revise = (extra: any) =>
    request(`/reports/${made.body.id}/revisions`, "POST", {
      ...reportInput,
      run_ids: [run],
      expected_revision: 1,
      ...extra,
    });
  assert.equal((await revise({})).status, 400);
  assert.equal((await revise({ dependencies: [] })).status, 201);
  assert.deepEqual(
    (await request(`/reports/${made.body.id}`)).body.dependencies,
    [],
  );
});

test("HTML pages render public content without JavaScript and preserve visibility and revisions", async () => {
  const { JSDOM } = await import("jsdom");
  const { db, env, request } = await fixture();
  const made = await request("/reports", "POST", {
    ...reportInput,
    title: "SSR <script>report</script>",
    explanation: "Visible report explanation",
  });
  assert.equal(made.status, 201);
  const claim = db.prepare("SELECT id FROM claims WHERE report_id=1").get()!.id;
  for (const [path, expected] of [
    ["/", "Recent reports"],
    ["/crates?q=sample", "sample"],
    ["/crate/sample?version=1.0.0", "safe"],
    ["/api/safe", "sample::safe"],
    ["/reports", "SSR <script>report</script>"],
    ["/report/1", "Visible report explanation"],
    [`/claim/${claim}?report_revision=1`, "Preconditions"],
    ["/tools", "Kani"],
    ["/tool/kani", "0.68.0"],
    ["/tool-version/kani-0.68.0", "SSR <script>report</script>"],
    ["/user/alice", "SSR <script>report</script>"],
    ["/account", "SSR <script>report</script>"],
    ["/settings", "Email notifications"],
  ]) {
    const response = await app.request(
      "https://example.test" + path,
      { headers: { Cookie: "__Host-proofsr_session=alice" } },
      env,
    );
    assert.equal(
      response.status,
      200,
      path + ": " + (await response.clone().text()),
    );
    assert.match(response.headers.get("content-type")!, /text\/html/);
    assert.ok(response.headers.get("cache-control")?.includes("no-store"));
    const dom = new JSDOM(await response.text());
    assert.ok(
      dom.window.document
        .querySelector("main")!
        .textContent!.includes(expected),
      path,
    );
    assert.equal(dom.window.document.querySelector("main script"), null);
    assert.equal(
      dom.window.document.querySelector('script[src*="main"]'),
      null,
    );
    dom.window.close();
  }
  const response = await app.request("https://example.test/report/1", {}, env);
  const html = await response.text();
  assert.match(html, /Run locally/);
  assert.match(html, /Recorded run/);
  assert.match(html, /Diagnostics &amp; logs/);
  assert.doesNotMatch(html, /Loading…|Loading recorded runs/);
  for (const path of [
    "/report/999",
    "/report/1?v=999",
    "/claim/missing",
    "/api/missing",
    "/crate/serde",
  ]) {
    const r = await app.request("https://example.test" + path, {}, env);
    assert.equal(r.status, 404, path);
    assert.match(r.headers.get("content-type")!, /text\/html/);
    // Readers see sentences, not internal error codes.
    assert.doesNotMatch(await r.text(), /_not_found/, path);
  }
  const unlisted = await (
    await app.request("https://example.test/crate/serde", {}, env)
  ).text();
  assert.match(unlisted, /says nothing about a crate's quality/);
  assert.match(unlisted, /href="\/book\/publish-a-report.html"/);
  const empty = await (
    await app.request("https://example.test/crates?q=serde", {}, env)
  ).text();
  assert.match(empty, /No matching crates/);
  assert.match(empty, /says nothing about a crate's quality/);
  const home = new JSDOM(
    await (await app.request("https://example.test/", {}, env)).text(),
  ).window.document;
  assert.deepEqual(
    [...home.querySelectorAll(".home-paths a")].map((a) =>
      a.getAttribute("href"),
    ),
    ["/book/read-a-report.html", "/book/publish-a-report.html", "/contact"],
  );
  assert.match(
    home.querySelector(".home-trust")!.textContent!,
    /not certification/,
  );
  assert.equal(home.querySelector(".home-example"), null);
  env.HOME_EXAMPLE_REPORT = "1";
  const example = new JSDOM(
    await (await app.request("https://example.test/", {}, env)).text(),
  ).window.document;
  assert.equal(
    example.querySelector(".home-example a")?.getAttribute("href"),
    "/report/1",
  );
  delete env.HOME_EXAMPLE_REPORT;
  const help = new JSDOM(
    await (await app.request("https://example.test/contact", {}, env)).text(),
  ).window.document;
  assert.deepEqual(
    [...help.querySelectorAll("main h2")].map((h) => h.textContent),
    [
      "A question about a report",
      "A problem or suggestion for proofs.rs",
      "Help with using proofs.rs or a verifier",
      "Private matters",
    ],
  );
  const cratePage = new JSDOM(
    await (
      await app.request(
        "https://example.test/crate/sample?version=1.0.0",
        {},
        env,
      )
    ).text(),
  ).window.document;
  assert.deepEqual(
    [...cratePage.querySelectorAll("main > h2, main > section > h2")].map(
      (h) => h.id || h.parentElement!.getAttribute("aria-labelledby"),
    ),
    ["reports", "findings", "apis"],
  );
  assert(cratePage.querySelector("form[data-api-filter][hidden]"));
  assert(
    cratePage.querySelector('[data-api-path="sample::safe"][data-claims="1"]'),
  );
  const reportPage = new JSDOM(html).window.document;
  const outline = [...reportPage.querySelectorAll(".report-outline a")].map(
    (a) => a.getAttribute("href")!,
  );
  assert.equal(outline.at(-1), "#discussion");
  for (const href of outline)
    assert(reportPage.querySelector(href), `${href} has no target`);
  assert.match(
    reportPage.querySelector(".report-provenance")!.textContent!,
    /has not re-run/,
  );
  const comment = await request("/reports/1/comments", "POST", {
    body: "Linked comment",
    revision_no: 1,
  });
  assert.equal(comment.status, 201);
  const linked = await app.request(
    "https://example.test/report/1?comment=" + comment.body.id,
    {},
    env,
  );
  assert.equal(linked.status, 302);
  assert.equal(
    linked.headers.get("location"),
    "/report/1#comment-" + comment.body.id,
  );
  const section = await app.request(
    "https://example.test/crate/sample?version=1.0.0&section=apis",
    {},
    env,
  );
  assert.equal(section.status, 302);
  assert.equal(
    section.headers.get("location"),
    "/crate/sample?version=1.0.0#apis",
  );
  db.exec("UPDATE reports SET visibility='hidden' WHERE id=1");
  for (const path of [
    "/report/1",
    `/claim/${claim}`,
    "/runs/11111111-1111-4111-8111-111111111111?report=1",
  ]) {
    const r = await app.request("https://example.test" + path, {}, env);
    assert.equal(r.status, 404, path);
    assert.doesNotMatch(await r.text(), /Visible report explanation/);
  }
});

test("HTML page links paginate growing lists and retain filters while bounded content is complete", async () => {
  const { JSDOM } = await import("jsdom");
  const { db, env, request } = await fixture();
  for (let i = 0; i < 35; i++) {
    db.exec("DELETE FROM rate_limits");
    assert.equal(
      (
        await request("/reports", "POST", {
          ...reportInput,
          title: "Report " + i,
        })
      ).status,
      201,
    );
  }
  for (const path of [
    "/reports",
    "/crate/sample?version=1.0.0",
    "/api/safe",
    "/tool/kani",
    "/tool-version/kani-0.68.0",
    "/user/alice?section=reports",
    "/account?section=reports",
  ]) {
    const read = async (url: string) =>
      new JSDOM(
        await (
          await app.request(
            url,
            { headers: { Cookie: "__Host-proofsr_session=alice" } },
            env,
          )
        ).text(),
      );
    const first = await read("https://example.test" + path);
    const next = first.window.document
      .querySelector('a[rel="next"]')!
      .getAttribute("href")!;
    assert.ok(next, path);
    const nextURL = new URL(next, "https://example.test");
    for (const [key, value] of new URL(path, "https://example.test")
      .searchParams)
      assert.equal(nextURL.searchParams.get(key), value);
    const second = await read(nextURL.href);
    if (path === "/api/safe") {
      assert.equal(
        first.window.document.querySelector("#claims")?.textContent,
        "Claims (35)",
      );
      assert.equal(
        second.window.document.querySelector("#claims")?.textContent,
        "Claims (35)",
      );
      assert.doesNotMatch(
        first.window.document.querySelector("main")!.textContent!,
        /Target:|Catalogue uses|Publish a report/,
      );
    }
    assert.equal(
      second.window.document.querySelector('a[rel="next"]'),
      null,
      path,
    );
    const selector = path.startsWith("/api/")
      ? 'main .claim-item a[href^="/claim/"]'
      : 'main .claim-item a[href^="/report/"]';
    const links = (dom: any) =>
      Array.from(dom.window.document.querySelectorAll(selector)).map((a: any) =>
        a.getAttribute("href"),
      );
    assert.equal(links(first).length, 30, path);
    assert.equal(links(second).length, 5, path);
    assert.equal(new Set([...links(first), ...links(second)]).size, 35, path);
    first.window.close();
    second.window.close();
  }
  // More than one API page of revisions and a deep reply chain must still appear in initial HTML.
  for (let revision = 2; revision <= 36; revision++)
    db.prepare(
      "INSERT INTO report_revisions SELECT report_id,?,title,explanation,trusted_assumptions,tool_version_id,environment,evidence_url,limitations,created_at FROM report_revisions WHERE report_id=1 AND revision_no=1",
    ).run(revision);
  const time = new Date().toISOString();
  for (let n = 1; n <= 36; n++)
    db.prepare(
      "INSERT INTO report_comments(id,report_id,sequence_no,revision_no,author_id,reply_to_id,body,created_at) VALUES(?,1,?,1,'alice',?,?,?)",
    ).run(
      "ssr-comment-" + n,
      n,
      n === 1 ? null : "ssr-comment-" + (n - 1),
      "Reply body " + n,
      time,
    );
  db.exec(
    "UPDATE report_comments SET visibility='hidden' WHERE id='ssr-comment-4'; UPDATE report_comments SET deleted_at=created_at WHERE id='ssr-comment-5'",
  );
  const page = new JSDOM(
    await (
      await app.request("https://example.test/report/1?v=1", {}, env)
    ).text(),
  );
  assert.equal(
    page.window.document.querySelectorAll("#revision-history a").length,
    36,
  );
  assert.equal(page.window.document.querySelectorAll(".comment").length, 36);
  assert.match(
    page.window.document.querySelector("#discussion")!.textContent!,
    /Reply body 36/,
  );
  assert.doesNotMatch(
    page.window.document.querySelector("#discussion")!.textContent!,
    /Reply body [45](?!\d)/,
  );
  assert.equal(page.window.document.querySelector('a[rel="next"]'), null);
  page.window.close();
});

test("ordinary HTML forms preserve API CSRF, origin, ownership, idempotency and session guards", async () => {
  const { JSDOM } = await import("jsdom");
  const { db, env, request } = await fixture();
  assert.equal((await request("/reports", "POST", reportInput)).status, 201);
  const send = async (
    action: string,
    fields: Record<string, string>,
    user = "alice",
    origin = env.APP_ORIGIN,
  ) =>
    app.request(
      "https://example.test/_actions/" + action,
      {
        method: "POST",
        headers: {
          Cookie: "__Host-proofsr_session=" + user,
          Origin: origin,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(fields),
      },
      env,
    );
  const read = await app.request(
    "https://example.test/report/1",
    { headers: { Cookie: "__Host-proofsr_session=alice" } },
    env,
  );
  const dom = new JSDOM(await read.text());
  const form =
    dom.window.document.querySelector<HTMLFormElement>("#comment-form")!;
  const fields = Object.fromEntries(
    Array.from(
      form.querySelectorAll<HTMLInputElement>('input[type="hidden"]'),
    ).map((input) => [input.name, input.value]),
  );
  fields.body = "Posted without JS <script>alert(1)</script>";
  fields.revision_no = "1";
  assert.equal(
    (await send("comment", { ...fields, _csrf: "wrong" })).status,
    403,
  );
  assert.equal(
    (await send("comment", fields, "alice", "https://evil.test")).status,
    403,
  );
  assert.equal((await send("comment", fields, "missing")).status, 401);
  const posted = await send("comment", fields);
  assert.equal(posted.status, 303, await posted.clone().text());
  assert.equal(posted.headers.get("location"), "/report/1?v=1#discussion");
  assert.equal((await send("comment", fields)).status, 303);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM report_comments").get()!.n,
    1,
  );
  const cm = db.prepare("SELECT * FROM report_comments").get()!;
  const edited = {
    _csrf: "csrf",
    _back: "/report/1",
    id: String(cm.id),
    edit_version: String(cm.edit_version),
    body: "Edited without JS",
  };
  assert.equal((await send("edit-comment", edited, "bob")).status, 403);
  assert.equal((await send("edit-comment", edited)).status, 303);
  assert.equal(
    db.prepare("SELECT body FROM report_comments").get()!.body,
    "Edited without JS",
  );
  assert.equal(
    (await send("preferences", { _csrf: "csrf", replies: "on" })).status,
    303,
  );
  assert.equal(
    db
      .prepare(
        "SELECT replies FROM notification_preferences WHERE user_id='alice'",
      )
      .get()!.replies,
    1,
  );
  const star = await send("star", {
    _csrf: "csrf",
    _back: "//evil.test",
    kind: "report",
    id: "1",
    on: "true",
  });
  assert.equal(star.status, 303);
  assert.equal(star.headers.get("location"), "/");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM report_stars").get()!.n, 1);
  const logout = await send("logout", { _csrf: "csrf" });
  assert.equal(logout.status, 303);
  assert.match(logout.headers.get("set-cookie")!, /proofsr_session=/);
  dom.window.close();
});

test("HTML includes all crate versions, API items, report claims, tool versions and tokens beyond page size", async () => {
  const { JSDOM } = await import("jsdom");
  const { db, env, request } = await fixture();
  const time = new Date().toISOString();
  for (let i = 0; i < 36; i++) {
    const id = "bounded-api-" + i;
    db.prepare(
      "INSERT INTO api_items(id,release_id,canonical_key,display_path,kind,is_unsafe,signature,upstream_url) VALUES(?,1,?,?,'function',0,'pub fn verify()','https://docs.rs')",
    ).run(id, id, "sample::verify_" + i);
    db.prepare(
      "INSERT INTO tool_versions(id,tool_id,version,selectable) VALUES(?,'kani',?,1)",
    ).run("bounded-tool-" + i, "1.0." + i);
    db.prepare(
      "INSERT INTO api_tokens(id,user_id,token_hash,scope,created_at,expires_at) VALUES(?,'alice',?,'publish',?,?)",
    ).run(
      "bounded-token-" + i,
      "token-hash-" + i,
      time,
      new Date(Date.now() + 86400000).toISOString(),
    );
  }
  assert.equal((await request("/reports", "POST", reportInput)).status, 201);
  for (let i = 0; i < 36; i++) {
    const id = "bounded-claim-" + i;
    db.prepare(
      "INSERT INTO claims(id,report_id,api_item_id,created_at) VALUES(?,1,?,?)",
    ).run(id, "bounded-api-" + i, time);
    db.prepare(
      "INSERT INTO claim_revisions SELECT ?,report_id,report_revision,?,title,precondition,explanation,trusted_assumptions,evidence_url,limitations FROM claim_revisions WHERE report_id=1 AND position=0",
    ).run(id, i + 1);
  }
  for (let i = 0; i < 36; i++) {
    const release = i + 2;
    db.prepare(
      "INSERT INTO releases(id,crate_id,version,checksum,yanked,created_at) VALUES(?,1,?,'checksum',0,?)",
    ).run(release, "1.0." + (i + 1), time);
    db.prepare(
      "INSERT INTO reports(id,release_id,author_id,visibility,withdrawn_at,created_at,updated_at,create_key) SELECT ?,?,author_id,visibility,withdrawn_at,created_at,updated_at,? FROM reports WHERE id=1",
    ).run(i + 2, release, "bounded-report-" + i);
    db.prepare(
      "INSERT INTO report_revisions SELECT ?,revision_no,title,explanation,trusted_assumptions,tool_version_id,environment,evidence_url,limitations,created_at FROM report_revisions WHERE report_id=1",
    ).run(i + 2);
  }
  const read = async (path: string) =>
    new JSDOM(
      await (
        await app.request(
          "https://example.test" + path,
          { headers: { Cookie: "__Host-proofsr_session=alice" } },
          env,
        )
      ).text(),
    );
  const crate = await read("/crate/sample?version=1.0.0");
  assert.equal(
    crate.window.document.querySelectorAll('select[name="version"] option')
      .length,
    37,
  );
  assert.equal(
    crate.window.document.querySelectorAll(
      'a.api-name[href^="/api/bounded-api-"]',
    ).length,
    36,
  );
  const report = await read("/report/1");
  assert.equal(
    report.window.document.querySelectorAll(
      '.report-api-claims a[href^="/claim/bounded-claim-"]',
    ).length,
    36,
  );
  const tool = await read("/tool/kani");
  assert.equal(
    tool.window.document.querySelectorAll('a[href^="/tool-version/"]').length,
    37,
  );
  const settings = await read("/settings");
  assert.equal(
    settings.window.document.querySelectorAll(
      'form[action="/settings"] input[name="revoke"]',
    ).length,
    36,
  );
  for (const dom of [crate, report, tool, settings]) dom.window.close();
});

test("signup and CLI approval complete through HTML forms and return session cookies", async () => {
  const { JSDOM } = await import("jsdom");
  const { db, env } = await fixture();
  const origin = env.APP_ORIGIN;
  const time = new Date().toISOString();
  db.prepare("INSERT INTO pending_signups VALUES(?,?,?,?,?,?)").run(
    await hash("pending-html"),
    JSON.stringify({
      user: { id: 999, login: "html-user" },
      email: { email: "html@example.test", verified: true, primary: true },
      emailsOK: true,
    }),
    "signup-csrf",
    "/book/concepts",
    time,
    new Date(Date.now() + 600000).toISOString(),
  );
  const signup = await app.request(
    origin + "/signup",
    { headers: { Cookie: "__Host-proofsr_signup=pending-html" } },
    env,
  );
  assert.equal(signup.status, 200);
  const dom = new JSDOM(await signup.text());
  assert.equal(
    dom.window.document
      .querySelector('form[action="/_actions/signup"] input[name="_csrf"]')!
      .getAttribute("value"),
    "signup-csrf",
  );
  const completed = await app.request(
    origin + "/_actions/signup",
    {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: "__Host-proofsr_signup=pending-html",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        _csrf: "signup-csrf",
        terms_version: "test",
      }),
    },
    env,
  );
  assert.equal(completed.status, 303, await completed.clone().text());
  assert.equal(completed.headers.get("location"), "/book/concepts");
  assert.match(completed.headers.get("set-cookie")!, /__Host-proofsr_session=/);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM pending_signups").get()!.n,
    0,
  );
  const codeResponse = await app.request(
    origin + "/auth/device/code",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "proofs-cli", scope: "publish" }),
    },
    env,
  );
  const code: any = await codeResponse.json();
  assert.equal(codeResponse.status, 200);
  const inspect = await app.request(
    origin + "/device?code=" + encodeURIComponent(code.user_code),
    { headers: { Cookie: "__Host-proofsr_session=alice" } },
    env,
  );
  assert.equal(inspect.status, 200, await inspect.clone().text());
  assert.match(await inspect.text(), /Authorize/);
  const approved = await app.request(
    origin + "/_actions/device",
    {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: "__Host-proofsr_session=alice",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: "csrf", user_code: code.user_code }),
    },
    env,
  );
  assert.equal(approved.status, 200, await approved.clone().text());
  assert.match(await approved.text(), /CLI connected/);
  assert.equal(
    db.prepare("SELECT state FROM device_authorizations").get()!.state,
    "approved",
  );
  dom.window.close();
});

test("optional staging pagination fixture is repeatable and provides two HTML pages", async () => {
  const { JSDOM } = await import("jsdom");
  const { db, env } = await fixture();
  for (const name of [
    "staging-demo",
    "staging-pagination",
    "staging-pagination",
  ]) {
    db.exec(
      readFileSync(new URL(`../fixtures/${name}.sql`, import.meta.url), "utf8"),
    );
  }
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM reports WHERE create_key LIKE 'staging-pagination-v1-%'",
      )
      .get()!.n,
    36,
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  const first = new JSDOM(
    await (
      await app.request(
        "https://example.test/crate/pagination-demo?version=1.0.0-demo.1",
        {},
        env,
      )
    ).text(),
  );
  const next = first.window.document
    .querySelector('a[rel="next"]')!
    .getAttribute("href")!;
  assert.ok(next);
  const second = new JSDOM(
    await (
      await app.request(new URL(next, "https://example.test").href, {}, env)
    ).text(),
  );
  const ids = (dom: any) =>
    [
      ...dom.window.document.querySelectorAll(
        'main .claim-item a[href^="/report/"]',
      ),
    ].map((a: any) => a.getAttribute("href"));
  assert.equal(ids(first).length, 30);
  assert.equal(ids(second).length, 6);
  assert.equal(new Set([...ids(first), ...ids(second)]).size, 36);
  assert.equal(second.window.document.querySelector('a[rel="next"]'), null);
  const canonical = new URL(
    second.window.document
      .querySelector('link[rel="canonical"]')!
      .getAttribute("href")!,
  );
  assert.equal(canonical.pathname, "/crate/pagination-demo");
  assert.equal(canonical.searchParams.get("version"), null);
  assert.equal(
    canonical.searchParams.get("cursor"),
    new URL(next, env.APP_ORIGIN).searchParams.get("cursor"),
  );
});

test("My activity always shows report and comment sections without section navigation", async () => {
  const { JSDOM } = await import("jsdom");
  const { env } = await fixture();
  for (const path of ["/account", "/account?section=comments"]) {
    const response = await app.request(
      "https://example.test" + path,
      { headers: { Cookie: "__Host-proofsr_session=alice" } },
      env,
    );
    assert.equal(response.status, 200);
    const document = new JSDOM(await response.text()).window.document;
    assert.equal(
      document.querySelector("#reports h2")?.textContent,
      "My reports",
    );
    assert.equal(
      document.querySelector("#comments h2")?.textContent,
      "My comments",
    );
    assert.equal(document.querySelector('nav[aria-label="Activity"]'), null);
    assert.equal(document.querySelector('main a[href*="section="]'), null);
  }
});

test("SSR retains the original controls, comment editor placement and inline logs", async () => {
  const { JSDOM } = await import("jsdom");
  const { env, request, db } = await fixture();
  env.SHOW_STAR_KARMA = "false";
  await request("/reports", "POST", reportInput);
  const comment = await request("/reports/1/comments", "POST", {
    body: "Original comment",
    revision_no: 1,
  });
  const id = comment.body.id;
  const read = async (path: string, signedIn = true) => {
    const response = await app.request(
      env.APP_ORIGIN + path,
      signedIn ? { headers: { Cookie: "__Host-proofsr_session=alice" } } : {},
      env,
    );
    assert.equal(response.status, 200, await response.clone().text());
    return new JSDOM(await response.text()).window.document;
  };
  const crate = await read("/crate/sample?version=1.0.0");
  assert.equal(
    crate.querySelector('select[name="version"]')?.querySelectorAll("option")
      .length,
    1,
  );
  assert.equal(crate.querySelector("#reports")?.textContent, "Reports (1)");
  assert.equal(
    crate
      .querySelector('a[href^="https://crates.io/"]')
      ?.getAttribute("target"),
    "_blank",
  );
  const crates = await read("/crates");
  assert.equal(crates.querySelectorAll("td.numeric").length, 3);
  assert.match(
    crates.querySelector("time")!.textContent!,
    /^\d{4}-\d{2}-\d{2}$/,
  );
  assert.ok(crates.querySelector("th[title]"));
  const report = await read("/report/1");
  assert.equal(report.querySelectorAll(".vote button").length, 2);
  assert.equal(
    report
      .querySelector('button[aria-label="Upvote"]')
      ?.getAttribute("aria-pressed"),
    "false",
  );
  assert.match(
    report.querySelector(".run-log-content")!.textContent!,
    /SUCCESS/,
  );
  assert.equal(report.querySelectorAll('a[href^="/runs/"]').length, 0);
  assert.equal(
    report.querySelector(".report-actions button")?.textContent,
    "Withdraw report",
  );
  assert.equal(report.querySelector("dialog"), null);
  const edited = await read(`/report/1?edit=${id}`);
  assert.ok(
    edited.querySelector(
      '.comment .editor form[action="/_actions/edit-comment"]',
    ),
  );
  assert.ok(edited.querySelector('form[action="/_actions/comment"]'));
  assert.equal(
    edited.querySelector(".editor textarea")?.textContent,
    "Original comment",
  );
  const confirmDelete = await read(`/report/1?delete=${id}`);
  assert.ok(
    confirmDelete.querySelector(
      'dialog form[action="/_actions/delete-comment"]',
    ),
  );
  const confirmWithdraw = await read("/report/1?withdraw=1");
  assert.ok(
    confirmWithdraw.querySelector('dialog form[action="/_actions/withdraw"]'),
  );
  assert.equal(
    db.prepare("SELECT withdrawn_at FROM reports WHERE id=1").get()!
      .withdrawn_at,
    null,
  );
  const loggedOut = await read("/report/1", false);
  assert.equal(
    loggedOut.querySelectorAll('.vote input[name="sign_in"]').length,
    2,
  );
  const home = await read("/");
  assert.equal(home.querySelector('main a[href="/reports"]'), null);
  db.prepare(
    "INSERT INTO api_tokens(id,user_id,token_hash,scope,created_at,expires_at) VALUES('restore-token','alice','restore-hash','publish',?,?)",
  ).run(
    new Date().toISOString(),
    new Date(Date.now() + 86400000).toISOString(),
  );
  const settings = await read("/settings");
  assert.ok(
    settings.querySelector('td form[action="/settings"] input[name="revoke"]'),
  );
  assert.equal(settings.querySelector("td details"), null);
  const revoke = await read("/settings?revoke=restore-token");
  assert.ok(
    revoke.querySelector('#revoke-confirm form[action="/_actions/revoke"]'),
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM api_tokens WHERE id='restore-token'")
      .get()!.n,
    1,
  );
  assert.equal(
    settings.querySelectorAll('form[action="/_actions/preferences"] p label')
      .length,
    2,
  );
});

test("browser and API device checks share an account limit without blocking other users", async () => {
  for (const ip of ["192.0.2.1", ""]) {
    const { db, env } = await fixture();
    const bucket = new Date().toISOString().slice(0, 10);
    db.prepare("INSERT INTO rate_limits VALUES(?,?,?,?,?)").run(
      await hash("user:alice"),
      "device_check",
      bucket,
      99,
      100,
    );
    // Exhausting the old missing-IP bucket must not block any account.
    db.prepare("INSERT INTO rate_limits VALUES(?,?,?,?,?)").run(
      await hash("unknown"),
      "device_check",
      bucket,
      100,
      100,
    );
    const headers = (user: string) => ({
      Origin: env.APP_ORIGIN,
      Cookie: "__Host-proofsr_session=" + user,
      ...(ip ? { "CF-Connecting-IP": ip } : {}),
    });
    const inspect = await app.request(
      env.APP_ORIGIN + "/device?code=ABCDEFGH",
      { headers: headers("alice") },
      env,
    );
    assert.equal(inspect.status, 400); // Invalid code still consumes a check.
    const approve = (user: string) =>
      app.request(
        env.APP_ORIGIN + "/_actions/device",
        {
          method: "POST",
          headers: {
            ...headers(user),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ _csrf: "csrf", user_code: "ABCDEFGH" }),
        },
        env,
      );
    assert.equal((await approve("alice")).status, 429);
    assert.equal((await approve("bob")).status, 409); // Same IP, separate account.
    const direct = await app.request(
      env.APP_ORIGIN + "/auth/device/inspect",
      {
        method: "POST",
        headers: {
          ...headers("alice"),
          "Content-Type": "application/json",
          "X-CSRF-Token": "csrf",
          "CF-Connecting-IP": "192.0.2.2",
        },
        body: JSON.stringify({ user_code: "ABCDEFGH" }),
      },
      env,
    );
    assert.equal(direct.status, 429); // Changing route or IP cannot reset the limit.
  }
});

test("report dependency catalog shows unreviewed direct crates and only matching public reports", async (t) => {
  const { JSDOM } = await import("jsdom");
  const { db, env, request } = await fixture();
  const parent = await request("/reports", "POST", reportInput);
  assert.equal(parent.status, 201);
  db.exec(`
    INSERT INTO crates(id,name) VALUES(2,'dependency');
    INSERT INTO releases VALUES(2,2,'1.2.0',NULL,0,'2026-10-14'),(3,2,'2.0.0',NULL,0,'2026-10-14');
    INSERT INTO reports(id,create_key,release_id,author_id,visibility,created_at,updated_at)
    VALUES(10,'direct-public',2,'alice','public','2026-10-14','2026-10-14'),
          (11,'direct-hidden',2,'alice','hidden','2026-10-14','2026-10-14'),
          (12,'direct-withdrawn',2,'alice','public','2026-10-14','2026-10-14'),
          (13,'direct-mismatch',3,'alice','public','2026-10-14','2026-10-14');
    UPDATE reports SET withdrawn_at='2026-10-14' WHERE id=12;
    INSERT INTO report_revisions
    SELECT id,1,'Dependency evidence','','','kani-0.68.0','','','','2026-10-14' FROM reports WHERE id>=10;
    INSERT INTO report_revisions VALUES(10,2,'New evidence','','','kani-0.68.0','','','','2026-10-14');
  `);
  const upstream = [
    {
      crate_id: "dependency",
      req: "1",
      kind: "normal",
      optional: false,
      target: null,
    },
    {
      crate_id: "without-report",
      req: "2",
      kind: "build",
      optional: true,
      target: "cfg(unix)",
    },
  ];
  const getRun = env.ARCHIVE.get.bind(env.ARCHIVE);
  const cache = new Map<string, string>();
  t.mock.method(env.ARCHIVE, "get", async (key: string) => {
    if (!key.startsWith("cache/crates.io/dependencies/")) return getRun(key);
    return cache.has(key)
      ? { json: async () => JSON.parse(cache.get(key)!) }
      : null;
  });
  t.mock.method(env.ARCHIVE, "put", async (key: string, body: string) => {
    cache.set(key, body);
  });
  const fetched = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ dependencies: upstream }),
  );
  const read = async () => {
    const response = await app.request(
      env.APP_ORIGIN + `/report/${parent.body.id}`,
      {},
      env,
    );
    assert.equal(response.status, 200);
    return new JSDOM(await response.text()).window.document;
  };
  let d = await read();
  assert.equal(
    d.querySelector(".report-dependencies h2")!.textContent,
    "Dependencies (2)",
  );
  assert.equal(
    d.querySelectorAll(".report-dependencies .catalog-row").length,
    2,
  );
  assert.deepEqual(
    [...d.querySelectorAll('.report-dependencies a[href^="/report/"]')].map(
      (a) => a.getAttribute("href"),
    ),
    ["/report/10?v=2"],
  );
  assert.equal(d.querySelectorAll(".report-dependencies .muted").length, 1);
  assert.match(
    (
      await request(`/reports/${parent.body.id}`)
    ).body.dependency_count.toString(),
    /^0$/,
  );
  assert.deepEqual(
    (await request(`/reports/${parent.body.id}`)).body.dependencies,
    [],
  );
  // Reports are queried on every render even when release metadata is cached.
  db.prepare("UPDATE reports SET visibility='hidden' WHERE id=10").run();
  d = await read();
  assert.equal(
    d.querySelectorAll('.report-dependencies a[href^="/report/"]').length,
    0,
  );
  assert.equal(d.querySelectorAll(".report-dependencies .muted").length, 2);
  assert.equal(fetched.mock.callCount(), 1);
});

test("formal evidence is revision scoped, rejects invalid references, and reaches escaped Claim HTML", async () => {
  const { env, db, request } = await fixture();
  const objects = new Map<string, any>();
  env.ARCHIVE = {
    put: async (key: string, bytes: ArrayBuffer) =>
      objects.set(key, JSON.parse(new TextDecoder().decode(bytes))),
    get: async (key: string) =>
      objects.has(key)
        ? {
            json: async () => structuredClone(objects.get(key)),
            body: new Response(JSON.stringify(objects.get(key))).body,
          }
        : null,
  } as any;
  const tv = db
    .prepare("SELECT id FROM tool_versions WHERE tool_id='aeneas'")
    .get()!.id as string;
  const version = db
    .prepare("SELECT version FROM tool_versions WHERE id=?")
    .get(tv)!.version;
  const rid = "33333333-3333-4333-8333-333333333333";
  const second = "44444444-4444-4444-8444-444444444444";
  const sarif = recordedSarif(rid, ["lake", "build"]);
  const r: any = sarif.runs[0];
  r.tool.driver = { name: "aeneas", version };
  const contract: any = r.properties.proofs.contracts[0];
  contract.precondition = "";
  contract.harness = "Proofs.safe";
  contract.file = "Proofs.lean";
  contract.formal = {
    version: 1,
    theorem: "Proofs.safe",
    module: "Proofs",
    statement: "∀ (x : Nat), x < 10 → x & <safe> = x",
    binders: [{ name: "x", type: "Nat", kind: "variable", binder: "explicit" }],
    conclusion: "x & <safe> = x",
    program: "sample.safe x",
    program_head: "sample.safe",
    axioms: [],
    mapping: "manual",
    manifest: null,
    source: { file: "Proofs.lean", first_line: 1, last_line: 2 },
    definitions: [],
    definitions_truncated: false,
    translation_rerun: false,
  };
  r.results = [
    {
      ruleId: "aeneas.lean.theorem",
      kind: "pass",
      message: { text: "checked" },
      properties: { harness: "Proofs.safe" },
    },
  ];
  for (const mutate of [
    (s: any) =>
      s.runs[0].properties.proofs.contracts.push(structuredClone(contract)),
    (s: any) => (s.runs[0].results[0].kind = "fail"),
    (s: any) => (s.runs[0].results[0].kind = "informational"),
    (s: any) =>
      (s.runs[0].properties.proofs.contracts[0].formal.theorem = "Wrong"),
    (s: any) =>
      (s.runs[0].properties.proofs.contracts[0].formal.axioms = ["sorryAx"]),
    (s: any) => (s.runs[0].properties.proofs.contracts[0].formal.version = 2),
    (s: any) =>
      (s.runs[0].properties.proofs.contracts[0].formal.conclusion_segments = [
        { text: "wrong" },
      ]),
    (s: any) =>
      (s.runs[0].properties.proofs.contracts[0].formal.binders[0].type_segments =
        [{ text: "wrong" }]),
  ]) {
    const bad = structuredClone(sarif);
    mutate(bad);
    assert.throws(() => readRecord(bad));
  }
  assert.equal(
    (await request(`/runs/${rid}/sarif`, "POST", sarif)).status,
    201,
  );
  const alternate = structuredClone(sarif) as any;
  alternate.runs[0].automationDetails.guid = second;
  alternate.runs[0].properties.proofs.contracts[0].formal.statement =
    "Different recorded proposition";
  assert.equal(
    (await request(`/runs/${second}/sarif`, "POST", alternate)).status,
    201,
  );
  const input = {
    ...reportInput,
    tool_version_id: tv,
    run_ids: [rid, second],
    claims: [
      {
        ...reportInput.claims[0],
        precondition: "",
        evidence_ref: { run_id: rid, harness: "Proofs.safe" },
      },
    ],
  };
  for (const ref of [
    { run_id: rid, harness: "missing" },
    { run_id: reportInput.run_ids[0], harness: "Proofs.safe" },
  ]) {
    assert.equal(
      (
        await request("/reports/validate", "POST", {
          ...input,
          claims: [{ ...input.claims[0], evidence_ref: ref }],
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await request("/reports/validate", "POST", {
        ...input,
        claims: [{ ...input.claims[0], api_item_id: "unsafe" }],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/reports/validate", "POST", {
        ...input,
        claims: [{ ...input.claims[0], evidence_ref: null }],
      })
    ).status,
    400,
  );
  const created = await request("/reports", "POST", input);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const report = (await request(`/reports/${created.body.id}`)).body;
  const claim = report.claims[0];
  // List queries decode only the small reference and never fetch per-claim SARIF.
  const archive = env.ARCHIVE;
  env.ARCHIVE = {
    get: async () => {
      throw new Error("List must not load SARIF");
    },
  } as any;
  const listing = await request("/apis/safe/claims");
  assert.deepEqual(
    listing.body.items[0].evidence_ref,
    input.claims[0].evidence_ref,
  );
  env.ARCHIVE = archive;
  assert.deepEqual(claim.evidence_ref, input.claims[0].evidence_ref);
  let detail = (await request(`/claims/${claim.id}`)).body;
  assert.equal(detail.formal_evidence.statement, contract.formal.statement);
  assert.match(
    detail.formal_evidence.source_url,
    /\/blob\/[a-f0-9]{40}\/Proofs.lean#L1-L2$/,
  );
  const html = await (
    await app.request(`https://example.test/claim/${claim.id}`, {}, env)
  ).text();
  assert.match(html, /Formal statement/);
  assert.match(html, /&amp; &lt;safe&gt;/);
  assert.doesNotMatch(html, /None stated|<safe>/);
  const update = {
    ...input,
    expected_revision: 1,
    claims: [
      {
        ...input.claims[0],
        id: claim.id,
        precondition: "Edited explanation",
        evidence_ref: { run_id: second, harness: "Proofs.safe" },
      },
    ],
  };
  const updated = await request(
    `/reports/${report.id}/revisions`,
    "POST",
    update,
  );
  assert.equal(updated.status, 201, JSON.stringify(updated.body));
  detail = (await request(`/claims/${claim.id}?report_revision=1`)).body;
  assert.equal(detail.formal_evidence.statement, contract.formal.statement);
  detail = (await request(`/claims/${claim.id}`)).body;
  assert.equal(
    detail.formal_evidence.statement,
    "Different recorded proposition",
  );
});

test(
  "real Aeneas run → CLI publish → Claim HTML",
  { skip: !process.env.PROOFS_REAL_AENEAS_RECORD },
  async () => {
    const { createServer } = await import("node:http");
    const { execFile, spawn } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join, dirname } = await import("node:path");
    const record = JSON.parse(
      readFileSync(process.env.PROOFS_REAL_AENEAS_RECORD!, "utf8"),
    );
    const selectedRun = record.run_id ? ["--run", record.run_id] : [];
    const sarif = JSON.parse(readFileSync(record.sarif, "utf8"));
    const proofMetadata = sarif.runs[0].properties.proofs;
    const isPatched = !!proofMetadata.toolchain;
    const contracts = proofMetadata.contracts;
    const { env, db, request } = await fixture();
    db.prepare("UPDATE crates SET name=? WHERE id=1").run(proofMetadata.crate);
    db.prepare("UPDATE releases SET version=? WHERE id=1").run(
      proofMetadata.version,
    );
    db.exec("DELETE FROM api_items");
    const apiPaths = [
      ...new Set<string>(contracts.map((c: any) => c.api_paths[0])),
    ];
    assert.ok(
      isPatched ? contracts.length > 0 : contracts.length > apiPaths.length,
      "fixture has multiple theorems for one API",
    );
    for (const [i, path] of apiPaths.entries())
      db.prepare(
        "INSERT INTO api_items VALUES(?,1,?,?,'function',0,?,'https://docs.rs')",
      ).run(
        `api-${i}`,
        path,
        path,
        `pub fn ${path.split("::").at(-1)}(x: u32) -> u32`,
      );
    // This fixture seeds API entries directly and has no import queue worker.
    // Mark that prepared catalogue current, just as a completed import would.
    db.prepare(
      "INSERT INTO catalog_versions(release_id,extractor_version) VALUES(1,?)",
    ).run(CATALOG_EXTRACTOR_VERSION);
    const prepared = await request("/publish/prepare", "POST", {
      crate: proofMetadata.crate,
      version: proofMetadata.version,
    });
    assert.equal(prepared.status, 200);
    assert.equal(prepared.body.status, "ready");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM import_jobs").get()!.n, 0);
    const objects = new Map<string, any>();
    env.ARCHIVE = {
      put: async (key: string, bytes: ArrayBuffer) =>
        objects.set(key, JSON.parse(new TextDecoder().decode(bytes))),
      get: async (key: string) =>
        objects.has(key)
          ? {
              json: async () => objects.get(key),
              body: new Response(JSON.stringify(objects.get(key))).body,
            }
          : null,
    } as any;
    const token = "a".repeat(64);
    db.prepare(
      "INSERT INTO api_tokens VALUES('formal-token','alice',?,'publish',?,NULL,?,NULL)",
    ).run(
      await hash(token),
      new Date().toISOString(),
      new Date(Date.now() + 3600000).toISOString(),
    );
    const server = createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        const response = await app.request(
          env.APP_ORIGIN + req.url,
          {
            method: req.method,
            headers: req.headers as any,
            ...(bytes.length ? { body: bytes } : {}),
          },
          env,
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as import("node:net").AddressInfo;
    env.APP_ORIGIN = `http://127.0.0.1:${address.port}`;
    const config = await mkdtemp(join(tmpdir(), "proofs-formal-credentials-"));
    await writeFile(
      join(config, (await hash(env.APP_ORIGIN)) + ".json"),
      JSON.stringify({
        access_token: token,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const proofPath = join(record.project, "Proofs.lean");
    const committedProof = readFileSync(proofPath, "utf8");
    try {
      await writeFile(
        proofPath,
        "This working-tree file is deliberately not valid Lean.\n",
      );
      if (isPatched) {
        await assert.rejects(
          promisify(execFile)(
            record.binary,
            [
              "proofs",
              "--server",
              env.APP_ORIGIN,
              "publish",
              "--yes",
              "--force",
              ...selectedRun,
            ],
            {
              cwd: record.project,
              env: { ...process.env, PROOFS_CONFIG_DIR: config },
              timeout: 60000,
            },
          ),
          /Toolchain inputs changed/,
        );
        await writeFile(proofPath, committedProof);
        const patchPath = join(
          record.project,
          proofMetadata.toolchain.components.aeneas.source.patch.path,
        );
        const committedPatch = readFileSync(patchPath);
        try {
          await writeFile(
            patchPath,
            Buffer.concat([committedPatch, Buffer.from("\n")]),
          );
          await assert.rejects(
            promisify(execFile)(
              record.binary,
              [
                "proofs",
                "--server",
                env.APP_ORIGIN,
                "publish",
                "--yes",
                "--force",
                ...selectedRun,
              ],
              {
                cwd: record.project,
                env: { ...process.env, PROOFS_CONFIG_DIR: config },
                timeout: 60000,
              },
            ),
            /Toolchain inputs changed/,
          );
        } finally {
          await writeFile(patchPath, committedPatch);
        }
      }
      const result = await promisify(execFile)(
        record.binary,
        [
          "proofs",
          "--server",
          env.APP_ORIGIN,
          "publish",
          "--yes",
          ...selectedRun,
        ],
        {
          cwd: record.project,
          env: { ...process.env, PROOFS_CONFIG_DIR: config },
          timeout: 60000,
        },
      );
      await writeFile(
        join(dirname(record.sarif), "publish.log"),
        result.stdout + result.stderr,
      );
      const claim = db
        .prepare(
          "SELECT c.id FROM claims c JOIN claim_revisions r ON r.claim_id=c.id ORDER BY r.position LIMIT 1",
        )
        .get()!;
      const detail = (await request(`/claims/${claim.id}`)).body;
      assert.ok(detail.formal_evidence.statement);
      assert.equal(
        detail.precondition,
        contracts.find((c: any) => c.harness === detail.evidence_ref.harness)
          .precondition,
      );
      assert.ok(
        contracts.some(
          (c: any) => c.formal.statement === detail.formal_evidence.statement,
        ),
      );
      const html = await (
        await app.request(env.APP_ORIGIN + `/claim/${claim.id}`, {}, env)
      ).text();
      if (isPatched) {
        const { toolchainLabel } = await import("../web/toolchain");
        const label = toolchainLabel(proofMetadata.toolchain);
        assert.ok(html.includes(label));
        const publishedReport = db
          .prepare("SELECT id FROM reports ORDER BY id DESC LIMIT 1")
          .get()!;
        for (const path of ["/reports", `/report/${publishedReport.id}`]) {
          const response = await app.request(env.APP_ORIGIN + path, {}, env);
          assert.equal(response.status, 200);
          assert.ok((await response.text()).includes(label));
        }
        const page = await (
          await app.request(
            env.APP_ORIGIN + `/report/${publishedReport.id}`,
            {},
            env,
          )
        ).text();
        assert.ok(page.includes("cargo proofs prepare"));
        assert.ok(page.includes("Materialized tree"));
      }
      assert.match(html, /Formal statement/);
      assert.doesNotMatch(html, /None stated/);
      await writeFile(join(dirname(record.sarif), "claim.html"), html);
      const published = db
        .prepare(
          "SELECT c.id,c.api_item_id,e.harness FROM claims c JOIN claim_evidence e ON e.claim_id=c.id WHERE e.report_revision=1",
        )
        .all();
      assert.equal(published.length, contracts.length);
      for (const contract of contracts) {
        const row = published.find((c) => c.harness === contract.harness)!;
        assert.ok(row);
        const actual = (await request(`/claims/${row.id}`)).body;
        assert.equal(
          actual.formal_evidence.statement,
          contract.formal.statement,
        );
        assert.equal(actual.evidence_ref.harness, contract.harness);
        const page = await (
          await app.request(env.APP_ORIGIN + `/claim/${row.id}`, {}, env)
        ).text();
        assert.match(page, /Formal statement/);
        assert.ok(page.includes(contract.harness));
      }
      assert.equal(
        new Set(published.map((c) => c.api_item_id)).size,
        apiPaths.length,
      );
      // A no-op republish preserves the reference and Claim IDs despite working-tree edits.
      const again = await promisify(execFile)(
        record.binary,
        [
          "proofs",
          "--server",
          env.APP_ORIGIN,
          "publish",
          "--yes",
          ...selectedRun,
        ],
        {
          cwd: record.project,
          env: { ...process.env, PROOFS_CONFIG_DIR: config },
          timeout: 60000,
        },
      );
      assert.match(again.stdout, /No changes/);
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM claims").get()!.n,
        contracts.length,
      );
      // The packaged preview resolves each claim's theorem even when API IDs repeat.
      const preview = spawn(
        record.binary,
        [
          "proofs",
          "--server",
          env.APP_ORIGIN,
          "preview",
          "--no-browser",
          ...selectedRun,
        ],
        {
          cwd: record.project,
          env: { ...process.env, PROOFS_CONFIG_DIR: config },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const exited = new Promise<void>((resolve) =>
        preview.once("exit", () => resolve()),
      );
      let diagnostic = "";
      preview.stderr.on("data", (chunk) => {
        diagnostic += chunk;
      });
      try {
        const previewURL = await new Promise<string>((resolve, reject) => {
          let output = "";
          const timer = setTimeout(
            () => reject(new Error(`Preview timed out: ${diagnostic}`)),
            25000,
          );
          preview.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          preview.once("exit", () => {
            clearTimeout(timer);
            reject(new Error(diagnostic));
          });
          preview.stdout.on("data", (chunk) => {
            output += chunk;
            const url = output.match(/http:\/\/127\.0\.0\.1:\d+\/report/);
            if (url) {
              clearTimeout(timer);
              resolve(url[0]);
            }
          });
        });
        const previewOrigin = new URL(previewURL).origin;
        for (const row of published) {
          const response = await fetch(`${previewOrigin}/claim/${row.id}`);
          assert.equal(response.status, 200);
          const page = await response.text();
          assert.match(page, /Formal statement/);
          assert.ok(page.includes(String(row.harness)));
        }
      } finally {
        preview.kill("SIGINT");
        await exited;
      }
    } finally {
      await writeFile(proofPath, committedProof);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test("report and recorded-run limits accept 200 claims and reject 201", async () => {
  const { request, env } = await fixture();
  const rid = reportInput.run_ids[0];
  const sarif = recordedSarif(rid);
  const run = sarif.runs[0];
  const original = run.properties.proofs.contracts[0];
  run.properties.proofs.contracts = Array.from({ length: 200 }, (_, i) => ({
    ...original,
    harness: `sample::check_${i}`,
    precondition: `x = ${i}`,
  }));
  run.results = run.properties.proofs.contracts.map((c) => ({
    kind: "pass",
    message: { text: "checked" },
    properties: { harness: c.harness },
  }));
  assert.doesNotThrow(() => readRecord(sarif));
  const tooMany = structuredClone(sarif);
  tooMany.runs[0].properties.proofs.contracts.push({
    ...original,
    harness: "extra",
  });
  assert.throws(() => readRecord(tooMany));
  env.ARCHIVE = {
    get: async () => ({
      json: async () => sarif,
      body: new Response(JSON.stringify(sarif)).body,
    }),
  } as any;
  const input = {
    ...reportInput,
    claims: run.properties.proofs.contracts.map((c) => ({
      ...reportInput.claims[0],
      precondition: c.precondition,
    })),
  };
  assert.equal((await request("/reports/validate", "POST", input)).status, 200);
  assert.equal(
    (
      await request("/reports", "POST", {
        ...input,
        claims: [
          ...input.claims,
          { ...input.claims[0], precondition: "extra" },
        ],
      })
    ).status,
    400,
  );
  assert.equal((await request("/reports", "POST", input)).status, 201);
});

test("crate canonical and sitemap agree with public SemVer defaults", async () => {
  const { JSDOM } = await import("jsdom");
  const { seoResponse } = await import("../src/seo");
  const { db, env, request } = await fixture();
  try {
    assert.equal((await request("/reports", "POST", reportInput)).status, 201);
    for (const [id, version] of [
      [2, "1.9.0"],
      [3, "1.10.0"],
      [4, "2.0.0-rc.1"],
    ] as const) {
      db.prepare(
        "INSERT INTO releases(id,crate_id,version,created_at) VALUES(?,1,?,'2026-01-01')",
      ).run(id, version);
      db.prepare(
        "INSERT INTO reports(id,create_key,release_id,author_id,created_at,updated_at) VALUES(?,?,?,'alice','2026-01-01','2026-01-01')",
      ).run(id, `canonical-${id}`, id);
    }
    const read = async (query: string) => {
      const response = await app.request(
        env.APP_ORIGIN + "/crate/sample" + query,
        {},
        env,
      );
      assert.equal(response.status, 200);
      return new JSDOM(await response.text()).window.document;
    };
    for (const expected of ["1.10.0", "1.9.0", "2.0.0-rc.1"]) {
      assert.equal(
        (await request("/crates/sample/releases")).body.default_version,
        expected,
      );
      const doc = await read("?utm_source=test");
      assert.ok(doc.querySelector("h1")!.textContent!.includes(expected));
      assert.equal(
        doc.querySelector('link[rel="canonical"]')!.getAttribute("href"),
        env.APP_ORIGIN + "/crate/sample",
      );
      const explicit = await read(`?version=${expected}&utm_source=test`);
      assert.equal(
        explicit.querySelector('link[rel="canonical"]')!.getAttribute("href"),
        env.APP_ORIGIN + "/crate/sample",
      );
      const xml = await (await seoResponse(
        { ...env, ENVIRONMENT: "production" },
        "/sitemap-records-1.xml",
      ))!.text();
      assert.ok(!xml.includes(`/crate/sample?version=${expected}</loc>`));
      if (expected === "1.10.0")
        db.exec(
          "UPDATE reports SET withdrawn_at='2026-02-01' WHERE release_id=3",
        );
      else if (expected === "1.9.0")
        db.exec(
          "UPDATE reports SET visibility='hidden' WHERE release_id IN (1,2)",
        );
    }
    // The only remaining published version is now the prerelease.
    const old = await read("?version=1.0.0&utm_source=test");
    assert.equal(
      old.querySelector('link[rel="canonical"]')!.getAttribute("href"),
      env.APP_ORIGIN + "/crate/sample?version=1.0.0",
    );
  } finally {
    db.close();
  }
});

test("trait declaration methods can be resolved and attached to an existing finding", async () => {
  const { env, request } = await fixture();
  const report = await request("/reports", "POST", reportInput);
  const finding = await request(`/reports/${report.body.id}/findings`, "POST", {
    title: "Default method returns an incorrect value",
    body: "The trait default method has a reproducible counterexample.",
  });
  assert.equal(finding.status, 201);
  const doc = traitImplFixture({ primitive: "u8" });
  doc.index[1].inner.trait.implementations = [];
  doc.index[2].inner.function.has_body = true;
  doc.index[2].visibility = "default";
  (env as any).ARCHIVE.get = async () => ({
    text: async () => JSON.stringify(doc),
  });
  assert.deepEqual(await refreshCatalog(env, 1), { indexed: 1, added: 1 });
  const resolved = await request(
    "/resolve-api?crate=sample&version=1.0.0&path=sample::T::m",
  );
  assert.equal(resolved.status, 200);
  const api = (await request(`/apis/${resolved.body.id}`)).body;
  assert.equal(
    api.upstream_url,
    "https://docs.rs/sample/1.0.0/sample/trait.T.html#method.m",
  );
  assert.match(api.signature, /^trait sample::T\npub fn m/);
  const updated = await request(`/findings/${finding.body.id}`, "PATCH", {
    edit_version: 1,
    api_item_ids: [resolved.body.id],
  });
  assert.equal(updated.status, 200);
  const saved = (await request(`/findings/${finding.body.id}`)).body;
  assert.deepEqual(
    saved.apis.map((a: any) => a.display_path),
    ["sample::T::m"],
  );
});

test("publication preparation refreshes stale catalogs for ordinary authors and skips current versions", async () => {
  const { db, env, request } = await fixture();
  const report = await request("/reports", "POST", reportInput);
  const claims = db.prepare("SELECT * FROM claims").all();
  const before = db.prepare("SELECT * FROM api_items ORDER BY id").all();
  let reads = 0;
  const doc = traitImplFixture({ primitive: "u8" });
  (env as any).ARCHIVE.get = async () => {
    reads++;
    return { text: async () => JSON.stringify(doc) };
  };
  const prepare = () =>
    request("/publish/prepare", "POST", { crate: "sample", version: "1.0.0" });
  const first = await prepare();
  assert.equal(first.status, 202);
  assert.equal(
    (await prepare()).body.id,
    first.body.id,
    "share an in-progress refresh",
  );
  assert.equal(await importJob(env, first.body.id), true);
  assert.equal(reads, 1);
  assert.equal((await prepare()).status, 200);
  assert.equal(reads, 1, "current catalog does not reread rustdoc");
  assert.deepEqual(
    db
      .prepare(
        "SELECT * FROM api_items WHERE id IN ('safe','unsafe') ORDER BY id",
      )
      .all(),
    before,
  );
  assert.deepEqual(db.prepare("SELECT * FROM claims").all(), claims);
  assert.equal(
    (await request(`/reports/${report.body.id}`)).body.revision_no,
    1,
  );
  assert.equal(
    (await request("/resolve-api?crate=sample&version=1.0.0&path=sample::T::m"))
      .status,
    200,
  );
  db.exec("UPDATE catalog_versions SET extractor_version=999");
  assert.equal(
    (await prepare()).status,
    200,
    "older deployments do not downgrade newer catalogs",
  );
  await refreshCatalog(env, 1);
  assert.equal(
    db.prepare("SELECT extractor_version FROM catalog_versions").get()!
      .extractor_version,
    999,
  );
});

test("failed catalog refresh stays stale and retries from the archived snapshot", async () => {
  const { db, env, request } = await fixture();
  (env as any).ARCHIVE.get = async () => null;
  const prepared = await request("/publish/prepare", "POST", {
    crate: "sample",
    version: "1.0.0",
  });
  assert.equal(prepared.status, 202);
  assert.equal(await importJob(env, prepared.body.id), false);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM catalog_versions").get()!.n,
    0,
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM api_items").get()!.n, 2);
  db.prepare("UPDATE import_jobs SET next_retry_at=NULL WHERE id=?").run(
    prepared.body.id,
  );
  (env as any).ARCHIVE.get = async () => ({
    text: async () => JSON.stringify(traitImplFixture({ primitive: "u8" })),
  });
  assert.equal(await importJob(env, prepared.body.id), true);
  assert.equal(
    (
      await request("/publish/prepare", "POST", {
        crate: "sample",
        version: "1.0.0",
      })
    ).status,
    200,
  );
});

test("patched revisions and Claim references retain their own source labels", async () => {
  const { toolchainLabel } = await import("../web/toolchain");
  const { env, db, request } = await fixture();
  const objects = new Map<string, any>();
  env.ARCHIVE = {
    put: async (key: string, bytes: ArrayBuffer) =>
      objects.set(key, JSON.parse(new TextDecoder().decode(bytes))),
    get: async (key: string) =>
      objects.has(key)
        ? {
            json: async () => structuredClone(objects.get(key)),
            body: new Response(JSON.stringify(objects.get(key))).body,
          }
        : null,
  } as any;
  const tv = db
    .prepare("SELECT id,version FROM tool_versions WHERE tool_id='aeneas'")
    .get()!;
  const ids = [
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
  ];
  const records: any[] = [];
  for (const [i, id] of ids.entries()) {
    const sarif = recordedSarif(id, ["lake", "--no-cache", "build"]);
    const r: any = sarif.runs[0],
      p = r.properties.proofs;
    const descriptor: any = {
      schema_version: 1,
      components: {
        aeneas: {
          tool: "aeneas",
          source: {
            kind: "git_patch",
            repository: "https://github.com/AeneasVerif/aeneas",
            base_commit: tv.version,
            patch: {
              path: "proofs/aeneas.patch",
              sha256: (i ? "f" : "b").repeat(64),
            },
          },
          materialized: { git_tree: (i ? "e" : "c").repeat(40) },
        },
        charon: {
          tool: "charon",
          source: {
            kind: "git",
            repository: "https://github.com/AeneasVerif/charon",
            commit: "d".repeat(40),
          },
        },
        lean: {
          tool: "lean",
          source: { kind: "release", release_id: "leanprover/lean4:v4.35.0" },
        },
      },
      uses: [
        {
          component: "aeneas",
          role: "lean_library",
          observation: {
            kind: "dependency_resolved",
            dependency_name: "aeneas",
            subdirectory: "backends/lean",
          },
        },
        {
          component: "aeneas",
          role: "translator",
          observation: { kind: "not_run" },
        },
        {
          component: "charon",
          role: "rust_frontend",
          observation: { kind: "not_run" },
        },
        {
          component: "lean",
          role: "proof_checker",
          observation: {
            kind: "process_executed",
            reported_version: "Lean (version 4.35.0, Release)",
          },
        },
      ],
    };
    r.tool.driver = {
      name: "aeneas",
      version: i ? String(tv.version).toUpperCase() : tv.version,
      fullName: toolchainLabel(descriptor),
    };
    p.toolchain = descriptor;
    p.toolchain_input = { manifest_path: "Cargo.toml" };
    p.contracts[0] = {
      ...p.contracts[0],
      harness: "Proofs.safe",
      precondition: "",
      file: "Proofs.lean",
      formal: {
        version: 1,
        theorem: "Proofs.safe",
        module: "Proofs",
        statement: "True",
        binders: [],
        conclusion: "True",
        program: null,
        program_head: null,
        axioms: [],
        mapping: "manual",
        manifest: null,
        source: { file: "Proofs.lean", first_line: 1, last_line: 2 },
        definitions: [],
        definitions_truncated: false,
        translation_rerun: false,
      },
    };
    r.results = [
      {
        kind: "pass",
        ruleId: "aeneas.lean.theorem",
        message: { text: "checked" },
        properties: { harness: "Proofs.safe" },
      },
    ];
    assert.equal(
      (await request(`/runs/${id}/sarif`, "POST", sarif)).status,
      201,
    );
    records.push(sarif);
  }
  const body = (i: number) => ({
    ...reportInput,
    tool_version_id: tv.id,
    run_ids: [ids[i]],
    claims: [
      {
        ...reportInput.claims[0],
        precondition: "",
        evidence_ref: { run_id: ids[i], harness: "Proofs.safe" },
      },
    ],
  });
  const mixed = await request("/reports/validate", "POST", {
    ...body(0),
    run_ids: ids,
  });
  assert.equal(mixed.status, 400);
  assert.equal(mixed.body.error, "inconsistent_run_toolchain_sources");
  const created = await request("/reports", "POST", body(0));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const report = (await request(`/reports/${created.body.id}`)).body;
  const claim = report.claims[0];
  const update = await request(`/reports/${report.id}/revisions`, "POST", {
    ...body(1),
    expected_revision: 1,
    claims: [{ ...body(1).claims[0], id: claim.id }],
  });
  assert.equal(update.status, 201, JSON.stringify(update.body));
  for (const i of [0, 1]) {
    const expected = toolchainLabel(
      records[i].runs[0].properties.proofs.toolchain,
    );
    for (const path of [
      `/report/${report.id}?v=${i + 1}`,
      `/claim/${claim.id}?report_revision=${i + 1}`,
    ]) {
      const response = await app.request(env.APP_ORIGIN + path, {}, env);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.ok(html.includes(expected), path);
      assert.ok(
        !html.includes(
          toolchainLabel(records[1 - i].runs[0].properties.proofs.toolchain),
        ),
        path,
      );
    }
  }
  const mutated = structuredClone(records[0]);
  mutated.runs[0].properties.proofs.toolchain.components.aeneas.source.patch.sha256 =
    "a".repeat(64);
  assert.equal(
    (await request(`/runs/${ids[0]}/sarif`, "POST", mutated)).status,
    409,
  );
});

test("catalogue includes provided local trait defaults for primitive and nominal impls", () => {
  for (const nominal of [false, true]) {
    const doc = traitImplFixture(
      nominal ? { resolved_path: { path: "S", id: 5 } } : { primitive: "u8" },
    );
    if (nominal) {
      doc.index[0].inner.module.items.push(5);
      doc.index[5] = {
        crate_id: 0,
        name: "S",
        visibility: "public",
        inner: { struct: { impls: [3] } },
      };
    }
    doc.index[1].inner.trait.items.push(8);
    doc.index[8] = {
      name: "inherited",
      inner: {
        function: {
          ...structuredClone(doc.index[2].inner.function),
          has_body: true,
        },
      },
    };
    doc.index[3].inner.impl.provided_trait_methods = ["inherited"];
    const key = `<${nominal ? "sample::S" : "u8"} as sample::T>::inherited`;
    assert.equal(
      extractAPIs(doc, "sample", "1.0.0").filter((a) => a.canonical_key === key)
        .length,
      1,
    );
    doc.index[9] = {
      name: "inherited",
      inner: {
        function: {
          ...structuredClone(doc.index[8].inner.function),
          header: { is_unsafe: true, abi: "Rust" },
        },
      },
    };
    doc.index[3].inner.impl.items.push(9);
    const overridden = extractAPIs(doc, "sample", "1.0.0").filter(
      (a) => a.canonical_key === key,
    );
    assert.equal(overridden.length, 1);
    assert.equal(overridden[0].is_unsafe, 1);
    doc.index[3].inner.impl.items.pop();
    doc.index[3].inner.impl.provided_trait_methods = [];
    assert.equal(
      extractAPIs(doc, "sample", "1.0.0").filter((a) => a.canonical_key === key)
        .length,
      0,
    );
  }
});

test("crate badge counts current public claims for only the selected release", async () => {
  const { db, env, request } = await fixture();
  const path = "/crates/sample/1.0.0/badge";
  const badge = async (message: string) => {
    const response = await request(path, "GET", undefined, "");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      schemaVersion: 1,
      label: "proofs.rs",
      message,
      color: "blue",
    });
  };
  await badge("0 claims");
  assert.equal((await request("/reports", "POST", reportInput)).status, 201);
  await badge("1 claim");
  const claims = (await request("/reports/1")).body.claims;
  assert.equal(
    (
      await request("/reports/1/revisions", "POST", {
        ...reportInput,
        expected_revision: 1,
        claims: [
          { ...reportInput.claims[0], id: claims[0].id },
          { ...reportInput.claims[0], title: "Another claim" },
        ],
      })
    ).status,
    201,
  );
  await badge("2 claims");
  const updated = (await request("/reports/1")).body.claims;
  assert.equal(
    (
      await request("/reports/1/revisions", "POST", {
        ...reportInput,
        expected_revision: 2,
        claims: [{ ...reportInput.claims[0], id: updated[0].id }],
      })
    ).status,
    201,
  );
  await badge("1 claim");
  db.exec("UPDATE reports SET visibility='hidden' WHERE id=1");
  await badge("0 claims");
  db.exec(
    "UPDATE reports SET visibility='public',withdrawn_at='2026-10-29' WHERE id=1",
  );
  await badge("0 claims");
  db.exec("UPDATE reports SET withdrawn_at=NULL WHERE id=1");
  db.exec("INSERT INTO releases VALUES(2,1,'2.0.0','checksum',0,'2026-10-29')");
  assert.equal(
    (await request("/crates/sample/2.0.0/badge")).body.message,
    "0 claims",
  );
  assert.equal((await request("/crates/missing/1.0.0/badge")).status, 404);
  assert.equal((await request("/crates/sample/9.0.0/badge")).status, 404);

  const page = await app.request(
    "https://example.test/crate/sample?version=1.0.0",
    {},
    env,
  );
  assert.equal(page.status, 200);
  const { JSDOM } = await import("jsdom");
  const document = new JSDOM(await page.text()).window.document;
  const image = document.querySelector<HTMLImageElement>(".crate-badge img")!;
  const imageURL = new URL(image.src);
  assert.equal(imageURL.origin, "https://img.shields.io");
  assert.equal(
    imageURL.searchParams.get("url"),
    "https://example.test/api/v1/crates/sample/1.0.0/badge",
  );
  assert.equal(
    document.querySelector(".crate-badge code")!.textContent,
    `[![proofs.rs](${image.src})](https://example.test/crate/sample?version=1.0.0)`,
  );
  assert.ok(document.querySelector("button[data-copy-badge]"));
  assert.match(
    page.headers.get("Content-Security-Policy")!,
    /img-src[^;]*https:\/\/img.shields.io/,
  );
});

test("Zulip announcements: transactional events, idempotency, retries and visibility", async () => {
  const { deliverZulip } = await import("../src/zulip");
  const { db, env, request } = await fixture();
  Object.assign(env, {
    ENVIRONMENT: "production",
    EMAIL_DISABLED: "true",
    ZULIP_ENABLED: "true",
    ZULIP_SITE: "https://zulip.example",
    ZULIP_CHANNEL_ID: "12",
    ZULIP_BOT_EMAIL: "bot@example.test",
    ZULIP_API_KEY: "test-key",
  });
  const key = { "Idempotency-Key": crypto.randomUUID() };
  const made = await request("/reports", "POST", reportInput, "alice", key);
  assert.equal(made.status, 201);
  await request("/reports", "POST", reportInput, "alice", key);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM outbox_events WHERE type='zulip'").get()!
      .n,
    1,
  );
  const id = made.body.id;
  const revision = await request(`/reports/${id}/revisions`, "POST", {
    ...reportInput,
    expected_revision: 1,
  });
  assert.equal(revision.status, 201);
  const cm = await request(
    `/reports/${id}/comments`,
    "POST",
    { body: "hello", revision_no: 2 },
    "bob",
  );
  assert.equal(cm.status, 201);
  const events = db
    .prepare(
      "SELECT * FROM outbox_events WHERE type='zulip' ORDER BY created_at",
    )
    .all();
  assert.equal(events.length, 3);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM outbox_events WHERE type='zulip_check'")
      .get()!.n,
    3,
  );
  const original = globalThis.fetch;
  const messages: URLSearchParams[] = [];
  let status = 200;
  globalThis.fetch = (async (_url: any, init: any) => {
    assert.match(init.headers.Authorization, /^Basic /);
    assert.equal(init.redirect, "manual");
    messages.push(init.body);
    return new Response(JSON.stringify({ result: "success", id: 99 }), {
      status,
      headers: { "Retry-After": "120" },
    });
  }) as typeof fetch;
  try {
    await deliverZulip(env, events[0]);
    await deliverZulip(env, events[0]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].get("topic"), `Report #${id}`);
    assert.match(messages[0].get("content")!, /\?v=1/);
    status = 429;
    await deliverZulip(env, events[1]);
    assert.equal(
      db
        .prepare("SELECT status FROM zulip_deliveries WHERE event_id=?")
        .get(events[1].id as string)!.status,
      "retry",
    );
    db.prepare(
      "UPDATE zulip_deliveries SET next_attempt_at=NULL WHERE event_id=?",
    ).run(events[1].id as string);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) n FROM outbox_events WHERE type='zulip_failure'",
        )
        .get()!.n,
      0,
    );
    status = 200;
    await deliverZulip(env, events[1]);
    const { queue } = await import("../src/jobs");
    let acknowledged = false;
    await queue(
      {
        messages: [
          {
            body: { event_id: events[2].id },
            ack() {
              acknowledged = true;
            },
            retry() {
              assert.fail("unexpected queue retry");
            },
          },
        ],
      } as any,
      env,
    );
    assert.equal(acknowledged, true);
    assert.match(messages.at(-1)!.get("content")!, /\?comment=/);
    assert.ok(messages.every((m) => m.get("topic") === `Report #${id}`));
    const extra = { ...events[0], id: crypto.randomUUID() };
    db.prepare(
      "INSERT INTO outbox_events SELECT ?,type,aggregate_id,?,payload,created_at,NULL,NULL FROM outbox_events WHERE id=?",
    ).run(extra.id as string, crypto.randomUUID(), events[0].id as string);
    db.prepare("UPDATE reports SET visibility='hidden' WHERE id=?").run(id);
    await deliverZulip(env, extra);
    assert.equal(
      db
        .prepare("SELECT status FROM zulip_deliveries WHERE event_id=?")
        .get(extra.id as string)!.status,
      "cancelled",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Zulip leases, retry limits, permanent errors and rollback", async () => {
  const { deliverZulip, zulipText } = await import("../src/zulip");
  const { db, env, request } = await fixture();
  Object.assign(env, {
    ENVIRONMENT: "production",
    ZULIP_ENABLED: "true",
    ZULIP_SITE: "https://zulip.example",
    ZULIP_CHANNEL_ID: "12",
    ZULIP_BOT_EMAIL: "bot@example.test",
    ZULIP_API_KEY: "key",
  });
  assert.equal((await request("/reports", "POST", reportInput)).status, 201);
  const event = db
    .prepare("SELECT * FROM outbox_events WHERE type='zulip'")
    .get()!;
  const original = globalThis.fetch;
  let calls = 0;
  let status = 503;
  globalThis.fetch = (async (_url: any, init: any) => {
    assert.equal(init.redirect, "manual");
    calls++;
    return new Response("{}", {
      status,
      headers: { Location: "https://other.example/messages" },
    });
  }) as typeof fetch;
  try {
    db.prepare(
      "INSERT INTO zulip_deliveries(event_id,status,attempts,lease_until) VALUES(?,'sending',1,?)",
    ).run(event.id as string, new Date(Date.now() + 60000).toISOString());
    await deliverZulip(env, event);
    assert.equal(calls, 0);
    db.prepare(
      "UPDATE zulip_deliveries SET lease_until='2000',attempts=7 WHERE event_id=?",
    ).run(event.id as string);
    await deliverZulip(env, event);
    assert.equal(calls, 1);
    assert.equal(
      db.prepare("SELECT status FROM zulip_deliveries").get()!.status,
      "failed",
    );
    db.prepare(
      "UPDATE zulip_deliveries SET status='pending',attempts=0,next_attempt_at=NULL",
    ).run();
    status = 401;
    await deliverZulip(env, event);
    assert.equal(
      db.prepare("SELECT status FROM zulip_deliveries").get()!.status,
      "failed",
    );
    assert.equal(
      db.prepare("SELECT attempts FROM zulip_deliveries").get()!.attempts,
      1,
    );
    // Redirects are permanent failures, never followed with the bot credentials.
    for (const redirectStatus of [301, 302, 303, 307, 308]) {
      db.prepare(
        "UPDATE zulip_deliveries SET status='pending',attempts=0,next_attempt_at=NULL",
      ).run();
      db.prepare("UPDATE outbox_events SET completed_at=NULL WHERE id=?").run(
        event.id as string,
      );
      status = redirectStatus;
      const beforeCalls: number = calls;
      await deliverZulip(env, event);
      assert.equal(calls, beforeCalls + 1);
      const delivery = db.prepare("SELECT * FROM zulip_deliveries").get()!;
      assert.equal(delivery.status, "failed");
      assert.equal(delivery.last_error, `http_${redirectStatus}`);
      assert.equal(delivery.attempts, 1);
      assert.ok(
        db
          .prepare("SELECT completed_at FROM outbox_events WHERE id=?")
          .get(event.id as string)!.completed_at,
      );
    }
    const before = db.prepare("SELECT COUNT(*) n FROM reports").get()!.n;
    db.exec(
      "CREATE TRIGGER reject_zulip BEFORE INSERT ON outbox_events WHEN NEW.type='zulip' BEGIN SELECT RAISE(ABORT,'test rollback'); END",
    );
    assert.notEqual(
      (await request("/reports", "POST", reportInput)).status,
      201,
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM reports").get()!.n, before);
    assert.ok(!zulipText("@**all** `title`\nhello").includes("@"));
    assert.equal(zulipText("@**all** `title`\nhello").split("`").length, 3);
  } finally {
    globalThis.fetch = original;
  }
});

// Only callable names from the CRC recordings are retained here; the compact
// fixture is not evidence of a Lean run. The optional test below uses original SARIF.
function callableRecord(rid: string, paths: string[], formal = false) {
  const sarif: any = recordedSarif(
    rid,
    formal ? ["lake", "build"] : ["cargo", "kani"],
  );
  const r = sarif.runs[0];
  r.properties.proofs.contracts = paths.map((path, i) => {
    const harness = formal ? `Proofs.p${i}` : `check_${i}`;
    const source = { file: "Proofs.lean", first_line: 1, last_line: 2 };
    return {
      harness,
      api_paths: [path],
      precondition: formal ? "" : "true",
      ...source,
      ...(formal
        ? {
            formal: {
              version: 1,
              theorem: harness,
              module: "Proofs",
              statement: "True",
              binders: [],
              conclusion: "True",
              program: "sample.f",
              program_head: "sample.f",
              axioms: [],
              mapping: "manual",
              manifest: null,
              source,
              definitions: [],
              definitions_truncated: false,
              translation_rerun: false,
            },
          }
        : {}),
    };
  });
  r.results = r.properties.proofs.contracts.map((c: any) => ({
    kind: "pass",
    ...(formal ? { ruleId: "aeneas.lean.theorem" } : {}),
    message: { text: "checked" },
    properties: { harness: c.harness },
  }));
  return sarif;
}
function recordObjects(env: Env) {
  const objects = new Map<string, any>();
  env.ARCHIVE = {
    put: async (key: string, bytes: ArrayBuffer) =>
      objects.set(key, JSON.parse(new TextDecoder().decode(bytes))),
    get: async (key: string) =>
      objects.has(key)
        ? {
            json: async () => structuredClone(objects.get(key)),
            body: new Response(JSON.stringify(objects.get(key))).body,
          }
        : null,
    delete: async (key: string) => objects.delete(key),
  } as any;
  return objects;
}
test("recorded callable preparation is mutation-free; exact bindings publish without rustdoc and retain identity", async () => {
  const { env, db, request } = await fixture();
  const objects = recordObjects(env);
  const rid = "77777777-7777-4777-8777-777777777777";
  const paths = [
    "unimported::Crc<u8, Table<0>>::checksum",
    "unimported::Table<16>::clone_from",
    "<[u8; 32] as unimported::Read>::read",
  ];
  const sarif = callableRecord(rid, paths);
  sarif.runs[0].properties.proofs.crate = "unimported";
  sarif.runs[0].properties.proofs.contracts[0].api_paths.push(
    "unimported::alias",
  );
  const before = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((x: any) => [
      x.name,
      db.prepare(`SELECT COUNT(*) n FROM ${x.name}`).get()!.n,
    ]);
  const prepared = await request("/runs/prepare", "POST", sarif);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  assert.equal(prepared.body.apis.length, paths.length);
  assert.deepEqual(
    prepared.body.apis.map((x: any) => x.display_path),
    paths,
  );
  for (const [table, count] of before)
    assert.equal(
      db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n,
      count,
      table,
    );
  assert.equal(objects.size, 0);
  const uploaded = await request(`/runs/${rid}/sarif`, "POST", sarif);
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  assert.deepEqual(uploaded.body.apis, prepared.body.apis);
  assert.deepEqual(
    (await request(`/runs/${rid}/sarif`, "POST", sarif)).body,
    uploaded.body,
  );
  const api = uploaded.body.apis[0].api_item_id;
  assert.equal((await request(`/apis/${api}`)).status, 404);
  assert.equal(
    (await request("/crates/unimported/1.0.0/apis")).body.items.length,
    0,
  );
  assert.equal(
    (
      await request(
        `/resolve-api?crate=unimported&version=1.0.0&path=${encodeURIComponent(paths[0])}`,
      )
    ).status,
    404,
  );
  const body = {
    ...structuredClone(reportInput),
    crate: "unimported",
    run_ids: [rid],
    claims: uploaded.body.apis.map((b: any) => ({
      ...reportInput.claims[0],
      api_item_id: b.api_item_id,
    })),
  };
  const published = await request("/reports", "POST", body);
  assert.equal(published.status, 201, JSON.stringify(published.body));
  const detail = await request(`/apis/${api}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.origin, "recorded");
  assert.equal(detail.body.is_unsafe, null);
  assert.equal(detail.body.signature, "");
  assert.equal(detail.body.upstream_url, "");
  assert.equal(
    (await request("/crates/unimported/1.0.0/apis")).body.items.length,
    3,
  );
  const current = (await request(`/reports/${published.body.id}`)).body;
  const other = structuredClone(sarif);
  const otherID = "88888888-8888-4888-8888-888888888888";
  other.runs[0].automationDetails.guid = otherID;
  const next = await request(`/runs/${otherID}/sarif`, "POST", other);
  assert.deepEqual(next.body.apis, uploaded.body.apis);
  const revision = await request(
    `/reports/${published.body.id}/revisions`,
    "POST",
    {
      ...body,
      run_ids: [otherID],
      expected_revision: current.revision_no,
      claims: current.claims,
    },
  );
  assert.equal(revision.status, 201, JSON.stringify(revision.body));
  assert.deepEqual(
    (await request(`/reports/${published.body.id}`)).body.claims.map(
      (c: any) => c.id,
    ),
    current.claims.map((c: any) => c.id),
  );
  assert.equal(
    (await request("/reports/validate", "POST", body, "bob")).status,
    400,
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM import_jobs").get()!.n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM doc_snapshots").get()!.n, 1);
});
test("recorded callable preparation retains exact rustdoc IDs and rejects invalid or unowned evidence", async () => {
  const { env, db, request } = await fixture();
  recordObjects(env);
  const rid = "99999999-9999-4999-8999-999999999999";
  const sarif = callableRecord(rid, ["sample::safe"]);
  assert.equal(
    (await request("/runs/prepare", "POST", sarif)).body.apis[0].api_item_id,
    "safe",
  );
  const aliases = structuredClone(sarif);
  aliases.runs[0].properties.proofs.contracts[0].api_paths = [
    "sample::first_alias_missing",
    "sample::safe",
  ];
  const aliasBinding = (await request("/runs/prepare", "POST", aliases)).body
    .apis[0];
  assert.equal(aliasBinding.api_item_id, "safe");
  assert.equal(aliasBinding.display_path, "sample::safe");
  db.prepare(
    "INSERT INTO api_items VALUES('display',1,?,?,'method',0,'pub fn fmt()','https://docs.rs')",
  ).run(
    "<sample::S as core::fmt::Display>::fmt",
    "<sample::S as core::fmt::Display>::fmt",
  );
  aliases.runs[0].properties.proofs.contracts[0].api_paths = [
    "<sample::S as Display>::fmt",
    "<sample::S as core::fmt::Display>::fmt",
  ];
  assert.equal(
    (await request("/runs/prepare", "POST", aliases)).body.apis[0].api_item_id,
    "display",
  );

  for (const mutate of [
    (s: any) => (s.runs[0].results[0].kind = "fail"),
    (s: any) => (s.runs[0].invocations[0].exitCode = 1),
    (s: any) => (s.runs[0].versionControlProvenance[0].revisionId = "HEAD"),
    (s: any) => (s.runs[0].properties.proofs.contracts[0].api_paths = [""]),
    (s: any) => (s.runs[0].tool.driver.version = "unknown"),
    (s: any) => (s.runs[0].properties.proofs.crate = "bad/name"),
    (s: any) => (s.runs[0].properties.proofs.version = "not-semver"),
  ]) {
    const invalid = structuredClone(sarif);
    mutate(invalid);
    assert.equal((await request("/runs/prepare", "POST", invalid)).status, 400);
    assert.equal(
      (await request(`/runs/${rid}/sarif`, "POST", invalid)).status,
      400,
    );
  }
  assert.equal(
    (await request(`/runs/${rid}/sarif`, "POST", sarif)).status,
    201,
  );
  assert.equal(
    (await request("/runs/prepare", "POST", sarif, "bob")).status,
    409,
  );
  const changed = structuredClone(sarif);
  changed.runs[0].properties.proofs.contracts[0].api_paths = ["sample::forged"];
  assert.equal((await request("/runs/prepare", "POST", changed)).status, 409);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM api_item_provenance").get()!.n,
    0,
  );
});
test("all 96 CRC callable spellings and formal references survive preparation, upload and report validation", async () => {
  const paths = JSON.parse(
    readFileSync(
      new URL("../fixtures/crc-3.4.0-recorded-api-paths.json", import.meta.url),
      "utf8",
    ),
  );
  for (const [profile, apis] of Object.entries(paths)) {
    const { env, db, request } = await fixture();
    recordObjects(env);
    const tv = db
      .prepare("SELECT id,version FROM tool_versions WHERE tool_id='aeneas'")
      .get()!;
    const rid = crypto.randomUUID();
    const sarif = callableRecord(rid, apis as string[], true);
    sarif.runs[0].tool.driver = { name: "aeneas", version: tv.version };
    sarif.runs[0].properties.proofs.crate = "crc";
    sarif.runs[0].properties.proofs.version = "3.4.0";
    const prepared = await request("/runs/prepare", "POST", sarif);
    assert.equal(prepared.status, 200, profile + JSON.stringify(prepared.body));
    assert.equal(prepared.body.apis.length, profile === "default" ? 21 : 75);
    assert.deepEqual(
      prepared.body.apis.map((a: any) => a.display_path),
      apis,
    );
    const uploaded = await request(`/runs/${rid}/sarif`, "POST", sarif);
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const body = {
      ...structuredClone(reportInput),
      crate: "crc",
      version: "3.4.0",
      tool_version_id: tv.id,
      run_ids: [rid],
      claims: uploaded.body.apis.map((a: any, i: number) => ({
        ...reportInput.claims[0],
        api_item_id: a.api_item_id,
        precondition: "",
        evidence_ref: {
          run_id: rid,
          harness: sarif.runs[0].properties.proofs.contracts[i].harness,
        },
      })),
    };
    const validated = await request("/reports/validate", "POST", body);
    assert.equal(validated.status, 200, JSON.stringify(validated.body));
    const published = await request("/reports", "POST", body);
    assert.equal(published.status, 201, JSON.stringify(published.body));
    for (const c of (await request(`/reports/${published.body.id}`)).body
      .claims) {
      const detail = await request(`/claims/${c.id}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.formal_evidence.theorem, c.evidence_ref.harness);
      assert.equal(detail.body.origin, "recorded");
      assert.equal(detail.body.is_unsafe, null);
    }
    const forged = structuredClone(body);
    forged.claims[0].evidence_ref.harness = "Proofs.absent";
    assert.equal(
      (await request("/reports/validate", "POST", forged)).status,
      400,
    );
    const invalid = structuredClone(sarif);
    invalid.runs[0].automationDetails.guid = crypto.randomUUID();
    invalid.runs[0].properties.proofs.contracts[0].formal.axioms = ["sorryAx"];
    assert.equal((await request("/runs/prepare", "POST", invalid)).status, 400);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM import_jobs").get()!.n, 0);
  }
});
test(
  "original CRC SARIF records are accepted without a rustdoc catalogue",
  { skip: !process.env.PROOFS_CRC_RECORDS },
  async () => {
    const records = JSON.parse(
      readFileSync(process.env.PROOFS_CRC_RECORDS!, "utf8"),
    );
    for (const metadata of Object.values(records) as any[]) {
      const { env, db, request } = await fixture();
      recordObjects(env);
      const sarif = JSON.parse(readFileSync(metadata.sarif, "utf8"));
      const r = sarif.runs[0];
      const rid = r.automationDetails.guid;
      const tv = db
        .prepare("SELECT id,version FROM tool_versions WHERE tool_id='aeneas'")
        .get()!;
      assert.equal(tv.version, r.tool.driver.version);
      const prepared = await request("/runs/prepare", "POST", sarif);
      assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
      assert.equal(prepared.body.apis.length, metadata.contracts);
      const upload = await request(`/runs/${rid}/sarif`, "POST", sarif);
      assert.equal(upload.status, 201, JSON.stringify(upload.body));
      const validated = await request("/reports/validate", "POST", {
        ...reportInput,
        crate: r.properties.proofs.crate,
        version: r.properties.proofs.version,
        tool_version_id: tv.id,
        run_ids: [rid],
        claims: upload.body.apis.map((a: any, i: number) => ({
          ...reportInput.claims[0],
          api_item_id: a.api_item_id,
          precondition: "",
          evidence_ref: {
            run_id: rid,
            harness: r.properties.proofs.contracts[i].harness,
          },
        })),
      });
      assert.equal(validated.status, 200, JSON.stringify(validated.body));
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM import_jobs").get()!.n,
        0,
      );
    }
  },
);

test("recorded APIs upgrade to trusted rustdoc metadata without changing IDs or being downgraded by retries", async () => {
  const { env, db, request } = await fixture();
  recordObjects(env);
  const rid = crypto.randomUUID();
  const sarif = callableRecord(rid, ["sample::new_unsafe"]);
  const uploaded = await request(`/runs/${rid}/sarif`, "POST", sarif);
  assert.equal(uploaded.status, 201);
  const id = uploaded.body.apis[0].api_item_id;
  assert.equal((await request(`/apis/${id}`)).status, 404);
  const doc = {
    format_version: 61,
    crate_version: "1.0.0",
    root: 0,
    index: {
      0: { name: "sample", inner: { module: { items: [1] } } },
      1: {
        name: "new_unsafe",
        visibility: "public",
        inner: {
          function: {
            header: { is_unsafe: true, abi: "Rust" },
            generics: { params: [], where_predicates: [] },
            sig: { inputs: [], output: null },
          },
        },
      },
    },
  };
  (env.ARCHIVE as any).get = async () => ({
    text: async () => JSON.stringify(doc),
  });
  await refreshCatalog(env, 1);
  const upgraded = await request(`/apis/${id}`);
  assert.equal(upgraded.status, 200);
  assert.equal(upgraded.body.origin, "rustdoc");
  assert.equal(upgraded.body.is_unsafe, 1);
  assert.match(upgraded.body.signature, /unsafe fn new_unsafe/);
  assert.match(upgraded.body.upstream_url, /docs.rs/);
  const retried = await request(`/runs/${rid}/sarif`, "POST", sarif);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.apis[0].api_item_id, id);
  assert.equal(retried.body.apis[0].origin, "rustdoc");
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM api_item_provenance WHERE api_item_id=?")
      .get(id)!.n,
    0,
  );
});

test(
  "original CRC CLI dry-runs and publications work against the local Worker without imports",
  { skip: !process.env.PROOFS_CRC_PROJECT || !process.env.PROOFS_CRC_RECORDS },
  async () => {
    const { createServer } = await import("node:http");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join, resolve } = await import("node:path");
    const { db, env } = await fixture();
    const objects = recordObjects(env);
    const requested: string[] = [];
    const token = "b".repeat(64);
    db.prepare(
      "INSERT INTO api_tokens VALUES('crc-token','alice',?,'publish',?,NULL,?,NULL)",
    ).run(
      await hash(token),
      new Date().toISOString(),
      new Date(Date.now() + 3600000).toISOString(),
    );
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        requested.push(`${req.method} ${req.url}`);
        const response = await app.request(
          env.APP_ORIGIN + req.url,
          {
            method: req.method,
            headers: req.headers as any,
            ...(bytes.length ? { body: bytes } : {}),
          },
          env,
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    env.APP_ORIGIN = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    const credentials = await mkdtemp(join(tmpdir(), "crc-cli-observations-"));
    await writeFile(
      join(credentials, (await hash(env.APP_ORIGIN)) + ".json"),
      JSON.stringify({
        access_token: token,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const records = JSON.parse(
      readFileSync(process.env.PROOFS_CRC_RECORDS!, "utf8"),
    );
    try {
      for (const [profile, r] of Object.entries(records) as [string, any][]) {
        const args = [
          "proofs",
          "--server",
          env.APP_ORIGIN,
          "publish",
          "--manifest-path",
          join(process.env.PROOFS_CRC_PROJECT!, "Cargo.toml"),
          "--proofs-config",
          `aeneas/profiles/${profile}/proofs.toml`,
          "--run",
          r.run_id,
        ];
        const options = {
          cwd: process.env.PROOFS_CRC_PROJECT,
          env: {
            ...process.env,
            PROOFS_CONFIG_DIR: credentials,
            RUSTUP_TOOLCHAIN: "1.91.1",
          },
          timeout: 60000,
          maxBuffer: 16 * 1024 * 1024,
        };
        const binary =
          process.env.PROOFS_TEST_CLI ??
          resolve("cli/target/debug/cargo-proofs");
        const before = objects.size;
        const dry = await promisify(execFile)(
          binary,
          [...args, "--dry-run"],
          options,
        );
        assert.match(dry.stdout, new RegExp(`${r.contracts} claims`));
        assert.equal(objects.size, before);
        const published = await promisify(execFile)(
          binary,
          [...args, "--yes"],
          options,
        );
        assert.match(published.stdout, /Published|Created|report/i);
      }
      assert.equal(db.prepare("SELECT COUNT(*) n FROM claims").get()!.n, 96);
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM import_jobs").get()!.n,
        0,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM doc_snapshots").get()!.n,
        1,
      );
      assert(requested.some((p) => p === "POST /api/v1/runs/prepare"));
      assert(
        !requested.some(
          (p) => p.includes("/publish/prepare") || p.includes("/resolve-api"),
        ),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(credentials, { recursive: true, force: true });
    }
  },
);

test("recorded Cargo versions preserve build metadata and prereleases", async () => {
  const { request } = await fixture();
  for (const version of ["1.0.0+build.1", "1.0.0-alpha.1+build.1"]) {
    const sarif = callableRecord(crypto.randomUUID(), ["sample::f"]);
    sarif.runs[0].properties.proofs.version = version;
    const prepared = await request("/runs/prepare", "POST", sarif);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  }
});

test("recorded callable syntax is not narrowed by a catalogue name limit", async () => {
  const { request } = await fixture();
  const path = "sample::" + "a".repeat(11000);
  const prepared = await request(
    "/runs/prepare",
    "POST",
    callableRecord(crypto.randomUUID(), [path]),
  );
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  assert.equal(prepared.body.apis[0].display_path, path);
});
