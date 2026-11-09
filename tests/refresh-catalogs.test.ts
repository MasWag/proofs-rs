import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const fixture = readFileSync(
  new URL(
    "../fixtures/lexical-parse-integer-1.0.6-rustdoc-56.json",
    import.meta.url,
  ),
  "utf8",
);

test("deployment catalog refresh persists and clears format 56 warnings without weakening validation", () => {
  const dir = mkdtempSync(join(tmpdir(), "proofs-refresh-test-"));
  try {
    const bin = join(dir, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    const wrangler = join(bin, "wrangler");
    writeFileSync(
      wrangler,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = 'state.json';
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
if (args[0] === 'r2') {
  fs.writeFileSync(args[args.indexOf('--file') + 1], state.raw);
} else if (args[0] === 'd1') {
  const sql = args.includes('--command')
    ? args[args.indexOf('--command') + 1]
    : fs.readFileSync(args[args.indexOf('--file') + 1], 'utf8');
  state.sql.push(sql);
  let results = [];
  if (sql.startsWith('SELECT s.release_id')) results = [state.release];
  else if (sql.startsWith('SELECT COUNT(*)')) results = [{ total: state.total }];
  else if (sql.startsWith('INSERT OR IGNORE INTO api_items'))
    state.total += (sql.match(/INSERT OR IGNORE INTO api_items/g) || []).length;
  else if (sql.startsWith('UPDATE doc_snapshots SET catalog_warnings_json=')) {
    const encoded = sql.match(/^UPDATE doc_snapshots SET catalog_warnings_json='((?:''|[^'])*)' WHERE release_id=1$/);
    if (!encoded) throw Error('Invalid warning update: ' + sql);
    state.warnings = JSON.parse(encoded[1].replaceAll("''", "'"));
  } else throw Error('Unexpected SQL: ' + sql);
  fs.writeFileSync(file, JSON.stringify(state));
  process.stdout.write(JSON.stringify([{ success: true, results }]));
} else throw Error('Unexpected Wrangler operation: ' + args[0]);
`,
    );
    chmodSync(wrangler, 0o755);
    const config = join(dir, "wrangler.json");
    writeFileSync(
      config,
      JSON.stringify({
        d1_databases: [{ database_name: "test" }],
        r2_buckets: [{ bucket_name: "test" }],
      }),
    );
    const statePath = join(dir, "state.json");
    const initial = {
      release: {
        release_id: 1,
        r2_key: "rustdoc.json",
        source_hash: hash(fixture),
        name: "lexical-parse-integer",
        version: "1.0.6",
      },
      raw: fixture,
      total: 0,
      warnings: [{ path: "stale" }],
      sql: [] as string[],
    };
    const save = (state: typeof initial) =>
      writeFileSync(statePath, JSON.stringify(state));
    const load = (): typeof initial =>
      JSON.parse(readFileSync(statePath, "utf8"));
    save(initial);
    const run = () =>
      spawnSync(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          new URL("../scripts/refresh-catalogs.mjs", import.meta.url).pathname,
          config,
        ],
        { cwd: dir, encoding: "utf8" },
      );
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /8 unresolved public exports/);
    const imported = load();
    assert.equal(imported.raw, fixture);
    assert.equal(imported.release.source_hash, hash(fixture));
    assert.equal(imported.total, 96);
    assert.equal(imported.warnings.length, 8);
    assert.ok(
      imported.warnings.some(
        (w) => w.path === "lexical_parse_integer::FromLexical",
      ),
    );

    const complete = JSON.parse(fixture);
    const absent = new Set([195, 197, 199, 201, 202, 203, 204, 205]);
    complete.index[complete.root].inner.module.items = complete.index[
      complete.root
    ].inner.module.items.filter((id: number) => !absent.has(id));
    imported.raw = JSON.stringify(complete);
    imported.release.source_hash = hash(imported.raw);
    save(imported);
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    const cleared = load();
    assert.deepEqual(cleared.warnings, []);
    assert.equal(cleared.raw, imported.raw);
    assert.equal(cleared.release.source_hash, imported.release.source_hash);
    const mutations = (state: typeof initial) =>
      state.sql.filter(
        (sql) =>
          sql.startsWith("INSERT OR IGNORE INTO api_items") ||
          sql.startsWith("UPDATE doc_snapshots"),
      ).length;
    const writesBeforeGuards = mutations(cleared);

    const badHash = load();
    badHash.release.source_hash = "wrong";
    save(badHash);
    const mismatch = run();
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /Archived rustdoc hash mismatch/);
    assert.equal(mutations(load()), writesBeforeGuards);

    const malformed = load();
    complete.index[complete.root].inner.module.items = [999999];
    malformed.raw = JSON.stringify(complete);
    malformed.release.source_hash = hash(malformed.raw);
    save(malformed);
    const invalid = run();
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /unresolved_public_reexport/);
    assert.equal(mutations(load()), writesBeforeGuards);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
