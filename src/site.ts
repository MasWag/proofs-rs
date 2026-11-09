import { reportShare } from "../web/report-share";
import { resolveSocialCard, cardMetadata } from "./social-card";
import { reportFindings } from "./findings";
import { pageLayout } from "../web/page-layout";
import type { Ctx } from "./core";
import { Fault, rows, one, latest } from "./core";
import { legal } from "../web/legal";
import {
  apiKindLabel,
  itemPathHTML,
  renderAPICatalog,
  signatureHTML,
} from "../web/api-catalog";
import { renderRecordedRun } from "../web/recorded-run";
import { reportDiscussion } from "./api";
import { createViews } from "./site-views";
import { dependencyCatalog } from "./dependencies";
import {
  githubIssueTemplates,
  githubIssueDraft,
  githubIssueURL,
  upstreamRepository,
} from "./github-issue";

export type SiteFetch = (request: Request) => Promise<Response>;
const enc = encodeURIComponent;
const escape = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
// Book guides for recording with a tool. Staging fixtures ("demo-kani")
// share the real tool's guide.
const toolGuides: Record<string, { href: string; title: string }> = {
  kani: { href: "/book/kani.html", title: "Record with Kani" },
  creusot: { href: "/book/creusot.html", title: "Record with Creusot" },
  aeneas: { href: "/book/aeneas.html", title: "Record with Aeneas and Lean" },
};
function toolGuide(id: string) {
  const guide = toolGuides[id.replace(/^demo-/, "")];
  return guide
    ? `<p><a href="${guide.href}">Guide: ${guide.title}</a></p>`
    : "";
}
// Shown wherever a crate has no reports, so readers do not take its absence
// as a verdict.
function unlistedCrate(name = "") {
  return `<p>${name ? `<code>${escape(name)}</code> has` : "No matching crate has"} no published reports yet. Not being listed says nothing about a crate's quality.</p><p><a href="/crates">Browse all crates</a> · <a href="/book/read-a-report.html">How reports work</a> · <a href="/book/publish-a-report.html">Publish a report</a></p>`;
}
// Readers see these instead of internal error codes.
const notFoundMessages: Record<string, string> = {
  api_not_found: "This API is not in any published catalogue.",
  claim_not_found: "This claim does not exist or is no longer public.",
  finding_not_found: "This finding does not exist or is no longer public.",
  report_not_found: "This report does not exist or is no longer public.",
  revision_not_found: "This report revision does not exist.",
  run_not_found: "This recorded run does not exist.",
  run_not_in_report: "This recorded run is not part of the report.",
  tool_not_found: "This verification tool is not registered.",
  tool_version_not_found: "This tool version is not registered.",
  user_not_found: "This user does not exist.",
};
const pageNames = new Set([
  "",
  "crates",
  "crate",
  "api",
  "reports",
  "report",
  "finding",
  "claim",
  "login",
  "signup",
  "terms-update",
  "user",
  "account",
  "my-reports",
  "my-comments",
  "my-starred-reports",
  "my-starred-claims",
  "admin",
  "settings",
  "device",
  "tool-version",
  "tools",
  "tool",
  "unsubscribe",
  "terms",
  "privacy",
  "contact",
  "about",
  "publish",
  "runs",
]);
export function isSitePage(path: string) {
  const parts = path.split("/").filter(Boolean);
  return (
    pageNames.has(parts[0] || "") &&
    !(parts[0] === "api" && ["v1", "docs"].includes(parts[1]))
  );
}
function safeBack(value: unknown) {
  const path = String(value || "/");
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\r\n]/.test(path))
    return "/";
  const url = new URL(path, "https://local");
  return url.origin === "https://local" &&
    (isSitePage(url.pathname) ||
      url.pathname === "/book" ||
      url.pathname.startsWith("/book/"))
    ? url.pathname + url.search + url.hash
    : "/";
}
function localRequest(
  c: Ctx,
  path: string,
  method = "GET",
  body?: unknown,
  csrf = "",
  key?: string,
) {
  const headers = new Headers({ Cookie: c.req.header("cookie") || "" });
  // Preserve the edge-provided address for API rate limits in internal requests.
  const ip = c.req.header("cf-connecting-ip");
  if (ip) headers.set("CF-Connecting-IP", ip);
  if (method !== "GET") {
    headers.set("Origin", c.req.header("origin") || "");
    headers.set("X-CSRF-Token", csrf);
    headers.set("Content-Type", "application/json");
    if (key) headers.set("Idempotency-Key", key);
  }
  return new Request(
    new URL(path.startsWith("/auth/") ? path : "/api/v1" + path, c.req.url),
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}
function accountNavigation(c: Ctx, me: any) {
  const login =
    "/auth/github?return_to=" + enc(c.req.path + new URL(c.req.url).search);
  const stars = c.env.SHOW_STAR_KARMA === "true";
  return me.user
    ? `<details><summary>${escape(me.user.username)}</summary><div class="profile-menu"><a href="/account">My activity${stars ? ` (${escape(me.karma)} karma)` : ""}</a><a href="/settings">Settings</a>${me.user.role === "admin" ? '<a href="/admin/catalogs">Catalogs</a>' : ""}<form method="post" action="/_actions/logout"><input type="hidden" name="_csrf" value="${escape(me.csrf)}"><button>Sign out</button></form></div></details>`
    : `<div class="signin"><a href="${escape(login)}">Sign in with GitHub</a></div>`;
}
function layout(
  c: Ctx,
  title: string,
  body: string,
  me: any = { user: null },
  canonicalPath?: string,
  metadata?: Parameters<typeof pageLayout>[6],
) {
  const account = accountNavigation(c, me);
  const canonical = new URL(
    canonicalPath ?? c.req.path + new URL(c.req.url).search,
    c.env.APP_ORIGIN,
  ).href;
  return pageLayout(
    title,
    body,
    account,
    canonical,
    undefined,
    false,
    metadata,
  );
}
export async function sitePage(c: Ctx, fetch: SiteFetch): Promise<Response> {
  c.header("Cache-Control", "private, no-store");
  const current = new URL(c.req.url);
  let me: any = { user: null };
  const get = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(localRequest(c, path, method, body, me.csrf));
    const value: any = await response.json();
    if (!response.ok)
      throw new Fault(
        response.status,
        value.error || "request_failed",
        value.message || value.error,
      );
    return value;
  };
  let canonicalPath: string | undefined;
  let metadata: Parameters<typeof pageLayout>[6];
  const result = async (title: string, body: string, status = 200) => {
    if (status === 200 && !metadata) {
      const card = await resolveSocialCard(current, get).catch(() => null);
      if (card) {
        metadata = cardMetadata(card, c.env.APP_ORIGIN);
        canonicalPath ??= card.path;
      }
    }
    return new Response(layout(c, title, body, me, canonicalPath, metadata), {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
      },
    });
  };
  try {
    const parts = current.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          throw new Fault(400, "invalid_path");
        }
      });
    const [p = "", id] = parts;
    if (p === "about" || p === "publish")
      return c.redirect(
        p === "about" ? "/book/" : "/book/publish-a-report.html",
        302,
      );
    if (p.startsWith("my-"))
      return c.redirect("/account?section=" + enc(p.slice(3)), 302);
    me = await get("/me");
    const config = {
      show_star_karma: c.env.SHOW_STAR_KARMA === "true",
      show_home_discussion: c.env.SHOW_HOME_DISCUSSION === "true",
      login_url:
        "/auth/github?return_to=" + enc(current.pathname + current.search),
    };
    const back = current.pathname + current.search;
    const action = (
      name: string,
      fields: Record<string, unknown>,
      label: string,
      csrf = me.csrf || "",
      buttonAttributes = "",
    ) =>
      `<form class="inline-action" method="post" action="/_actions/${enc(name)}">${Object.entries(
        { _csrf: csrf, _back: back, ...fields },
      )
        .map(
          ([k, v]) =>
            `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`,
        )
        .join("")}<button ${buttonAttributes}>${escape(label)}</button></form>`;
    const navigateButton = (
      fields: Record<string, unknown>,
      label: string,
      buttonAttributes = "",
    ) =>
      `<form class="inline-action" method="get" action="${escape(current.pathname)}">${Object.entries(
        fields,
      )
        .map(
          ([k, v]) =>
            `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`,
        )
        .join("")}<button ${buttonAttributes}>${escape(label)}</button></form>`;
    const confirmation = (message: string, submit: string, cancel: string) =>
      `<dialog open class="confirmation-dialog"><p>${escape(message)}</p><div class="form-actions">${submit}<a class="button-link" href="${escape(cancel)}">Cancel</a></div></dialog>`;
    const v = createViews(me, config, action, {
      addIssue:
        p === "finding" && current.searchParams.get("add_issue") === "1",
    });
    const {
      esc,
      date,
      badge,
      statusBadge,
      user,
      breadcrumbs,
      crateCrumbs,
      claimCrumbs,
      claimItem,
      findingItem,
      findingForm,
      reportSummary,
      reportContent,
      reportBody,
      reportAPIs,
      reportOutline,
      claimContent,
    } = v;
    const search = (q = "") =>
      `<form action="/crates" method="get" class="searchbar"><input name="q" value="${esc(q)}" aria-label="Crate name" placeholder="Search crates"><button>Search</button></form>`;
    const login = () =>
      result(
        "Sign in",
        `<h1>Sign in</h1>${c.env.GITHUB_CLIENT_ID && c.env.GITHUB_CLIENT_SECRET ? `<p><a href="/auth/github?return_to=${enc(p === "login" ? safeBack(current.searchParams.get("return_to") || "/account") : back)}">Sign in with GitHub</a></p>` : "<p>GitHub sign-in is currently unavailable.</p>"}`,
      );
    const pagination = (data: any, cursorName = "cursor") => {
      let html = "";
      if (current.searchParams.has(cursorName)) {
        const first = new URL(current);
        first.searchParams.delete(cursorName);
        html += `<a href="${esc(first.pathname + first.search)}">First page</a> `;
      }
      if (data.next_cursor !== null && data.next_cursor !== undefined) {
        const next = new URL(current);
        next.searchParams.set(cursorName, String(data.next_cursor));
        html += `<a rel="next" href="${esc(next.pathname + next.search)}">Next →</a>`;
      }
      return html
        ? `<nav class="pagination" aria-label="Pagination">${html}</nav>`
        : "";
    };
    const list = async (
      path: string,
      render: (item: any) => string = reportSummary,
      cursorName = "cursor",
      empty = "No results.",
    ) => {
      const url = new URL(path, "https://local");
      const cursor = current.searchParams.get(cursorName);
      if (cursor) url.searchParams.set("cursor", cursor);
      const data = await get(url.pathname + url.search);
      return (
        (data.items.map((item: any) => render(item)).join("") ||
          `<p>${empty}</p>`) + pagination(data, cursorName)
      );
    };
    if (p in legal) {
      const page = legal[p];
      return result(page.title, `<h1>${esc(page.title)}</h1>${page.body}`);
    }
    if (p === "login") return login();
    if (
      ["account", "settings", "terms-update", "admin"].includes(p) &&
      !me.user
    )
      return login();
    if (me.terms_required && ["account", "device", "admin"].includes(p))
      return c.redirect("/terms-update?return_to=" + enc(back), 302);
    if (!p) {
      const data = await get("/home");
      // An operator-chosen small report that first-time readers can learn from.
      const example = c.env.HOME_EXAMPLE_REPORT
        ? await get(`/reports/${enc(c.env.HOME_EXAMPLE_REPORT)}`).catch(
            () => null,
          )
        : null;
      return result(
        "Rust API verification",
        `<section class="home-search"><h1>proofs.rs</h1><p class="home-lede">Formal verification results for Rust crates, organized by crate, version and API. Each report states what was proved, under which assumptions, and with what evidence.</p>${search()}<p><a href="https://proofs-rs.zulipchat.com/">Join our community on Zulip</a></p></section><nav class="home-paths" aria-label="Get started"><a href="/book/read-a-report.html"><strong>Read a report</strong><span>What claims, findings and evidence tell you</span></a><a href="/book/publish-a-report.html"><strong>Publish a report</strong><span>Record Kani, Creusot or Aeneas results with <code>cargo proofs</code></span></a><a href="/contact"><strong>Ask or give feedback</strong><span>Report comments, GitHub issues and Zulip</span></a></nav>${example && !example.withdrawn_at ? `<section class="home-example"><h2>Start with an example</h2><p>A one-claim report that is quick to read end to end: the Overview says what holds, the Claim names the API, and Evidence shows how to rerun it.</p>${reportSummary({ ...example, claim_count: example.claim_count ?? example.claims?.length ?? 0 })}</section>` : ""}<div class="home-columns${config.show_home_discussion ? "" : " home-single-column"}"><section><h2>Recent reports</h2>${data.reports.map((item: any) => reportSummary(item)).join("") || "<p>No reports yet.</p>"}</section>${config.show_home_discussion ? `<section><h2>Latest discussion</h2>${data.discussion.map((cm: any) => `<article><a href="/report/${cm.report_id}?comment=${enc(cm.id)}#comment-${enc(cm.id)}">Report #${cm.report_id} · comment #${cm.sequence_no}</a><p>${esc(cm.body.slice(0, 200))}</p><p class="meta">${user(cm.author_id, cm.username)} · ${date(cm.created_at)}</p></article>`).join("") || "<p>No comments yet.</p>"}</section>` : ""}</div><p class="home-trust">Publication is not certification. Reports record the authors' own runs; proofs.rs does not re-run them. <a href="/book/">How to judge a report →</a></p>`,
      );
    }
    if (p === "crates" && id) {
      if (parts[3]) {
        const a = await get(
          "/resolve-api?" +
            new URLSearchParams({
              crate: id,
              version: parts[2],
              path: parts[3],
            }),
        );
        return c.redirect("/api/" + enc(a.id), 302);
      }
      return c.redirect(
        "/crate/" + enc(id) + (parts[2] ? "?version=" + enc(parts[2]) : ""),
        302,
      );
    }
    if (p === "crates") {
      const q = current.searchParams.get("q") || "";
      const data = await get(
        "/crates?" +
          new URLSearchParams({
            q,
            cursor: current.searchParams.get("cursor") || "0",
          }),
      );
      return result(
        "Crates",
        `<h1>Crates</h1>${search(q)}<p class="meta">${q ? `${data.matching_count} matching · ` : ""}${data.total_count} crates total</p><div class="table-wrap"><table class="crate-list"><thead><tr><th>Crate</th><th class="numeric" title="Distinct API paths across versions with public reports">APIs</th><th class="numeric">Reports</th><th class="numeric">Claims</th><th>Updated</th></tr></thead><tbody>${data.items.map((item: any) => `<tr><td><a href="/crate/${enc(item.name)}">${esc(item.name)}</a></td><td class="numeric">${item.api_count}</td><td class="numeric">${item.report_count}</td><td class="numeric">${item.claim_count}</td><td><time datetime="${esc(item.updated_at)}" title="${date(item.updated_at)}">${esc(item.updated_at?.slice(0, 10) || "—")}</time></td></tr>`).join("") || '<tr><td colspan="5">No matching crates.</td></tr>'}</tbody></table></div>${data.items.length ? "" : unlistedCrate(q)}${pagination(data)}`,
      );
    }
    if (p === "crate" && id) {
      const section = current.searchParams.get("section");
      if (
        section === "apis" ||
        section === "reports" ||
        section === "findings"
      ) {
        current.searchParams.delete("section");
        return c.redirect(
          current.pathname + current.search + "#" + section,
          302,
        );
      }
      const releases = await get("/crates/" + enc(id) + "/releases");
      const version =
        current.searchParams.get("version") || releases.default_version;
      if (!version)
        return result(
          `${id} not found`,
          `${breadcrumbs([{ label: "crates", href: "/crates" }])}<h1>${esc(id)}</h1>${unlistedCrate(id)}`,
          404,
        );
      const canonical = new URL(`/crate/${enc(id)}`, c.env.APP_ORIGIN);
      if (version !== releases.default_version)
        canonical.searchParams.set("version", version);
      const badgeEndpoint = new URL(
        `/api/v1/crates/${enc(id)}/${enc(version)}/badge`,
        c.env.APP_ORIGIN,
      );
      const badgeURL = `https://img.shields.io/endpoint?url=${enc(badgeEndpoint.href)}`;
      const badgeTarget = new URL(`/crate/${enc(id)}`, c.env.APP_ORIGIN);
      badgeTarget.searchParams.set("version", version);
      const badgeMarkdown = `[![proofs.rs](${badgeURL})](${badgeTarget.href})`;
      const badge = `<div class="crate-badge"><a href="${esc(badgeTarget.href)}"><img src="${esc(badgeURL)}" alt="proofs.rs claims for ${esc(id)} ${esc(version)}" height="20"></a><details><summary>README badge</summary><p class="meta">Claims in public reports for version ${esc(version)}.</p><button type="button" data-copy-badge>Copy Markdown</button><span role="status" data-copy-status></span><pre tabindex="0"><code>${esc(badgeMarkdown)}</code></pre></details></div>`;
      const cursor = current.searchParams.get("cursor");
      if (cursor) canonical.searchParams.set("cursor", cursor);
      canonicalPath = canonical.pathname + canonical.search;
      const apis = await get(`/crates/${enc(id)}/${enc(version)}/apis`);
      const claimedAPIs = apis.items.filter(
        (a: any) => a.claim_count > 0,
      ).length;
      const catalogWarning = apis.catalog_warnings?.length
        ? `<p class="warning"><strong>Documentation import is incomplete.</strong> ${apis.catalog_warnings.length} public export${apis.catalog_warnings.length === 1 ? "" : "s"} could not be resolved in the upstream rustdoc JSON: ${apis.catalog_warnings.map((w: any) => `<code>${esc(w.path)}</code>`).join(", ")}. APIs missing from that JSON cannot be mapped from documentation. Counts cover catalogued APIs only.</p>`
        : "";
      // Same visibility and validity rules as the Findings count below.
      const findingsByAPI = new Map(
        (
          await rows(
            c.env.DB,
            "SELECT fa.api_item_id id, COUNT(DISTINCT f.id) n FROM finding_apis fa JOIN findings f ON f.id=fa.finding_id JOIN reports p ON p.id=f.report_id JOIN releases r ON r.id=p.release_id JOIN crates c ON c.id=r.crate_id WHERE c.name=? AND r.version=? AND p.visibility='public' AND p.withdrawn_at IS NULL AND f.validity NOT IN ('invalid','duplicate') GROUP BY fa.api_item_id",
            id,
            version,
          )
        ).map((x: any) => [x.id, x.n]),
      );
      for (const a of apis.items)
        a.finding_count = findingsByAPI.get(a.id) ?? 0;
      const counts = await rows(
        c.env.DB,
        "SELECT COUNT(*) AS n FROM reports p JOIN releases r ON r.id=p.release_id JOIN crates c ON c.id=r.crate_id WHERE c.name=? AND r.version=? AND p.visibility='public' AND p.withdrawn_at IS NULL",
        id,
        version,
      );
      const findingCursor = current.searchParams.get("findings_cursor");
      const crateFindings = await get(
        `/crates/${enc(id)}/${enc(version)}/findings${findingCursor ? `?cursor=${enc(findingCursor)}` : ""}`,
      );
      const findingCount = await rows(
        c.env.DB,
        "SELECT COUNT(*) n FROM findings f JOIN reports p ON p.id=f.report_id JOIN releases r ON r.id=p.release_id JOIN crates c ON c.id=r.crate_id WHERE c.name=? AND r.version=? AND p.visibility='public' AND p.withdrawn_at IS NULL AND f.validity NOT IN ('invalid','duplicate')",
        id,
        version,
      );
      // Keep pagination pinned to the version the reader selected (including
      // when the first page used the default version).
      current.searchParams.set("version", version);
      const linkNames: Record<string, string> = {
        issue: "Issue",
        pr: "PR",
        commit: "Commit",
        release: "Release",
        report: "Revalidation report",
      };
      const findingRows = crateFindings.items
        .map((f: any) => {
          return `<tr><td><a href="/finding/${enc(f.id)}">${esc(f.title)}</a></td><td class="status-cell">${statusBadge(f.validity)}${f.upstream_status !== "not_reported" ? `<br>${statusBadge(f.upstream_status)}` : ""}</td><td><a href="/report/${f.report_id}?v=${f.origin_revision_no}">#${f.report_id} · v${f.origin_revision_no}</a></td><td>${f.links.map((l: any) => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(linkNames[l.kind])}${l.version ? ` · ${esc(l.version)}` : ""}</a>`).join("<br>") || "—"}</td></tr>`;
        })
        .join("");
      const findingSection = `<section aria-labelledby="findings"><h2 id="findings">Findings (${findingCount[0].n})</h2><p class="meta">For version ${esc(version)}. Statuses are author reported.</p>${findingRows ? `<div class="table-wrap"><table class="crate-findings" aria-label="Findings for ${esc(version)}"><thead><tr><th scope="col">Finding</th><th scope="col">Status</th><th scope="col">Report</th><th scope="col">Links</th></tr></thead><tbody>${findingRows}</tbody></table></div>` : "<p>No findings reported for this version.</p>"}${pagination(crateFindings, "findings_cursor")}</section>`;
      const reports = await list(
        `/crates/${enc(id)}/${enc(version)}/reports`,
        (x) => reportSummary(x, true),
      );
      return result(
        `${id} ${version}`,
        `${breadcrumbs([{ label: "crates", href: "/crates" }])}<h1>${esc(id)} ${esc(version)}</h1>${badge}${releases.description ? `<p>${esc(releases.description)}</p>` : ""}<p><a href="https://crates.io/crates/${enc(id)}/${enc(version)}" target="_blank" rel="noopener noreferrer">crates.io</a></p><form method="get" action="/crate/${enc(id)}" data-version-selector><label>Version <select name="version" aria-label="Version">${releases.items.map((r: any) => `<option value="${esc(r.version)}"${r.version === version ? " selected" : ""}>${esc(r.version)}${r.yanked ? " (yanked)" : ""}</option>`).join("")}</select></label></form>${catalogWarning}<nav class="filterbar" aria-label="Sections for version ${esc(version)}"><a href="#reports">${counts[0].n} report${counts[0].n === 1 ? "" : "s"}</a> · <a href="#findings">${findingCount[0].n} finding${findingCount[0].n === 1 ? "" : "s"}</a> · <a href="#apis">${claimedAPIs} of ${apis.items.length} catalogued API${apis.items.length === 1 ? "" : "s"} with claims</a></nav><h2 id="reports">Reports (${counts[0].n})</h2>${reports}${findingSection}<h2 id="apis">APIs (${apis.items.length})</h2><p class="meta">APIs are imported from documentation or named in published verification records. ${claimedAPIs} ${claimedAPIs === 1 ? "has" : "have"} at least one claim; a count says nothing about how strong each claim is.</p><form class="api-filter" data-api-filter hidden><input type="search" aria-label="Filter APIs" placeholder="Filter APIs"><label><input type="checkbox" name="claimed"> With claims</label><label><input type="checkbox" name="found"> With findings</label><span role="status" class="meta"></span></form>${renderAPICatalog(apis.items, id)}`,
      );
    }
    if (p === "api" && id) {
      if (parts[2]) {
        const releases = await get("/crates/" + enc(id) + "/releases");
        const a = await get(
          "/resolve-api?" +
            new URLSearchParams({
              crate: id,
              version:
                current.searchParams.get("v") || releases.default_version || "",
              path: parts[2],
            }),
        );
        return c.redirect("/api/" + enc(a.id), 302);
      }
      const a = await get("/apis/" + enc(id));
      const counts = await rows(
        c.env.DB,
        `SELECT COUNT(*) n FROM claims c JOIN reports p ON p.id=c.report_id JOIN claim_revisions r ON r.claim_id=c.id WHERE c.api_item_id=? AND p.visibility='public' AND p.withdrawn_at IS NULL AND ${latest}`,
        id,
      );
      return result(
        a.display_path,
        `${breadcrumbs(crateCrumbs(a, "apis"))}<p class="item-kind">${esc(apiKindLabel(a))}</p><h1 class="code">${itemPathHTML(a.display_path)}</h1>${a.is_unsafe ? "<p><strong>unsafe API — callers must uphold its safety requirements.</strong></p>" : ""}${a.origin === "recorded" ? `<p>Named in an author’s verification record. Signature and safety are not independently recorded.</p>` : `<pre class="signature">${signatureHTML(a.signature)}</pre><p><a href="${esc(a.upstream_url)}" target="_blank" rel="noopener noreferrer">Documentation on docs.rs</a></p>`}<h2 id="claims">Claims (${counts[0].n})</h2>${await list("/apis/" + enc(id) + "/claims", claimItem)}`,
      );
    }
    if (p === "reports") {
      const filters = new URLSearchParams();
      for (const name of ["q", "tool", "author"]) {
        const value = current.searchParams.get(name)?.trim();
        if (value) filters.set(name, value);
      }
      const filtered = filters.size > 0;
      const [tools, reports] = await Promise.all([
        get("/tools"),
        list(
          "/reports?" + filters,
          reportSummary,
          "cursor",
          filtered ? "No matching reports." : "No reports yet.",
        ),
      ]);
      const value = (name: string) => esc(filters.get(name) || "");
      const form = `<form method="get" action="/reports" class="searchbar report-filters"><input name="q" type="search" value="${value("q")}" aria-label="Title or crate" placeholder="Title or crate"><select name="tool" aria-label="Tool"><option value="">All tools</option>${tools.items.map((t: any) => `<option value="${esc(t.id)}"${t.id === filters.get("tool") ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select><input name="author" value="${value("author")}" aria-label="Author" placeholder="Author"><button>Filter</button>${filtered ? ' <a href="/reports">Clear</a>' : ""}</form>`;
      return result("Reports", `<h1>Reports</h1>${form}${reports}`);
    }
    if ((p === "report" || p === "claim") && id && parts[2] === "stars") {
      const item = await get(`/${p}s/${enc(id)}`);
      if (!config.show_star_karma) return c.redirect(`/${p}/${enc(id)}`, 302);
      return result(
        "Stars",
        `${breadcrumbs(p === "claim" ? claimCrumbs(item) : crateCrumbs(item, "reports"))}<h1>Stars</h1>${await list(`/${p}s/${enc(id)}/stars`, (u) => `<p>${user(u.id, u.username)}</p>`)}`,
      );
    }
    if (p === "claim" && id) {
      const revision = current.searchParams.get("report_revision");
      const item = await get(
        "/claims/" +
          enc(id) +
          (revision ? "?report_revision=" + enc(revision) : ""),
      );
      return result(
        `Claim #${item.claim_number} — ${item.title}`,
        `${breadcrumbs(claimCrumbs(item))}${!item.in_current_report ? "<p><strong>This claim is not included in the current report.</strong></p>" : ""}${item.withdrawn_at ? "<p><strong>The report has been withdrawn.</strong></p>" : ""}${item.report_revision !== item.latest_report_revision ? `<p>From an earlier report revision. <a href="/report/${item.report_id}">Current report →</a></p>` : ""}${claimContent(item, true)}<p><a href="/report/${item.report_id}?v=${item.report_revision}#discussion">Read and join the discussion on the report →</a></p>`,
      );
    }
    if (current.searchParams.has("sign_in"))
      return c.redirect(config.login_url, 302);
    if (p === "finding" && id) {
      const f = await get(`/findings/${enc(id)}`);
      const owner = await get(`/reports/${f.report_id}`);
      const editable = me.user?.id === owner.author_id && !f.withdrawn_at;
      if (parts.length === 3 && parts[2] === "github-issue") {
        if (!me.user) return login();
        if (me.user.id !== owner.author_id) throw new Fault(403, "not_author");
        if (f.withdrawn_at) throw new Fault(409, "report_withdrawn");
        const upstream = await upstreamRepository(c.env, f.crate);
        if (!upstream.repository)
          throw new Fault(
            upstream.reason === "unavailable" ? 503 : 404,
            "github_upstream_unavailable",
          );
        const draft = githubIssueDraft(f, c.env.APP_ORIGIN);
        const templates = await githubIssueTemplates(
          c.env,
          upstream.repository,
        );
        const issue = githubIssueURL(upstream.repository, draft, templates);
        if (templates !== null && issue.prefill === "all")
          return c.redirect(issue.url, 302);
        const unavailable = templates === null;
        return result(
          "Create GitHub issue",
          `<h1>Create GitHub issue</h1>${unavailable ? `<p role="alert">Unable to check the repository’s Issue templates. Your draft is preserved below.</p><p><a href="${esc(current.pathname)}">Retry template lookup</a></p>` : "<p>The draft is too long to prefill in a GitHub URL. Copy it below, then submit on GitHub.</p>"}<p>Upstream repository: <a href="${esc(upstream.repository)}" target="_blank" rel="noopener noreferrer">${esc(upstream.repository)}</a></p><section class="finding-form" data-issue-draft><label>Issue title<input id="issue-title" readonly value="${esc(draft.title)}"></label><button type="button" data-copy-issue="issue-title">Copy title</button><label>Issue body (Markdown)<textarea id="issue-body" readonly rows="18">\n${esc(draft.body)}</textarea></label><button type="button" data-copy-issue="issue-body">Copy body</button><p data-copy-status role="status" aria-live="polite"></p><p>${unavailable ? "Copy the title and body below before continuing to GitHub, then follow the repository’s template instructions." : issue.prefill === "title" ? "The body is too long to prefill in a URL. Copy the complete body and paste it into GitHub." : "The title and body are too long to prefill in a URL. Copy both fields and paste them into GitHub."}</p><p><a href="${esc(issue.url)}" target="_blank" rel="noopener noreferrer">Continue on GitHub</a></p></section><p><a href="/finding/${enc(f.id)}">Return to Finding</a></p>`,
        );
      }
      if (editable)
        f.github_issue_available = !!(await upstreamRepository(c.env, f.crate))
          .repository;
      const apis = editable
        ? await get(`/crates/${enc(f.crate)}/${enc(f.version)}/apis`)
        : null;
      return result(
        f.title,
        `${breadcrumbs([...crateCrumbs(owner, "reports"), { label: `Report #${owner.id}`, href: `/report/${owner.id}` }])}<h1>${esc(f.title)}</h1>${findingItem(f, editable, apis?.items ?? [])}<p><a href="/report/${f.report_id}#discussion">Read and join the discussion on the report →</a></p>`,
      );
    }
    if (p === "report" && id) {
      const revision = current.searchParams.get("v");
      const item = await get(
        revision
          ? `/reports/${enc(id)}/revisions/${enc(revision)}`
          : `/reports/${enc(id)}`,
      );
      if (
        current.searchParams.has("comment") ||
        current.searchParams.has("discussion")
      ) {
        const commentID = current.searchParams.get("comment");
        if (commentID) {
          const comment = await get("/comments/" + enc(commentID));
          if (comment.report_id !== item.id)
            throw new Fault(400, "comment_report_mismatch");
        }
        current.searchParams.delete("comment");
        current.searchParams.delete("discussion");
        return c.redirect(
          current.pathname +
            current.search +
            (commentID ? "#comment-" + enc(commentID) : "#discussion"),
          302,
        );
      }
      const [history, comments] = await Promise.all([
        rows(
          c.env.DB,
          "SELECT revision_no,created_at FROM report_revisions WHERE report_id=? ORDER BY revision_no DESC",
          item.id,
        ),
        reportDiscussion(c.env.DB, item.id, me.user?.id),
      ]);
      item.direct_dependencies = await dependencyCatalog(
        c.env,
        item.crate,
        item.version,
        item.dependencies,
      );
      const recorded: string[] = [];
      if (item.run_ids.length) {
        // Parse one potentially large SARIF record at a time to bound Worker memory.
        for (const [index, run] of (item.run_ids as string[]).entries()) {
          try {
            recorded.push(
              renderRecordedRun(
                await get(`/runs/${enc(run)}/sarif`),
                run,
                index,
                item,
                true,
              ),
            );
          } catch {
            recorded.push(
              `<p role="alert">Unable to load recorded run. <a href="/runs/${enc(run)}?report=${item.id}&amp;v=${item.revision_no}">View run</a></p>`,
            );
          }
        }
      }
      item.findings = await reportFindings(c.env.DB, item.id);
      item.finding_count = item.withdrawn_at
        ? 0
        : item.findings.filter(
            (f: any) => !["invalid", "duplicate"].includes(f.validity),
          ).length;
      const editableFindings =
        me.user?.id === item.author_id && !item.withdrawn_at;
      if (editableFindings && item.findings.length) {
        const available = !!(await upstreamRepository(c.env, item.crate))
          .repository;
        for (const finding of item.findings)
          finding.github_issue_available = available;
      }
      const findingAPIs = editableFindings
        ? await get(`/crates/${enc(item.crate)}/${enc(item.version)}/apis`)
        : null;
      const findingSection = `<section id="findings" class="report-section"><h2>Findings (${item.finding_count})</h2>${item.revision_no !== item.latest_revision_no ? "<p>Findings show current information, including later additions. Each entry identifies its origin revision and latest update; it is separate from this revision’s proof content.</p>" : ""}${item.findings.map((f: any) => findingItem(f, false, [], true, editableFindings)).join("") || "<p>No findings reported.</p>"}${editableFindings ? `<details><summary>Add finding</summary>${findingForm(item.id, undefined, findingAPIs.items)}</details>` : ""}</section>`;
      const content = reportBody(
        item,
        recorded.join(""),
        findingSection,
        reportAPIs(item),
      );
      const commentForm = (editing: any, replying: any) =>
        `${editing ? "" : `<h3>${replying ? "Reply to #" + replying.sequence_no : "Add a comment"}</h3>`}<form method="post" action="/_actions/${editing ? "edit-comment" : "comment"}" id="${editing ? "comment-editor-form" : "comment-form"}"><input type="hidden" name="_csrf" value="${esc(me.csrf)}"><input type="hidden" name="_back" value="/report/${item.id}?v=${item.revision_no}#discussion"><input type="hidden" name="id" value="${esc(editing?.id || item.id)}"><input type="hidden" name="edit_version" value="${editing?.edit_version || 0}"><input type="hidden" name="reply_to_id" value="${esc(replying?.id || "")}"><input type="hidden" name="_key" value="${crypto.randomUUID()}">${editing ? "" : `<label>Report revision <select name="revision_no">${history.map((h) => `<option value="${h.revision_no}"${h.revision_no === (replying?.revision_no || item.revision_no) ? " selected" : ""}>v${h.revision_no}</option>`).join("")}</select></label>`}<textarea name="body" required maxlength="5000" aria-label="Comment">${esc(editing?.body || "")}</textarea><button>${editing ? "Save" : "Post comment"}</button>${editing || replying ? ` <a href="/report/${item.id}?v=${item.revision_no}#discussion">Cancel</a>` : ""}</form>`;
      const byParent = new Map<string | null, any[]>();
      for (const cm of comments) {
        const key = cm.reply_to_id || null;
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key)!.push(cm);
      }
      // Render an arbitrary-depth tree without recursive calls or per-thread database reads.
      const tasks: (string | any)[] = [...(byParent.get(null) || [])].reverse();
      const rendered: string[] = [];
      const seen = new Set<string>();
      while (tasks.length) {
        const cm = tasks.pop();
        if (typeof cm === "string") {
          rendered.push(cm);
          continue;
        }
        if (seen.has(cm.id)) continue;
        seen.add(cm.id);
        const anchor = "comment-" + enc(cm.id);
        const commentLink = `/report/${item.id}?v=${cm.revision_no}#${anchor}`;
        const vote =
          !cm.deleted_at && !cm.hidden
            ? `<span class="vote">${me.user ? action("vote", { id: cm.id, value: 1, on: cm.my_vote !== 1 }, "▲", me.csrf, `aria-label="Upvote" aria-pressed="${cm.my_vote === 1}"`) : navigateButton({ sign_in: "1" }, "▲", 'aria-label="Upvote" aria-pressed="false"')} ${cm.score} ${me.user ? action("vote", { id: cm.id, value: -1, on: cm.my_vote !== -1 }, "▼", me.csrf, `aria-label="Downvote" aria-pressed="${cm.my_vote === -1}"`) : navigateButton({ sign_in: "1" }, "▼", 'aria-label="Downvote" aria-pressed="false"')}</span>`
            : "";
        const controls = me.user
          ? `${navigateButton({ v: item.revision_no, reply: cm.id }, "Reply")}${me.user.id === cm.author_id && !cm.deleted_at && !cm.hidden ? navigateButton({ v: item.revision_no, edit: cm.id }, "Edit") + navigateButton({ v: item.revision_no, delete: cm.id }, "Delete") : ""}`
          : "";
        const deleteConfirmation =
          current.searchParams.get("delete") === cm.id &&
          me.user?.id === cm.author_id &&
          !cm.deleted_at &&
          !cm.hidden
            ? confirmation(
                "Delete this comment? Its previous text is retained privately.",
                action(
                  "delete-comment",
                  { id: cm.id, edit_version: cm.edit_version },
                  "Delete",
                ),
                `/report/${item.id}?v=${item.revision_no}#${anchor}`,
              )
            : "";
        rendered.push(
          `<article class="comment" id="${esc("comment-" + cm.id)}"><div class="comment-top">${user(cm.author_id, cm.username)} <time>${date(cm.created_at)}</time><a href="${commentLink}">v${cm.revision_no} · #${cm.sequence_no}</a>${vote}</div><div class="comment-content"><p class="preserve">${cm.deleted_at ? "<em>deleted comment</em>" : cm.hidden ? "<em>hidden comment</em>" : esc(cm.body)}</p>${cm.edited_at && !cm.deleted_at ? '<p class="meta">Edited ' + date(cm.edited_at) + "</p>" : ""}</div><div class="comment-actions">${controls}</div><div class="editor">${current.searchParams.get("edit") === cm.id ? "<!--comment-editor-->" : ""}</div>${deleteConfirmation}</article><div class="comment-children">`,
        );
        tasks.push("</div>");
        tasks.push(...(byParent.get(cm.id) || []).slice().reverse());
      }
      let form = "";
      if (me.user && !me.terms_required) {
        const editID = current.searchParams.get("edit"),
          replyID = current.searchParams.get("reply");
        const editing = editID
          ? comments.find((x) => x.id === editID)
          : undefined;
        const replying = replyID
          ? comments.find((x) => x.id === replyID)
          : undefined;
        if (
          editID &&
          (!editing ||
            editing.author_id !== me.user.id ||
            editing.hidden ||
            editing.deleted_at)
        )
          throw new Fault(403, "comment_edit_forbidden");
        if (replyID && (!replying || replying.hidden || replying.deleted_at))
          throw new Fault(400, "invalid_reply");
        form = commentForm(editing, replying);
      } else
        form = me.terms_required
          ? '<p><a href="/terms-update">Accept updated terms to comment.</a></p>'
          : '<p><a href="/auth/github?return_to=' +
            enc(back) +
            '">Sign in to comment.</a></p>';
      if (current.searchParams.has("edit") && form) {
        const index = rendered.findIndex((html) =>
          html.includes("<!--comment-editor-->"),
        );
        if (index >= 0)
          rendered[index] = rendered[index].replace(
            "<!--comment-editor-->",
            form,
          );
        form = commentForm(undefined, undefined);
      }
      // Long histories show the newest revisions and the one being viewed.
      const revisionLink = (h: any) =>
        `<a href="/report/${item.id}?v=${h.revision_no}"${h.revision_no === item.revision_no ? ' aria-current="page"' : ""}>v${h.revision_no}</a>`;
      const shownRevisions =
        history.length > 8
          ? history.filter(
              (h: any, i: number) =>
                i < 5 || h.revision_no === item.revision_no,
            )
          : history;
      const olderRevisions = history.filter(
        (h: any) => !shownRevisions.includes(h),
      );
      canonicalPath = `/report/${item.id}${current.searchParams.has("v") ? `?v=${item.revision_no}` : ""}`;
      const shareURL = new URL(
        `/report/${item.id}?v=${item.revision_no}`,
        c.env.APP_ORIGIN,
      ).href;
      const plain = item.explanation
        ? (await import("./markdown"))
            .renderMarkdown(item.explanation, 1)
            .replace(/<[^>]*>/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, " ")
            .trim()
        : `${item.crate} ${item.version} verification report using ${item.tool}.`;
      metadata = {
        title: `${item.withdrawn_at ? "Withdrawn · " : ""}${item.title} · ${item.crate} ${item.version} · proofs.rs`,
        description: Array.from(plain).slice(0, 160).join(""),
        url: shareURL,
        image: new URL(
          `/og/report/${item.id}/${item.revision_no}.png`,
          c.env.APP_ORIGIN,
        ).href,
        alt: `${item.withdrawn_at ? "Withdrawn · " : ""}${item.title} · ${item.crate} ${item.version}`,
      };
      const share = reportShare(item.title, shareURL, !!item.withdrawn_at);
      return result(
        `Report #${item.id} — ${item.title}`,
        `${breadcrumbs(crateCrumbs(item, "reports"))}${reportContent(item, true)}<p class="meta">${user(item.author_id, item.username)} · ${date(item.created_at)}</p>${share}<div class="meta" id="revision-history">Revision ${shownRevisions.map(revisionLink).join(" · ")}${item.revision_no !== item.latest_revision_no ? ` ${badge("Past revision", "warn")}` : ""}${olderRevisions.length ? `<details class="revision-more"><summary>${olderRevisions.length} more revisions</summary>${olderRevisions.map(revisionLink).join(" · ")}</details>` : ""}</div>${item.withdrawn_at ? `<p>${badge("Withdrawn by the author.", "warn")}</p>` : ""}<div class="report-actions">${me.user?.id === item.author_id && !item.withdrawn_at ? navigateButton({ v: item.revision_no, withdraw: "1" }, "Withdraw report") + (current.searchParams.has("withdraw") ? confirmation("Withdraw this report? Its history and discussion remain public.", action("withdraw", { id: item.id }, "Withdraw report"), `/report/${item.id}?v=${item.revision_no}`) : "") : ""}</div>${reportOutline(item, true, item.comment_count)}${content}<section id="discussion" class="discussion"><h2>Comments (${item.comment_count})</h2>${rendered.join("") || "<p>No comments.</p>"}${form}</section>`,
      );
    }
    if (p === "runs" && id) {
      const report = current.searchParams.get("report");
      if (!report) throw new Fault(400, "report_required");
      const revision = current.searchParams.get("v");
      const item = await get(
        revision
          ? `/reports/${enc(report)}/revisions/${enc(revision)}`
          : `/reports/${enc(report)}`,
      );
      if (!item.run_ids.includes(id)) throw new Fault(404, "run_not_in_report");
      return result(
        "Recorded run",
        `<h1>Recorded run</h1>${renderRecordedRun(await get(`/runs/${enc(id)}/sarif`), id, item.run_ids.indexOf(id), item, true)}`,
      );
    }
    if (p === "tools") {
      const tools = await get("/tools");
      return result(
        "Verification tools",
        `<h1>Verification tools</h1>${tools.items.map((t: any) => `<article><h2><a href="/tool/${enc(t.id)}">${esc(t.name)}</a></h2><p>${esc(t.description)}</p>${toolGuide(t.id)}</article>`).join("") || "<p>No tools have been registered yet.</p>"}<p><a href="https://github.com/proofs-rs/proofs-rs/issues/new?template=tool.yml">Request a tool or version</a></p>`,
      );
    }
    if (p === "tool" && id) {
      const t = await get("/tools/" + enc(id));
      return result(
        t.name,
        `${breadcrumbs([{ label: "Tools", href: "/tools" }])}<h1>${esc(t.name)}</h1><p>${esc(t.description)}</p><p><a href="${esc(t.official_url)}">Tool website</a></p>${toolGuide(t.id)}<h2>Supported versions</h2><ul>${t.versions.map((r: any) => `<li><a href="/tool-version/${enc(r.id)}">${esc(r.version)}</a>${r.selectable ? "" : " (retired)"}</li>`).join("")}</ul><h2>Reports</h2>${await list(`/tools/${enc(id)}/reports`)}`,
      );
    }
    if (p === "tool-version" && id) {
      const t = await get("/tool-versions/" + enc(id));
      return result(
        `${t.tool} ${t.version}`,
        `${breadcrumbs([
          { label: "Tools", href: "/tools" },
          { label: t.tool, href: "/tool/" + enc(t.tool_id) },
        ])}<h1>${esc(t.tool)} ${esc(t.version)}</h1>${t.selectable ? "" : "<p>This version is retired from new submissions.</p>"}${t.limitations ? `<h2>Technical limitations</h2><p class="plain-text">${esc(t.limitations)}</p>${t.limitations_updated_at ? `<p class="meta">Updated ${date(t.limitations_updated_at)}</p>` : ""}` : ""}<h2>Reports</h2>${await list(`/tool-versions/${enc(id)}/reports`)}`,
      );
    }
    if ((p === "user" && id) || p === "account") {
      const own = p === "account";
      const u = await get("/users/" + enc(own ? me.user.id : id));
      const prefix = own ? "/me" : "/users/" + enc(u.id);
      const sections = [
        "reports",
        "comments",
        ...(own && config.show_star_karma
          ? ["starred-reports", "starred-claims"]
          : []),
      ];
      const content = await Promise.all(
        sections.map(async (section) => {
          const render =
            section === "comments"
              ? (cm: any) =>
                  `<article><p><a href="/report/${cm.report_id}?v=${cm.revision_no}#comment-${enc(cm.id)}">Report #${cm.report_id} · v${cm.revision_no} · comment #${cm.sequence_no}</a> · ${date(cm.created_at)}</p><p class="preserve">${esc(cm.body)}</p></article>`
              : section === "starred-claims"
                ? claimItem
                : reportSummary;
          const label =
            section === "reports"
              ? own
                ? "My reports"
                : "Reports"
              : section === "comments"
                ? own
                  ? "My comments"
                  : "Comments"
                : section === "starred-reports"
                  ? "Starred reports"
                  : "Starred claims";
          return `<section id="${section}"><h2>${label}</h2>${await list(prefix + "/" + section, render, section + "_cursor")}</section>`;
        }),
      );
      return result(
        u.username,
        `<h1>${esc(u.username)}</h1><p>${config.show_star_karma ? `${u.karma} karma · ` : ""}joined ${date(u.created_at)}</p><p><a href="https://github.com/${enc(u.username)}">GitHub profile</a></p>${content.join("")}`,
      );
    }

    if (p === "settings") {
      const [prefs, tokens] = await Promise.all([
        get("/me/notification-preferences"),
        get("/me/tokens"),
      ]);
      return result(
        "Settings",
        `<h1>Settings</h1><h2>Account</h2><p>GitHub username: ${esc(me.user.username)}</p><p>Email: ${esc(me.email?.address || "Unavailable")}</p><p>Your GitHub username and verified primary email are refreshed when you sign in again.</p>${current.searchParams.get("email") === "retry" ? "<p>GitHub email lookup failed. Please sign in again to refresh your email.</p>" : ""}<h2>Email notifications</h2>${c.env.EMAIL_DISABLED === "true" ? "<p>Email notifications are currently disabled.</p>" : !(c.env.EMAIL && c.env.EMAIL_FROM) ? "<p>Email delivery is currently unavailable.</p>" : ""}<form method="post" action="/_actions/preferences"><input type="hidden" name="_csrf" value="${esc(me.csrf)}"><p><label><input type="checkbox" name="replies"${prefs.replies ? " checked" : ""}> Replies to my comments</label></p><p><label><input type="checkbox" name="report_comments"${prefs.report_comments ? " checked" : ""}> Comments on my reports</label></p><button>Save preferences</button></form><h2>Tokens</h2>${tokens.items.length ? `<div class="table-wrap"><table><thead><tr><th>ID</th><th>Created</th><th>Last used</th><th>Expires</th><th></th></tr></thead><tbody>${tokens.items.map((t: any) => `<tr><td><code>${esc(t.id)}</code></td><td>${date(t.created_at)}</td><td>${date(t.last_used_at) || "Never"}</td><td>${date(t.expires_at)}</td><td>${navigateButton({ revoke: t.id }, "Revoke")}</td></tr>`).join("")}</tbody></table></div>` : "<p>No tokens.</p>"}<div id="revoke-confirm">${tokens.items.some((t: any) => t.id === current.searchParams.get("revoke")) ? `<p>Revoke this token?</p><div class="form-actions">${action("revoke", { id: current.searchParams.get("revoke") }, "Revoke")}<a class="button-link" href="/settings">Cancel</a></div>` : ""}</div><h2>Delete my account</h2><p>For account deletion, contact the operator through <a href="/contact">Contact</a>.</p>`,
      );
    }
    if (p === "signup") {
      const pending = await get("/auth/signup");
      return result(
        "Sign up",
        `<h1>Sign up</h1><p>Signed in with GitHub as <strong>${esc(pending.username)}</strong>. <a href="/auth/github?switch_account=1&amp;return_to=${enc(pending.return_to)}">Use another account</a></p><p>By signing up, you agree to the <a href="/terms">Terms</a> and acknowledge the <a href="/privacy">Privacy Policy</a>.</p>${action("signup", { terms_version: pending.terms_version }, "Sign up", pending.csrf)}`,
      );
    }
    if (p === "terms-update")
      return result(
        "Updated terms",
        `<h1>Updated terms</h1>${legal.terms.body}<p>Version: ${esc(c.env.TERMS_VERSION)}</p>${action("terms", { version: c.env.TERMS_VERSION, _back: safeBack(current.searchParams.get("return_to") || "/account") }, "Agree and continue")}`,
      );
    if (p === "device") {
      const code = (current.searchParams.get("code") || "")
        .toUpperCase()
        .replace(/[^A-Z2-9]/g, "");
      if (!me.user) return login();
      const account = `<p>Signed in as <strong>${esc(me.user.username)}</strong>. <a href="/auth/github?switch_account=1&amp;return_to=${enc(back)}">Use another account</a></p>`;
      if (!code)
        return result(
          "Connect CLI",
          `<h1>Connect CLI</h1>${account}<form action="/device" method="get"><label>Code from your terminal <input name="code" autocomplete="off" maxlength="12" required></label><button>Continue</button></form>`,
        );
      // Inspection remains a read of the existing protocol; its API uses POST.
      const inspection = localRequest(
        c,
        "/auth/device/inspect",
        "POST",
        { user_code: code },
        me.csrf,
      );
      inspection.headers.set("Origin", c.env.APP_ORIGIN);
      const inspected = await fetch(inspection);
      const d: any = await inspected.json();
      if (!inspected.ok)
        return result(
          "Connect CLI",
          `<h1>Connect CLI</h1>${account}<p>This code is invalid or has expired. Check your terminal or run <code>cargo proofs login</code> again.</p><a href="/device">Enter another code</a>`,
          inspected.status,
        );
      return result(
        "Connect CLI",
        `<h1>Connect CLI</h1>${account}${d.state === "pending" ? `<p>Check the code:</p><p class="device-code"><code>${esc(code.slice(0, 4) + "-" + code.slice(4))}</code></p>${action("device", { user_code: code }, "Authorize")}` : "<p>This request has already been used. Run <code>cargo proofs login</code> again.</p>"}`,
      );
    }
    if (p === "unsubscribe")
      return result(
        "Unsubscribe",
        `<h1>Unsubscribe</h1><p>Turn off all comment email notifications?</p>${action("unsubscribe", { user: current.searchParams.get("user"), signature: current.searchParams.get("signature") }, "Unsubscribe")}`,
      );
    if (p === "admin" && id === "catalogs") {
      const data = await get("/admin/catalogs");
      return result(
        "Catalogs",
        `<h1>Catalogs</h1><p>Reindex stored rustdoc snapshots to include available public callable APIs. Existing API IDs and claims are preserved.</p><ul>${data.items.map((item: any) => `<li>${esc(item.crate)} ${esc(item.version)} ${action("refresh", { id: item.id }, "Refresh")}</li>`).join("")}</ul>`,
      );
    }
    return result("Page not found", "<h1>Page not found</h1>", 404);
  } catch (error) {
    if (!(error instanceof Fault)) throw error;
    return result(
      error.status === 404 ? "Page not found" : "Request failed",
      `<h1>${error.status === 404 ? "Page not found" : "Request failed"}</h1><p role="alert">${escape(error.status === 404 ? (notFoundMessages[error.code] ?? "This page does not exist or is no longer public.") : error.message)}</p><p><a href="/">Home</a> · <a href="/contact">Help &amp; feedback</a></p>`,
      error.status,
    );
  }
}

export async function siteAction(c: Ctx, fetch: SiteFetch): Promise<Response> {
  c.header("Cache-Control", "private, no-store");
  if (c.req.header("origin") !== c.env.APP_ORIGIN)
    return c.html(
      layout(
        c,
        "Request failed",
        '<h1>Request failed</h1><p role="alert">invalid_origin</p>',
      ),
      403,
    );
  const form = await c.req.formData();
  const field = (name: string) => String(form.get(name) || "");
  const name = c.req.path.split("/").at(-1);
  const id = enc(field("id"));
  let path = "",
    method = "POST",
    body: any = {},
    back = safeBack(field("_back"));
  switch (name) {
    case "logout":
      path = "/auth/logout";
      back = "/";
      break;
    case "signup":
      path = "/auth/signup";
      body = { terms_version: field("terms_version") };
      break;
    case "terms":
      path = "/me/terms-acceptance";
      body = { version: field("version") };
      break;
    case "preferences":
      path = "/me/notification-preferences";
      method = "PATCH";
      body = {
        replies: form.has("replies"),
        report_comments: form.has("report_comments"),
      };
      back = "/settings";
      break;
    case "revoke":
      path = "/me/tokens/" + id;
      method = "DELETE";
      break;
    case "finding":
    case "edit-finding":
      path = name === "finding" ? `/reports/${id}/findings` : `/findings/${id}`;
      method = name === "finding" ? "POST" : "PATCH";
      body = {
        title: field("title"),
        body: field("body"),
        evidence_url: field("evidence_url") || null,
        api_item_ids: form.has("api_ids")
          ? field("api_ids")
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean)
          : form.getAll("api_item_ids").map(String),
        ...(name === "edit-finding"
          ? {
              edit_version: Number(field("edit_version")),
              validity: field("validity"),
              upstream_status: field("upstream_status"),
              duplicate_of: field("duplicate_of") || null,
            }
          : {}),
      };
      if (name === "edit-finding") {
        const current = await one(
          c.env.DB,
          "SELECT body,edit_version FROM findings WHERE id=?",
          field("id"),
        );
        // HTML form submission normalizes textarea newlines to CRLF. Preserve
        // unchanged historical prose, even when it exceeds today's input limit.
        const newlines = (value: string) => value.replace(/\r\n|\r/g, "\n");
        if (
          current &&
          (current.edit_version !== body.edit_version ||
            newlines(current.body) === newlines(body.body))
        )
          delete body.body;
        // Stale forms omit the body too: the API's version guard must return
        // 409, rather than rejecting unchanged legacy prose with 400 first.
        // Ownership, CSRF and the transactional version check remain in the API.
      }
      break;
    case "finding-link":
      path = `/findings/${id}/links`;
      body = {
        kind: field("kind"),
        url: field("url"),
        version: field("version") || null,
        target_report_id: field("target_report_id")
          ? Number(field("target_report_id"))
          : null,
        target_revision_no: field("target_revision_no")
          ? Number(field("target_revision_no"))
          : null,
        edit_version: Number(field("edit_version")),
      };
      break;
    case "delete-finding-link":
      path = `/findings/${id}/links/${enc(field("link_id"))}`;
      method = "DELETE";
      body = { edit_version: Number(field("edit_version")) };
      break;
    case "comment":
      path = `/reports/${id}/comments`;
      body = {
        body: field("body"),
        revision_no: Number(field("revision_no")),
        reply_to_id: field("reply_to_id") || null,
      };
      break;
    case "edit-comment":
      path = "/comments/" + id;
      method = "PATCH";
      body = {
        body: field("body"),
        edit_version: Number(field("edit_version")),
      };
      break;
    case "delete-comment":
      path = "/comments/" + id;
      method = "DELETE";
      body = { edit_version: Number(field("edit_version")) };
      break;
    case "vote":
      path = "/comments/" + id + "/vote";
      method = field("on") === "true" ? "PUT" : "DELETE";
      body = method === "PUT" ? { value: Number(field("value")) } : undefined;
      break;
    case "star":
      if (!["report", "claim"].includes(field("kind")))
        return c.text("Invalid kind", 400);
      path = `/${field("kind")}s/${id}/star`;
      method = field("on") === "true" ? "PUT" : "DELETE";
      break;
    case "withdraw":
      path = `/reports/${id}/withdrawal`;
      method = "PUT";
      break;
    case "device":
      path = "/auth/device/approve";
      body = { user_code: field("user_code") };
      break;
    case "unsubscribe":
      path = "/notifications/unsubscribe";
      body = { user: field("user"), signature: field("signature") };
      break;
    case "refresh":
      path = `/admin/catalogs/${id}/refresh`;
      break;
    default:
      return c.text("Not found", 404);
  }
  const response = await fetch(
    localRequest(
      c,
      path,
      method,
      body,
      field("_csrf"),
      field("_key") || undefined,
    ),
  );
  const value: any = await response.json();
  if (!response.ok) {
    if (response.status === 428)
      return c.redirect("/terms-update?return_to=" + enc(back), 303);
    const retry = `<form method="post" action="${escape(c.req.path)}">${Array.from(
      form.entries(),
    )
      .filter(([k, v]) => k !== "body" && typeof v === "string")
      .map(
        ([k, v]) =>
          `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`,
      )
      .join(
        "",
      )}<label>Comment <textarea name="body" maxlength="5000">${escape(field("body"))}</textarea></label><button>Retry</button></form>`;
    return new Response(
      layout(
        c,
        "Request failed",
        `<h1>Request failed</h1><p role="alert">${escape(value.message || value.error)}</p>${["comment", "edit-comment"].includes(name || "") ? retry : ""}<p><a href="${escape(back)}">Return to page</a></p>`,
      ),
      {
        status: response.status,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "private, no-store",
        },
      },
    );
  }
  if (name === "device" || name === "unsubscribe" || name === "refresh")
    return c.html(
      layout(
        c,
        "Done",
        name === "device"
          ? '<h1>CLI connected</h1><p>Return to your terminal to continue. You can close this page.</p><a href="/settings">Manage tokens</a>'
          : name === "unsubscribe"
            ? "<h1>Unsubscribed</h1><p>You can re-enable notifications in your account settings.</p>"
            : `<h1>Catalog refreshed</h1><p>${escape(value.indexed)} indexed, ${escape(value.added)} added${value.catalog_warnings?.length ? `; ${escape(value.catalog_warnings.length)} unresolved public exports` : ""}</p><a href="/admin/catalogs">Catalogs</a>`,
      ),
    );
  if (name === "signup") back = safeBack(value.return_to);
  const headers = new Headers({
    Location: back,
    "Cache-Control": "private, no-store",
  });
  for (const cookie of response.headers.getSetCookie())
    headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

// mdBook keeps its static body; only the account menu and feature-flag text vary.
export async function bookPage(c: Ctx, response: Response, fetch: SiteFetch) {
  if (!response.headers.get("Content-Type")?.includes("text/html"))
    return response;
  const session = await fetch(localRequest(c, "/me"));
  const me = session.ok ? await session.json() : { user: null };
  const stars = c.env.SHOW_STAR_KARMA === "true";
  const rewriter = new HTMLRewriter()
    .on("#account-nav", {
      element(element) {
        element.setAttribute("data-server-rendered", "true");
        element.setInnerContent(accountNavigation(c, me), { html: true });
      },
    })
    .on("[data-star-karma-score]", {
      element(element) {
        if (stars)
          element.setInnerContent(
            " User scores provide an additional signal derived from contributions to the community, helping readers decide whose judgments deserve greater weight.",
          );
      },
    });
  if (stars && /\/concepts(?:\.html)?$/.test(c.req.path))
    rewriter.on("h2#reproduce", {
      element(element) {
        element.before(
          '<section><h2 id="star--karma">Star / Karma</h2><p>Stars express interest in or appreciation of Reports and Claims. In the current implementation, Karma counts Stars received from other users on Reports that are public and have not been withdrawn. Comment ratings are not included in the calculation. Both are intended as signals that help readers evaluate contributions.</p></section>',
          { html: true },
        );
      },
    });
  const rendered = rewriter.transform(response);
  rendered.headers.set("Cache-Control", "private, no-store");
  return rendered;
}
