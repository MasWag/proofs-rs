import { operation } from "./openapi";
import * as S from "./schemas";
import { Hono } from "hono";
import { exactCargoVersion } from "./releases";
import {
  App,
  Env,
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
  hash,
} from "./core";
// Format 60 is still served by docs.rs for releases such as hex 0.4.3.
export const FORMATS = [60, 61];
// Bump when extraction or metadata changes require replaying archived rustdoc.
export const CATALOG_EXTRACTOR_VERSION = 2;

function markCatalogCurrent(db: D1Database, releaseId: number) {
  return stmt(
    db,
    "INSERT INTO catalog_versions(release_id,extractor_version) VALUES(?,?) ON CONFLICT(release_id) DO UPDATE SET extractor_version=MAX(catalog_versions.extractor_version,excluded.extractor_version)",
    releaseId,
    CATALOG_EXTRACTOR_VERSION,
  );
}

async function catalogCurrent(db: D1Database, releaseId: number) {
  return !!(await one(
    db,
    "SELECT 1 FROM catalog_versions WHERE release_id=? AND extractor_version>=?",
    releaseId,
    CATALOG_EXTRACTOR_VERSION,
  ));
}
function typ(t: any): string {
  if (t === null) return "()";
  if (typeof t === "string") return t === "infer" ? "_" : t;
  if (t.primitive) return t.primitive;
  if (t.generic) return t.generic;
  if (t.resolved_path) return t.resolved_path.path + args(t.resolved_path.args);
  if (t.borrowed_ref)
    return (
      "&" +
      (t.borrowed_ref.lifetime ? t.borrowed_ref.lifetime + " " : "") +
      (t.borrowed_ref.is_mutable ? "mut " : "") +
      typ(t.borrowed_ref.type)
    );
  if (t.raw_pointer)
    return (
      "*" +
      (t.raw_pointer.is_mutable ? "mut " : "const ") +
      typ(t.raw_pointer.type)
    );
  if (t.slice) return "[" + typ(t.slice) + "]";
  if (t.array) return "[" + typ(t.array.type) + "; " + t.array.len + "]";
  if (t.tuple)
    return (
      "(" +
      t.tuple.map(typ).join(", ") +
      (t.tuple.length === 1 ? "," : "") +
      ")"
    );
  if (t.impl_trait) return "impl " + t.impl_trait.map(bound).join(" + ");
  if (t.dyn_trait)
    return (
      "dyn " +
      t.dyn_trait.traits
        .map(
          (x: any) =>
            higherRanked(x.generic_params) + x.trait.path + args(x.trait.args),
        )
        .join(" + ") +
      (t.dyn_trait.lifetime ? " + " + t.dyn_trait.lifetime : "")
    );
  if (t.qualified_path)
    return (
      "<" +
      typ(t.qualified_path.self_type) +
      (t.qualified_path.trait
        ? " as " +
          t.qualified_path.trait.path +
          args(t.qualified_path.trait.args)
        : "") +
      ">::" +
      t.qualified_path.name +
      args(t.qualified_path.args)
    );
  if (t.function_pointer) {
    const f = t.function_pointer;
    return (
      higherRanked(f.generic_params) +
      header(f.header) +
      "fn" +
      signature(f.sig)
    );
  }
  throw new Fault(422, "unsupported_rustdoc_type");
}
function args(a: any): string {
  if (!a) return "";
  if (a.angle_bracketed) {
    const x = a.angle_bracketed;
    const values = (x.args || []).map((v: any) =>
      v.type ? typ(v.type) : v.lifetime || v.const?.expr || "_",
    );
    for (const c of x.constraints || []) {
      const b = c.binding;
      if (b.equality)
        values.push(
          c.name +
            " = " +
            (b.equality.type
              ? typ(b.equality.type)
              : b.equality.constant?.expr),
        );
      else if (b.constraint)
        values.push(c.name + ": " + b.constraint.map(bound).join(" + "));
      else throw new Fault(422, "unsupported_rustdoc_constraint");
    }
    return values.length ? "<" + values.join(", ") + ">" : "";
  }
  if (a.parenthesized)
    return (
      "(" +
      a.parenthesized.inputs.map(typ).join(", ") +
      ")" +
      (a.parenthesized.output ? " -> " + typ(a.parenthesized.output) : "")
    );
  throw new Fault(422, "unsupported_rustdoc_arguments");
}
function bound(b: any): string {
  if (b.outlives) return b.outlives;
  if (b.trait_bound) {
    const t = b.trait_bound;
    return (
      higherRanked(t.generic_params) +
      (t.modifier === "maybe" ? "?" : "") +
      t.trait.path +
      args(t.trait.args)
    );
  }
  if (b.use)
    return (
      "use<" +
      b.use
        .map((x: any) => (typeof x === "string" ? x : x.lifetime || x.param))
        .join(", ") +
      ">"
    );
  throw new Fault(422, "unsupported_rustdoc_bound");
}
function params(g: any): string {
  const p = (g?.params || []).map((p: any) => {
    if (p.kind.type) {
      const t = p.kind.type;
      return (
        p.name +
        (t.bounds?.length ? ": " + t.bounds.map(bound).join(" + ") : "") +
        (t.default ? " = " + typ(t.default) : "")
      );
    }
    if (p.kind.lifetime)
      return (
        p.name +
        (p.kind.lifetime.outlives?.length
          ? ": " + p.kind.lifetime.outlives.join(" + ")
          : "")
      );
    if (p.kind.const)
      return (
        "const " +
        p.name +
        ": " +
        typ(p.kind.const.type) +
        (p.kind.const.default ? " = " + p.kind.const.default : "")
      );
    throw new Fault(422, "unsupported_rustdoc_generic");
  });
  return p.length ? "<" + p.join(", ") + ">" : "";
}
function wheres(g: any): string {
  const w = (g?.where_predicates || []).map((p: any) => {
    if (p.bound_predicate)
      return (
        higherRanked(p.bound_predicate.generic_params) +
        typ(p.bound_predicate.type) +
        ": " +
        p.bound_predicate.bounds.map(bound).join(" + ")
      );
    if (p.lifetime_predicate)
      return (
        p.lifetime_predicate.lifetime +
        ": " +
        p.lifetime_predicate.outlives.join(" + ")
      );
    if (p.eq_predicate)
      return typ(p.eq_predicate.lhs) + " = " + typ(p.eq_predicate.rhs?.type);
    throw new Fault(422, "unsupported_rustdoc_where");
  });
  return w.length ? " where " + w.join(", ") : "";
}
function higherRanked(p: any[] | undefined) {
  return p?.length ? "for" + params({ params: p }) + " " : "";
}
function header(h: any) {
  if (!h) return "";
  const abi = typeof h.abi === "string" ? h.abi : Object.keys(h.abi || {})[0];
  const abiName =
    abi && typeof h.abi === "object" && h.abi[abi]?.unwind
      ? abi + "-unwind"
      : abi;
  return (
    (h.is_const ? "const " : "") +
    (h.is_async ? "async " : "") +
    (h.is_unsafe ? "unsafe " : "") +
    (abiName && abiName !== "Rust"
      ? "extern " + JSON.stringify(abiName) + " "
      : "")
  );
}
function signature(s: any) {
  if (!s || !Array.isArray(s.inputs))
    throw new Fault(422, "invalid_rustdoc_signature");
  return (
    "(" +
    s.inputs
      .map(([n, t]: [string, any]) => n + ": " + typ(t))
      .concat(s.is_c_variadic ? ["..."] : [])
      .join(", ") +
    ")" +
    (s.output ? " -> " + typ(s.output) : "")
  );
}
// rustdoc can omit a written trait path in associated-type projections
// (e.g. S::Ok), while retaining its ID. Resolve that ID before rendering.
function resolveEmptyPaths(value: any, paths: any): any {
  if (Array.isArray(value))
    return value.map((v) => resolveEmptyPaths(v, paths));
  if (!value || typeof value !== "object") return value;
  const result = Object.fromEntries(
    Object.entries(value).map(([key, v]) => [key, resolveEmptyPaths(v, paths)]),
  );
  if (result.path === "" && result.id !== undefined) {
    const path = paths?.[String(result.id)]?.path;
    if (
      !Array.isArray(path) ||
      !path.length ||
      path.some((p) => typeof p !== "string" || !p)
    )
      throw new Fault(422, "unresolved_rustdoc_path");
    result.path = path.join("::");
  }
  return result;
}

export function extractAPIs(
  doc: any,
  crate: string,
  version: string,
  metadata?: Map<string, any>,
) {
  if (!FORMATS.includes(doc.format_version))
    throw new Fault(422, "unsupported_rustdoc_format");
  if (doc.crate_version && doc.crate_version !== version)
    throw new Fault(422, "rustdoc_version_mismatch");
  const index = doc.index;
  if (!index?.[doc.root]?.inner?.module)
    throw new Fault(422, "invalid_rustdoc");
  const output = new Map<string, any>();
  const publicTraits = new Map<string, Set<string>>();
  const typeImpls = new Set<string>();
  const publicTypes = new Map<string, string>();
  const traitMethods: {
    item: any;
    path: string[];
    owner: { kind: string; path: string[]; impl: any };
    trait: any;
  }[] = [];
  let visits = 0;
  const rootName = index[doc.root].name || crate.replaceAll("-", "_");
  function add(
    item: any,
    path: string[],
    owner?: {
      kind: string;
      path: string[];
      impl: any;
      trait?: string;
      selfType?: string;
      anchor?: string;
      declaration?: boolean;
    },
  ) {
    const fn = resolveEmptyPaths(item.inner.function, doc.paths);
    if (!fn || typeof fn.header?.is_unsafe !== "boolean")
      throw new Fault(422, "invalid_rustdoc_function");
    const name =
      owner?.trait && !owner.declaration
        ? `<${owner.selfType ?? owner.path.join("::")} as ${owner.trait}>::${path.at(-1)}`
        : path.join("::");
    const prefix = owner?.declaration
      ? `trait ${owner.path.join("::")}${params(owner.impl.generics)}${wheres(owner.impl.generics)}\n`
      : owner
        ? `impl${params(owner.impl.generics)} ${owner.trait ? owner.trait + " for " : ""}${typ(owner.impl.for)}${wheres(owner.impl.generics)}\n`
        : "";
    const h = fn.header;
    const abi = typeof h.abi === "string" ? h.abi : Object.keys(h.abi || {})[0];
    const sig =
      prefix +
      "pub " +
      (h.is_const ? "const " : "") +
      (h.is_async ? "async " : "") +
      (h.is_unsafe ? "unsafe " : "") +
      (abi && abi !== "Rust" ? "extern " + JSON.stringify(abi) + " " : "") +
      "fn " +
      path.at(-1) +
      params(fn.generics) +
      signature(fn.sig) +
      wheres(fn.generics);
    const parts = owner ? owner.path : path;
    const file = owner
      ? `${owner.kind}.${parts.at(-1)}.html#${owner.anchor || "method"}.${path.at(-1)}`
      : `fn.${parts.at(-1)}.html`;
    const link = `https://docs.rs/${encodeURIComponent(crate)}/${encodeURIComponent(version)}/${parts.slice(0, -1).map(encodeURIComponent).join("/")}/${file}`;
    output.set(name, {
      canonical_key: name,
      display_path: name,
      kind: owner ? "method" : "function",
      is_unsafe: +h.is_unsafe,
      signature: sig,
      upstream_url: link,
    });
    if (metadata) {
      const imp = owner && canonicalPaths(owner.impl);
      const trait = owner?.declaration
        ? owner.path.join("::")
        : owner?.trait
          ? index[owner.impl.trait?.id]?.inner?.trait
            ? owner.trait
            : (imp.trait?.path || owner.trait.replace(/<.*$/, "")) +
              args(imp.trait?.args)
          : null;
      metadata.set(name, {
        category: owner?.trait
          ? "trait"
          : !owner
            ? "function"
            : fn.sig.inputs?.[0]?.[0] === "self"
              ? "method"
              : "associated",
        trait_path: trait,
        self_type:
          owner && !owner.declaration ? owner.selfType || typ(imp.for) : null,
        method_name: path.at(-1),
        is_blanket: owner?.trait && owner.impl.blanket_impl != null ? 1 : 0,
      });
    }
    if (output.size > 20000) throw new Fault(422, "api_catalog_too_large");
  }
  function implMethods(imp: any): any[] {
    const methods = (imp.items || []).map((id: any) => {
      const method = index[id];
      if (!method) throw new Fault(422, "invalid_rustdoc_impl_item");
      return method;
    });
    const declared = index[imp.trait?.id];
    const localCrate = index[doc.root].crate_id;
    if (
      !declared?.inner?.trait ||
      imp.is_negative ||
      (localCrate !== undefined && declared.crate_id !== localCrate)
    )
      return methods;
    const overridden = new Set(methods.map((m: any) => m.name));
    const provided = new Set(imp.provided_trait_methods || []);
    for (const id of declared.inner.trait.items || []) {
      const method = index[id];
      if (
        method?.inner?.function?.has_body === true &&
        provided.has(method.name) &&
        !overridden.has(method.name)
      )
        methods.push(method);
    }
    return methods;
  }
  function walk(
    id: any,
    path: string[],
    seen: Set<string>,
    alias?: string,
    exposed = false,
  ) {
    if (++visits > 100000 || path.length > 80)
      throw new Fault(422, "api_graph_too_large");
    const item = index[id];
    if (!item) {
      throw new Fault(422, "unresolved_public_reexport");
    }
    if (seen.has(String(id))) return;
    if (!exposed && id !== doc.root && item.visibility !== "public") return;
    const next = new Set(seen);
    next.add(String(id));
    const inner = item.inner;
    const name = alias || item.name;
    const current = id === doc.root ? [rootName] : [...path, name];
    if (inner.use) {
      if (inner.use.id === null)
        throw new Fault(422, "unresolved_public_reexport");
      if (inner.use.is_glob) {
        const target = index[inner.use.id];
        if (!target?.inner?.module)
          throw new Fault(422, "unsupported_public_glob");
        for (const child of target.inner.module.items) walk(child, path, next);
      } else walk(inner.use.id, path, next, inner.use.name, true);
      return;
    }
    if (inner.module) {
      for (const child of inner.module.items) walk(child, current, next);
      return;
    }
    if (inner.function) {
      add(item, current);
      return;
    }
    if (inner.trait) {
      const aliases = publicTraits.get(String(id)) || new Set<string>();
      aliases.add(current.join("::"));
      publicTraits.set(String(id), aliases);
      for (const methodID of inner.trait.items || []) {
        const method = index[methodID];
        if (!method) throw new Fault(422, "invalid_rustdoc_trait_item");
        if (!method.inner?.function) continue;
        add(method, [...current, method.name], {
          kind: "trait",
          path: current,
          impl: inner.trait,
          trait: current.join("::"),
          declaration: true,
          anchor:
            method.inner.function.has_body === false ? "tymethod" : "method",
        });
      }
      return;
    }
    for (const kind of ["struct", "enum", "union"])
      if (inner[kind]) {
        publicTypes.set(
          String(id),
          [publicTypes.get(String(id)), current.join("::")]
            .filter(Boolean)
            .sort()[0]!,
        );
        for (const implID of inner[kind].impls || []) {
          const imp = index[implID]?.inner?.impl;
          if (!imp) throw new Fault(422, "invalid_rustdoc_impl");
          if (imp.is_synthetic) continue;
          typeImpls.add(String(implID));
          const trait = imp.trait && resolveEmptyPaths(imp.trait, doc.paths);
          for (const method of implMethods(imp)) {
            if (!method?.inner?.function) continue;
            const owner = {
              kind,
              path: current,
              impl: resolveEmptyPaths(imp, doc.paths),
            };
            if (trait)
              traitMethods.push({
                item: method,
                path: [...current, method.name],
                owner,
                trait,
              });
            else if (method.visibility === "public")
              add(method, [...current, method.name], owner);
          }
        }
      }
  }
  walk(doc.root, [], new Set());
  for (const { item, path, owner, trait } of traitMethods) {
    const local = trait.id !== undefined && index[trait.id]?.inner?.trait;
    const paths = local
      ? publicTraits.get(String(trait.id)) || new Set<string>()
      : new Set([trait.path]);
    for (const traitPath of paths)
      add(item, path, { ...owner, trait: traitPath + args(trait.args) });
  }
  // Preserve every type-driven identity above (including its aliases and generic
  // erasure). Only impls not reached there may introduce structural self types.
  function canonicalPaths(value: any): any {
    if (Array.isArray(value)) return value.map(canonicalPaths);
    if (!value || typeof value !== "object") return value;
    const result = Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, canonicalPaths(v)]),
    );
    if (typeof result.path === "string" && result.id !== undefined) {
      const id = String(result.id);
      const publicPath =
        publicTypes.get(id) || [...(publicTraits.get(id) || [])].sort()[0];
      const summary = doc.paths?.[id];
      if (publicPath) result.path = publicPath;
      else if (summary?.path) result.path = summary.path.join("::");
    }
    return result;
  }
  const visitedImpls = new Set<string>();
  for (const [traitID, aliases] of publicTraits) {
    const declaration = index[traitID];
    const localCrate = index[doc.root].crate_id;
    if (localCrate !== undefined && declaration.crate_id !== localCrate)
      continue;
    for (const implID of declaration.inner.trait.implementations || []) {
      if (++visits > 100000) throw new Fault(422, "api_graph_too_large");
      const id = String(implID);
      if (typeImpls.has(id) || visitedImpls.has(id)) continue;
      visitedImpls.add(id);
      const entry = index[id];
      const raw = entry?.inner?.impl;
      if (!raw) throw new Fault(422, "invalid_rustdoc_impl");
      if (raw.is_synthetic || raw.is_negative) continue;
      if (localCrate !== undefined && entry.crate_id !== localCrate) continue;
      if (String(raw.trait?.id) !== traitID)
        throw new Fault(422, "invalid_rustdoc_impl_trait");
      // A private nominal type does not become a public API through its trait.
      const nominal = raw.for?.resolved_path?.id;
      if (
        nominal !== undefined &&
        !publicTypes.has(String(nominal)) &&
        index[nominal]?.crate_id === localCrate &&
        ["struct", "enum", "union"].some((k) => index[nominal]?.inner?.[k])
      )
        continue;
      const imp = resolveEmptyPaths(raw, doc.paths);
      const selfType = typ(canonicalPaths(imp.for));
      for (const method of implMethods(imp)) {
        if (!method.inner?.function) continue;
        const declared = (declaration.inner.trait.items || [])
          .map((id: any) => index[id])
          .find(
            (item: any) => item?.name === method.name && item.inner?.function,
          );
        for (const alias of aliases) {
          const traitPath = alias + args(canonicalPaths(imp.trait.args));
          const key = `<${selfType} as ${traitPath}>::${method.name}`;
          if (output.has(key)) continue;
          add(method, [method.name], {
            kind: "trait",
            path: alias.split("::"),
            impl: imp,
            trait: traitPath,
            selfType,
            anchor:
              declared?.inner.function.has_body === false
                ? "tymethod"
                : "method",
          });
        }
      }
    }
  }
  return [...output.values()];
}
export async function safeFetch(
  url: string,
  hosts: string[],
  signal: AbortSignal,
) {
  for (let i = 0; i < 5; i++) {
    const u = new URL(url);
    if (u.protocol !== "https:" || !hosts.includes(u.hostname))
      throw new Fault(422, "upstream_redirect_refused");
    const r = await fetch(u, {
      redirect: "manual",
      signal,
      headers: {
        "User-Agent": "proofs.rs/0.1 (https://github.com/proofs-rs/proofs-rs)",
      },
    });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      url = new URL(r.headers.get("location") || "", u).href;
      continue;
    }
    if (!r.ok)
      throw new Fault(
        r.status === 404 ? 422 : 502,
        r.status === 404 ? "docs_unavailable" : "upstream_unavailable",
      );
    return r;
  }
  throw new Fault(422, "too_many_redirects");
}
export async function bounded(stream: ReadableStream<Uint8Array>, max: number) {
  const reader = stream.getReader(),
    chunks = [];
  let n = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    n += r.value.byteLength;
    if (n > max) {
      await reader.cancel();
      throw new Fault(422, "rustdoc_too_large");
    }
    chunks.push(r.value);
  }
  const result = new Uint8Array(n);
  let offset = 0;
  for (const b of chunks) {
    result.set(b, offset);
    offset += b.length;
  }
  return result;
}
export const importRoutes = new Hono<App>();
// Rebuild an imported release from its immutable source document. Existing keys
// and their claim references are preserved; only newly indexed APIs are inserted.
export async function refreshCatalog(env: Env, releaseId: number) {
  const snapshot = await one(
    env.DB,
    "SELECT s.r2_key,cr.name,r.version FROM doc_snapshots s JOIN releases r ON r.id=s.release_id JOIN crates cr ON cr.id=r.crate_id WHERE r.id=?",
    releaseId,
  );
  if (!snapshot) throw new Fault(404, "snapshot_not_found");
  const object = await env.ARCHIVE.get(snapshot.r2_key);
  if (!object) throw new Fault(502, "snapshot_missing");
  const metadata = new Map<string, any>();
  const apis = extractAPIs(
    JSON.parse(await object.text()),
    snapshot.name,
    snapshot.version,
    metadata,
  );
  let added = 0;
  for (let i = 0; i < apis.length; i += 50) {
    const statements = await Promise.all(
      apis
        .slice(i, i + 50)
        .map(async (a) =>
          stmt(
            env.DB,
            "INSERT INTO api_items VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(release_id,canonical_key) DO UPDATE SET kind=excluded.kind,is_unsafe=excluded.is_unsafe,signature=excluded.signature,upstream_url=excluded.upstream_url WHERE EXISTS(SELECT 1 FROM api_item_provenance ap WHERE ap.api_item_id=api_items.id AND ap.origin='recorded')",
            await hash(releaseId + ":" + a.canonical_key),
            releaseId,
            a.canonical_key,
            a.display_path,
            a.kind,
            a.is_unsafe,
            a.signature,
            a.upstream_url,
          ),
        ),
    );
    added += (await env.DB.batch(statements)).reduce(
      (n, result) => n + (result.meta?.changes || 0),
      0,
    );
  }
  await promoteImportedAPIs(env.DB, releaseId, apis);
  await saveMetadata(env.DB, releaseId, metadata);
  await markCatalogCurrent(env.DB, releaseId).run();
  return { indexed: apis.length, added };
}
importRoutes.post(
  "/publish/prepare",
  ...operation(
    "Prepare a crate release for publishing",
    S.z.object({
      status: S.z.literal("ready"),
      crate: S.string,
      version: S.string,
    }),
    {
      tags: ["Imports"],
      body: S.z.object({
        crate: S.string.trim().min(1).max(64),
        version: S.string.trim().min(1).max(100),
      }),
      additionalResponses: {
        202: S.z.object({
          id: S.string,
          status: S.z.enum(["pending", "running", "retry"]),
        }),
      },
      auth: "user",
      write: true,
      errors: [400, 428, 429, 503],
    },
  ),
  async (c) => {
    const u = requireUser(c),
      b = await jsonBody(c),
      name = text(b.crate, "Crate", 64, true),
      version = text(b.version, "Version", 100, true);
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name) ||
      !exactCargoVersion(version)
    )
      throw new Fault(400, "exact_crate_version_required");
    if (
      (
        await one(
          c.env.DB,
          "SELECT value FROM settings WHERE key='imports_paused'",
        )
      )?.value === "1"
    )
      throw new Fault(503, "imports_paused");
    const db = c.env.DB;
    await batch(db, [
      stmt(
        db,
        "INSERT INTO crates(name) VALUES(?) ON CONFLICT DO NOTHING",
        name,
      ),
      stmt(
        db,
        "INSERT INTO releases(crate_id,version,created_at) SELECT id,?,? FROM crates WHERE name=? ON CONFLICT DO NOTHING",
        version,
        now(),
        name,
      ),
    ]);
    const rel = await one(
      db,
      "SELECT r.* FROM releases r JOIN crates cr ON cr.id=r.crate_id WHERE cr.name=? AND r.version=?",
      name,
      version,
    );
    if (await catalogCurrent(db, rel.id))
      return c.json({ status: "ready", crate: name, version });
    const running = await one(
      db,
      "SELECT id,status FROM import_jobs WHERE release_id=? AND status IN ('pending','running','retry')",
      rel.id,
    );
    if (running) return c.json(running, 202);
    const id = uid();
    try {
      await batch(db, [
        guard(
          db,
          "EXISTS(SELECT 1 FROM users WHERE id=? AND status='active' AND accepted_terms_version=?)",
          u.id,
          c.env.TERMS_VERSION,
        ),
        quota(db, u.id, "import", 50),
        quota(
          db,
          await hash(c.req.header("cf-connecting-ip") || u.id),
          "import_ip",
          500,
        ),
        stmt(
          db,
          "INSERT INTO import_jobs(id,release_id,requested_by,status,created_at) VALUES(?,?,?,?,?)",
          id,
          rel.id,
          u.id,
          "pending",
          now(),
        ),
        stmt(
          db,
          "INSERT INTO outbox_events(id,type,aggregate_id,dedupe_key,payload,created_at) VALUES(?,?,?,?,?,?)",
          uid(),
          "import",
          id,
          "import:" + id,
          JSON.stringify({ job_id: id }),
          now(),
        ),
      ]);
    } catch (e) {
      const job = await one(
        db,
        "SELECT id,status FROM import_jobs WHERE release_id=? AND status IN ('pending','running','retry')",
        rel.id,
      );
      if (job) return c.json(job, 202);
      throw e;
    }
    return c.json({ id, status: "pending" }, 202);
  },
);
importRoutes.get(
  "/imports/:id",
  ...operation(
    "Read crate import status",
    S.z.object({
      id: S.string,
      status: S.string,
      error_code: S.nullableString,
      crate: S.string,
      version: S.string,
    }),
    { tags: ["Imports"], auth: "user", errors: [404] },
  ),
  async (c) => {
    requireUser(c);
    const job = await one(
      c.env.DB,
      "SELECT j.id,j.status,j.error_code,cr.name crate,r.version FROM import_jobs j JOIN releases r ON r.id=j.release_id JOIN crates cr ON cr.id=r.crate_id WHERE j.id=?",
      c.req.param("id"),
    );
    if (!job) throw new Fault(404, "import_not_found");
    return c.json(job);
  },
);
export async function importJob(env: Env, id: string) {
  const db = env.DB;
  if (
    (await one(db, "SELECT value FROM settings WHERE key='imports_paused'"))
      ?.value === "1"
  )
    return false;
  const job = await stmt(
    db,
    "UPDATE import_jobs SET status='running',lease_until=?,attempts=attempts+1 WHERE id=? AND ((status IN ('pending','retry') AND (next_retry_at IS NULL OR next_retry_at<=?)) OR (status='running' AND lease_until<?)) RETURNING *",
    new Date(Date.now() + 180000).toISOString(),
    id,
    now(),
    now(),
  ).first<any>();
  if (!job) {
    const state = await one(
      db,
      "SELECT status FROM import_jobs WHERE id=?",
      id,
    );
    return !state || ["ready", "failed"].includes(state.status);
  }
  try {
    const rel = await one(
      db,
      "SELECT r.*,cr.name FROM releases r JOIN crates cr ON cr.id=r.crate_id WHERE r.id=?",
      job.release_id,
    );
    if (
      await one(db, "SELECT 1 FROM doc_snapshots WHERE release_id=?", rel.id)
    ) {
      if (!(await catalogCurrent(db, rel.id)))
        await refreshCatalog(env, rel.id);
      await stmt(
        db,
        "UPDATE import_jobs SET status='ready',error_code=NULL,lease_until=NULL WHERE id=?",
        id,
      ).run();
      return true;
    }
    const signal = AbortSignal.timeout(110000);
    const metaR = await safeFetch(
      `https://crates.io/api/v1/crates/${encodeURIComponent(rel.name)}/${encodeURIComponent(rel.version)}`,
      ["crates.io"],
      signal,
    );
    const meta: any = JSON.parse(
      new TextDecoder().decode(await bounded(metaR.body!, 1024 * 1024)),
    );
    if (meta.version?.num !== rel.version || !meta.version.checksum)
      throw new Fault(422, "crate_version_not_found");
    const source = `https://docs.rs/crate/${encodeURIComponent(rel.name)}/${encodeURIComponent(rel.version)}/json.gz`;
    const r = await safeFetch(source, ["docs.rs", "static.crates.io"], signal);
    let bytes = await bounded(r.body!, 20 * 1024 * 1024);
    if (bytes[0] === 31 && bytes[1] === 139)
      bytes = await bounded(
        new Response(bytes).body!.pipeThrough(new DecompressionStream("gzip")),
        30 * 1024 * 1024,
      );
    const metadata = new Map<string, any>();
    const raw = new TextDecoder().decode(bytes),
      doc = JSON.parse(raw),
      apis = extractAPIs(doc, rel.name, rel.version, metadata),
      digest = await hash(raw),
      r2key = `rustdoc/${rel.name}/${rel.version}/${digest}.json`;
    await env.ARCHIVE.put(r2key, raw, {
      httpMetadata: { contentType: "application/json" },
    });
    const items = [];
    for (const a of apis)
      items.push({ ...a, id: await hash(rel.id + ":" + a.canonical_key) });
    for (let i = 0; i < items.length; i += 50)
      await db.batch(
        items
          .slice(i, i + 50)
          .map((a) =>
            stmt(
              db,
              "INSERT INTO api_items VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(release_id,canonical_key) DO UPDATE SET kind=excluded.kind,is_unsafe=excluded.is_unsafe,signature=excluded.signature,upstream_url=excluded.upstream_url WHERE EXISTS(SELECT 1 FROM api_item_provenance ap WHERE ap.api_item_id=api_items.id AND ap.origin='recorded')",
              a.id,
              rel.id,
              a.canonical_key,
              a.display_path,
              a.kind,
              a.is_unsafe,
              a.signature,
              a.upstream_url,
            ),
          ),
      );
    await promoteImportedAPIs(db, rel.id, apis);
    await saveMetadata(db, rel.id, metadata);
    await batch(db, [
      stmt(
        db,
        "INSERT INTO doc_snapshots VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        rel.id,
        typeof doc.target === "string"
          ? doc.target
          : doc.target?.triple || "docs.rs default",
        JSON.stringify({ source: "docs.rs build configuration; see docs.rs" }),
        doc.format_version,
        doc.rustc_version || null,
        source,
        digest,
        r2key,
        now(),
      ),
      markCatalogCurrent(db, rel.id),
      ...(typeof meta.version.description === "string"
        ? [
            stmt(
              db,
              "UPDATE crates SET description=? WHERE id=?",
              meta.version.description.replace(/\s+/g, " ").trim(),
              rel.crate_id,
            ),
          ]
        : []),
      stmt(
        db,
        "UPDATE releases SET checksum=?,yanked=? WHERE id=?",
        meta.version.checksum,
        +meta.version.yanked,
        rel.id,
      ),
      stmt(
        db,
        "UPDATE import_jobs SET status='ready',error_code=NULL,lease_until=NULL WHERE id=?",
        id,
      ),
    ]);
    return true;
  } catch (e) {
    const permanent = e instanceof Fault && e.status === 422;
    const retry = !permanent && job.attempts < 3;
    await stmt(
      db,
      "UPDATE import_jobs SET status=?,error_code=?,lease_until=NULL,next_retry_at=? WHERE id=?",
      retry ? "retry" : "failed",
      e instanceof Fault ? e.code : "import_failed",
      new Date(Date.now() + 60000 * 2 ** job.attempts).toISOString(),
      id,
    ).run();
    return !retry;
  }
}

async function saveMetadata(
  db: D1Database,
  releaseId: number,
  metadata: Map<string, any>,
) {
  const entries = [...metadata];
  for (let i = 0; i < entries.length; i += 50) {
    await db.batch(
      await Promise.all(
        entries
          .slice(i, i + 50)
          .map(async ([key, m]) =>
            stmt(
              db,
              "INSERT INTO api_item_metadata(api_item_id,category,trait_path,self_type,method_name,is_blanket) SELECT id,?,?,?,?,? FROM api_items WHERE release_id=? AND canonical_key=? ON CONFLICT(api_item_id) DO UPDATE SET category=excluded.category,trait_path=excluded.trait_path,self_type=excluded.self_type,method_name=excluded.method_name,is_blanket=excluded.is_blanket",
              m.category,
              m.trait_path,
              m.self_type,
              m.method_name,
              m.is_blanket,
              releaseId,
              key,
            ),
          ),
      ),
    );
  }
}

async function promoteImportedAPIs(
  db: D1Database,
  release: number,
  apis: { canonical_key: string }[],
) {
  for (let i = 0; i < apis.length; i += 50)
    await db.batch(
      apis
        .slice(i, i + 50)
        .map((a) =>
          stmt(
            db,
            "DELETE FROM api_item_provenance WHERE api_item_id IN (SELECT id FROM api_items WHERE release_id=? AND canonical_key=? AND kind<>'callable')",
            release,
            a.canonical_key,
          ),
        ),
    );
}
