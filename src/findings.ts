import { visibleAPI, apiOrigin, apiObservation } from "./recorded-api-sql";
import { Hono } from "hono";
import type { App, Ctx } from "./core";
import {
  Fault,
  one,
  stmt,
  guard,
  batch,
  now,
  uid,
  requireUser,
  jsonBody,
  positive,
  idempotent,
  listing,
  quota,
} from "./core";
import { operation } from "./openapi";
import * as S from "./schemas";
import type { z } from "zod";

type FindingInput = z.infer<typeof S.findingInput>;
const columns = "f.*,cr.name crate,rel.version,p.withdrawn_at";
const joins =
  "FROM findings f JOIN reports p ON p.id=f.report_id JOIN releases rel ON rel.id=p.release_id JOIN crates cr ON cr.id=rel.crate_id";
const select = `SELECT ${columns} ${joins}`;

async function origin(c: Ctx, id: number, write = false) {
  const p = await one(
    c.env.DB,
    `SELECT p.*,(SELECT MAX(revision_no) FROM report_revisions WHERE report_id=p.id) revision_no FROM reports p WHERE p.id=? AND p.visibility='public'`,
    id,
  );
  if (!p) throw new Fault(404, "report_not_found");
  if (write) {
    if (p.author_id !== requireUser(c).id) throw new Fault(403, "not_author");
    if (p.withdrawn_at) throw new Fault(409, "report_withdrawn");
  }
  return p;
}
async function current(c: Ctx, write = false) {
  const f = await one(
    c.env.DB,
    select + " WHERE f.id=? AND p.visibility='public'",
    c.req.param("id"),
  );
  if (!f) throw new Fault(404, "finding_not_found");
  if (write) await origin(c, f.report_id, true);
  return f;
}
// Correlated aggregates keep each page's content and related rows in one SQL
// snapshot, including pagination. Do not hydrate previously read finding rows.
function findingQuery(history = false) {
  return `SELECT ${columns},
    (SELECT json_group_array(json_object('id',id,'display_path',display_path)) FROM (
      SELECT a.id,a.display_path FROM finding_apis fa JOIN api_items a ON a.id=fa.api_item_id
      WHERE fa.finding_id=f.id ORDER BY a.display_path
    )) apis,
    (SELECT json_group_array(json_object(
      'id',id,'finding_id',finding_id,'kind',kind,'url',url,'version',version,
      'target_report_id',target_report_id,'target_revision_no',target_revision_no,
      'created_at',created_at,'deleted_at',deleted_at
    )) FROM (
      SELECT * FROM finding_links WHERE finding_id=f.id AND deleted_at IS NULL ORDER BY created_at,id
    )) links
    ${
      history
        ? `,(SELECT json_group_array(json_object(
      'id',id,'finding_id',finding_id,'edit_version',edit_version,'actor_id',actor_id,
      'action',action,'payload',payload,'created_at',created_at
    )) FROM (
      SELECT * FROM finding_events WHERE finding_id=f.id ORDER BY edit_version
    )) events`
        : ""
    }
    ${joins}`;
}
function decodeFinding(f: any) {
  return {
    ...f,
    apis: JSON.parse(f.apis),
    links: JSON.parse(f.links),
    ...(f.events === undefined ? {} : { events: JSON.parse(f.events) }),
  };
}
// The Report renders every anchor so stable fragment links also reach older
// findings. Histories are fetched separately when requested.
export async function reportFindings(db: D1Database, reportID: number) {
  const [found, apis, links] = await db.batch<any>([
    stmt(
      db,
      select +
        " WHERE f.report_id=? AND p.visibility='public' ORDER BY f.created_at,f.id",
      reportID,
    ),
    stmt(
      db,
      `SELECT fa.finding_id,a.*,${apiOrigin()} origin FROM finding_apis fa JOIN api_items a ON a.id=fa.api_item_id JOIN findings f ON f.id=fa.finding_id WHERE f.report_id=? ORDER BY a.display_path`,
      reportID,
    ),
    stmt(
      db,
      "SELECT l.* FROM finding_links l JOIN findings f ON f.id=l.finding_id WHERE f.report_id=? AND l.deleted_at IS NULL ORDER BY l.created_at,l.id",
      reportID,
    ),
  ]);
  return found.results.map((f: any) => ({
    ...f,
    apis: apis.results
      .filter((a: any) => a.finding_id === f.id)
      .map(apiObservation),
    links: links.results.filter((l: any) => l.finding_id === f.id),
  }));
}
export async function validateFinding(
  db: D1Database,
  input: unknown,
  releaseID: number,
  allowedRecordedAPIs: string[] = [],
): Promise<FindingInput> {
  const parsed = S.findingInput.safeParse(input);
  if (!parsed.success)
    throw new Fault(400, "invalid_finding", parsed.error.message);
  await validateAPIs(
    db,
    parsed.data.api_item_ids,
    releaseID,
    allowedRecordedAPIs,
  );
  return parsed.data;
}
async function validateAPIs(
  db: D1Database,
  ids: string[] | undefined,
  releaseID: number,
  allowedRecordedAPIs: string[] = [],
) {
  for (const id of ids ?? []) {
    if (
      !(await one(
        db,
        `SELECT a.id FROM api_items a WHERE a.id=? AND a.release_id=? AND (${visibleAPI()} OR a.id IN (SELECT value FROM json_each(?)))`,
        id,
        releaseID,
        JSON.stringify(allowedRecordedAPIs),
      ))
    )
      throw new Fault(400, "api_not_in_release");
  }
}
function activeGuard(c: Ctx, reportID: number) {
  return guard(
    c.env.DB,
    `EXISTS(SELECT 1 FROM reports p JOIN users u ON u.id=p.author_id WHERE p.id=? AND p.author_id=? AND p.visibility='public' AND p.withdrawn_at IS NULL AND u.status='active' AND u.accepted_terms_version=?)`,
    reportID,
    requireUser(c).id,
    c.env.TERMS_VERSION,
  );
}
function versionGuard(c: Ctx, f: any, version: number) {
  return [
    activeGuard(c, f.report_id),
    guard(
      c.env.DB,
      "EXISTS(SELECT 1 FROM findings WHERE id=? AND edit_version=?)",
      f.id,
      version,
    ),
  ];
}
function event(
  c: Ctx,
  id: string,
  version: number,
  action: string,
  payload: unknown,
) {
  return stmt(
    c.env.DB,
    "INSERT INTO finding_events VALUES(?,?,?,?,?,?,?)",
    uid(),
    id,
    version,
    requireUser(c).id,
    action,
    JSON.stringify(payload),
    now(),
  );
}
// These statements join the caller's batch, including the initial Report batch.
export function findingStatements(
  c: Ctx,
  input: FindingInput,
  reportID: number | string,
  revision: number,
  byKey = false,
  id = uid(),
) {
  const db = c.env.DB,
    time = now();
  const ref = byKey ? "(SELECT id FROM reports WHERE create_key=?)" : "?";
  return [
    stmt(
      db,
      `INSERT INTO findings(id,report_id,origin_revision_no,title,body,evidence_url,created_at,updated_at) VALUES(?,${ref},?,?,?,?,?,?)`,
      id,
      reportID,
      revision,
      input.title,
      input.body,
      input.evidence_url ?? null,
      time,
      time,
    ),
    ...(input.api_item_ids ?? []).map((api) =>
      stmt(db, "INSERT INTO finding_apis VALUES(?,?)", id, api),
    ),
    event(c, id, 1, "created", {
      ...input,
      validity: "reported",
      upstream_status: "not_reported",
    }),
  ];
}
// Check supporting evidence inside the same batch as the mutation. Removing the
// last supporting link must roll back along with its event and version increment.
function evidenceGuard(db: D1Database, id: string) {
  return guard(
    db,
    `EXISTS(SELECT 1 FROM findings f WHERE f.id=? AND (
    f.upstream_status='not_reported' OR EXISTS(SELECT 1 FROM finding_links l WHERE l.finding_id=f.id AND l.deleted_at IS NULL AND (
      (f.upstream_status IN ('reported_upstream','wont_fix') AND l.kind IN ('issue','pr')) OR
      (f.upstream_status='fix_proposed' AND l.kind='pr') OR
      (f.upstream_status='fix_merged' AND l.kind IN ('pr','commit')) OR
      (f.upstream_status='released' AND l.kind='release' AND l.version IS NOT NULL)
    ))))`,
    id,
  );
}
function duplicateGuard(db: D1Database, id: string) {
  return guard(
    db,
    `EXISTS(SELECT 1 FROM findings f WHERE f.id=? AND (f.duplicate_of IS NULL OR EXISTS(SELECT 1 FROM findings d JOIN reports p ON p.id=d.report_id WHERE d.id=f.duplicate_of AND p.visibility='public')))`,
    id,
  );
}
export const findings = new Hono<App>();
const writeOptions = {
  tags: ["Findings"],
  auth: "user" as const,
  write: true,
  errors: [400, 403, 404, 409, 428],
};
findings.get(
  "/reports/:id/findings",
  ...operation("List findings for a report", S.list(S.finding), {
    tags: ["Findings"],
    query: S.pagination,
    auth: "optional",
    errors: [404],
  }),
  async (c) => {
    const p = await origin(c, positive(c.req.param("id")));
    const data = await listing(
      c,
      findingQuery() + " WHERE f.report_id=? AND p.visibility='public'",
      [p.id],
      [
        { sql: "f.created_at", key: "created_at" },
        { sql: "f.id", key: "id" },
      ],
      decodeFinding,
    );
    return c.json(data);
  },
);
findings.get(
  "/crates/:name/:version/findings",
  ...operation("List active findings for a crate version", S.list(S.finding), {
    tags: ["Findings"],
    query: S.pagination,
    auth: "optional",
    errors: [404],
  }),
  async (c) => {
    const rel = await one(
      c.env.DB,
      "SELECT rel.id FROM releases rel JOIN crates cr ON cr.id=rel.crate_id WHERE cr.name=? AND rel.version=?",
      c.req.param("name"),
      c.req.param("version"),
    );
    if (!rel) throw new Fault(404, "release_not_found");
    const data = await listing(
      c,
      findingQuery() +
        " WHERE p.release_id=? AND p.visibility='public' AND p.withdrawn_at IS NULL AND f.validity NOT IN ('invalid','duplicate')",
      [rel.id],
      [
        { sql: "f.created_at", key: "created_at" },
        { sql: "f.id", key: "id" },
      ],
      decodeFinding,
    );
    return c.json(data);
  },
);
findings.get(
  "/findings/:id",
  ...operation("Read a finding and its event history", S.findingDetail, {
    tags: ["Findings"],
    auth: "optional",
    errors: [404],
  }),
  async (c) => {
    const f = await one(
      c.env.DB,
      findingQuery(true) + " WHERE f.id=? AND p.visibility='public'",
      c.req.param("id"),
    );
    if (!f) throw new Fault(404, "finding_not_found");
    return c.json(decodeFinding(f));
  },
);
findings.post(
  "/reports/:id/findings",
  ...operation("Add a finding to a report", S.z.object({ id: S.string }), {
    ...writeOptions,
    body: S.findingInput,
    idempotent: true,
    status: 201,
  }),
  async (c) => {
    const p = await origin(c, positive(c.req.param("id")), true);
    const b = await jsonBody(c),
      input = await validateFinding(c.env.DB, b, p.release_id);
    const candidate = uid();
    const id = await idempotent(
      c,
      "finding:" + p.id,
      b,
      candidate,
      async () => [
        activeGuard(c, p.id),
        guard(
          c.env.DB,
          "(SELECT MAX(revision_no) FROM report_revisions WHERE report_id=?)=?",
          p.id,
          p.revision_no,
        ),
        quota(c.env.DB, requireUser(c).id, "finding", 1000),
        ...findingStatements(c, input, p.id, p.revision_no, false, candidate),
      ],
    );
    return c.json({ id }, 201);
  },
);
findings.patch(
  "/findings/:id",
  ...operation(
    "Edit finding content or reported status",
    S.z.object({ edit_version: S.integer }),
    { ...writeOptions, body: S.editFinding },
  ),
  async (c) => {
    const f = await current(c, true),
      b = S.editFinding.parse(await jsonBody(c));
    if (b.edit_version !== f.edit_version)
      throw new Fault(409, "edit_conflict");
    const next = { ...f, ...b, edit_version: f.edit_version + 1 };
    if ((next.validity === "duplicate") !== (next.duplicate_of != null))
      throw new Fault(400, "duplicate_target_required");
    if (next.duplicate_of === f.id) throw new Fault(400, "duplicate_cycle");
    // PATCH validates supplied fields, not historical prose. Migrated bodies
    // may exceed today's authoring limit; status-only edits still work.
    await validateAPIs(
      c.env.DB,
      b.api_item_ids,
      (await origin(c, f.report_id)).release_id,
    );
    const ss = [
      ...versionGuard(c, f, b.edit_version),
      stmt(
        c.env.DB,
        "UPDATE findings SET title=?,body=?,evidence_url=?,validity=?,upstream_status=?,duplicate_of=?,edit_version=edit_version+1,updated_at=? WHERE id=?",
        next.title,
        next.body,
        next.evidence_url ?? null,
        next.validity,
        next.upstream_status,
        next.duplicate_of,
        now(),
        f.id,
      ),
    ];
    if (b.api_item_ids !== undefined)
      ss.push(
        stmt(c.env.DB, "DELETE FROM finding_apis WHERE finding_id=?", f.id),
        ...b.api_item_ids.map((api) =>
          stmt(c.env.DB, "INSERT INTO finding_apis VALUES(?,?)", f.id, api),
        ),
      );
    ss.push(
      duplicateGuard(c.env.DB, f.id),
      evidenceGuard(c.env.DB, f.id),
      event(c, f.id, next.edit_version, "edited", b),
    );
    await batch(c.env.DB, ss);
    return c.json({ edit_version: next.edit_version });
  },
);
findings.post(
  "/findings/:id/links",
  ...operation(
    "Add supporting evidence to a finding",
    S.z.object({ id: S.string, edit_version: S.integer }),
    {
      ...writeOptions,
      body: S.findingLinkInput,
      idempotent: true,
      status: 201,
    },
  ),
  async (c) => {
    const f = await current(c, true),
      b = S.findingLinkInput.parse(await jsonBody(c));
    if (b.kind === "release" && !b.version)
      throw new Fault(400, "release_version_required");
    if (
      b.kind !== "report" &&
      (b.target_report_id != null || b.target_revision_no != null)
    )
      throw new Fault(400, "unexpected_report_target");
    const ss: D1PreparedStatement[] = [];
    if (b.kind === "report") {
      if (!b.target_report_id || !b.target_revision_no)
        throw new Fault(400, "report_target_required");
      ss.push(
        guard(
          c.env.DB,
          `EXISTS(SELECT 1 FROM reports p JOIN report_revisions rr ON rr.report_id=p.id JOIN releases rel ON rel.id=p.release_id JOIN crates cr ON cr.id=rel.crate_id WHERE p.id=? AND rr.revision_no=? AND p.visibility='public' AND p.withdrawn_at IS NULL AND cr.name=?)`,
          b.target_report_id,
          b.target_revision_no,
          f.crate,
        ),
      );
      const canonical = new URL(
        `/report/${b.target_report_id}?v=${b.target_revision_no}`,
        c.env.APP_ORIGIN,
      ).href;
      if (b.url !== canonical)
        throw new Fault(400, "report_url_mismatch", `Use ${canonical}`);
    }
    const candidate = uid();
    const id = await idempotent(
      c,
      "finding_link:" + f.id,
      b,
      candidate,
      async () => [
        ...versionGuard(c, f, b.edit_version),
        ...ss,
        quota(c.env.DB, requireUser(c).id, "finding_link", 2000),
        stmt(
          c.env.DB,
          "INSERT INTO finding_links VALUES(?,?,?,?,?,?,?,?,NULL)",
          candidate,
          f.id,
          b.kind,
          b.url,
          b.version ?? null,
          b.target_report_id ?? null,
          b.target_revision_no ?? null,
          now(),
        ),
        stmt(
          c.env.DB,
          "UPDATE findings SET edit_version=edit_version+1,updated_at=? WHERE id=?",
          now(),
          f.id,
        ),
        event(c, f.id, b.edit_version + 1, "link_added", {
          id: candidate,
          ...b,
        }),
      ],
    );
    return c.json({ id, edit_version: b.edit_version + 1 }, 201);
  },
);
findings.delete(
  "/findings/:id/links/:link_id",
  ...operation(
    "Soft delete a finding link",
    S.z.object({ edit_version: S.integer }),
    {
      ...writeOptions,
      body: S.z.strictObject({ edit_version: S.integer.positive() }),
    },
  ),
  async (c) => {
    const f = await current(c, true),
      b = await jsonBody(c),
      version = positive(b.edit_version),
      id = c.req.param("link_id");
    await batch(c.env.DB, [
      ...versionGuard(c, f, version),
      guard(
        c.env.DB,
        "EXISTS(SELECT 1 FROM finding_links WHERE id=? AND finding_id=? AND deleted_at IS NULL)",
        id,
        f.id,
      ),
      stmt(
        c.env.DB,
        "UPDATE finding_links SET deleted_at=? WHERE id=? AND finding_id=?",
        now(),
        id,
        f.id,
      ),
      evidenceGuard(c.env.DB, f.id),
      stmt(
        c.env.DB,
        "UPDATE findings SET edit_version=edit_version+1,updated_at=? WHERE id=?",
        now(),
        f.id,
      ),
      event(c, f.id, version + 1, "link_deleted", { id }),
    ]);
    return c.json({ edit_version: version + 1 });
  },
);
