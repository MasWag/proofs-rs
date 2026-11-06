import { apiOrigin, apiObservation, visibleAPI } from "./recorded-api-sql";
import { zulipEvent } from "./zulip";
import { findings, validateFinding, findingStatements } from "./findings";
import { decodeEvidence } from "./core";
import { claimFormalEvidence } from "./runs";
import { claimTitle } from "../web/claim-title";
import { operation } from "./openapi";
import * as S from "./schemas";
import { Hono } from "hono";
import { defaultRelease, compareReleases } from "./releases";
import {
  App,
  Ctx,
  Fault,
  now,
  uid,
  one,
  rows,
  stmt,
  batch,
  guard,
  quota,
  requireUser,
  jsonBody,
  text,
  positive,
  url,
  page,
  paged,
  idempotent,
  publicClaim,
  publicReport,
  reportLatest,
  latest,
  karmaPolicy,
  hash,
  verifyToken,
  listing,
} from "./core";
import { runs, validateReportRuns } from "./runs";
const api = new Hono<App>();
api.route("/runs", runs);
api.route("/", findings);
const visible = (db: D1Database, id: number) =>
  one(db, "SELECT * FROM reports WHERE id=? AND visibility=?", id, "public");
async function report(c: Ctx) {
  const q = await visible(c.env.DB, positive(c.req.param("id")));
  if (!q) throw new Fault(404, "report_not_found");
  return q;
}
const activeGuard = (c: Ctx) =>
  guard(
    c.env.DB,
    "EXISTS(SELECT 1 FROM users WHERE id=? AND status='active' AND accepted_terms_version=?)",
    requireUser(c).id,
    c.env.TERMS_VERSION,
  );
function publicComment(cm: any) {
  const { author_id, visibility, ...rest } = cm;
  if (cm.deleted_at || visibility !== "public") rest.body = null;
  if (visibility !== "public") rest.username = null;
  return { ...rest, author_id, hidden: visibility !== "public" };
}
api.get(
  "/health",
  ...operation(
    "Check service health",
    S.z.object({ ok: S.z.literal(true), environment: S.string }),
    { tags: ["System"], auth: "optional" },
  ),
  (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT }),
);
api.get(
  "/config",
  ...operation(
    "Read public application configuration",
    S.z.object({
      environment: S.string,
      oauth_configured: S.z.boolean(),
      email_disabled: S.z.boolean(),
      email_configured: S.z.boolean(),
      terms_version: S.string,
      show_star_karma: S.z.boolean(),
      show_home_discussion: S.z.boolean(),
    }),
    { tags: ["System"], auth: "optional" },
  ),
  (c) =>
    c.json({
      environment: c.env.ENVIRONMENT,
      oauth_configured: !!(
        c.env.GITHUB_CLIENT_ID && c.env.GITHUB_CLIENT_SECRET
      ),
      email_disabled: c.env.EMAIL_DISABLED === "true",
      email_configured:
        c.env.EMAIL_DISABLED !== "true" && !!(c.env.EMAIL && c.env.EMAIL_FROM),
      terms_version: c.env.TERMS_VERSION,
      show_star_karma: c.env.SHOW_STAR_KARMA === "true",
      show_home_discussion: c.env.SHOW_HOME_DISCUSSION === "true",
    }),
);
api.get(
  "/terms/current",
  ...operation(
    "Read current terms",
    S.z.object({
      version: S.string,
      url: S.string,
      summary: S.string,
      requires_agreement: S.z.boolean(),
    }),
    { tags: ["System"], auth: "optional" },
  ),
  (c) =>
    c.json({
      version: c.env.TERMS_VERSION,
      url: "/terms",
      summary:
        "Report publication, permanent claim links, independent stars and report discussions.",
      requires_agreement:
        !!c.get("user") &&
        c.get("user")!.accepted_terms_version !== c.env.TERMS_VERSION,
    }),
);
api.get(
  "/me",
  ...operation("Read the current session", S.me, {
    tags: ["Account"],
    auth: "optional",
  }),
  async (c) => {
    const u = c.get("user");
    if (!u) return c.json({ user: null });
    const [contacts, stats] = await c.env.DB.batch<any>([
      stmt(
        c.env.DB,
        "SELECT address,delivery_status FROM email_contacts WHERE user_id=?",
        u.id,
      ),
      stmt(
        c.env.DB,
        `SELECT (SELECT COUNT(*) FROM email_deliveries WHERE user_id=? AND status IN ('pending','retry','unknown')) n,${karmaPolicy.sql("?")} karma`,
        u.id,
        u.id,
      ),
    ]);
    const email = contacts.results[0] || null;
    const delayed = stats.results[0];
    return c.json({
      user: u,
      csrf: c.get("csrf"),
      email,
      delayed_notifications: delayed.n,
      karma: delayed.karma,
      terms_required: u.accepted_terms_version !== c.env.TERMS_VERSION,
    });
  },
);
api.post(
  "/me/terms-acceptance",
  ...operation("Accept current terms", S.ok, {
    tags: ["Account"],
    body: S.z.object({ version: S.string }),
    auth: "session",
    write: true,
    errors: [409],
  }),
  async (c) => {
    const u = requireUser(c),
      b = await jsonBody(c);
    if (b.version !== c.env.TERMS_VERSION)
      throw new Fault(409, "terms_changed");
    await stmt(
      c.env.DB,
      "UPDATE users SET accepted_terms_version=?,terms_accepted_at=? WHERE id=? AND accepted_terms_version<>?",
      b.version,
      now(),
      u.id,
      b.version,
    ).run();
    return c.json({ ok: true });
  },
);
api.get(
  "/me/notification-preferences",
  ...operation("Read notification preferences", S.preferences, {
    tags: ["Account"],
    auth: "session",
  }),
  async (c) =>
    c.json(
      await one(
        c.env.DB,
        "SELECT replies,report_comments FROM notification_preferences WHERE user_id=?",
        requireUser(c).id,
      ),
    ),
);
api.patch(
  "/me/notification-preferences",
  ...operation("Update notification preferences", S.ok, {
    tags: ["Account"],
    body: S.preferencesInput,
    auth: "session",
    write: true,
  }),
  async (c) => {
    const u = requireUser(c),
      b = await jsonBody(c);
    if (
      typeof b.replies !== "boolean" ||
      typeof b.report_comments !== "boolean"
    )
      throw new Fault(400, "invalid_preferences");
    await stmt(
      c.env.DB,
      "UPDATE notification_preferences SET replies=?,report_comments=? WHERE user_id=?",
      +b.replies,
      +b.report_comments,
      u.id,
    ).run();
    return c.json({ ok: true });
  },
);
api.post(
  "/notifications/unsubscribe",
  ...operation("Unsubscribe from notifications", S.ok, {
    tags: ["Account"],
    body: S.z.object({ user: S.string, signature: S.string }),
    description:
      "Requires a signed unsubscribe link and the application Origin.",
  }),
  async (c) => {
    const b = await jsonBody(c);
    if (
      typeof b.user !== "string" ||
      typeof b.signature !== "string" ||
      !(await verifyToken(c.env, `unsubscribe:${b.user}`, b.signature))
    )
      throw new Fault(403, "invalid_token");
    await stmt(
      c.env.DB,
      "UPDATE notification_preferences SET replies=0,report_comments=0 WHERE user_id=?",
      b.user,
    ).run();
    return c.json({ ok: true });
  },
);
const activeReport = "p.visibility='public' AND p.withdrawn_at IS NULL";
// LIKE pattern matching `text` anywhere, with wildcards in it taken literally.
const likeContains = (text: string) =>
  "%" + text.replace(/[\\%_]/g, "\\$&") + "%";
api.get(
  "/home",
  ...operation(
    "Read recent reports and discussion",
    S.z.object({
      reports: S.z.array(S.report),
      discussion: S.z.array(S.discussion),
    }),
    { tags: ["System"] },
  ),
  async (c) => {
    const [reports, discussion] = await c.env.DB.batch<any>([
      stmt(
        c.env.DB,
        publicReport +
          ` WHERE ${activeReport} AND ${reportLatest} ORDER BY p.id DESC LIMIT 12`,
      ),
      stmt(
        c.env.DB,
        `SELECT cm.id,cm.report_id,cm.sequence_no,cm.revision_no,cm.body,cm.created_at,u.username,cm.author_id FROM report_comments cm JOIN reports p ON p.id=cm.report_id LEFT JOIN users u ON u.id=cm.author_id WHERE p.visibility='public' AND cm.visibility='public' AND cm.deleted_at IS NULL ORDER BY cm.created_at DESC,cm.id DESC LIMIT 12`,
      ),
    ]);
    return c.json({ reports: reports.results, discussion: discussion.results });
  },
);
api.get(
  "/reports",
  ...operation("List public reports", S.list(S.report), {
    tags: ["Reports"],
    auth: "optional",
    query: S.reportFilters,
  }),
  async (c) => {
    let filters = "";
    const bindings: string[] = [];
    const q = c.req.query("q")?.trim();
    if (q) {
      filters +=
        " AND (rr.title LIKE ? ESCAPE '\\' OR cr.name LIKE ? ESCAPE '\\')";
      bindings.push(likeContains(q), likeContains(q));
    }
    const tool = c.req.query("tool")?.trim();
    if (tool) {
      filters += " AND t.id=?";
      bindings.push(tool);
    }
    const author = c.req.query("author")?.trim();
    if (author) {
      filters += " AND u.username=? COLLATE NOCASE";
      bindings.push(author);
    }
    return c.json(
      await listing(
        c,
        publicReport + ` WHERE ${activeReport} AND ${reportLatest}${filters}`,
        bindings,
        [{ sql: "p.id", key: "id", desc: true }],
      ),
    );
  },
);
api.get(
  "/crates",
  ...operation(
    "Search crates with published reports",
    S.list(S.crate).extend({
      total_count: S.integer,
      matching_count: S.integer,
    }),
    { tags: ["Crates"], auth: "optional", query: S.search },
  ),
  async (c) => {
    const published = `EXISTS(SELECT 1 FROM releases rel JOIN reports p ON p.release_id=rel.id WHERE rel.crate_id=cr.id AND ${activeReport})`;
    const filter = "cr.name LIKE ? ESCAPE '\\'";
    const query = likeContains(c.req.query("q") || "");
    let counts: any;
    const data = await listing(
      c,
      `SELECT cr.*,
    (SELECT COUNT(DISTINCT a.display_path) FROM api_items a JOIN releases rel ON rel.id=a.release_id WHERE rel.crate_id=cr.id AND ${visibleAPI()} AND EXISTS(SELECT 1 FROM reports p WHERE p.release_id=rel.id AND ${activeReport})) api_count,
    (SELECT COUNT(*) FROM reports p JOIN releases rel ON rel.id=p.release_id WHERE rel.crate_id=cr.id AND ${activeReport}) report_count,
    (SELECT COUNT(*) FROM claims c JOIN reports p ON p.id=c.report_id JOIN claim_revisions r ON r.claim_id=c.id JOIN releases rel ON rel.id=p.release_id WHERE rel.crate_id=cr.id AND ${activeReport} AND ${latest}) claim_count,
    (SELECT MAX(p.updated_at) FROM reports p JOIN releases rel ON rel.id=p.release_id WHERE rel.crate_id=cr.id AND ${activeReport}) updated_at
    FROM crates cr WHERE ${filter} AND ${published}`,
      [query],
      [{ sql: "cr.name", key: "name" }],
      undefined,
      {
        statements: [
          stmt(
            c.env.DB,
            `SELECT COUNT(*) total_count,COALESCE(SUM(${filter}),0) matching_count FROM crates cr WHERE ${published}`,
            query,
          ),
        ],
        check: ([result]) => {
          counts = result.results[0];
        },
      },
    );
    return c.json({ ...data, ...counts });
  },
);
api.get(
  "/crates/:name/releases",
  ...operation(
    "List published crate releases",
    S.z.object({
      items: S.z.array(S.release),
      description: S.string,
      default_version: S.string.optional(),
    }),
    { tags: ["Crates"], auth: "optional" },
  ),
  async (c) => {
    const [releases, crates] = await c.env.DB.batch<any>([
      stmt(
        c.env.DB,
        `SELECT rel.* FROM releases rel JOIN crates cr ON cr.id=rel.crate_id WHERE cr.name=? AND EXISTS(SELECT 1 FROM reports p WHERE p.release_id=rel.id AND ${activeReport})`,
        c.req.param("name"),
      ),
      stmt(
        c.env.DB,
        "SELECT description FROM crates WHERE name=?",
        c.req.param("name"),
      ),
    ]);
    const items = releases.results as any[];
    const crate = crates.results[0];
    items.sort(compareReleases);
    return c.json({
      items,
      description: crate?.description || "",
      default_version: defaultRelease(items)?.version,
    });
  },
);
api.get(
  "/crates/:name/:version/badge",
  ...operation(
    "Read a Shields.io claims badge for a crate release",
    S.z.object({
      schemaVersion: S.z.literal(1),
      label: S.z.literal("proofs.rs"),
      message: S.string,
      color: S.z.literal("blue"),
    }),
    {
      tags: ["Crates"],
      auth: "optional",
      description:
        "Shields.io endpoint badge. Counts claims in the latest revisions of public, non-withdrawn reports for this version.",
    },
  ),
  async (c) => {
    const release = await one(
      c.env.DB,
      "SELECT rel.id FROM releases rel JOIN crates cr ON cr.id=rel.crate_id WHERE cr.name=? AND rel.version=?",
      c.req.param("name"),
      c.req.param("version"),
    );
    if (!release) throw new Fault(404, "release_not_found");
    const count = await one(
      c.env.DB,
      `SELECT COUNT(*) n FROM claims c JOIN reports p ON p.id=c.report_id JOIN claim_revisions r ON r.claim_id=c.id WHERE p.release_id=? AND ${activeReport} AND ${latest}`,
      release.id,
    );
    return c.json({
      schemaVersion: 1 as const,
      label: "proofs.rs" as const,
      message: `${count.n} claim${count.n === 1 ? "" : "s"}`,
      color: "blue" as const,
    });
  },
);
api.get(
  "/crates/:name/:version/apis",
  ...operation(
    "List crate APIs",
    S.list(
      S.apiItem.extend({
        claim_count: S.integer,
        category: S.nullableString,
        trait_path: S.nullableString,
        self_type: S.nullableString,
        method_name: S.nullableString,
        is_blanket: S.flag.nullable(),
      }),
    ).extend({ catalog_warnings: S.z.array(S.catalogWarning) }),
    {
      tags: ["Crates"],
      auth: "optional",
      query: S.z.object({ q: S.string.optional() }),
    },
  ),
  async (c) => {
    const count = `(SELECT COUNT(*) FROM claims c JOIN reports p ON p.id=c.report_id JOIN claim_revisions r ON r.claim_id=c.id WHERE c.api_item_id=a.id AND ${activeReport} AND ${latest})`;
    const items = await rows(
      c.env.DB,
      `SELECT a.*,${apiOrigin()} origin,m.category,m.trait_path,m.self_type,m.method_name,m.is_blanket,
      ${count} claim_count
     FROM api_items a JOIN releases rel ON rel.id=a.release_id JOIN crates cr ON cr.id=rel.crate_id
     LEFT JOIN api_item_metadata m ON m.api_item_id=a.id
     WHERE cr.name=? AND rel.version=? AND ${visibleAPI()} AND a.display_path LIKE ? ORDER BY a.display_path,a.id`,
      c.req.param("name"),
      c.req.param("version"),
      "%" + (c.req.query("q") || "") + "%",
    );
    const snapshot = await one(
      c.env.DB,
      "SELECT ds.catalog_warnings_json FROM doc_snapshots ds JOIN releases rel ON rel.id=ds.release_id JOIN crates cr ON cr.id=rel.crate_id WHERE cr.name=? AND rel.version=?",
      c.req.param("name"),
      c.req.param("version"),
    );
    return c.json({
      items: items.map(apiObservation),
      next_cursor: null,
      catalog_warnings: JSON.parse(snapshot?.catalog_warnings_json || "[]"),
    });
  },
);
api.get(
  "/crates/:name/:version/reports",
  ...operation("List reports for a crate release", S.list(S.report), {
    tags: ["Crates"],
    auth: "optional",
    query: S.pagination,
  }),
  async (c) =>
    c.json(
      await listing(
        c,
        publicReport +
          ` WHERE cr.name=? AND rel.version=? AND ${activeReport} AND ${reportLatest}`,
        [c.req.param("name"), c.req.param("version")],
        [{ sql: "p.id", key: "id", desc: true }],
      ),
    ),
);
api.get(
  "/apis/:id",
  ...operation("Read an API item", S.apiDetail, {
    tags: ["APIs"],
    auth: "optional",
    errors: [404],
  }),
  async (c) => {
    const item = await one(
      c.env.DB,
      `SELECT a.*,${apiOrigin()} origin,cr.name crate,rel.version,rel.yanked,ds.target,ds.features_json,ds.rustdoc_format,ds.catalog_warnings_json FROM api_items a JOIN releases rel ON rel.id=a.release_id JOIN crates cr ON cr.id=rel.crate_id LEFT JOIN doc_snapshots ds ON ds.release_id=rel.id WHERE a.id=? AND ${visibleAPI()}`,
      c.req.param("id"),
    );
    if (!item) throw new Fault(404, "api_not_found");
    const observed = apiObservation(item);
    const { catalog_warnings_json: _, ...apiItem } = observed;
    return c.json({
      ...apiItem,
      catalog_warnings: JSON.parse(item.catalog_warnings_json || "[]"),
    });
  },
);
api.get(
  "/apis/:id/claims",
  ...operation("List claims for an API item", S.list(S.claim), {
    tags: ["APIs"],
    auth: "optional",
    query: S.pagination,
  }),
  async (c) =>
    c.json(
      await listing(
        c,
        publicClaim +
          ` WHERE c.api_item_id=? AND ${activeReport} AND ${latest}`,
        [c.req.param("id")],
        [
          { sql: "c.created_at", key: "created_at", desc: true },
          { sql: "c.id", key: "id", desc: true },
        ],
      ),
    ),
);
api.get(
  "/reports/:id/revisions",
  ...operation(
    "List report revisions",
    S.list(S.z.object({ revision_no: S.integer, created_at: S.string })),
    { tags: ["Reports"], auth: "optional", query: S.pagination, errors: [404] },
  ),
  async (c) => {
    const p = await report(c);
    return c.json(
      await listing(
        c,
        "SELECT revision_no,created_at FROM report_revisions WHERE report_id=?",
        [p.id],
        [{ sql: "revision_no", key: "revision_no", desc: true }],
      ),
    );
  },
);
async function reportDetail(c: Ctx, revision?: number) {
  const id = positive(c.req.param("id"));
  const user = c.get("user")?.id;
  const revisionSQL = revision
    ? "?"
    : "(SELECT MAX(v.revision_no) FROM report_revisions v WHERE v.report_id=p.id)";
  const args = [id, ...(revision ? [revision] : [])];
  const withStar = (sql: string, kind: "report" | "claim", alias: string) =>
    sql.replace(
      "SELECT ",
      `SELECT ${user ? `EXISTS(SELECT 1 FROM ${kind}_stars s WHERE s.${kind}_id=${alias}.id AND s.user_id=?)` : "0"} my_star,`,
    );
  // One read transaction keeps visibility, revision selection and all child rows consistent.
  // Keep the existence result to preserve report_not_found vs revision_not_found.
  const [visible, reports, claims, runs, dependencies] =
    await c.env.DB.batch<any>([
      stmt(
        c.env.DB,
        "SELECT id FROM reports WHERE id=? AND visibility='public'",
        id,
      ),
      stmt(
        c.env.DB,
        withStar(publicReport, "report", "p") +
          ` WHERE p.id=? AND p.visibility='public' AND rr.revision_no=${revisionSQL}`,
        ...(user ? [user] : []),
        ...args,
      ),
      stmt(
        c.env.DB,
        withStar(publicClaim, "claim", "c") +
          ` WHERE p.id=? AND p.visibility='public' AND r.report_revision=${revisionSQL} ORDER BY r.position`,
        ...(user ? [user] : []),
        ...args,
      ),
      stmt(
        c.env.DB,
        `SELECT run_id FROM report_runs x JOIN reports p ON p.id=x.report_id WHERE p.id=? AND p.visibility='public' AND x.revision_no=${revisionSQL} ORDER BY x.position`,
        ...args,
      ),
      stmt(
        c.env.DB,
        `SELECT x.crate,x.version,CASE WHEN e.visibility='public' THEN x.evidence_report_id ELSE NULL END report,CASE WHEN e.visibility='public' THEN x.evidence_revision_no ELSE NULL END revision,CASE WHEN e.visibility='public' AND e.withdrawn_at IS NULL THEN 0 ELSE 1 END withdrawn FROM report_dependencies x JOIN reports p ON p.id=x.report_id JOIN reports e ON e.id=x.evidence_report_id WHERE p.id=? AND p.visibility='public' AND x.revision_no=${revisionSQL} ORDER BY x.crate`,
        ...args,
      ),
    ]);
  if (!visible.results.length) throw new Fault(404, "report_not_found");
  const r = reports.results[0];
  if (!r) throw new Fault(404, "revision_not_found");
  return c.json({
    ...r,
    my_star: !!r.my_star,
    run_ids: runs.results.map((x) => x.run_id),
    dependencies: dependencies.results.map((x) => ({
      ...x,
      withdrawn: !!x.withdrawn,
    })),
    claims: claims.results.map((raw) => {
      const x = decodeEvidence(raw);
      return { ...x, my_star: !!x.my_star };
    }),
  });
}
api.get(
  "/reports/:id",
  ...operation("Read the latest report revision", S.reportDetail, {
    tags: ["Reports"],
    auth: "optional",
    errors: [404],
  }),
  (c) => reportDetail(c),
);
api.get(
  "/reports/:id/revisions/:n",
  ...operation("Read a report revision", S.reportDetail, {
    tags: ["Reports"],
    auth: "optional",
    errors: [404],
  }),
  (c) => reportDetail(c, positive(c.req.param("n"))),
);
api.get(
  "/claims/:id",
  ...operation(
    "Read a claim",
    S.claim.extend({
      my_star: S.z.boolean(),
      formal_evidence: S.formalDetail.nullable().optional(),
    }),
    {
      tags: ["Claims"],
      auth: "optional",
      query: S.z.object({ report_revision: S.string.optional() }),
      errors: [404],
    },
  ),
  async (c) => {
    const n = c.req.query("report_revision");
    const item = await one(
      c.env.DB,
      publicClaim +
        ` WHERE c.id=? AND p.visibility='public' AND r.report_revision=${n ? "?" : "(SELECT MAX(v.report_revision) FROM claim_revisions v WHERE v.claim_id=c.id)"}`,
      c.req.param("id"),
      ...(n ? [positive(n)] : []),
    );
    if (!item) throw new Fault(404, "claim_not_found");
    return c.json({
      ...item,
      formal_evidence: await claimFormalEvidence(c, item),
      my_star: !!(await one(
        c.env.DB,
        "SELECT 1 FROM claim_stars WHERE claim_id=? AND user_id=?",
        item.id,
        c.get("user")?.id || "",
      )),
    });
  },
);
const optionalURL = (v: any) => (text(v, "Evidence URL", 1000) ? url(v) : "");
async function validate(c: Ctx, b: any, existing?: any) {
  const rel = await one(
    c.env.DB,
    "SELECT rel.*,cr.name crate FROM releases rel JOIN crates cr ON cr.id=rel.crate_id WHERE cr.name=? AND rel.version=? AND (EXISTS(SELECT 1 FROM doc_snapshots ds WHERE ds.release_id=rel.id) OR EXISTS(SELECT 1 FROM verification_runs vr WHERE vr.crate=cr.name AND vr.version=rel.version AND vr.author_id=?))",
    text(b.crate, "Crate", 100, true),
    text(b.version, "Version", 100, true),
    requireUser(c).id,
  );
  if (!rel) throw new Fault(400, "release_not_imported");
  if (existing && existing.release_id !== rel.id)
    throw new Fault(400, "immutable_release");
  const tv = await one(
    c.env.DB,
    "SELECT tv.*,t.name FROM tool_versions tv JOIN tools t ON t.id=tv.tool_id WHERE tv.id=? AND tv.selectable=1 AND t.active=1",
    text(b.tool_version_id, "Tool version", 200, true),
  );
  if (!tv) throw new Fault(400, "tool_version_unavailable");
  if (
    !Array.isArray(b.claims) ||
    b.claims.length < 1 ||
    b.claims.length > S.MAX_REPORT_CLAIMS
  )
    throw new Fault(
      400,
      "invalid_claims",
      `A report must contain 1–${S.MAX_REPORT_CLAIMS} claims.`,
    );
  const v: any = {
    release_id: rel.id,
    crate: rel.crate,
    version: rel.version,
    title: text(b.title, "Report title", 1000, true),
    explanation: text(b.explanation, "Explanation"),
    trusted_assumptions: text(b.trusted_assumptions, "Trusted assumptions"),
    environment: text(b.environment, "Environment"),
    evidence_url: optionalURL(b.evidence_url),
    limitations: text(b.limitations, "Limitations"),
    tool_version_id: tv.id,
    tool: tv.name,
    tool_version: tv.version,
    claims: [],
  };
  const ids = new Set();
  for (let i = 0; i < b.claims.length; i++) {
    try {
      const x = b.claims[i];
      if (!x || typeof x !== "object" || Array.isArray(x))
        throw new Fault(400, "invalid_claim");
      const a = await one(
        c.env.DB,
        `SELECT a.*,${apiOrigin()} origin FROM api_items a WHERE a.id=? AND a.release_id=?`,
        text(x.api_item_id, "API", 200, true),
        rel.id,
      );
      if (!a) throw new Fault(400, "api_not_in_release");
      const id = x.id === undefined ? null : text(x.id, "Claim ID", 100, true);
      if (id) {
        if (ids.has(id)) throw new Fault(400, "duplicate_claim_id");
        ids.add(id);
        const old =
          existing &&
          (await one(
            c.env.DB,
            "SELECT * FROM claims WHERE id=? AND report_id=?",
            id,
            existing.id,
          ));
        if (!old) throw new Fault(400, "invalid_claim_id");
        if (old.api_item_id !== a.id)
          throw new Fault(400, "immutable_claim_target");
      }
      const title = claimTitle(
        text(x.title, "Claim title", 1000),
        a.display_path,
        tv.name,
        tv.version,
      );
      const evidence_url = optionalURL(x.evidence_url);
      if (!evidence_url && !v.evidence_url)
        throw new Fault(400, "evidence_required");
      v.claims.push({
        id,
        api_item_id: a.id,
        title,
        precondition: text(
          x.precondition,
          "Preconditions",
          10000,
          !x.evidence_ref,
        ),
        evidence_ref:
          x.evidence_ref == null ? null : S.evidenceRef.parse(x.evidence_ref),
        explanation: text(x.explanation, "Explanation"),
        trusted_assumptions: text(x.trusted_assumptions, "Trusted assumptions"),
        evidence_url,
        limitations: text(x.limitations, "Limitations"),
        display_path: a.display_path,
        is_unsafe: a.origin === "recorded" ? null : a.is_unsafe,
        origin: a.origin,
        signature: a.signature,
      });
    } catch (e) {
      if (e instanceof Fault)
        throw new Fault(e.status, e.code, `Claim ${i + 1}: ${e.message}`);
      throw e;
    }
  }
  const previous = existing
    ? await rows(
        c.env.DB,
        `SELECT c.id FROM claims c JOIN claim_revisions r ON r.claim_id=c.id WHERE c.report_id=? AND r.report_revision=(SELECT MAX(revision_no) FROM report_revisions WHERE report_id=?)`,
        existing.id,
        existing.id,
      )
    : [];
  v.changes = {
    added: v.claims.filter((x: any) => !x.id).length,
    retained: v.claims.filter((x: any) => !!x.id).map((x: any) => x.id),
    removed: previous.filter((x) => !ids.has(x.id)).map((x) => x.id),
  };
  await validateReportRuns(c, b, v);
  const reviews =
    b.dependencies === undefined && existing
      ? await rows(
          c.env.DB,
          "SELECT crate,evidence_report_id report,evidence_revision_no revision FROM report_dependencies WHERE report_id=? AND revision_no=(SELECT MAX(revision_no) FROM report_revisions WHERE report_id=?)",
          existing.id,
          existing.id,
        )
      : (b.dependencies ?? []);
  if (!Array.isArray(reviews) || reviews.length > 100)
    throw new Fault(400, "invalid_dependencies");
  const reviewed = new Set<string>();
  v.dependencies = [];
  for (const d of reviews) {
    const parsed = S.dependencyInput.safeParse(d);
    if (!parsed.success || reviewed.has(parsed.data.crate))
      throw new Fault(400, "invalid_dependency_review");
    const crate = parsed.data.crate,
      report = positive(parsed.data.report),
      revision = positive(parsed.data.revision);
    reviewed.add(crate);
    const evidence = await one(
      c.env.DB,
      "SELECT rel.version,cr.name crate FROM reports p JOIN report_revisions rr ON rr.report_id=p.id JOIN releases rel ON rel.id=p.release_id JOIN crates cr ON cr.id=rel.crate_id WHERE p.id=? AND rr.revision_no=? AND p.visibility='public' AND p.withdrawn_at IS NULL",
      report,
      revision,
    );
    if (!evidence || evidence.crate !== crate)
      throw new Fault(400, "dependency_evidence_unavailable");
    let found = false;
    for (const run of v.run_ids) {
      if (
        await one(
          c.env.DB,
          "SELECT 1 FROM run_dependencies WHERE run_id=? AND crate=? AND version=? AND source='registry+https://github.com/rust-lang/crates.io-index'",
          run,
          crate,
          evidence.version,
        )
      )
        found = true;
    }
    if (!found) throw new Fault(400, "dependency_not_in_recorded_run");
    v.dependencies.push({
      crate,
      version: evidence.version,
      report,
      revision,
      withdrawn: false,
    });
  }
  if (existing && b.findings !== undefined)
    throw new Fault(400, "findings_use_independent_api");
  if (!existing && b.findings !== undefined) {
    if (!Array.isArray(b.findings) || b.findings.length > 20)
      throw new Fault(400, "invalid_findings");
    v.findings = [];
    for (const input of b.findings)
      v.findings.push(
        await validateFinding(
          c.env.DB,
          input,
          rel.id,
          v.claims.map((c: any) => c.api_item_id),
        ),
      );
  }
  return v;
}
function revisionStatements(
  c: Ctx,
  v: any,
  reportID: number | string,
  n: number,
  byKey = false,
) {
  const db = c.env.DB;
  const select = byKey ? "(SELECT id FROM reports WHERE create_key=?)" : "?";
  const ss = [
    stmt(
      db,
      `INSERT INTO report_revisions VALUES(${select},?,?,?,?,?,?,?,?,?)`,
      reportID,
      n,
      v.title,
      v.explanation,
      v.trusted_assumptions,
      v.tool_version_id,
      v.environment,
      v.evidence_url,
      v.limitations,
      now(),
    ),
  ];
  v.claims.forEach((x: any, i: number) => {
    const id = x.id || uid();
    if (!x.id)
      ss.push(
        stmt(
          db,
          `INSERT INTO claims VALUES(?,${select},?,?)`,
          id,
          reportID,
          x.api_item_id,
          now(),
        ),
      );
    ss.push(
      stmt(
        db,
        `INSERT INTO claim_revisions VALUES(?,${select},?,?,?,?,?,?,?,?)`,
        id,
        reportID,
        n,
        i,
        x.title,
        x.precondition,
        x.explanation,
        x.trusted_assumptions,
        x.evidence_url,
        x.limitations,
      ),
    );
    if (x.evidence_ref)
      ss.push(
        stmt(
          db,
          `INSERT INTO claim_evidence(claim_id,report_revision,run_id,harness) VALUES(?,?,?,?)`,
          id,
          n,
          x.evidence_ref.run_id,
          x.evidence_ref.harness,
        ),
      );
  });
  v.run_ids.forEach((run: string, position: number) =>
    ss.push(
      stmt(
        db,
        `INSERT INTO report_runs VALUES(${select},?,?,?)`,
        reportID,
        n,
        run,
        position,
      ),
    ),
  );
  for (const d of v.dependencies) {
    ss.push(
      guard(
        db,
        "EXISTS(SELECT 1 FROM reports p JOIN report_revisions rr ON rr.report_id=p.id JOIN releases rel ON rel.id=p.release_id JOIN crates cr ON cr.id=rel.crate_id WHERE p.id=? AND rr.revision_no=? AND p.visibility='public' AND p.withdrawn_at IS NULL AND cr.name=? AND rel.version=?)",
        d.report,
        d.revision,
        d.crate,
        d.version,
      ),
    );
    ss.push(
      guard(
        db,
        `EXISTS(SELECT 1 FROM report_runs rr JOIN run_dependencies rd ON rd.run_id=rr.run_id WHERE rr.report_id=${select} AND rr.revision_no=? AND rd.crate=? AND rd.version=? AND rd.source='registry+https://github.com/rust-lang/crates.io-index')`,
        reportID,
        n,
        d.crate,
        d.version,
      ),
    );
    ss.push(
      stmt(
        db,
        `INSERT INTO report_dependencies VALUES(${select},?,?,?,?,?)`,
        reportID,
        n,
        d.crate,
        d.version,
        d.report,
        d.revision,
      ),
    );
  }
  return ss;
}
api.post(
  "/reports/validate",
  ...operation("Validate a report without publishing", S.validatedReport, {
    tags: ["Reports"],
    body: S.reportInput.extend({ report_id: S.positiveInput.optional() }),
    auth: "user",
    write: true,
    errors: [400],
  }),
  async (c) => {
    const u = requireUser(c),
      b = await jsonBody(c);
    let p;
    if (b.report_id !== undefined) {
      p = await visible(c.env.DB, positive(b.report_id));
      if (!p || p.author_id !== u.id) throw new Fault(403, "not_author");
    }
    return c.json(await validate(c, b, p));
  },
);
api.post(
  "/reports",
  ...operation("Publish a report", S.z.object({ id: S.integer }), {
    tags: ["Reports"],
    body: S.reportInput,
    auth: "user",
    write: true,
    idempotent: true,
    status: 201,
    errors: [400, 409, 428, 429],
  }),
  async (c) => {
    const u = requireUser(c),
      b = await jsonBody(c),
      v = await validate(c, b);
    await idempotent(c, "report", b, "pending", async (key) => [
      activeGuard(c),
      quota(c.env.DB, u.id, "report", 200),
      stmt(
        c.env.DB,
        "INSERT INTO reports(create_key,release_id,author_id,created_at,updated_at) VALUES(?,?,?,?,?)",
        key,
        v.release_id,
        u.id,
        now(),
        now(),
      ),
      ...revisionStatements(c, v, key, 1, true),
      ...zulipEvent(c.env, "report", key, 1, true),
      ...(v.findings ?? []).flatMap((input: any) =>
        findingStatements(c, input, key, 1, true),
      ),
      stmt(
        c.env.DB,
        "UPDATE idempotency_keys SET resource_id=(SELECT CAST(id AS TEXT) FROM reports WHERE create_key=?) WHERE user_id=? AND operation=? AND key=?",
        key,
        u.id,
        "report",
        c.req.header("Idempotency-Key"),
      ),
    ]);
    const result = await one(
      c.env.DB,
      "SELECT resource_id FROM idempotency_keys WHERE user_id=? AND operation=? AND key=?",
      u.id,
      "report",
      c.req.header("Idempotency-Key"),
    );
    return c.json({ id: Number(result.resource_id) }, 201);
  },
);
api.post(
  "/reports/:id/revisions",
  ...operation(
    "Publish a report revision",
    S.z.object({ id: S.integer, revision_no: S.integer }),
    {
      tags: ["Reports"],
      body: S.reportInput
        .omit({ findings: true })
        .extend({ expected_revision: S.positiveInput }),
      auth: "user",
      write: true,
      idempotent: true,
      status: 201,
      errors: [400, 404, 409, 428, 429],
    },
  ),
  async (c) => {
    const p = await report(c),
      u = requireUser(c);
    if (p.author_id !== u.id) throw new Fault(403, "not_author");
    if (p.withdrawn_at) throw new Fault(409, "report_withdrawn");
    const b = await jsonBody(c),
      v = await validate(c, b, p),
      expected = positive(b.expected_revision),
      n = expected + 1;
    await idempotent(c, "report_revision:" + p.id, b, String(n), async () => [
      activeGuard(c),
      guard(
        c.env.DB,
        "(SELECT MAX(revision_no) FROM report_revisions WHERE report_id=?)=? AND EXISTS(SELECT 1 FROM reports WHERE id=? AND author_id=? AND visibility='public' AND withdrawn_at IS NULL)",
        p.id,
        expected,
        p.id,
        u.id,
      ),
      quota(c.env.DB, u.id, "report", 200),
      ...revisionStatements(c, v, p.id, n),
      ...zulipEvent(c.env, "report", p.id, n),
      stmt(c.env.DB, "UPDATE reports SET updated_at=? WHERE id=?", now(), p.id),
    ]);
    return c.json({ id: p.id, revision_no: n }, 201);
  },
);
api.put(
  "/reports/:id/withdrawal",
  ...operation("Withdraw a report", S.ok, {
    tags: ["Reports"],
    auth: "session",
    write: true,
    errors: [404],
  }),
  async (c) => {
    const p = await report(c),
      u = requireUser(c);
    if (p.author_id !== u.id) throw new Fault(403, "not_author");
    await batch(c.env.DB, [
      activeGuard(c),
      stmt(
        c.env.DB,
        "UPDATE reports SET withdrawn_at=COALESCE(withdrawn_at,?) WHERE id=? AND author_id=?",
        now(),
        p.id,
        u.id,
      ),
    ]);
    return c.json({ ok: true });
  },
);
for (const kind of ["report", "claim"] as const) {
  api.get(
    `/${kind}s/:id/stars`,
    ...operation(`List ${kind} stars`, S.list(S.star), {
      tags: [kind === "report" ? "Reports" : "Claims"],
      auth: "optional",
      query: S.pagination,
      errors: [404],
    }),
    async (c) => {
      const item =
        kind === "report"
          ? await visible(c.env.DB, positive(c.req.param("id")))
          : await one(
              c.env.DB,
              "SELECT c.* FROM claims c JOIN reports p ON p.id=c.report_id WHERE c.id=? AND p.visibility='public'",
              c.req.param("id"),
            );
      if (!item) throw new Fault(404, kind + "_not_found");
      return c.json(
        await listing(
          c,
          `SELECT u.id,u.username,s.created_at FROM ${kind}_stars s JOIN users u ON u.id=s.user_id WHERE s.${kind}_id=?`,
          [item.id],
          [
            { sql: "s.created_at", key: "created_at", desc: true },
            { sql: "u.id", key: "id" },
          ],
        ),
      );
    },
  );
  api.on(
    ["PUT", "DELETE"],
    `/${kind}s/:id/star`,
    ...operation(`Set or remove a ${kind} star`, S.ok, {
      tags: [kind === "report" ? "Reports" : "Claims"],
      auth: "session",
      write: true,
      errors: [404],
    }),
    async (c) => {
      const u = requireUser(c);
      const item =
        kind === "report"
          ? await visible(c.env.DB, positive(c.req.param("id")))
          : await one(
              c.env.DB,
              "SELECT c.* FROM claims c JOIN reports p ON p.id=c.report_id WHERE c.id=? AND p.visibility='public'",
              c.req.param("id"),
            );
      if (!item) throw new Fault(404, kind + "_not_found");
      await batch(c.env.DB, [
        activeGuard(c),
        guard(
          c.env.DB,
          "EXISTS(SELECT 1 FROM reports WHERE id=? AND visibility='public')",
          kind === "report" ? item.id : item.report_id,
        ),
        c.req.method === "PUT"
          ? stmt(
              c.env.DB,
              `INSERT INTO ${kind}_stars VALUES(?,?,?) ON CONFLICT DO NOTHING`,
              item.id,
              u.id,
              now(),
            )
          : stmt(
              c.env.DB,
              `DELETE FROM ${kind}_stars WHERE ${kind}_id=? AND user_id=?`,
              item.id,
              u.id,
            ),
      ]);
      return c.json({ ok: true });
    },
  );
}
const commentSelect = `SELECT cm.*,u.username,COALESCE((SELECT SUM(value) FROM report_comment_votes WHERE comment_id=cm.id),0) score,(SELECT value FROM report_comment_votes WHERE comment_id=cm.id AND user_id=?) my_vote,(SELECT COUNT(*) FROM report_comments ch WHERE ch.reply_to_id=cm.id) reply_count FROM report_comments cm LEFT JOIN users u ON u.id=cm.author_id`;
// HTML pages show the complete discussion, while the JSON API keeps keyset paging.
export async function reportDiscussion(
  db: D1Database,
  reportID: number,
  userID = "",
) {
  return (
    await rows(
      db,
      commentSelect +
        " WHERE cm.report_id=? AND EXISTS(SELECT 1 FROM reports p WHERE p.id=cm.report_id AND p.visibility='public') ORDER BY cm.sequence_no",
      userID,
      reportID,
    )
  ).map(publicComment);
}
api.get(
  "/reports/:id/comments",
  ...operation("List report comments or replies", S.list(S.comment), {
    tags: ["Comments"],
    auth: "optional",
    query: S.pagination.extend({ parent_id: S.string.optional() }),
    errors: [404],
  }),
  async (c) => {
    const id = positive(c.req.param("id"));
    return c.json(
      await listing(
        c,
        commentSelect +
          " WHERE cm.report_id=? AND cm.reply_to_id IS ? AND EXISTS(SELECT 1 FROM reports p WHERE p.id=cm.report_id AND p.visibility='public')",
        [c.get("user")?.id || "", id, c.req.query("parent_id") || null],
        [{ sql: "cm.sequence_no", key: "sequence_no" }],
        publicComment,
        {
          statements: [
            stmt(
              c.env.DB,
              "SELECT id FROM reports WHERE id=? AND visibility='public'",
              id,
            ),
          ],
          check: ([result]) => {
            if (!result.results.length)
              throw new Fault(404, "report_not_found");
          },
        },
      ),
    );
  },
);
api.get(
  "/comments/:id",
  ...operation(
    "Read a comment and its ancestors",
    S.comment.extend({ ancestors: S.z.array(S.string) }),
    { tags: ["Comments"], errors: [404] },
  ),
  async (c) => {
    const cm = await one(
      c.env.DB,
      commentSelect + " WHERE cm.id=?",
      c.get("user")?.id || "",
      c.req.param("id"),
    );
    if (!cm || !(await visible(c.env.DB, cm.report_id)))
      throw new Fault(404, "comment_not_found");
    const ancestors = await rows(
      c.env.DB,
      `WITH RECURSIVE chain(id,reply_to_id,depth) AS (SELECT id,reply_to_id,0 FROM report_comments WHERE id=? UNION ALL SELECT p.id,p.reply_to_id,chain.depth+1 FROM report_comments p JOIN chain ON p.id=chain.reply_to_id) SELECT id FROM chain ORDER BY depth DESC`,
      cm.id,
    );
    return c.json({
      ...publicComment(cm),
      ancestors: ancestors.map((x) => x.id),
    });
  },
);
api.post(
  "/reports/:id/comments",
  ...operation("Post a report comment", S.z.object({ id: S.string }), {
    tags: ["Comments"],
    body: S.createComment,
    auth: "session",
    write: true,
    idempotent: true,
    status: 201,
    errors: [404, 409, 428, 429],
  }),
  async (c) => {
    const q = await report(c),
      u = requireUser(c),
      b = await jsonBody(c),
      body = text(b.body, "Comment", 5000, true),
      rev = positive(b.revision_no),
      parent = b.reply_to_id ? text(b.reply_to_id, "Reply", 100) : null,
      id = uid(),
      event = uid();
    const resource = await idempotent(c, "comment:" + q.id, b, id, async () => [
      activeGuard(c),
      guard(
        c.env.DB,
        "EXISTS(SELECT 1 FROM reports WHERE id=? AND visibility='public')",
        q.id,
      ),
      quota(c.env.DB, u.id, "comment", 1000),
      stmt(
        c.env.DB,
        "INSERT INTO report_comments(id,report_id,sequence_no,revision_no,author_id,reply_to_id,body,created_at) SELECT ?,?,COALESCE(MAX(sequence_no),0)+1,?,?,?,?,? FROM report_comments WHERE report_id=?",
        id,
        q.id,
        rev,
        u.id,
        parent,
        body,
        now(),
        q.id,
      ),
      stmt(
        c.env.DB,
        "INSERT INTO report_comment_history VALUES(?,1,?,?,?,?)",
        id,
        "create",
        body,
        u.id,
        now(),
      ),
      stmt(
        c.env.DB,
        "INSERT INTO outbox_events(id,type,aggregate_id,dedupe_key,payload,created_at) VALUES(?,?,?,?,?,?)",
        event,
        "comment",
        id,
        "comment:" + id,
        JSON.stringify({ comment_id: id }),
        now(),
      ),
      ...zulipEvent(c.env, "comment", id),
    ]);
    return c.json({ id: resource }, 201);
  },
);
async function editComment(c: Ctx, deleting: boolean) {
  const u = requireUser(c),
    b = await jsonBody(c),
    id = c.req.param("id"),
    cm = await one(c.env.DB, "SELECT * FROM report_comments WHERE id=?", id);
  if (!cm || !(await visible(c.env.DB, cm.report_id)))
    throw new Fault(404, "comment_not_found");
  if (cm.author_id !== u.id) throw new Fault(403, "not_author");
  const expected = positive(b.edit_version),
    body = deleting ? null : text(b.body, "Comment", 5000, true);
  await batch(c.env.DB, [
    activeGuard(c),
    guard(
      c.env.DB,
      "EXISTS(SELECT 1 FROM report_comments cm JOIN reports c ON c.id=cm.report_id WHERE cm.id=? AND cm.author_id=? AND cm.edit_version=? AND cm.deleted_at IS NULL AND cm.visibility='public' AND c.visibility='public')",
      id,
      u.id,
      expected,
    ),
    stmt(
      c.env.DB,
      "INSERT INTO report_comment_history VALUES(?,?,?,?,?,?)",
      id,
      expected + 1,
      deleting ? "delete" : "edit",
      body,
      u.id,
      now(),
    ),
    stmt(
      c.env.DB,
      "UPDATE report_comments SET body=?,edit_version=edit_version+1,edited_at=?,deleted_at=? WHERE id=?",
      body,
      now(),
      deleting ? now() : null,
      id,
    ),
    ...(deleting
      ? [
          stmt(
            c.env.DB,
            "DELETE FROM report_comment_votes WHERE comment_id=?",
            id,
          ),
        ]
      : []),
  ]);
  return c.json({ ok: true, edit_version: expected + 1 });
}
api.patch(
  "/comments/:id",
  ...operation("Edit a comment", S.ok.extend({ edit_version: S.integer }), {
    tags: ["Comments"],
    body: S.editComment,
    auth: "session",
    write: true,
    errors: [404, 409],
  }),
  (c) => editComment(c, false),
);
api.delete(
  "/comments/:id",
  ...operation("Delete a comment", S.ok.extend({ edit_version: S.integer }), {
    tags: ["Comments"],
    body: S.deleteComment,
    auth: "session",
    write: true,
    errors: [404, 409],
  }),
  (c) => editComment(c, true),
);
for (const method of ["PUT", "DELETE"] as const)
  api.on(
    method,
    "/comments/:id/vote",
    ...operation(
      method === "PUT" ? "Vote on a comment" : "Remove a comment vote",
      S.ok,
      {
        tags: ["Comments"],
        body:
          method === "PUT"
            ? S.z.object({
                value: S.z.union([S.z.literal(-1), S.z.literal(1)]),
              })
            : undefined,
        auth: "session",
        write: true,
        errors: [404],
      },
    ),
    async (c) => {
      const u = requireUser(c),
        id = c.req.param("id");
      const cm = await one(
        c.env.DB,
        "SELECT * FROM report_comments WHERE id=?",
        id,
      );
      if (!cm || !(await visible(c.env.DB, cm.report_id)))
        throw new Fault(404, "comment_not_found");
      if (cm.author_id === u.id || cm.deleted_at || cm.visibility !== "public")
        throw new Fault(403, "vote_forbidden");
      const b = c.req.method === "PUT" ? await jsonBody(c) : {};
      if (c.req.method === "PUT" && ![-1, 1].includes(b.value))
        throw new Fault(400, "invalid_vote");
      await batch(c.env.DB, [
        activeGuard(c),
        guard(
          c.env.DB,
          "EXISTS(SELECT 1 FROM reports WHERE id=? AND visibility='public')",
          cm.report_id,
        ),
        c.req.method === "DELETE"
          ? stmt(
              c.env.DB,
              "DELETE FROM report_comment_votes WHERE comment_id=? AND user_id=?",
              id,
              u.id,
            )
          : stmt(
              c.env.DB,
              "INSERT INTO report_comment_votes VALUES(?,?,?,?) ON CONFLICT(comment_id,user_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
              id,
              u.id,
              b.value,
              now(),
            ),
      ]);
      return c.json({ ok: true });
    },
  );
api.get(
  "/users/:id",
  ...operation(
    "Read a public user profile",
    S.z.object({
      id: S.string,
      username: S.string,
      created_at: S.string,
      karma: S.integer,
      algorithm_version: S.string,
    }),
    {
      tags: ["Account"],
      description: "Accepts a user ID or username.",
      errors: [404],
    },
  ),
  async (c) => {
    const u = await one(
      c.env.DB,
      "SELECT id,username,created_at FROM users WHERE id=? OR username=? ORDER BY id=? DESC LIMIT 1",
      c.req.param("id"),
      c.req.param("id"),
      c.req.param("id"),
    );
    if (!u) throw new Fault(404, "user_not_found");
    return c.json({
      ...u,
      karma: await karmaPolicy.compute(c.env.DB, u.id),
      algorithm_version: karmaPolicy.id,
    });
  },
);
for (const prefix of ["/users/:id", "/me"]) {
  api.get(
    prefix + "/reports",
    ...operation("List reports by user", S.list(S.report), {
      tags: ["Account"],
      query: S.pagination,
      auth: prefix === "/me" ? "user" : undefined,
    }),
    async (c) =>
      c.json(
        await listing(
          c,
          publicReport +
            ` WHERE p.author_id=? AND p.visibility='public' AND ${reportLatest}`,
          [prefix === "/me" ? requireUser(c).id : c.req.param("id")],
          [{ sql: "p.id", key: "id", desc: true }],
        ),
      ),
  );
  api.get(
    prefix + "/comments",
    ...operation("List comments by user", S.list(S.comment), {
      tags: ["Comments"],
      query: S.pagination,
      auth: prefix === "/me" ? "session" : undefined,
    }),
    async (c) =>
      c.json(
        await listing(
          c,
          commentSelect +
            " JOIN reports c ON c.id=cm.report_id WHERE cm.author_id=? AND c.visibility='public' AND cm.visibility='public' AND cm.deleted_at IS NULL",
          [
            c.get("user")?.id || "",
            prefix === "/me" ? requireUser(c).id : c.req.param("id"),
          ],
          [
            { sql: "cm.created_at", key: "created_at", desc: true },
            { sql: "cm.id", key: "id", desc: true },
          ],
          publicComment,
        ),
      ),
  );
}
for (const kind of ["report", "claim"] as const) {
  api.get(
    "/me/starred-" + kind + "s",
    ...operation(
      `List my starred ${kind}s`,
      S.list(
        (kind === "report" ? S.report : S.claim).extend({
          starred_at: S.string,
        }),
      ),
      { tags: ["Account"], query: S.pagination, auth: "session" },
    ),
    async (c) =>
      c.json(
        await listing(
          c,
          (kind === "report"
            ? publicReport.replace(
                "SELECT ",
                "SELECT s.created_at starred_at,",
              ) +
              ` JOIN report_stars s ON s.report_id=p.id WHERE ${reportLatest}`
            : publicClaim.replace(
                "SELECT ",
                "SELECT s.created_at starred_at,",
              ) +
              ` JOIN claim_stars s ON s.claim_id=c.id WHERE r.report_revision=(SELECT MAX(v.report_revision) FROM claim_revisions v WHERE v.claim_id=c.id)`) +
            " AND s.user_id=? AND p.visibility='public'",
          [requireUser(c).id],
          [
            { sql: "s.created_at", key: "starred_at", desc: true },
            { sql: kind === "report" ? "p.id" : "c.id", key: "id", desc: true },
          ],
        ),
      ),
  );
}
api.get(
  "/tools",
  ...operation(
    "List verification tools and versions",
    S.z.object({
      items: S.z.array(S.tool),
      versions: S.z.array(S.toolVersion),
    }),
    { tags: ["Tools"], auth: "optional" },
  ),
  async (c) => {
    const [items, versions] = await c.env.DB.batch<any>([
      stmt(c.env.DB, "SELECT * FROM tools ORDER BY name"),
      stmt(c.env.DB, "SELECT * FROM tool_versions ORDER BY tool_id,version"),
    ]);
    return c.json({ items: items.results, versions: versions.results });
  },
);
api.get(
  "/tool-versions/:id",
  ...operation(
    "Read a tool version",
    S.toolVersion.extend({ tool: S.string }),
    { tags: ["Tools"], errors: [404] },
  ),
  async (c) => {
    const version = await one(
      c.env.DB,
      "SELECT tv.*,t.name tool FROM tool_versions tv JOIN tools t ON t.id=tv.tool_id WHERE tv.id=?",
      c.req.param("id"),
    );
    if (!version) throw new Fault(404, "tool_version_not_found");
    return c.json(version);
  },
);
api.get(
  "/tool-versions/:id/reports",
  ...operation("List reports for a tool version", S.list(S.report), {
    tags: ["Reports"],
    query: S.pagination,
    errors: [404],
  }),
  async (c) => {
    const id = c.req.param("id");
    return c.json(
      await listing(
        c,
        publicReport + ` WHERE tv.id=? AND ${activeReport} AND ${reportLatest}`,
        [id],
        [{ sql: "p.id", key: "id", desc: true }],
        undefined,
        {
          statements: [
            stmt(c.env.DB, "SELECT id FROM tool_versions WHERE id=?", id),
          ],
          check: ([result]) => {
            if (!result.results.length)
              throw new Fault(404, "tool_version_not_found");
          },
        },
      ),
    );
  },
);
api.get(
  "/tools/:slug",
  ...operation(
    "Read a tool and its versions",
    S.tool.extend({ versions: S.z.array(S.toolVersion) }),
    { tags: ["Tools"], auth: "optional", errors: [404] },
  ),
  async (c) => {
    const id = c.req.param("slug");
    const [tools, versions] = await c.env.DB.batch<any>([
      stmt(c.env.DB, "SELECT * FROM tools WHERE id=?", id),
      stmt(c.env.DB, "SELECT * FROM tool_versions WHERE tool_id=?", id),
    ]);
    const t = tools.results[0];
    if (!t) throw new Fault(404, "tool_not_found");
    return c.json({ ...t, versions: versions.results });
  },
);
api.get(
  "/tools/:slug/reports",
  ...operation("List reports for a tool", S.list(S.report), {
    tags: ["Reports"],
    auth: "optional",
    query: S.pagination,
  }),
  async (c) =>
    c.json(
      await listing(
        c,
        publicReport + ` WHERE t.id=? AND ${activeReport} AND ${reportLatest}`,
        [c.req.param("slug")],
        [{ sql: "p.id", key: "id", desc: true }],
      ),
    ),
);
api.get(
  "/resolve-api",
  ...operation(
    "Resolve a crate API path to its ID",
    S.z.object({ id: S.string }),
    {
      tags: ["APIs"],
      auth: "optional",
      query: S.z.object({ crate: S.string, version: S.string, path: S.string }),
      errors: [404],
    },
  ),
  async (c) => {
    const name = c.req.query("crate") || "",
      version = c.req.query("version") || "",
      path = c.req.query("path") || "";
    const a = await one(
      c.env.DB,
      `SELECT a.id FROM api_items a JOIN releases r ON r.id=a.release_id JOIN crates cr ON cr.id=r.crate_id WHERE cr.name=? AND r.version=? AND ${visibleAPI()} AND a.display_path IN (?,?)`,
      name,
      version,
      path,
      name.replaceAll("-", "_") + "::" + path,
    );
    if (!a) throw new Fault(404, "api_not_found");
    return c.json(a);
  },
);
export default api;
