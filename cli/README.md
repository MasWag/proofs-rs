# cargo-proofs

A Rust CLI for publishing verification reports to [proofs.rs](https://proofs.rs). For Kani, it discovers `#[kani::proof_for_contract(...)]` harnesses and publishes one claim per API under the target's `requires` conditions.

Creusot also publishes one claim per API. Describe the verified behavior in the report and claim text.

Commit and push the source and Cargo.lock to GitHub, then run verification through `cargo proofs run` before publishing. The CLI records observed results and embeds stdout/stderr in SARIF 2.1.0. `publish` uploads only that SARIF. Source remains on GitHub; no additional push is needed between run and publish.

Reports remain author-submitted evidence, not independent service certification. A harness may constrain inputs, concrete types, stubs, or execution beyond the extracted `requires`; describe those restrictions in the report's assumptions/limitations.

## Install

Rust 1.91 or newer, Cargo, and the selected verification tool must be installed:

```sh
cargo install cargo-proofs --locked
cargo proofs --help
```

The CLI is developed in `cli/` alongside the service. To install a checkout, run `cargo install --path cli --locked` from the repository root. Only the CLI package is distributed on crates.io; access to the service repository is not required to install a published version.

`preview` additionally requires Node.js 24 or newer. Other commands do not require Node.js.

## Quick start

Run inside the crate to verify:

```sh
cargo proofs init --tool-version 0.68.0 --title 'Contract verification of my crate'
cargo proofs login
# Commit and push all verification inputs, including Cargo.lock, before run.
cargo proofs run -- cargo kani -Z function-contracts
cargo proofs preview # Requires Node.js 24+; stop with Ctrl+C after reviewing.
cargo proofs publish --dry-run
cargo proofs publish
```

Kani function contracts are unstable, so `-Z function-contracts` is required; the CLI does not add it. `init` can detect the installed Kani version if `--tool-version` is omitted. Check that this is the version actually used for verification. It never overwrites an existing `proofs.toml`.

```toml
[report]
title = "Contract verification of my crate" # required
# explanation = "Optional report explanation"
# trusted_assumptions = "Optional shared assumptions"
# limitations = "Optional scope restrictions"
# environment = "Optional verification environment"

[tool]
name = "kani"
version = "0.68.0" # must be registered/selectable on the selected service

```

Crate name/version come from Cargo metadata, including workspace inheritance. There is no `[crate]` section. One selected library crate and one tool/version are supported per publication. Use `-p NAME` or `--manifest-path PATH` to select a workspace package. A virtual workspace with multiple packages requires `-p`.

Staging has separate login credentials and publication state:

```sh
cargo proofs login --server https://proofs-rs-staging.proofs-rs.workers.dev
cargo proofs publish --server https://proofs-rs-staging.proofs-rs.workers.dev --dry-run
```

You may set `PROOFS_SERVER` instead. The default is `https://proofs.rs`. Tokens are stored in a per-server file in the OS user config directory (`cargo-proofs`), with mode 0600 on Unix. Set `PROOFS_CONFIG_DIR` to override that credentials directory. Tokens are never saved in the repository. `logout` revokes the token before removing it. HTTP is allowed only for loopback development servers; redirects are not followed.

## Local report preview

Install Node.js 24 or newer. To review local report text before committing,
pushing or recording verification:

```sh
cargo proofs preview --draft
cargo proofs preview --draft --manifest-path path/to/crate/Cargo.toml \
  --proofs-config aeneas/profiles/stage2/proofs.toml
```

Draft mode requires no Git repository, recorded run, login or service connection.
It displays report prose and Finding drafts; Aeneas configurations also show the
configured API, module, theorem and precondition. Every page is marked
**Unverified draft**. No verification is performed and no run, logs, SARIF,
source links or evidence are generated. The mode makes no service requests and
does not access credentials, recorded runs or publication state. Save and reload
to see changes, including changes to mappings.

`--proofs-config` is relative to the selected package directory, must stay inside
it, and requires `--draft`. `--draft` conflicts with `--run` and `--report`.
The normal recording and publication requirements are unchanged.

To preview a successful recorded run before publishing:

```sh
cargo proofs preview
cargo proofs preview --run <RUN_UUID> --report 123
cargo proofs preview --port 8080 --no-browser
```

The command opens a local web server on `127.0.0.1` using an available port by
default. It displays the report, individual claims, reproduction instructions,
execution logs, and a SARIF download using the UI bundled with this CLI release.
The production fonts and their SIL OFL licenses are bundled and served locally;
font loading requires no network connection.
No repository checkout or npm installation is needed to use an installed CLI
that includes `preview`. Stop it with Ctrl+C.

In **Verified APIs**, click an API name or **Claim #…** to open its local claim
page. Report/claim navigation, recorded-run pages, and SARIF downloads stay on
localhost. An unresolved API name is marked unverified; its **Claim #…** link is
still available locally. Tool details, dependency evidence, and the API catalogue
link within a claim point to the selected remote service.

| Option | Behavior |
| --- | --- |
| `--manifest-path PATH`, `-p NAME` | Select the same Cargo package as other CLI commands |
| `--run UUID` | Use a specific local recording; otherwise pin the latest at startup |
| `--report ID` | Preview changes to this public report instead of the saved target |
| `--port PORT` | Listen on this port; `0` (the default) selects an available port |
| `--no-browser` | Print the URL without opening the browser |
| `--server ORIGIN` | Read metadata and existing reports from this service; also accepts `PROOFS_SERVER` |

For example, from a repository containing separate crate workspaces:

```sh
cargo proofs preview --manifest-path path/to/crate/Cargo.toml --no-browser
```

Edit `proofs.toml` and reload the browser to see changes. The selected run stays
fixed until restart, even if a newer run is recorded. A malformed configuration
shows an error page; fix it and reload to recover. Project selection options such
as `--manifest-path` and `-p` work as with `publish`.

Preview only makes GET requests to `--server`; it never uploads runs, prepares a
catalogue, validates remotely, publishes, or updates credentials/publication state.
New reports do not require login. With valid saved credentials, it selects the
same saved report as `publish`. Use `--report ID` to preview a public existing
report explicitly without login. If identity lookup fails, automatic selection is
unavailable and the preview clearly identifies itself as a new report.

Existing Web text is preserved where local settings are omitted; explicitly empty
settings clear it. Unavailable or ambiguous API mappings use recorded paths and
show an unverified warning; they cannot preserve existing claim text by guessing
its API. Missing tool details and dependency reviews are also identified. The
direct dependency catalogue is unavailable locally; pinned reviewed evidence is
still shown. No fake publication ID or timestamp is assigned to a new report.

Preview is for reviewing content, not approval to publish. Conflicts, removed
claims, withdrawn reports, and interrupted publications are shown as warnings.
`publish` remains responsible for permissions and final validation. Browser-based
editing, publishing, comments, and stars are not available in the preview.

### Preview and dry-run

`preview` opens the reader-facing UI and uses GET requests only. It does not run
the verifier or require Node.js for any other CLI command. `publish --dry-run`
prints prospective publication data and requires login. It sends the selected
SARIF to `/api/v1/runs/prepare` for transient validation and exact API bindings;
it does not store SARIF, create catalogue entries or import jobs, or publish a
report. Only `publish` stores evidence and performs final report validation and
publication. This protocol requires the updated CLI and service together.

### Troubleshooting

- **Unknown `preview` command:** check `cargo proofs --help`. To use this feature
  from a source checkout, build with `cargo build --manifest-path cli/Cargo.toml
  --locked`, then invoke `cli/target/debug/cargo-proofs preview --manifest-path
  /absolute/path/to/your/Cargo.toml`. Use an absolute binary path when running
  outside the proofs-rs checkout.
- **No recorded run:** record a successful verification run for the selected
  package first. `preview` does not start verification automatically.
- **Tool configuration or crate/version changed:** select a matching recorded run
  or record again. Editing only report prose needs no new run.
- **Port in use:** stop the earlier server or omit `--port` to choose a free port.
- **UI changes are missing after rebuilding the CLI:** stop and restart preview;
  a running server retains the UI bundle it started with. Reloading only refreshes
  report data. If you rebuild from source, regenerate the bundle first as described
  in [Development](#development).

## Dependency reviews

Attach a specific report revision for a dependency in `proofs.toml`:

```toml
[dependencies]
serde = { report = 123, revision = 2 }
```

Report and revision IDs must be positive integers. Entries accept only `report` and `revision`; crate versions come from the recorded run. Names use the actual package name even when Cargo renames the dependency. Each selected report must target a crate/version present in the recorded crates.io dependency snapshot and remain active. Multiple resolved versions of a crate are supported.

New runs record `properties.proofs.schemaVersion = 2` and a required dependency snapshot containing each reachable resolved package's crate, version, and Cargo source. The snapshot retains identities from `cargo metadata --locked` in the detached verification worktree. `cargo tree --locked` scopes the graph to the selected package with the verifier's features and compilation target, so sibling workspace features cannot add dependencies to the snapshot. Workspace dependencies, transitive dependencies and distinct versions retain their resolved identities. Publishing uses this snapshot rather than the current checkout's lockfile.

Omitting `[dependencies]` preserves the existing report's reviews when revising. An explicit empty `[dependencies]` clears them. Editing reviews reuses the selected recorded run; selecting another run revalidates reviews against that run. Publishing requires a version 2 recording; record verification again to migrate older runs. `publish --dry-run` displays review additions and removals and checks referenced report revisions; the service performs final authoritative validation. Interrupted publication resumes the exact saved review references.

## Discovery

- Supports library free functions and concrete methods, including trait implementation methods identified as `<Type as Trait>::method`, nested/ordinary external modules, explicit `use` aliases and public reexports, `#[kani::...]` and `#[cfg_attr(kani, kani::...)]`.
- `requires` predicates are conjoined. No `requires` means `true`, for both claims, including safe APIs.
- Ordinary `#[kani::proof]` harnesses are ignored with a notice. Their target/scope cannot be safely inferred from arbitrary code.
- Multiple contract harnesses for one API, ambiguous targets/reexports, and `include!` source trees stop publication. Glob imports are not used to guess targets. Macro-generated functions/harnesses are not expanded or discovered; this is a source parser, not a Rust compiler frontend.
- Conditional compilation is evaluated with `kani`, the selected Cargo features, and `rustc --print cfg` for the host or `--target`. Pass `--features foo,bar`, `--all-features`, `--no-default-features`, and `--target` to match verification. Build-script/custom cfgs are not inferred; encountered unsupported cfgs stop discovery. Integration-test targets are not scanned. Target-dependent dependency feature unification and RUSTFLAGS are not used to infer library features.
- For standard `Default`, `Clone`, `Hasher`, `Display`, and `FromStr` implementations, discovery also records the short trait spelling used by rustdoc catalogues. Arbitrary external trait basenames are not guessed.
- Every callable in a valid recorded run receives an exact API binding from the service. Existing exact rustdoc IDs are retained, including supported trait aliases. Otherwise its precise spelling is stored as an author-attributed recorded callable, without inventing a Rust signature, safety status or docs.rs entry. Concrete type arguments and inherited default methods are not erased. The immutable run and selected theorem remain authoritative for claim scope; recorded callables are not independent compiler-replay attestations.
- The local fork's implementation may differ from the published crate with the same name/version. The CLI does not prove equivalence; evidence identifies the exact source commit.

## Creusot

```sh
cargo proofs init --tool creusot --tool-target annotated --tool-version VERSION --title 'My verification report'
cargo proofs login
cargo proofs run -- cargo creusot
cargo proofs publish --dry-run
cargo proofs publish
```

Use the version actually used for verification; it must be registered on the service. `init` tries `cargo creusot version` when `--tool-version` is omitted. Review tool-version limitations on proofs.rs, including any panics outside the verifier's coverage.

```toml
[report]
title = "My verification report"

[tool]
name = "creusot"
version = "VERSION"
target = "annotated" # required: "annotated" or "all"
```

- `annotated`: public free functions and concrete methods with `requires` or `ensures`.
- `all`: public free functions and concrete methods even without these annotations. This selects source APIs; it does not attest that every function was verified.
- Both exclude `trusted`, `logic`, `predicate`, `law`, and `check(ghost)` functions, including explicitly imported aliases. Private functions/types and APIs without a public path are excluded. Trait declarations, macro-generated APIs and glob reexports are not discovered. Explicit function/type/module reexports are supported; complex reexport chains may require future compiler-backed discovery.
- Recognizes bare attributes, `creusot_std::...` / legacy `creusot_contracts::...`, and `cfg_attr`. Explicit macro imports/aliases are resolved; arbitrary user-defined wrapper macros and renamed dependency crates are unsupported. Bare attribute names are interpreted as Creusot attributes under this tool selection.
- `requires` retains its original Pearlite source text, including `@`, `^`, quantifiers and implication. Multiple predicates are parenthesized and joined with `&&`; absence means `true`. `ensures` only selects an API, never becomes a precondition or functional correctness claim.
- Evidence points to the API declaration and body, including its attributes. Logic bodies are not parsed as Rust expressions.
- Conditional compilation uses `creusot` instead of `kani`, together with selected Cargo features and platform cfgs. The existing source-discovery limitations still apply.

`[tool].target` selects APIs; CLI `--target` selects the Rust compilation target. They are separate settings. Kani does not accept `[tool].target`: its targets remain explicit `proof_for_contract` harnesses.

## Aeneas (Lean)

Requires cargo-proofs 0.4.0 or later.

Aeneas translates Rust through Charon into a functional model. This adapter checks
**committed Lean proofs of that model**. It does not run Charon/Aeneas extraction
or infer that a theorem describes a Rust API. The author must review and declare
the API/theorem correspondence, input assumptions, and the generated model's
relationship to the recorded Rust commit. Explain those links in the report.
A successful translation or `lake build` alone does not produce claims.

1. Generate the model using [Aeneas and Charon](https://github.com/AeneasVerif/aeneas#usage),
   write the Lean proofs, and use a Lake project with ordinary module paths
   (`Proofs/F.lean` for module `Proofs.F`). Custom Lake source directories are
   currently unsupported.
2. Pin the official Aeneas Git dependency with `subDir = "backends/lean"` in your
   Lake project. Commit `lakefile.toml` or `lakefile.lean`, `lake-manifest.json`,
   `lean-toolchain`, generated model sources, proof sources, Rust source,
   `Cargo.lock`, and `proofs.toml` together. Do not commit `.lake/`, `.olean`, or
   `.ilean` files. Local path Aeneas dependencies are unsupported.
3. Initialize with the full Aeneas Git commit in the Lake lock file:
   `cargo proofs init --tool aeneas --tool-version <40-character-revision>`.
   This revision must also be registered/selectable in the service's tool catalogue.
4. Add explicit mappings to `proofs.toml`:

```toml
[tool]
name = "aeneas"
version = "0123456789abcdef0123456789abcdef01234567" # replace with the real revision
lean_dir = "proofs" # relative to Cargo.toml; defaults to "."

[[tool.proofs]]
api = "increment" # public Rust path relative to the library
module = "Proofs.Increment"
theorem = "demo.increment_spec"
precondition = "x < u32::MAX" # match the actual theorem's assumptions
```

One theorem maps to one API; inherent methods and qualified trait implementation
paths use the same public API resolution as the other adapters. Multiple theorems
may map to the same API and produce separate claims. Private or ambiguous APIs
and repeated mappings of the same theorem are rejected. Preconditions are optional
author prose; empty prose retains an existing claim's text. Use
`precondition = "true"` only when the theorem needs no additional input assumptions.
The module and theorem names currently accept dotted ASCII identifiers.

After committing and pushing, run from the Lean project directory:

```sh
cd proofs
cargo proofs run --manifest-path ../Cargo.toml -- lake build
cargo proofs publish --manifest-path ../Cargo.toml --dry-run
cargo proofs publish --manifest-path ../Cargo.toml
```

The recorder builds every mapped module explicitly in a detached checkout, then
runs `lake env lean --stdin` with a generated audit that requires each mapped
name to be a theorem. It follows transitive axiom dependencies and accepts only
`propext`, `Classical.choice`, and `Quot.sound`. Proofs relying on `sorryAx`,
custom axioms (including axiomatized external models), or native-decision axioms
are rejected. Compilation errors, missing theorems, and failed audits cannot be
published. The evidence link points to the committed Lean module; the SARIF
contains the exact audit, mappings, and build/audit logs. Reproduction includes
both the module build and the audit. Changing mappings requires another run.

The guarantee is that Lean accepted the named theorem under the allowed axioms.
Model freshness, extraction correctness, API correspondence, the meaning of the
stated precondition, and the selected theorem's strength remain review obligations.
Lean, Lake, the pinned Aeneas library, and their build tools remain trusted inputs.
The recorder captures the default Cargo configuration for dependency review;
feature/target-specific extraction is not currently supported by this adapter.
Coq, F*, and HOL4 are not currently supported.

## Recording and reproduction

`run` checks the installed tool version against `proofs.toml`. Commit and push the verification inputs, including Cargo.lock, before recording. `[git].remote` selects the remote (default `origin`). A clean working tree and a commit reachable on that remote are required. Source URLs use GitHub and the full commit SHA.

Verification runs in a detached temporary Git worktree at that commit, with a separate build directory and locked dependency resolution. Git determines the checkout contents; there is no custom source collector, archive, file-count limit, or source upload size limit. The worktree registration and files are removed on success and errors. Tracked input changes during verification prevent publication.

Before saving a publishable run, the CLI checks the 8 MiB limit and an embedded schema generated from the server input contract. A schema mismatch stops with “Server-side changes are required”; the CLI and server contract need a coordinated update. This offline check covers format; semantic and authorization checks still run on the server.

Each run directory contains only `run.sarif.json`. SARIF is the canonical record for source provenance, command, timing, contracts, results and embedded stdout/stderr. The latest-run pointer and report publication state are local navigation/retry state, not duplicate execution records. Review the logs before publishing. The complete SARIF has an 8 MiB limit. `publish` sends it in one request; there is no separate metadata registration.

- Kani: regular serial check output is supported. Checks are associated with the exact observed contract harness. Quiet/terse output, parallel jobs, options disabling safety checks, and unknown result formats are rejected. Unexecuted harnesses do not generate claims; unreachable checks remain labeled unreachable.
- Creusot: a prover run must create fresh `proof.json` sessions that map unambiguously to selected APIs. Compilation alone, unchanged stale sessions, unresolved proof goals, and unsupported proof layouts do not certify an API. Free-function sessions and Creusot 0.13 and 0.14 method sessions are supported. Method sessions are matched by the generated Coma declaration source span and method name; ambiguous matches are rejected.
- A failed process, changed worktree, or run without verified contracts cannot be published. Rejected candidates remain local under `diagnostics/<UUID>/diagnostic.sarif.json` for inspection, without creating a publishable run or replacing the previous latest recording.
- Pass compilation flags **after** `--`, as part of the actual verifier command, for example `cargo proofs run -- cargo kani -Z function-contracts --features foo`. The same flags drive contract discovery. Select the workspace package with `-p NAME` as appropriate.
- One run per CLI publication is supported. `publish` selects the latest recording, or use `publish --run UUID` for an explicit recording. Changes to tool configuration or crate/version require a new run.

The report's collapsed **Reproduce** section contains Git clone/checkout commands for the external commit, the exact recorded command, check-to-claim links, execution metadata, the SARIF download, and embedded logs. Install the report's tool version and recorded Rust toolchain first. System dependencies are not bundled. Only `RUSTFLAGS`, `CARGO_ENCODED_RUSTFLAGS`, and `RUSTDOCFLAGS` environment overrides are recorded.

## Revisions, conflicts, and recovery

Publication state is stored in the OS local data directory under `cargo-proofs/`, isolated by server, author, package manifest, crate and version. It is not committed. One process may publish a given package/state at a time.

- Repeat `publish` revises the same report and preserves existing claim IDs. An unchanged report produces no revision.
- A changed crate version starts a new report (the service makes report crate/version immutable).
- On another machine, or after losing local state, use `publish --report ID` to attach explicitly. The CLI matches formal claims by API and theorem name, independently of the run ID. Other claims are matched by API. Duplicate matches are rejected.
- Each formal claim keeps its own ID and prose when specifications are added, removed, or reordered. A theorem rename or migration from a legacy claim can reuse the ID when the API has exactly one old and one new claim; with multiple claims, an unmatched theorem creates a new claim. A removed theorem's ID can be restored from local publication state.
- Titles/explanations and other individual editorial fields from the server are preserved. The report title is controlled by TOML; shared optional fields are preserved when absent, or cleared when explicitly `""`. Contracts and evidence are controlled by the selected SARIF record.
- If the server revision changed since the last publication, show the differences and stop. `publish --dry-run` previews the prospective update. `publish --force` applies the local/config-owned fields over the latest server state, preserving unspecified editorial fields. It still sends `expected_revision` so a concurrent edit after fetching is rejected.
- Missing contracts remove claims only after a yes/no prompt. Noninteractive approval requires `--yes`. `--force` does not approve deletions or bypass recorded-run checks. Removed claims retain their history/permanent links on the service. Locally known removed claim IDs are reused if their contracts are later restored; recovering removed IDs on a different machine is not automatic.
- Before a write, the CLI saves the exact request and idempotency key atomically. If publication is interrupted, `publish --resume` retries that saved request rather than generating another report. It prints the saved payload and uses its original recorded evidence. Definite rejected requests are cleared so they can be corrected; ambiguous/network failures retain the journal.

`--dry-run` never publishes a report or updates its local baseline. It authenticates and sends the selected SARIF to the service for the same structural, source, tool, successful-result and formal-evidence checks used by upload, then previews exact API bindings without storing the artifact. It does not perform final report creation/revision validation. Publication no longer requires a docs.rs catalogue import. The report limit is 200 claims (Kani discovery supports up to 100 APIs) and 128 KiB; each Aeneas theorem counts as one claim. Automatic splitting is deliberately unsupported.

## Development

```sh
cd cli
cargo fmt --check
cargo test
cargo clippy --all-targets -- -D warnings
cargo build --locked
python3 tests/e2e.py target/debug/cargo-proofs
python3 tests/preview.py target/debug/cargo-proofs
```

When changing preview code, shared views, or public assets, run `npm ci` and
`npm run build:preview` from the repository root **before** building the CLI.
Commit the generated `cli/preview/server.cjs` and license notices together with
the sources. `npm run check:preview` detects a stale bundle. Preview E2E tests
require Node.js 24+.

CI runs tests on Linux and macOS. Tests use temporary Git repositories and local HTTP servers; they never publish to proofs.rs, run Kani/Creusot/Lean (the separate Lean audit job runs Lean), or push user source repositories.

The `lean-audit` job runs real Lean/Aeneas integration tests only when CLI,
service, test, dependency, or CI inputs change. PRs compare their merge base with
the head; pushes compare before/after commits. Unavailable comparisons run the
full audit. Documentation, book, static assets, and frontend-only changes skip
this job; the regular CLI and service checks still run. Manual runs of **CLI and
service checks**, and its Monday 08:00 UTC schedule, always run the full audit.

Lean toolchains, compiled Aeneas dependencies, and Cargo dependencies are cached
between runs. The Aeneas cache requires an exact key matching the toolchain,
fixture, and preparation script; each test still builds and audits fresh proof
sources. The Actions summary records the selection reason, cache hits, and
dependency preparation time. To compare cold/warm performance, compare runs with
the same Aeneas key and check both the summary and job step durations.

### Source repositories with submodules

Recording automatically restores all submodules recursively at the Gitlink commits
in the recorded source revision, before Cargo metadata and API discovery. This
applies to every supported verifier; submodules are optional. Relative submodule
URLs resolve against the selected source remote. No remote branches are followed.
An inaccessible repository or missing commit stops recording. Git transport
restrictions are retained; the recorder does not enable the file protocol.

Submodule snapshots use an isolated temporary clone so initialization cannot alter
the original checkout's Git configuration. Recording checks pinned HEADs and tracked
files before and after verification, and removes the snapshot on success or failure.
Reproduction instructions initialize submodules after checking out the source commit.

### Automatic Aeneas formal statements

Aeneas runs can resolve specifications using committed `-emit-json` output.
Set `proof_modules = ["Proofs"]` and
`translation_manifest = "Generated/translation.json"` under `[tool]` (paths
relative to `lean_dir`), then use the usual `cargo proofs run -- lake build`
and `cargo proofs publish`. Every specification that resolves to one public API
produces its own claim, including multiple specifications for the same API.
Existing `[[tool.proofs]]` entries remain supported and override the mapping of
their named theorem without excluding other specifications for that API. New recordings capture the
full Lean proposition, typed binders, target expression, source and axiom audit;
Claim revisions refer to the recorded run and theorem, so editing prose cannot
change the displayed theorem. `precondition` prose may be omitted for these
records. Translation itself is not rerun by the recorder.

See [the Aeneas guide](https://proofs.rs/book/aeneas.html) for setup, scope,
provenance, limits, and the tested Lean 4.35.0 / Aeneas be86ab0f adapter.

### Findings in the report draft

Add optional `[[report.findings]]` entries to `proofs.toml`, each with `title` and
Markdown `body`. Titles are limited to 1,000 characters, bodies to 10,000, and an
initial report to 20 findings. A finding can describe an observation, precondition,
limitation, or bug; no fixed reproduction format is required.

```toml
[[report.findings]]
title = "A useful observation"
body = "The property requires **nonempty input**."
```

Preview reloads this prose without rerunning verification. Findings are created
atomically with a new report. When revising an existing report, preview shows its
published findings and publish leaves them unchanged; add or edit them through
the report page or Findings API. The local array is not synchronized or reposted.

Related APIs can be specified by public Rust paths in `proofs.toml`:

```toml
[[report.findings]]
title = "Empty input behavior"
body = "Describe the observed behavior here."
api_paths = ["my_crate::parse", "my_crate::Parser::parse"]
```

`api_paths` is optional (up to 50 paths). Each path must resolve uniquely in the
report's crate and version. Publication resolves paths to API IDs and deduplicates
aliases; an unresolved or ambiguous path prevents publication. Preview displays
these associations and warns about unresolved paths. This applies to initial
publication only; edit published findings through the Web/API.

## Aeneas patches and prepare

Set `[tool].patch = "proofs/toolchain/aeneas.patch"` to use a committed cumulative
patch against a registered official Aeneas base in `[tool].version`. Patch paths
are package-relative. No public fork is required. In a separate modified Aeneas
checkout, commit all desired changes (including new files), then save:

```sh
git diff --binary --full-index --no-ext-diff --no-textconv BASE_COMMIT HEAD -- > /path/to/proof-repo/proofs/toolchain/aeneas.patch
```

Ignore `.proofs-toolchain/` in the Lean directory, run `cargo proofs prepare`,
and set Lake's `aeneas` require to path `.proofs-toolchain/aeneas/backends/lean`.
Run `lake update` and `lake build`, commit/push the inputs, then record from the
Lean directory with `cargo proofs run -- lake build`, preview and publish.
`prepare` supports `--manifest-path` and `-p`, changes no tracked configuration,
and executes no proofs or translation. It refuses unmanaged or edited sources.

Only Aeneas patches are supported. Official Charon/Lean pins and Lake package
configuration must be preserved. Run restores from the committed patch afresh,
checks the actual dependency and Lean release, builds and audits proofs. It never
builds the translator or reruns Rust-to-Lean translation. Provenance is stored in
common `toolchain.components` and role observations in `toolchain.uses`.

Input fingerprints include patch path/bytes, settings and source inputs; source
identities exclude paths, IDs and observations. Restored trees are checked
separately. Updating a patch requires a new Run even with `--force`. Matching Runs
remain previewable/publishable after deleting managed sources without rebuilding.
Legacy Runs remain supported with provenance unrecorded. See the full
[Aeneas guide](https://proofs.rs/book/aeneas.html#use-a-cumulative-aeneas-patch).

Maintainers can run the real patched Lean integration with local pinned source and
external dependency caches (the Aeneas library itself is rebuilt in a fresh checkout):

```sh
python3 cli/tests/aeneas_patch_e2e.py cli/target/debug/cargo-proofs /tmp/patch-test /path/to/aeneas-git /path/to/lake-packages
python3 cli/tests/aeneas_patch_failure.py /tmp/patch-test /path/to/aeneas-git /path/to/lake-packages
PROOFS_REAL_AENEAS_RECORD=/tmp/patch-test/record.json node --import tsx --test --test-name-pattern='real Aeneas run' tests/app.test.ts
```

The second check retains an old successful compiled proof while recording a
failing committed proof; it must create only an unsuccessful Run. The last step
publishes only to a temporary localhost service fixture, checks changed-input
rejection even with `--force`, and verifies public and preview HTML. Ordinary
`cargo test` and `npm test` cover local restoration, descriptor validation,
source comparison, revision history and legacy flows.

### Report profiles and independently patched Charon

Use `--proofs-config aeneas/profiles/default/proofs.toml` to select a package-relative
report for run, prepare, preview (including drafts), and publish. Overrides have
separate local recording and publication state.

`[tool].patch` remains the cumulative Aeneas patch. Optional
`[tool].charon_patch = "patches/charon.patch"` restores Charon using the official
Aeneas base's unchanged charon-pin, with an independent patch hash and resulting
Git tree. Either patch can be used alone. Run `cargo proofs prepare` and configure
Lake to use `.proofs-toolchain/aeneas/backends/lean` when either patch is present.
Prepare restores source trees; it does not build or execute extraction tools.

Recording builds maintained Lean models and proofs from an isolated checkout.
Rust sources and proof inputs must be available from that checkout without custom
setup hooks. Repository-specific preparation files are not supported. Recorded
provenance distinguishes the resolved Aeneas Lean library and executed Lean checker
from the Aeneas translator and Charon frontend, both marked not_run. Declaring their
patches does not establish that they generated the saved models.

### Concrete API instances

`[tool].concrete_api = true` checks explicitly configured instances such as
`Crc<u8, Table<0>>::checksum` with the native Rust compiler. It supports public
structs, enums and aliases declared at the library root, simple root-local type
arguments, primitive type arguments and integer const arguments. Unsupported
forms are rejected. This mode is limited to the host cfg and is mutually
exclusive with `expand_api`. Methods must resolve to a safe callable function item
with at most eight arguments (including the receiver). Fully qualified trait
paths, reexported owners, explicit lifetime arguments and general const expressions
are not supported.

Discovery expands cfg-selected declarations with `RUSTC_BOOTSTRAP=1` scoped to
that compiler subprocess, matches a function on an applicable impl, then compiles
function-item references in an isolated Cargo probe using the selected library
and features. Callable and zero-sized function-item checks reject associated
constants, including function-pointer constants. The probe rejects changes to
the copied locked dependency graph. The inherited standard `Clone::clone_from`
is checked through the actual trait implementation and compiler resolution.

These are API presence checks, not surrogate crate implementations or formal
proof results. The standard Lean build and theorem/axiom audit are unchanged.

### Macro-generated Rust APIs

Aeneas reports that map derive or macro-generated implementations may set
`[tool].expand_api = true`. The recorder then enumerates public APIs using the
selected native Rust compiler with `cargo rustc --locked --lib`, the selected
features, and `-Zunpretty=expanded`. Only that subprocess receives
`RUSTC_BOOTSTRAP=1`; its temporary build output is discarded. This is an explicit
opt-in to unstable compiler output, not Rust-to-Lean extraction or proof evidence.
The compiler identity remains in the Run's `rustc` metadata and the discovery mode
is part of the recorded Aeneas configuration. Creusot and Kani do not use this mode.

Use public callable paths in `[[tool.proofs]]`, including qualified trait methods.
Specializations or enum branches of one Rust callable may map separate theorems to
the same API; express their scope in the theorem and precondition. Private module
paths and descriptive labels such as `contains<&Addr>` or `hosts(V4)` are not API
paths. Explicit mappings are checked before rebuilding Lean.

Compiler expansion also enumerates inherited defaults from active traits defined
in the selected crate. Explicit implementations replace defaults; private traits
and unknown external defaults are excluded. This supplies callable paths only.

### Export/ingestion compatibility checks

`npm run test:cli-contract` (from the repository root after building the CLI)
requires production CLI exports to pass production server ingestion. It covers
concrete and inherited APIs, manifest/manual proofs, toolchain provenance and
failed runs. CI also checks the packaged binary and blocks release on a mismatch.
See `docs/development.md` for corpus capture and coverage rules. Verifier fixtures
in this gate are synthetic; real Lean checks are a separate requirement.
