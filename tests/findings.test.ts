import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, reportInput } from "./support/service-fixture";
import { app } from "../src/worker";
import { JSDOM } from "jsdom";
import { hash } from "../src/core";

test("unlinked findings offer issue creation or URL registration and hide the prompt after linking", async () => {
  const { env, request, report, path } = await setup();
  const id = (await request(path, "POST", findingInput)).body.id;
  const html = async (path: string) => {
    const response = await app.request(
      `https://example.test${path}`,
      { headers: { Cookie: "__Host-proofsr_session=alice" } },
      env,
    );
    assert.equal(response.status, 200);
    return new JSDOM(await response.text());
  };
  for (const page of [`/report/${report}`, `/finding/${id}`]) {
    const dom = await html(page);
    const prompt = dom.window.document.querySelector(
      `#finding-${id} .finding-issue-actions`,
    )!;
    assert.ok(prompt.querySelector(`a[href="/finding/${id}/github-issue"]`));
    const register = prompt.querySelector<HTMLAnchorElement>(
      'a[href*="add_issue=1"]',
    )!;
    assert.equal(register.textContent, "Add issue URL");
    const registration = await html(register.getAttribute("href")!);
    const details =
      registration.window.document.querySelector<HTMLDetailsElement>(
        `#finding-link-${id}`,
      )!;
    assert.equal(details.open, true);
    const kind = registration.window.document.querySelector(
      `#finding-link-${id} select[name="kind"]`,
    );
    assert.ok(kind instanceof registration.window.HTMLSelectElement);
    assert.equal(kind.value, "issue");
    assert.ok(details.querySelector('input[name="url"]'));
    registration.window.close();
    dom.window.close();
  }
  const linked = await app.request(
    "https://example.test/_actions/finding-link",
    {
      method: "POST",
      headers: {
        Origin: env.APP_ORIGIN,
        Cookie: "__Host-proofsr_session=alice",
      },
      body: new URLSearchParams({
        _csrf: "csrf",
        _key: crypto.randomUUID(),
        id,
        edit_version: "1",
        kind: "issue",
        url: "https://github.com/upstream/project/issues/123",
        _back: `/finding/${id}`,
      }),
    },
    env,
  );
  assert.equal(linked.status, 303);
  const finding = (await request(`/findings/${id}`)).body;
  assert.equal(finding.links[0].kind, "issue");
  for (const page of [`/report/${report}`, `/finding/${id}`]) {
    const dom = await html(page);
    assert.equal(
      dom.window.document.querySelector(".finding-issue-actions"),
      null,
    );
    dom.window.close();
  }
  assert.equal(
    (
      await request(`/findings/${id}/links/${finding.links[0].id}`, "DELETE", {
        edit_version: finding.edit_version,
      })
    ).status,
    200,
  );
  const restored = await html(`/finding/${id}`);
  assert.ok(restored.window.document.querySelector(".finding-issue-actions"));
  restored.window.close();
});

test("GitHub issue preparation uses the upstream, escapes the draft and leaves Finding state unchanged", async () => {
  const { env, request, report, path } = await setup();
  const input = {
    ...findingInput,
    title: '日本語 <script>alert("title")</script> & quotes',
    body: '\n## Details\n\n```rust\npanic!();\n```\n\n</textarea><script>alert("body")</script>',
    evidence_url: "https://example.test/evidence?a=1&b=2",
  };
  const id = (await request(path, "POST", input)).body.id;
  env.EXTERNAL_FETCH_DISABLED = "true";
  const originalGet = env.ARCHIVE.get.bind(env.ARCHIVE);
  let repository: string | null = "https://github.com/upstream/project.git/";
  Object.assign(env.ARCHIVE, {
    get: async (key: string) =>
      key.startsWith("local-demo/crates.io/repositories/")
        ? { json: async () => ({ name: "sample", repository }) }
        : originalGet(key),
  });
  const html = (url: string, user = "alice") =>
    app.request(
      `https://example.test${url}`,
      { headers: user ? { Cookie: `__Host-proofsr_session=${user}` } : {} },
      env,
    );
  const before = (await request(`/findings/${id}`)).body;
  for (const page of [`/finding/${id}`, `/report/${report}`]) {
    const dom = new JSDOM(await (await html(page)).text());
    assert.ok(
      dom.window.document.querySelector(
        `a[href="/finding/${id}/github-issue"]`,
      ),
    );
    dom.window.close();
  }
  for (const hasTemplates of [false, true, null]) {
    const previousGet = env.ARCHIVE.get.bind(env.ARCHIVE);
    Object.assign(env.ARCHIVE, {
      get: async (key: string) =>
        key.startsWith("local-demo/github/issue-templates/")
          ? { json: async () => ({ hasTemplates }) }
          : previousGet(key),
    });
    const response = await html(`/finding/${id}/github-issue`);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    if (hasTemplates === null) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Location"), null);
      const dom = new JSDOM(await response.text());
      const document = dom.window.document;
      assert.match(
        document.querySelector('[role="alert"]')!.textContent!,
        /Unable to check/,
      );
      assert.equal(
        document.querySelector<HTMLInputElement>("#issue-title")!.value,
        input.title,
      );
      const body =
        document.querySelector<HTMLTextAreaElement>("#issue-body")!.value;
      assert.ok(body.startsWith(before.body));
      assert.ok(body.includes(`https://example.test/report/${report}?v=1`));
      assert.equal(
        document.querySelectorAll("[data-issue-draft] script").length,
        0,
      );
      assert.equal(
        [...document.querySelectorAll("a")]
          .find((a) => a.textContent === "Retry template lookup")!
          .getAttribute("href"),
        `/finding/${id}/github-issue`,
      );
      const link = new URL(
        document.querySelector<HTMLAnchorElement>('a[href*="/issues/new"]')!
          .href,
      );
      assert.equal(link.pathname, "/upstream/project/issues/new/choose");
      assert.equal(link.searchParams.has("body"), false);
      dom.window.close();
      assert.deepEqual((await request(`/findings/${id}`)).body, before);
      continue;
    }
    assert.equal(response.status, 302);
    const url = new URL(response.headers.get("Location")!);
    assert.equal(url.origin, "https://github.com");
    assert.equal(
      url.pathname,
      hasTemplates === false
        ? "/upstream/project/issues/new"
        : "/upstream/project/issues/new/choose",
    );
    assert.equal(url.searchParams.get("title"), input.title);
    if (hasTemplates === false) {
      const body = url.searchParams.get("body")!;
      assert.ok(body.startsWith(before.body));
      assert.ok(body.includes(`https://example.test/report/${report}?v=1`));
      assert.ok(!body.includes(input.evidence_url));
    } else assert.equal(url.searchParams.has("body"), false);
    assert.deepEqual((await request(`/findings/${id}`)).body, before);
  }
  for (const value of [null, "https://gitlab.com/upstream/project"]) {
    repository = value;
    assert.equal((await html(`/finding/${id}/github-issue`)).status, 404);
    for (const page of [`/finding/${id}`, `/report/${report}`]) {
      const dom = new JSDOM(await (await html(page)).text());
      assert.equal(
        dom.window.document.querySelector('a[href$="/github-issue"]'),
        null,
      );
      dom.window.close();
    }
  }
});

test("GitHub issue preparation enforces authorship, visibility and withdrawal before repository lookup", async () => {
  const { db, env, request, report, path } = await setup();
  const id = (await request(path, "POST", findingInput)).body.id;
  let lookups = 0;
  const originalGet = env.ARCHIVE.get.bind(env.ARCHIVE);
  Object.assign(env.ARCHIVE, {
    get: async (key: string) => {
      if (key.includes("/repositories/")) lookups++;
      return originalGet(key);
    },
  });
  const page = (user: string, suffix = "/github-issue") =>
    app.request(
      `https://example.test/finding/${id}${suffix}`,
      { headers: user ? { Cookie: `__Host-proofsr_session=${user}` } : {} },
      env,
    );
  assert.equal((await page("bob")).status, 403);
  const anonymous = await page("");
  assert.equal(anonymous.status, 200);
  const anonymousHTML = await anonymous.text();
  assert.match(anonymousHTML, /Sign in/);
  assert.doesNotMatch(anonymousHTML, /id="issue-body"/);
  for (const user of ["bob", ""])
    assert.doesNotMatch(
      await (await page(user, "")).text(),
      /Create GitHub issue/,
    );
  db.prepare("UPDATE reports SET withdrawn_at='2026-10-26' WHERE id=?").run(
    report,
  );
  assert.equal((await page("alice")).status, 409);
  assert.doesNotMatch(
    await (await page("alice", "")).text(),
    /Create GitHub issue/,
  );
  db.prepare("UPDATE reports SET visibility='hidden' WHERE id=?").run(report);
  assert.equal((await page("alice")).status, 404);
  assert.equal(lookups, 0);
});

test("long Issue drafts retain the complete body and title for copying", async () => {
  const { env, request, path } = await setup();
  const body = "日本語".repeat(3000);
  const id = (await request(path, "POST", { ...findingInput, body })).body.id;
  env.EXTERNAL_FETCH_DISABLED = "true";
  Object.assign(env.ARCHIVE, {
    get: async (key: string) => ({
      json: async () =>
        key.includes("/issue-templates/")
          ? { hasTemplates: false }
          : {
              name: "sample",
              repository: "https://github.com/upstream/project",
            },
    }),
  });
  const page = async () => {
    const response = await app.request(
      `https://example.test/finding/${id}/github-issue`,
      { headers: { Cookie: "__Host-proofsr_session=alice" } },
      env,
    );
    assert.equal(response.status, 200);
    return new JSDOM(await response.text());
  };
  let dom = await page();
  assert.match(dom.window.document.body.textContent!, /body is too long/);
  assert.ok(
    dom.window.document
      .querySelector<HTMLTextAreaElement>("#issue-body")!
      .value.startsWith(body),
  );
  let link = dom.window.document.querySelector<HTMLAnchorElement>(
    'a[href*="/issues/new"]',
  )!;
  assert.equal(
    new URL(link.href).searchParams.get("title"),
    findingInput.title,
  );
  assert.equal(new URL(link.href).searchParams.has("body"), false);
  dom.window.close();
  const title = "日".repeat(1000);
  assert.equal(
    (await request(`/findings/${id}`, "PATCH", { edit_version: 1, title }))
      .status,
    200,
  );
  dom = await page();
  assert.equal(
    dom.window.document.querySelector<HTMLInputElement>("#issue-title")!.value,
    title,
  );
  link = dom.window.document.querySelector<HTMLAnchorElement>(
    'a[href*="/issues/new"]',
  )!;
  assert.equal(link.href, "https://github.com/upstream/project/issues/new");
  dom.window.close();
});

const findingInput = {
  title: "Incorrect empty input result",
  body: "Expected an empty result, but `safe()` panics on empty input.",
  api_item_ids: ["safe"],
};
async function setup() {
  const f = await fixture();
  const p = await f.request("/reports", "POST", reportInput);
  assert.equal(p.status, 201);
  return { ...f, report: p.body.id, path: `/reports/${p.body.id}/findings` };
}

test("finding lifecycle: idempotency, ownership, history, status evidence, soft delete and independent revisions", async () => {
  const { db, request, report, path } = await setup();
  assert.equal((await request(path, "POST", findingInput, "bob")).status, 403);
  assert.equal(
    (await request(path, "POST", { ...findingInput, body: "" })).status,
    400,
  );
  assert.equal(
    (
      await request(path, "POST", {
        ...findingInput,
        evidence_url: "javascript:alert(1)",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(path, "POST", {
        ...findingInput,
        evidence_url: "https://user:pass@example.test",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(path, "POST", {
        ...findingInput,
        api_item_ids: ["missing"],
      })
    ).status,
    400,
  );
  const headers = { "Idempotency-Key": crypto.randomUUID() };
  const added = await request(path, "POST", findingInput, "alice", headers);
  assert.equal(added.status, 201);
  assert.deepEqual(
    await request(path, "POST", findingInput, "alice", headers),
    added,
  );
  assert.equal(
    (
      await request(
        path,
        "POST",
        { ...findingInput, title: "changed" },
        "alice",
        headers,
      )
    ).status,
    409,
  );
  const url = `/findings/${added.body.id}`;
  let f = (await request(url)).body;
  assert.equal(f.origin_revision_no, 1);
  assert.equal(f.events.length, 1);
  assert.equal(f.apis[0].id, "safe");
  assert.equal((await request(url, "GET", undefined, "")).status, 200);
  assert.equal(
    (await request(url, "PATCH", { edit_version: 1, title: "edited" }, "bob"))
      .status,
    403,
  );
  assert.equal(
    (
      await request(url, "PATCH", {
        edit_version: 1,
        upstream_status: "fix_proposed",
      })
    ).status,
    409,
  );
  assert.equal((await request(url)).body.events.length, 1);
  assert.equal(
    (
      await request(url, "PATCH", {
        edit_version: 1,
        title: "edited",
        validity: "confirmed",
      })
    ).status,
    200,
  );
  assert.equal(
    (await request(url, "PATCH", { edit_version: 1, title: "stale" })).status,
    409,
  );
  const linkHeaders = { "Idempotency-Key": crypto.randomUUID() };
  const linkBody = {
    edit_version: 2,
    kind: "pr",
    url: "https://github.com/example/crate/pull/1",
  };
  const link = await request(
    url + "/links",
    "POST",
    linkBody,
    "alice",
    linkHeaders,
  );
  assert.equal(link.status, 201);
  assert.deepEqual(
    await request(url + "/links", "POST", linkBody, "alice", linkHeaders),
    link,
  );
  assert.equal(
    (
      await request(url + "/links", "POST", {
        ...linkBody,
        url: "https://example.test/stale",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(url, "PATCH", {
        edit_version: 3,
        upstream_status: "fix_proposed",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(url + "/links/" + link.body.id, "DELETE", {
        edit_version: 4,
      })
    ).status,
    409,
  );
  f = (await request(url)).body;
  assert.equal(f.edit_version, 4);
  assert.equal(f.links.length, 1);
  assert.equal(f.events.length, 4);
  assert.equal(
    (
      await request(url, "PATCH", {
        edit_version: 4,
        upstream_status: "not_reported",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(url + "/links/" + link.body.id, "DELETE", {
        edit_version: 5,
      })
    ).status,
    200,
  );
  f = (await request(url)).body;
  assert.equal(f.links.length, 0);
  assert.equal(f.events.length, 6);
  assert.equal(f.events[5].action, "link_deleted");
  assert.ok(
    db
      .prepare("SELECT deleted_at FROM finding_links WHERE id=?")
      .get(link.body.id)?.deleted_at,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM report_revisions WHERE report_id=?")
      .get(report)?.n,
    1,
  );
  assert.equal((await request(path)).body.items.length, 1);
  assert.equal(
    (await request("/crates/sample/1.0.0/findings")).body.items.length,
    1,
  );
  assert.equal(
    (await request(`/reports/${report}/withdrawal`, "PUT")).status,
    200,
  );
  assert.equal((await request(path, "POST", findingInput)).status, 409);
  assert.equal(
    (await request(url, "PATCH", { edit_version: 6, title: "withdrawn" }))
      .status,
    409,
  );
  assert.equal(
    (await request(url + "/links", "POST", { ...linkBody, edit_version: 6 }))
      .status,
    409,
  );
  assert.equal(
    (
      await request(url + "/links/" + link.body.id, "DELETE", {
        edit_version: 6,
      })
    ).status,
    409,
  );
  assert.equal((await request(url)).status, 200);
  assert.equal(
    (await request("/crates/sample/1.0.0/findings")).body.items.length,
    0,
  );
  db.prepare("UPDATE reports SET visibility='hidden' WHERE id=?").run(report);
  assert.equal((await request(url)).status, 404);
  assert.equal((await request(path)).status, 404);
});

test("duplicate chains reject cycles and invalid/duplicate findings stay out of crate lists", async () => {
  const { db, request, path } = await setup();
  const a = (await request(path, "POST", findingInput)).body.id;
  const b = (await request(path, "POST", findingInput)).body.id;
  const c = (await request(path, "POST", findingInput)).body.id;
  assert.equal(
    (
      await request(`/findings/${a}`, "PATCH", {
        edit_version: 1,
        validity: "duplicate",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/findings/${a}`, "PATCH", {
        edit_version: 1,
        validity: "duplicate",
        duplicate_of: a,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/findings/${a}`, "PATCH", {
        edit_version: 1,
        validity: "duplicate",
        duplicate_of: "missing",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/findings/${a}`, "PATCH", {
        edit_version: 1,
        validity: "duplicate",
        duplicate_of: b,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/findings/${b}`, "PATCH", {
        edit_version: 1,
        validity: "duplicate",
        duplicate_of: c,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/findings/${c}`, "PATCH", {
        edit_version: 1,
        validity: "duplicate",
        duplicate_of: a,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/findings/${c}`, "PATCH", {
        edit_version: 1,
        validity: "invalid",
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("/crates/sample/1.0.0/findings")).body.items.length,
    0,
  );
  assert.equal((await request(path)).body.items.length, 3);
  assert.throws(
    () =>
      db
        .prepare("UPDATE finding_events SET payload='{}' WHERE finding_id=?")
        .run(a),
    /immutable/,
  );
});

test("initial findings validate and commit atomically with claims and successful runs", async () => {
  const { db, request } = await fixture();
  const input = { ...reportInput, findings: [findingInput] };
  assert.equal(
    (await request("/reports/validate", "POST", input)).body.findings[0].title,
    findingInput.title,
  );
  const h = { "Idempotency-Key": crypto.randomUUID() };
  const created = await request("/reports", "POST", input, "alice", h);
  assert.equal(created.status, 201);
  assert.deepEqual(
    await request("/reports", "POST", input, "alice", h),
    created,
  );
  const findings = (await request(`/reports/${created.body.id}/findings`)).body
    .items;
  assert.equal(findings.length, 1);
  assert.equal(findings[0].origin_revision_no, 1);
  for (const body of [
    { ...input, claims: [] },
    { ...input, run_ids: [] },
    { ...input, findings: [{ ...findingInput, body: "" }] },
    { ...input, findings: [{ ...findingInput, api_item_ids: ["foreign"] }] },
  ]) {
    assert.equal(
      (await request("/reports/validate", "POST", body)).status,
      400,
    );
    assert.equal((await request("/reports", "POST", body)).status, 400);
  }
  assert.equal(
    (
      await request(`/reports/${created.body.id}/revisions`, "POST", {
        ...input,
        expected_revision: 1,
      })
    ).status,
    400,
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reports").get()?.n, 1);
  // Force a failure after the Report and Claim inserts to check rollback.
  db.exec(
    "CREATE TRIGGER reject_finding BEFORE INSERT ON findings BEGIN SELECT RAISE(ABORT,'constraint_test_finding'); END;",
  );
  assert.equal((await request("/reports", "POST", input)).status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reports").get()?.n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM claims").get()?.n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM findings").get()?.n, 1);
});

test("release and revalidation links require explicit version and actual same-crate Report", async () => {
  const { request, path, report } = await setup();
  const id = (await request(path, "POST", findingInput)).body.id;
  const p = `/findings/${id}`;
  assert.equal(
    (
      await request(p + "/links", "POST", {
        edit_version: 1,
        kind: "release",
        url: "https://example.test/release",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(p + "/links", "POST", {
        edit_version: 1,
        kind: "release",
        version: "1.0.1",
        url: "https://example.test/release",
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await request(p, "PATCH", {
        edit_version: 2,
        upstream_status: "released",
      })
    ).status,
    200,
  );
  const revalidation = {
    edit_version: 3,
    kind: "report",
    target_report_id: report,
    target_revision_no: 1,
    url: `https://example.test/report/${report}?v=1`,
  };
  assert.equal(
    (
      await request(p + "/links", "POST", {
        ...revalidation,
        target_revision_no: 2,
        url: `https://example.test/report/${report}?v=2`,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(p + "/links", "POST", {
        ...revalidation,
        url: "https://example.test/other",
      })
    ).status,
    400,
  );
  assert.equal((await request(p + "/links", "POST", revalidation)).status, 201);
});

test("Report and crate pages render findings, owner forms, safe links and current information on past revisions", async () => {
  const { request, env, path, report } = await setup();
  const id = (
    await request(path, "POST", {
      ...findingInput,
      title: '<script>alert("x")</script>',
    })
  ).body.id;
  await request(`/findings/${id}/links`, "POST", {
    edit_version: 1,
    kind: "issue",
    url: "https://example.test/issue",
  });
  assert.equal(
    (
      await request(`/reports/${report}/revisions`, "POST", {
        ...reportInput,
        expected_revision: 1,
        explanation: "Overview text",
      })
    ).status,
    201,
  );
  const html = async (path: string, signedIn = true) => {
    const r = await app.request(
      `https://example.test${path}`,
      { headers: signedIn ? { Cookie: "__Host-proofsr_session=alice" } : {} },
      env,
    );
    assert.equal(r.status, 200);
    return new JSDOM(await r.text());
  };
  let dom = await html(`/report/${report}`);
  let d = dom.window.document;
  assert.equal(
    d.querySelector(".report-explanation")?.nextElementSibling?.id,
    "findings",
  );
  assert.match(
    d.querySelector(".report-outcome")!.textContent!,
    /1 verified claim · 1 finding\b/,
  );
  assert.equal(
    d.querySelector(`#finding-${id} h3`)!.textContent,
    '<script>alert("x")</script>',
  );
  assert.equal(d.querySelectorAll("#findings script").length, 0);
  assert.ok(d.querySelector('form[action="/_actions/finding"]'));
  assert.equal(d.querySelector(".finding .markdown-body"), null);
  assert.equal(d.querySelector('form[action="/_actions/edit-finding"]'), null);
  assert.ok(d.querySelector("#discussion"));
  assert.ok(d.querySelector(".report-apis"));
  dom.window.close();
  dom = await html(`/finding/${id}`);
  d = dom.window.document;
  assert.ok(d.querySelector('form[action="/_actions/edit-finding"]'));
  assert.ok(d.querySelector('form[action="/_actions/finding-link"]'));
  assert.equal(
    d.querySelector(".finding-links a")!.getAttribute("rel"),
    "noopener noreferrer",
  );
  dom.window.close();
  dom = await html(`/report/${report}?v=1`, false);
  assert.match(
    dom.window.document.querySelector("#findings")!.textContent!,
    /current information/,
  );
  assert.equal(
    dom.window.document.querySelector('form[action="/_actions/finding"]'),
    null,
  );
  dom.window.close();
  dom = await html(`/finding/${id}`, false);
  assert.match(dom.window.document.body.textContent!, /link_added/);
  dom.window.close();
  dom = await html("/crate/sample?version=1.0.0", false);
  assert.equal(
    dom.window.document.querySelector("#findings")!.textContent,
    "Findings (1)",
  );
  // The catalogue marks the API the finding names, for the "With findings" filter.
  const row = dom.window.document.querySelector(
    '[data-api-path="sample::safe"]',
  )!;
  assert.equal(row.getAttribute("data-findings"), "1");
  assert.match(row.textContent!, /1 finding\b/);
  dom.window.close();
});

test("HTML finding forms preserve authentication, CSRF, API selection and optimistic versions", async () => {
  const { request, env, db, report } = await setup();
  const post = async (
    action: string,
    fields: Record<string, string>,
    csrf = "csrf",
  ) =>
    app.request(
      `https://example.test/_actions/${action}`,
      {
        method: "POST",
        headers: {
          Origin: env.APP_ORIGIN,
          Cookie: "__Host-proofsr_session=alice",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          _csrf: csrf,
          _key: crypto.randomUUID(),
          _back: `/report/${report}#findings`,
          ...fields,
        }),
      },
      env,
    );
  const fields = {
    id: String(report),
    title: "Via form",
    body: "A **useful observation**.",
    api_item_ids: "safe",
  };
  assert.equal((await post("finding", fields, "wrong")).status, 403);
  assert.equal((await post("finding", fields)).status, 303);
  const f = db.prepare("SELECT * FROM findings WHERE report_id=?").get(report)!;
  assert.equal(f.title, "Via form");
  assert.equal(
    db
      .prepare("SELECT api_item_id FROM finding_apis WHERE finding_id=?")
      .get(f.id)?.api_item_id,
    "safe",
  );
  assert.equal(
    (
      await post("edit-finding", {
        ...fields,
        id: String(f.id),
        edit_version: "1",
        validity: "confirmed",
        upstream_status: "not_reported",
        api_ids: "safe, unsafe",
      })
    ).status,
    303,
  );
  assert.equal(
    (
      await post("finding-link", {
        id: String(f.id),
        edit_version: "2",
        kind: "issue",
        url: "https://example.test/issue",
      })
    ).status,
    303,
  );
  const link = (await request(`/findings/${f.id}`)).body.links[0];
  assert.equal(
    (
      await post("delete-finding-link", {
        id: String(f.id),
        edit_version: "2",
        link_id: link.id,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await post("delete-finding-link", {
        id: String(f.id),
        edit_version: "3",
        link_id: link.id,
      })
    ).status,
    303,
  );
  assert.equal((await request(`/findings/${f.id}`)).body.events.length, 4);
});

test("finding writes recheck account, withdrawal and version inside the transaction", async () => {
  const { request, env, db, path, report } = await setup();
  const id = (await request(path, "POST", findingInput)).body.id;
  const p = `/findings/${id}`;
  const original = env.DB.batch.bind(env.DB);
  // Mutate after route preflight but immediately before the write batch.
  const race = (sql: string) => {
    env.DB.batch = async (statements) => {
      env.DB.batch = original;
      db.exec(sql);
      return original(statements);
    };
  };
  race(`UPDATE findings SET edit_version=2 WHERE id='${id}'`);
  assert.equal(
    (await request(p, "PATCH", { edit_version: 1, title: "stale race" }))
      .status,
    409,
  );
  assert.equal(
    db.prepare("SELECT title FROM findings WHERE id=?").get(id)?.title,
    findingInput.title,
  );
  race(`UPDATE reports SET withdrawn_at='withdrawn' WHERE id=${report}`);
  assert.equal(
    (
      await request(p + "/links", "POST", {
        edit_version: 2,
        kind: "issue",
        url: "https://example.test/issue",
      })
    ).status,
    409,
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM finding_links").get()?.n, 0);
  db.prepare("UPDATE reports SET withdrawn_at=NULL WHERE id=?").run(report);
  race("UPDATE users SET status='suspended' WHERE id='alice'");
  assert.equal((await request(path, "POST", findingInput)).status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM findings").get()?.n, 1);
});

test("version membership, finding pagination, stable Report anchors and account erasure", async () => {
  const { request, db, path, report, env } = await setup();
  db.exec(
    "INSERT INTO releases VALUES(2,1,'2.0.0','checksum',0,'now'); INSERT INTO api_items VALUES('other-version',2,'sample::new','sample::new','function',0,'pub fn new()','https://docs.rs');",
  );
  assert.equal(
    (
      await request(path, "POST", {
        ...findingInput,
        api_item_ids: ["other-version"],
      })
    ).status,
    400,
  );
  const ids = [];
  for (let n = 0; n < 32; n++) {
    const r = await request(path, "POST", {
      ...findingInput,
      title: `finding ${n}`,
    });
    assert.equal(r.status, 201);
    ids.push(r.body.id);
  }
  const first = (await request(path)).body;
  assert.equal(first.items.length, 30);
  const second = (
    await request(path + "?cursor=" + encodeURIComponent(first.next_cursor))
  ).body;
  assert.equal(second.items.length, 2);
  assert.equal(
    new Set([...first.items, ...second.items].map((f) => f.id)).size,
    32,
  );
  assert.equal(
    (await request("/crates/sample/2.0.0/findings")).body.items.length,
    0,
  );
  const r = await app.request(`https://example.test/report/${report}`, {}, env);
  assert.equal(r.status, 200);
  const dom = new JSDOM(await r.text());
  for (const id of ids)
    assert.ok(dom.window.document.getElementById(`finding-${id}`));
  dom.window.close();
  assert.equal(
    (
      await request(`/findings/${ids[0]}`, "PATCH", {
        edit_version: 1,
        api_item_ids: ["other-version"],
      })
    ).status,
    400,
  );
  // The immutable history must allow foreign-key anonymization during erasure.
  const erased = await request(
    "/admin/action",
    "POST",
    { action: "delete_user", target: "alice", reason: "Requested deletion" },
    "admin",
  );
  assert.equal(erased.status, 200);
  assert.equal(
    (await request(`/findings/${ids[0]}`)).body.events[0].actor_id,
    null,
  );
});

test("publish tokens operate Finding APIs with author checks and HTTPS validation", async () => {
  const { db, env, report, request, path } = await setup();
  const time = new Date().toISOString();
  db.prepare("INSERT INTO api_tokens VALUES(?,?,?,?,?,NULL,?,NULL)").run(
    "finding-token",
    "alice",
    await hash("f".repeat(64)),
    "publish",
    time,
    new Date(Date.now() + 86400000).toISOString(),
  );
  const bearer = async (path: string, method = "GET", body?: unknown) => {
    const response = await app.request(
      `https://example.test/api/v1${path}`,
      {
        method,
        headers: {
          Authorization: "Bearer " + "f".repeat(64),
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  const created = await bearer(path, "POST", findingInput);
  assert.equal(created.status, 201);
  const p = `/findings/${created.body.id}`;
  assert.equal((await bearer(p)).status, 200);
  assert.equal(
    (await bearer(p, "PATCH", { edit_version: 1, title: "Token edit" })).status,
    200,
  );
  const link = await bearer(p + "/links", "POST", {
    edit_version: 2,
    kind: "issue",
    url: "https://example.test/token-issue",
  });
  assert.equal(link.status, 201);
  assert.equal(
    (await bearer(p + "/links/" + link.body.id, "DELETE", { edit_version: 3 }))
      .status,
    200,
  );
  for (const url of [
    "not a URL",
    "http://example.test",
    "javascript:alert(1)",
  ]) {
    assert.equal(
      (await request(path, "POST", { ...findingInput, evidence_url: url }))
        .status,
      400,
    );
    assert.equal(
      (
        await bearer(p + "/links", "POST", {
          edit_version: 4,
          kind: "issue",
          url,
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (await bearer(`/reports/${report}/withdrawal`, "PUT")).status,
    403,
  );
});

test("Markdown body is the only required prose, supports observations, and has bounded input", async () => {
  const { request, path, report, db, env } = await setup();
  const input = {
    title: "A useful precondition",
    body: "# Scope\n\nRequires **nonempty** input.\n\n```rust\nassert!(!input.is_empty());\n```\n\n[Discussion](https://example.test/issue)\n\n<script>bad()</script>\n\n[bad](javascript:alert(1))",
  };
  for (const invalid of [
    { ...input, title: " " },
    { ...input, body: " " },
    { ...input, title: "a".repeat(1001) },
    { ...input, body: "a".repeat(10001) },
    { title: input.title },
    { ...input, expected_behavior: "legacy" },
  ])
    assert.equal((await request(path, "POST", invalid)).status, 400);
  const id = (await request(path, "POST", input)).body.id;
  const detail = (await request(`/findings/${id}`)).body;
  assert.equal(detail.body, input.body);
  assert.equal(JSON.parse(detail.events[0].payload).body, input.body);
  const r = await app.request(`https://example.test/finding/${id}`, {}, env);
  const dom = new JSDOM(await r.text()),
    d = dom.window.document;
  const finding = d.querySelector(`#finding-${id}`)!;
  assert.equal(finding.querySelector("h4")?.textContent, "Scope");
  assert.equal(finding.querySelector("strong")?.textContent, "nonempty");
  assert.match(finding.querySelector("pre code")!.textContent!, /assert!/);
  assert.equal(
    finding.querySelectorAll("script, a[href^='javascript:']").length,
    0,
  );
  assert.doesNotMatch(
    finding.querySelector(".meta")!.textContent!,
    /not_reported|author reported/,
  );
  dom.window.close();
  assert.equal(
    (
      await request(`/findings/${id}`, "PATCH", {
        edit_version: 1,
        body: "Updated **observation**",
      })
    ).status,
    200,
  );
  assert.equal(
    (await request(`/findings/${id}`)).body.body,
    "Updated **observation**",
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM report_revisions WHERE report_id=?")
      .get(report)?.n,
    1,
  );
  assert.equal(
    (
      await request("/reports/validate", "POST", {
        ...reportInput,
        findings: Array(21).fill(input),
      })
    ).status,
    400,
  );
});

test("body migration preserves origin, links, APIs and immutable history without truncation", async () => {
  const { readFileSync } = await import("node:fs");
  const { request, db, env } = await fixture(true, "0011_findings.sql");
  // The running server requires the current observation-provenance tables;
  // leave the finding-body migration unapplied for this historical fixture.
  db.exec(
    readFileSync(
      new URL("../migrations/0016_recorded_apis.sql", import.meta.url),
      "utf8",
    ),
  );
  const report = (await request("/reports", "POST", reportInput)).body.id;
  const expected = "x".repeat(10000),
    actual = "y".repeat(10000),
    repro = "z".repeat(10000);
  const payload = JSON.stringify({
    title: "Legacy",
    expected_behavior: expected,
    actual_behavior: actual,
    reproduction_steps: repro,
  });
  db.prepare(
    "INSERT INTO findings(id,report_id,origin_revision_no,title,expected_behavior,actual_behavior,reproduction_steps,created_at,updated_at) VALUES('legacy',?,1,'Legacy',?,?,?,'2026-10-23','2026-10-23')",
  ).run(report, expected, actual, repro);
  db.exec(
    "INSERT INTO finding_apis VALUES('legacy','safe'); INSERT INTO finding_links VALUES('legacy-link','legacy','issue','https://example.test/issue',NULL,NULL,NULL,'2026-10-23',NULL)",
  );
  db.prepare(
    "INSERT INTO finding_events VALUES('legacy-event','legacy',1,'alice','created',?,'2026-10-23')",
  ).run(payload);
  db.exec(
    readFileSync(
      new URL("../migrations/0012_finding_body.sql", import.meta.url),
      "utf8",
    ),
  );
  const f = (await request("/findings/legacy")).body;
  assert.equal(
    f.body,
    `## Expected behavior\n\n${expected}\n\n## Actual behavior\n\n${actual}\n\n## Reproduction steps\n\n${repro}`,
  );
  assert.equal(f.origin_revision_no, 1);
  assert.equal(f.edit_version, 1);
  assert.equal(f.updated_at, "2026-10-23");
  assert.equal(f.links[0].id, "legacy-link");
  assert.equal(f.apis[0].id, "safe");
  assert.equal(f.events[0].payload, payload);
  assert.throws(
    () =>
      db.exec("UPDATE finding_events SET payload='{}' WHERE id='legacy-event'"),
    /immutable/,
  );
  assert.throws(
    () => db.exec("UPDATE findings SET origin_revision_no=2 WHERE id='legacy'"),
    /immutable/,
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(
    (
      await request("/findings/legacy", "PATCH", {
        edit_version: 1,
        validity: "confirmed",
      })
    ).status,
    200,
  );
  assert.equal((await request("/findings/legacy")).body.body, f.body);
  // The running application expects the current Run projection schema too.
  db.exec(
    readFileSync(
      new URL("../migrations/0014_run_toolchain.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(
    readFileSync(
      new URL("../migrations/0018_catalog_warnings.sql", import.meta.url),
      "utf8",
    ),
  );
  // Submit the actual rendered form, including unchanged migrated prose.
  const page = await app.request(
    `https://example.test/finding/legacy`,
    {
      headers: { Cookie: "__Host-proofsr_session=alice" },
    },
    env,
  );
  assert.equal(page.status, 200);
  const dom = new JSDOM(await page.text());
  const form = dom.window.document.querySelector<HTMLFormElement>(
    'form[action="/_actions/edit-finding"]',
  )!;
  const fields = new URLSearchParams(
    Array.from(new dom.window.FormData(form).entries()).map(([key, value]) => [
      key,
      String(value),
    ]),
  );
  dom.window.close();
  assert.ok(fields.get("body")!.length > 10000);
  fields.set("validity", "disputed");
  // Browsers normalize textarea line breaks when submitting a form.
  fields.set("body", fields.get("body")!.replace(/\n/g, "\r\n"));
  const submit = () =>
    app.request(
      "https://example.test/_actions/edit-finding",
      {
        method: "POST",
        headers: {
          Origin: env.APP_ORIGIN,
          Cookie: "__Host-proofsr_session=alice",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: fields.toString(),
      },
      env,
    );
  assert.equal((await submit()).status, 303);
  const edited = (await request("/findings/legacy")).body;
  assert.equal(edited.validity, "disputed");
  assert.equal(edited.edit_version, 3);
  assert.equal(edited.body, f.body);
  assert.equal(
    Object.hasOwn(JSON.parse(edited.events.at(-1).payload), "body"),
    false,
  );
  // Stale forms must not overwrite intervening edits.
  assert.equal((await submit()).status, 409);
  fields.set("edit_version", "3");
  fields.set("body", fields.get("body")! + "Changed");
  assert.equal((await submit()).status, 400);
  fields.set("body", "A corrected **short** body.");
  assert.equal((await submit()).status, 303);
  assert.equal(
    (await request("/findings/legacy")).body.body,
    "A corrected **short** body.",
  );
  fields.set("body", f.body);
  assert.equal((await submit()).status, 409);
  assert.equal(
    (await request("/findings/legacy")).body.body,
    "A corrected **short** body.",
  );
});

for (const view of ["detail", "report", "crate"] as const) {
  test(`finding ${view} reads keep content, APIs, links and history in one snapshot`, async () => {
    const { request, db, env, path } = await setup();
    const id = (await request(path, "POST", findingInput)).body.id;
    await request(`/findings/${id}/links`, "POST", {
      edit_version: 1,
      kind: "issue",
      url: "https://example.test/before",
    });
    let changed = false;
    const change = () => {
      if (changed) return;
      changed = true;
      db.prepare(
        "UPDATE findings SET title='After',body='After body',edit_version=3 WHERE id=?",
      ).run(id);
      db.prepare("DELETE FROM finding_apis WHERE finding_id=?").run(id);
      db.prepare("INSERT INTO finding_apis VALUES(?,'unsafe')").run(id);
      db.prepare(
        "UPDATE finding_links SET deleted_at='2026-10-23' WHERE finding_id=?",
      ).run(id);
      db.prepare(
        "INSERT INTO finding_events VALUES('concurrent-edit',?,3,'alice','edited','{}','2026-10-23')",
      ).run(id);
    };
    // Simulate a committed writer immediately after the row query returns.
    // A split hydration read would then see the new APIs, links and events.
    const prepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql.includes("FROM findings f")) {
        const first = statement.first.bind(statement);
        statement.first = async <T = Record<string, unknown>>(
          columnName?: string,
        ) => {
          const result =
            columnName === undefined
              ? await first<T>()
              : await first<T>(columnName);
          change();
          return result;
        };
        const all = statement.all.bind(statement);
        statement.all = async <T = Record<string, unknown>>() => {
          const result = await all<T>();
          change();
          return result;
        };
      }
      return statement;
    };
    const url =
      view === "detail"
        ? `/findings/${id}`
        : view === "report"
          ? path
          : "/crates/sample/1.0.0/findings";
    const response = await request(url);
    assert.equal(response.status, 200);
    assert.equal(changed, true);
    const f = view === "detail" ? response.body : response.body.items[0];
    assert.equal(f.edit_version, 2);
    assert.equal(f.title, findingInput.title);
    assert.equal(f.body, findingInput.body);
    assert.deepEqual(
      f.apis.map((a: any) => a.id),
      ["safe"],
    );
    assert.deepEqual(
      f.links.map((l: any) => l.url),
      ["https://example.test/before"],
    );
    if (view === "detail") assert.equal(f.events.at(-1).edit_version, 2);
    const latest = (await request(`/findings/${id}`)).body;
    assert.equal(latest.edit_version, 3);
    assert.equal(latest.title, "After");
    assert.deepEqual(
      latest.apis.map((a: any) => a.id),
      ["unsafe"],
    );
    assert.equal(latest.links.length, 0);
    assert.equal(latest.events.at(-1).edit_version, 3);
  });
}

test("crate findings summary stays version scoped, compact, filtered and paginated", async () => {
  const { request, db, env, report, path } = await setup();
  const ids: string[] = [];
  for (let n = 0; n < 33; n++) {
    ids.push(
      (
        await request(path, "POST", {
          title: `Observation ${n}`,
          body: "Full details stay on the Report.",
        })
      ).body.id,
    );
  }
  await request(`/findings/${ids[31]}`, "PATCH", {
    edit_version: 1,
    validity: "invalid",
  });
  await request(`/findings/${ids[32]}`, "PATCH", {
    edit_version: 1,
    validity: "duplicate",
    duplicate_of: ids[0],
  });
  await request(`/findings/${ids[0]}/links`, "POST", {
    edit_version: 1,
    kind: "release",
    url: "https://example.test/release",
    version: "1.0.1",
  });
  await request(`/findings/${ids[0]}`, "PATCH", {
    edit_version: 2,
    validity: "confirmed",
    upstream_status: "released",
    title: "<script>unsafe title</script>",
  });
  // Additional public versions and inaccessible reports must not inflate counts.
  db.exec("INSERT INTO releases VALUES(2,1,'2.0.0','checksum',0,'2026-10-23')");
  for (const [id, release, visibility, withdrawn] of [
    [100, 2, "public", null],
    [101, 1, "hidden", null],
    [102, 1, "public", "2026-10-23"],
  ] as const) {
    db.prepare(
      "INSERT INTO reports(id,create_key,release_id,author_id,created_at,updated_at,visibility,withdrawn_at) VALUES(?,?,?,'alice','2026-10-23','2026-10-23',?,?)",
    ).run(id, `summary-${id}`, release, visibility, withdrawn);
    db.prepare(
      "INSERT INTO report_revisions SELECT ?,revision_no,title,explanation,trusted_assumptions,tool_version_id,environment,evidence_url,limitations,created_at FROM report_revisions WHERE report_id=?",
    ).run(id, report);
    db.prepare(
      "INSERT INTO findings(id,report_id,origin_revision_no,title,body,created_at,updated_at) VALUES(?,?,1,'Other observation','Other body','2026-10-23','2026-10-23')",
    ).run(`other-${id}`, id);
  }
  const page = async (path: string) => {
    const response = await app.request(`https://example.test${path}`, {}, env);
    assert.equal(response.status, 200);
    return new JSDOM(await response.text());
  };
  const dom = await page("/crate/sample?version=1.0.0");
  const d = dom.window.document;
  assert.equal(
    d.querySelector('.filterbar a[href="#findings"]')?.textContent,
    "31 findings",
  );
  assert.equal(d.querySelector("#findings")?.textContent, "Findings (31)");
  assert.ok(
    d
      .querySelector("#findings")!
      .compareDocumentPosition(d.querySelector("#apis")!) &
      dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
  );
  assert.equal(d.querySelectorAll(".crate-findings tbody tr").length, 30);
  assert.doesNotMatch(
    d.querySelector(".crate-findings")!.textContent!,
    /Full details|Other observation|Observation 31|Observation 32/,
  );
  const finding = d.querySelector(
    `.crate-findings a[href="/finding/${ids[0]}"]`,
  )!;
  assert.equal(finding.textContent, "<script>unsafe title</script>");
  assert.equal(d.querySelectorAll(".crate-findings script").length, 0);
  assert.match(finding.closest("tr")!.textContent!, /ConfirmedReleased/);
  const release = d.querySelector(
    '.crate-findings a[href="https://example.test/release"]',
  )!;
  assert.equal(release.textContent, "Release · 1.0.1");
  assert.equal(release.getAttribute("rel"), "noopener noreferrer");
  const next = d
    .querySelector('a[href*="findings_cursor="]')!
    .getAttribute("href")!;
  assert.equal(
    new URL(next, "https://example.test").searchParams.get("version"),
    "1.0.0",
  );
  const second = await page(next);
  assert.equal(
    second.window.document.querySelector("#findings")?.textContent,
    "Findings (31)",
  );
  assert.equal(
    second.window.document.querySelectorAll(".crate-findings tbody tr").length,
    1,
  );
  const other = await page("/crate/sample");
  assert.equal(
    other.window.document.querySelector("h1")?.textContent,
    "sample 2.0.0",
  );
  assert.equal(
    other.window.document.querySelector("#findings")?.textContent,
    "Findings (1)",
  );
  assert.equal(
    other.window.document.querySelectorAll(".crate-findings tbody tr").length,
    1,
  );
  db.prepare(
    "UPDATE findings SET validity='invalid' WHERE id='other-100'",
  ).run();
  const empty = await page("/crate/sample?version=2.0.0");
  assert.equal(
    empty.window.document.querySelector("#findings")?.textContent,
    "Findings (0)",
  );
  assert.match(
    empty.window.document.body.textContent!,
    /No findings reported for this version/,
  );
  // Report cards count findings by the same rule as the Findings heading.
  const cardFindings = (page: typeof dom) =>
    page.window.document.querySelector(".claim-item a[href$='#findings']")
      ?.textContent;
  assert.equal(cardFindings(dom), "31 findings");
  assert.equal(cardFindings(other), "1 finding");
  assert.equal(cardFindings(empty), undefined);
  const counts = Object.fromEntries(
    (await request("/reports")).body.items.map((r: any) => [
      r.id,
      r.finding_count,
    ]),
  );
  assert.deepEqual(counts, { [report]: 31, 100: 0 });
  for (const page of [dom, second, other, empty]) page.window.close();
});
