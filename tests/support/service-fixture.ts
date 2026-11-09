import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { app } from "../../src/worker";
import { hash, type Env } from "../../src/core";
import { assertResponseContract } from "../api-contract";

export function recordedSarif(id: string, command = ["cargo", "kani"]) {
  return {
    version: "2.1.0",
    runs: [
      {
        automationDetails: { guid: id },
        tool: { driver: { name: "Kani", version: "0.68.0" } },
        versionControlProvenance: [
          {
            repositoryUri: "https://github.com/test/source",
            revisionId: "a".repeat(40),
          },
        ],
        invocations: [
          {
            executableLocation: { uri: command[0] },
            arguments: command.slice(1),
            workingDirectory: { uri: "./" },
            startTimeUtc: "2026-09-23T00:00:00Z",
            endTimeUtc: "2026-09-23T00:00:01Z",
            executionSuccessful: true,
            exitCode: 0,
            stdout: { index: 0 },
            stderr: { index: 1 },
          },
        ],
        artifacts: [
          { contents: { text: "SUCCESS" } },
          { contents: { text: "" } },
        ],
        results: [
          {
            kind: "pass",
            message: { text: "bounds" },
            properties: { harness: "sample::check_safe" },
          },
        ],
        properties: {
          proofs: {
            schemaVersion: 2,
            dependencies: [],
            crate: "sample",
            version: "1.0.0",
            contracts: [
              {
                harness: "sample::check_safe",
                api_paths: ["sample::safe"],
                precondition: "true",
                file: "src/lib.rs",
                first_line: 1,
                last_line: 2,
              },
            ],
          },
        },
      },
    ],
  };
}
export function database(throughMigration?: string) {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(new URL("../../migrations/", import.meta.url))
    .filter(
      (f) => f.endsWith(".sql") && (!throughMigration || f <= throughMigration),
    )
    .sort())
    db.exec(
      readFileSync(new URL("../../migrations/" + f, import.meta.url), "utf8"),
    );
  const prepare = (sql: string) => {
    let values: any[] = [];
    const q = {
      bind(...v: any[]) {
        values = v;
        return q;
      },
      async first() {
        return db.prepare(sql).get(...values) || null;
      },
      async all() {
        return { results: db.prepare(sql).all(...values) };
      },
      async run() {
        const statement = db.prepare(sql);
        if (statement.columns().length)
          return { results: statement.all(...values), meta: {} };
        return { results: [], meta: statement.run(...values) };
      },
    };
    return q;
  };
  return {
    db,
    binding: {
      prepare,
      async batch(statements: any[]) {
        db.exec("BEGIN");
        try {
          const results = [];
          for (const s of statements) results.push(await s.run());
          db.exec("COMMIT");
          return results;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    } as unknown as D1Database,
  };
}
export async function fixture(seedTools = true, throughMigration?: string) {
  const { db, binding } = database(throughMigration);
  if (seedTools)
    db.exec(
      "INSERT INTO tools VALUES('kani','Kani','Test verifier','https://example.test',1); INSERT INTO tool_versions(id,tool_id,version,selectable) VALUES('kani-0.68.0','kani','0.68.0',1);",
    );
  const time = new Date().toISOString();
  for (const [id, n] of [
    ["alice", 1],
    ["bob", 2],
    ["admin", 3],
  ] as const) {
    db.prepare(
      "INSERT INTO users(id,github_id,username,role,accepted_terms_version,terms_accepted_at,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run(id, n, id, id === "admin" ? "admin" : "user", "test", time, time);
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(
      await hash(id),
      id,
      "csrf",
      new Date(Date.now() + 86400000).toISOString(),
    );
    db.prepare("INSERT INTO notification_preferences(user_id) VALUES(?)").run(
      id,
    );
  }
  db.exec(
    `INSERT INTO crates(id,name) VALUES(1,'sample');INSERT INTO releases VALUES(1,1,'1.0.0','checksum',0,'${time}');INSERT INTO doc_snapshots(release_id,target,features_json,rustdoc_format,rustc_version,source_url,source_hash,r2_key,imported_at) VALUES(1,'test','{}',61,NULL,'https://docs.rs','hash','key','${time}');INSERT INTO api_items VALUES('safe',1,'sample::safe','sample::safe','function',0,'pub fn safe()','https://docs.rs');INSERT INTO api_items VALUES('unsafe',1,'sample::unsafe','sample::unsafe','function',1,'pub unsafe fn unsafe()','https://docs.rs');`,
  );
  if (seedTools) {
    db.prepare(
      "INSERT INTO verification_runs(id,author_id,crate,version,tool_version_id,sha256,size,r2_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      "11111111-1111-4111-8111-111111111111",
      "alice",
      "sample",
      "1.0.0",
      "kani-0.68.0",
      "seed-hash",
      100,
      "seed-key",
      time,
    );
  }
  const env = {
    DB: binding,
    ENVIRONMENT: "staging",
    APP_ORIGIN: "https://example.test",
    ADMIN_GITHUB_IDS: "3",
    TERMS_VERSION: "test",
    SHOW_STAR_KARMA: "true",
    SHOW_HOME_DISCUSSION: "true",
    EMAIL_ALLOWLIST: "",
    ARCHIVE: {
      put: async () => {},
      get: async (key: string) => ({
        json: async () =>
          key.startsWith("cache/crates.io/repositories/")
            ? {
                name: "sample",
                repository: "https://github.com/upstream/project",
                fetchedAt: Date.now(),
              }
            : key.startsWith("cache/crates.io/dependencies/")
              ? []
              : recordedSarif("11111111-1111-4111-8111-111111111111"),
        body: new Response(
          JSON.stringify(recordedSarif("11111111-1111-4111-8111-111111111111")),
        ).body,
      }),
    },
    ASSETS: { fetch: async () => new Response("assets") },
  } as unknown as Env;
  async function request(
    path: string,
    method = "GET",
    body?: any,
    user = "alice",
    headers: Record<string, string> = {},
  ) {
    const response = await app.request(
      "https://example.test/api/v1" + path,
      {
        method,
        headers: {
          Origin: env.APP_ORIGIN,
          Cookie: "__Host-proofsr_session=" + user,
          "X-CSRF-Token": "csrf",
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
    const result = {
      status: response.status,
      body: (await response.json()) as any,
    };
    await assertResponseContract(
      "/api/v1" + path,
      method,
      result.status,
      result.body,
    );
    return result;
  }
  return { db, env, request };
}
export const reportInput = {
  run_ids: ["11111111-1111-4111-8111-111111111111"],
  crate: "sample",
  version: "1.0.0",
  title: "A verification report",
  tool_version_id: "kani-0.68.0",
  explanation: "",
  trusted_assumptions: "",
  environment: "test",
  evidence_url: "https://example.test/proof",
  claims: [
    {
      api_item_id: "safe",
      title: "",
      precondition: "true",
      explanation: "",
      trusted_assumptions: "",
      evidence_url: "",
    },
  ],
};
