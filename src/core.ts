import { apiOrigin, recordedAPI } from "./recorded-api-sql";
import type { Context } from "hono";
export interface Env {
  ZULIP_ENABLED?: string;
  ZULIP_SITE?: string;
  ZULIP_CHANNEL_ID?: string;
  ZULIP_BOT_EMAIL?: string;
  ZULIP_API_KEY?: string;
  ZULIP_FAILURE_WEBHOOK_URL?: string;
  DB: D1Database;
  ARCHIVE: R2Bucket;
  JOBS: Queue;
  ASSETS: Fetcher;
  EMAIL?: {
    send(m: {
      from: string;
      to: string;
      subject: string;
      text: string;
      headers?: Record<string, string>;
    }): Promise<{ messageId: string }>;
  };
  ENVIRONMENT: string;
  EXTERNAL_FETCH_DISABLED?: string;
  APP_ORIGIN: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET?: string;
  TOKEN_SECRET?: string;
  EMAIL_DISABLED?: string;
  EMAIL_FROM: string;
  EMAIL_ALLOWLIST: string;
  ADMIN_GITHUB_IDS: string;
  TERMS_VERSION: string;
  SHOW_STAR_KARMA?: string;
  SHOW_HOME_DISCUSSION?: string;
  HOME_EXAMPLE_REPORT?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_D1_TOKEN?: string;
  DB_ID?: string;
  EMAIL_EVENT_SUBSCRIPTION?: string;
  EMAIL_DOMAIN?: string;
}
export type User = {
  id: string;
  github_id: number;
  username: string;
  role: string;
  status: string;
  accepted_terms_version: string;
  terms_accepted_at: string;
};
export type App = {
  Bindings: Env;
  Variables: {
    user: User | null;
    csrf: string;
    sessionHash: string;
    tokenId: string;
    requestId: string;
  };
};
export type Ctx = Context<App>;
export class Fault extends Error {
  constructor(
    public status: number,
    public code: string,
    message = code,
  ) {
    super(message);
  }
}
export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();
export const stmt = (db: D1Database, sql: string, ...args: unknown[]) =>
  db.prepare(sql).bind(...args);
export function decodeEvidence<T>(row: T): T {
  if (row && typeof (row as any).evidence_ref === "string")
    (row as any).evidence_ref = JSON.parse((row as any).evidence_ref);
  return row;
}
export const one = async <T = any>(
  db: D1Database,
  sql: string,
  ...args: unknown[]
) => decodeEvidence(await stmt(db, sql, ...args).first<T>());
export const rows = async <T = any>(
  db: D1Database,
  sql: string,
  ...args: unknown[]
) => (await stmt(db, sql, ...args).all<T>()).results.map(decodeEvidence);
export const hash = async (v: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)),
    ),
  )
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
export const random = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
export const isAdmin = (env: Env, githubId: number) =>
  (env.ADMIN_GITHUB_IDS || "")
    .split(",")
    .some((id) => id.trim() === String(githubId));
export const requireUser = (c: Ctx) => {
  const u = c.get("user");
  if (!u) throw new Fault(401, "sign_in_required");
  if (u.status !== "active") throw new Fault(403, "account_suspended");
  return u;
};
export const guard = (db: D1Database, condition: string, ...args: unknown[]) =>
  stmt(
    db,
    `INSERT INTO transaction_checks(ok) SELECT CASE WHEN ${condition} THEN 1 ELSE 0 END`,
    ...args,
  );
export async function batch(db: D1Database, ss: D1PreparedStatement[]) {
  try {
    return await db.batch([...ss, stmt(db, "DELETE FROM transaction_checks")]);
  } catch (e) {
    const msg = String(e);
    if (msg.includes("used<=lim")) throw new Fault(429, "daily_limit");
    if (/constraint|immutable|vote_forbidden|invalid_parent/i.test(msg))
      throw new Fault(
        409,
        "conflict",
        "The data changed or this operation is not allowed. Refresh and retry.",
      );
    throw e;
  }
}
export function quota(
  db: D1Database,
  subject: string,
  kind: string,
  lim: number,
) {
  return stmt(
    db,
    "INSERT INTO rate_limits VALUES(?,?,?,1,?) ON CONFLICT(subject,kind,bucket) DO UPDATE SET used=used+1",
    subject,
    kind,
    now().slice(0, 10),
    lim,
  );
}
export async function jsonBody(c: Ctx) {
  if (!c.req.header("content-type")?.includes("application/json"))
    throw new Fault(415, "json_required");
  const t = await c.req.text();
  if (new TextEncoder().encode(t).length > 131072)
    throw new Fault(413, "payload_too_large");
  try {
    const v = JSON.parse(t);
    if (!v || Array.isArray(v) || typeof v !== "object") throw 0;
    return v as Record<string, any>;
  } catch {
    throw new Fault(400, "invalid_json");
  }
}
export function text(v: unknown, name: string, max = 10000, required = false) {
  if (v !== undefined && typeof v !== "string")
    throw new Fault(400, "invalid_field", name);
  const s = ((v as string) || "").trim();
  if (s.length > max || (required && !s))
    throw new Fault(
      400,
      "invalid_field",
      `${name} ${!s ? "is required" : "is too long"}`,
    );
  return s;
}
export function positive(v: unknown) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new Fault(400, "invalid_id");
  return n;
}
export function url(v: unknown) {
  const s = text(v, "Evidence URL", 1000, true);
  try {
    if (!["https:", "http:"].includes(new URL(s).protocol)) throw 0;
  } catch {
    throw new Fault(400, "invalid_url");
  }
  return s;
}
export function page(c: Ctx) {
  const n = Number(c.req.query("cursor") || 0);
  if (!Number.isSafeInteger(n) || n < 0) throw new Fault(400, "invalid_cursor");
  return n;
}
export function paged<T>(data: T[], cursor: number) {
  return {
    items: data.slice(0, 30),
    next_cursor: data.length > 30 ? cursor + 30 : null,
  };
}
export async function idempotent(
  c: Ctx,
  op: string,
  input: unknown,
  resource: string,
  build: (key: string) => Promise<D1PreparedStatement[]>,
) {
  const u = requireUser(c);
  const key = c.req.header("Idempotency-Key");
  if (!key || !/^[a-zA-Z0-9_-]{16,100}$/.test(key))
    throw new Fault(400, "idempotency_key_required");
  const h = await hash(JSON.stringify(input));
  const lookup = () =>
    one(
      c.env.DB,
      "SELECT * FROM idempotency_keys WHERE user_id=? AND operation=? AND key=?",
      u.id,
      op,
      key,
    );
  const prior = await lookup();
  if (prior) {
    if (prior.request_hash !== h) throw new Fault(409, "idempotency_mismatch");
    return prior.resource_id as string;
  }
  const createKey = await hash(u.id + ":" + op + ":" + key);
  try {
    await batch(c.env.DB, [
      stmt(
        c.env.DB,
        "INSERT INTO idempotency_keys VALUES(?,?,?,?,?,?)",
        u.id,
        op,
        key,
        h,
        resource,
        now(),
      ),
      ...(await build(createKey)),
    ]);
  } catch (e) {
    const p = await lookup();
    if (p?.request_hash === h) return p.resource_id as string;
    throw e;
  }
  return resource;
}
export async function signToken(env: Env, value: string) {
  if (!env.TOKEN_SECRET) throw new Fault(503, "token_secret_missing");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.TOKEN_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
    ),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export async function verifyToken(env: Env, value: string, sig: string) {
  const expected = await signToken(env, value);
  let diff = expected.length ^ sig.length;
  for (let i = 0; i < expected.length; i++)
    diff |= expected.charCodeAt(i) ^ (sig.charCodeAt(i) || 0);
  return diff === 0;
}
// One policy supplies both profile computation and list/detail SQL projections.
export const karmaPolicy = {
  id: "report-stars-excluding-self/v1",
  sql(author: string) {
    return `COALESCE((SELECT score FROM karma_v1 WHERE author_id=${author}),0)`;
  },
  async compute(db: D1Database, user: string) {
    return (await one(db, `SELECT ${this.sql("?")} score`, user)).score;
  },
};
export const reportLatest = `rr.revision_no=(SELECT MAX(v.revision_no) FROM report_revisions v WHERE v.report_id=p.id)`;
export const reportColumns = `(SELECT json_group_array(json(v.toolchain_json)) FROM report_runs x JOIN verification_runs v ON v.id=x.run_id WHERE x.report_id=p.id AND x.revision_no=rr.revision_no) toolchains_json,p.id,p.release_id,p.author_id,p.visibility,p.withdrawn_at,p.created_at,p.updated_at,rr.revision_no,rr.title,rr.explanation,rr.trusted_assumptions,rr.environment,rr.evidence_url,rr.limitations,rr.tool_version_id,cr.name crate,rel.version,rel.yanked,u.username,t.id tool_id,t.name tool,tv.version tool_version,tv.limitations tool_limitations,tv.limitations_updated_at tool_limitations_updated_at,(SELECT MAX(v.revision_no) FROM report_revisions v WHERE v.report_id=p.id) latest_revision_no,(SELECT COUNT(*) FROM report_comments cm WHERE cm.report_id=p.id AND cm.deleted_at IS NULL AND cm.visibility='public') comment_count,(SELECT COUNT(*) FROM report_stars s WHERE s.report_id=p.id) star_count,${karmaPolicy.sql("p.author_id")} author_karma,(SELECT COUNT(*) FROM claim_revisions x WHERE x.report_id=p.id AND x.report_revision=rr.revision_no) claim_count,(SELECT COUNT(*) FROM report_dependencies d WHERE d.report_id=p.id AND d.revision_no=rr.revision_no) dependency_count,CASE WHEN p.withdrawn_at IS NULL THEN (SELECT COUNT(*) FROM findings f WHERE f.report_id=p.id AND f.validity NOT IN ('invalid','duplicate')) ELSE 0 END finding_count`;
export const reportJoins = `FROM reports p JOIN report_revisions rr ON rr.report_id=p.id JOIN releases rel ON rel.id=p.release_id JOIN crates cr ON cr.id=rel.crate_id LEFT JOIN users u ON u.id=p.author_id JOIN tool_versions tv ON tv.id=rr.tool_version_id JOIN tools t ON t.id=tv.tool_id`;
export const publicReport = `SELECT ${reportColumns} ${reportJoins}`;
export const publicClaim = `SELECT (SELECT v.toolchain_json FROM claim_evidence e JOIN verification_runs v ON v.id=e.run_id WHERE e.claim_id=c.id AND e.report_revision=r.report_revision) toolchain_json,(SELECT json_object('run_id',e.run_id,'harness',e.harness) FROM claim_evidence e WHERE e.claim_id=c.id AND e.report_revision=r.report_revision) evidence_ref,c.id,(r.position+1) claim_number,c.report_id,c.api_item_id,c.created_at,r.report_revision,r.position,r.title,r.precondition,r.explanation,r.trusted_assumptions,r.evidence_url,r.limitations,a.kind,m.category,m.trait_path,m.self_type,m.method_name,m.is_blanket,a.display_path,${apiOrigin()} origin,CASE WHEN ${recordedAPI()} THEN NULL ELSE a.is_unsafe END is_unsafe,a.signature,a.upstream_url,p.author_id,p.withdrawn_at,p.visibility,rr.title report_title,rr.explanation shared_explanation,rr.trusted_assumptions shared_trusted_assumptions,rr.evidence_url shared_evidence_url,rr.limitations shared_limitations,rr.environment,rr.tool_version_id,cr.name crate,rel.version,u.username,t.name tool,tv.version tool_version,tv.limitations tool_limitations,tv.limitations_updated_at tool_limitations_updated_at,(SELECT MAX(v.revision_no) FROM report_revisions v WHERE v.report_id=p.id) latest_report_revision,(SELECT COUNT(*) FROM claim_stars s WHERE s.claim_id=c.id) star_count,(SELECT COUNT(*) FROM report_stars s WHERE s.report_id=p.id) report_star_count,(SELECT COUNT(*) FROM report_comments cm WHERE cm.report_id=p.id AND cm.deleted_at IS NULL AND cm.visibility='public') report_comment_count,${karmaPolicy.sql("p.author_id")} author_karma,EXISTS(SELECT 1 FROM claim_revisions x WHERE x.claim_id=c.id AND x.report_revision=(SELECT MAX(v.revision_no) FROM report_revisions v WHERE v.report_id=p.id)) in_current_report FROM claims c JOIN claim_revisions r ON r.claim_id=c.id JOIN api_items a ON a.id=c.api_item_id LEFT JOIN api_item_metadata m ON m.api_item_id=a.id JOIN reports p ON p.id=c.report_id JOIN report_revisions rr ON rr.report_id=p.id AND rr.revision_no=r.report_revision JOIN releases rel ON rel.id=p.release_id JOIN crates cr ON cr.id=rel.crate_id LEFT JOIN users u ON u.id=p.author_id JOIN tool_versions tv ON tv.id=rr.tool_version_id JOIN tools t ON t.id=tv.tool_id`;
export const latest = `r.report_revision=(SELECT MAX(v.revision_no) FROM report_revisions v WHERE v.report_id=p.id)`;
// Preflight reads share the listing transaction; check runs before rows are exposed.
type ListingPreflight = {
  statements: D1PreparedStatement[];
  check: (results: D1Result<any>[]) => void;
};
export async function listing(
  c: Ctx,
  sql: string,
  bindings: unknown[],
  order: { sql: string; key: string; desc?: boolean }[],
  map: (row: any) => any = (x) => x,
  preflight?: ListingPreflight,
) {
  let query: ReturnType<typeof prepareListing>;
  try {
    query = prepareListing(c, sql, bindings, order, map);
  } catch (error) {
    // Preserve not-found precedence over malformed cursors on guarded routes.
    if (preflight) preflight.check(await c.env.DB.batch(preflight.statements));
    throw error;
  }
  if (!preflight)
    return query.finish((await query.statement.all<any>()).results);
  const results = await c.env.DB.batch<any>([
    ...preflight.statements,
    query.statement,
  ]);
  preflight.check(results.slice(0, -1));
  return query.finish(results.at(-1)!.results);
}
// Keyset cursors keep pagination stable when new rows are inserted between requests.
function prepareListing(
  c: Ctx,
  sql: string,
  bindings: unknown[],
  order: { sql: string; key: string; desc?: boolean }[],
  map: (row: any) => any = (x) => x,
) {
  let values: any[] | null = null;
  const raw = c.req.query("cursor");
  if (raw && raw !== "0") {
    try {
      values = JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(
            atob(raw.replace(/-/g, "+").replace(/_/g, "/")),
            (ch) => ch.charCodeAt(0),
          ),
        ),
      );
      if (
        !Array.isArray(values) ||
        values.length !== order.length ||
        values.some((v) => !["string", "number"].includes(typeof v))
      )
        throw 0;
    } catch {
      throw new Fault(400, "invalid_cursor");
    }
  }
  if (values) {
    const alternatives = order.map(
      (o, i) =>
        "(" +
        order
          .slice(0, i)
          .map((p) => p.sql + "=?")
          .concat(o.sql + (o.desc ? "<" : ">") + "?")
          .join(" AND ") +
        ")",
    );
    sql += " AND (" + alternatives.join(" OR ") + ")";
    for (let i = 0; i < order.length; i++)
      bindings.push(...values.slice(0, i + 1));
  }
  sql +=
    " ORDER BY " +
    order.map((o) => o.sql + (o.desc ? " DESC" : " ASC")).join(",") +
    " LIMIT 31";
  return {
    statement: stmt(c.env.DB, sql, ...bindings),
    finish(result: any[]) {
      const items = result.slice(0, 30),
        last = items.at(-1);
      return {
        items: items.map((item) => map(decodeEvidence(item))),
        next_cursor:
          result.length > 30
            ? btoa(
                String.fromCharCode(
                  ...new TextEncoder().encode(
                    JSON.stringify(order.map((o) => last[o.key])),
                  ),
                ),
              )
                .replace(/\+/g, "-")
                .replace(/\//g, "_")
                .replace(/=+$/, "")
            : null,
      };
    },
  };
}
