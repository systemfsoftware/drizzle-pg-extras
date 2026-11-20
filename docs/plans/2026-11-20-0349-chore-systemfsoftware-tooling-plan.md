---
title: "Systemfsoftware Tooling Swap and SOTA Baseline - Plan"
type: chore
date: 2026-11-20
topic: systemfsoftware-tooling
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

## Goal Capsule

- **Objective:** drizzle-pg-extras is developed with the systemfsoftware stack — pnpm, oxlint, dprint, tsdown, commitlint, house-shaped CI — while the published package surface (exports map, dist files, engines, MIT license) stays exactly what v0.6.0 ships, and this artifact records where the library stands against the current state of the art with every found gap either scheduled as a unit or rejected with a reason.
- **Means:** minimal convention copy from public systemfsoftware sources — `systemfsoftware/effect-daemon` and upstream documentation; nothing invented. Implementation happens in later lanes; this lane writes and commits the plan only.
- **Product authority:** owner order (2026-11-20): "update the tooling but minimally i.e. pnpm latest, oxlint, dprint, the usual jazz were using. SOTAify it with gemini and then dogfood it into a systemfsoftware application". Earlier ruling: "no tsup obviously we use tsdown".
- **Open blockers:** none. The SOTA questions went to Gemini through the conductor; its rulings, accepted 2026-11-20, are recorded as KD10-KD13.
- **Execution profile:** one PR carrying U1-U7 in dependency order; implementation happens in later lanes; the owner releases (no publish from these lanes).

---

## Product Contract

### Summary

Swap npm to pnpm, ESLint to oxlint, tsup to tsdown, add dprint and commitlint, restyle CI to the house shape, and repoint package metadata at systemfsoftware/drizzle-pg-extras — all behavior-preserving. The same artifact carries a cited SOTA baseline (Drizzle 1.0, comparator libraries, TimescaleDB 2.32, Atlas) whose open questions went to Gemini and came back as recorded rulings (KD10-KD13).

### Problem Frame

The repo still carries the original author's stack: npm lockfile, ESLint flat config, tsup build. systemfsoftware took over maintenance and dogfoods the package in a systemfsoftware application, so contributor experience and CI now drift from every other maintained repo. The README's gap table against Drizzle also ages: drizzle-kit 1.0 rewrote migrations (folder layout, DDL snapshots), and 1.0 ships policies, roles, views, and sequences natively, so the comparison that justifies the package has moved and needs re-recording with citations.

### Actors

- A1. Contributor: clones, runs pnpm scripts locally, commits through commitlint.
- A2. Consumer: installs from npm; must see the same dist surface, exports, and engines as v0.6.0.
- A3. CI: runs static checks and the two database-backed lanes on systemfsoftware/drizzle-pg-extras.

### Requirements

**Toolchain**

- R1. pnpm is the only package manager: `packageManager` pins current pnpm 12 latest, `package-lock.json` is deleted, `pnpm-lock.yaml` is committed, and every script assumes pnpm.
- R2. tsdown replaces tsup and produces the same dist contract: `dist/index.js` (ESM), `dist/index.cjs` (CJS), `dist/index.d.ts`, `dist/index.d.cts`, and `dist/cli.js` with a node shebang, plus sourcemaps; `tsup.config.ts` and the tsup dependency are removed.
- R3. oxlint replaces ESLint: lint runs through `@systemfsoftware/oxlint-config-recommended` (the effect-daemon convention), with oxlint pinned to that preset's supported range; eslint, typescript-eslint, and `eslint.config.js` are removed.
- R4. dprint formats the repo with the effect-daemon `dprint.json` plugin set and style (no semicolons, single quotes, 120 columns), excludes adapted to this repo; `format` and `format:check` scripts exist; the swap includes one mechanical reformat of existing source.
- R5. commitlint guards commit messages with the effect-daemon config (`@commitlint/cli` v21, `config-conventional`, the house type-enum list, `no-ai-coauthors`).
- R6. Package metadata (`repository`, `bugs`, `homepage`) points at systemfsoftware/drizzle-pg-extras.
- R7. The consumer-facing surface stays unchanged: `engines` node >=18, `files`, exports map, `main`/`module`/`types`, `sideEffects`, peer ranges, MIT license.

**CI**

- R8. CI on every push and pull_request follows the house shape taken from systemfsoftware's reusable workflow: least-privilege permissions, pinned action SHAs with `persist-credentials: false`, concurrency group with PR cancellation, `pnpm install --frozen-lockfile`, Node 22 and 24 lanes, commitlint on PR squash messages.
- R9. CI keeps both database lanes: the Postgres 16 service covering the drizzle 0.x and drizzle 1.0-rc installs — the rc lane installs drizzle-orm/drizzle-kit from the `rc` dist-tag without mutating the committed lockfile — and the `timescale/timescaledb` lane, running only this package's own tests.
- R10. The workflow stays repo-owned rather than calling the reusable workflow, because the house reusable CI requires a Nix dev shell and exposes no service containers (KD7).

**SOTA baseline (artifact content, not code)**

- R11. The SOTA Baseline section states, per object type this package manages, the current state from primary sources with citations, and classifies every found gap as a scheduled unit or rejected with a reason.
- R12. Outstanding Questions lists the questions for Gemini, relayed by the conductor; answers may revise gap verdicts before those units are implemented and do not gate the tooling units. The 2026-11-20 answers arrived and are recorded as KD10-KD13; no open questions remain.

### Key Decisions

- KD1. tsdown replaces tsup, keeping dual ESM+CJS output (session-settled: user-directed — chosen over keeping tsup: owner ruling "no tsup obviously we use tsdown"). Governs R2. Challenge outcome: the current tsup config emits index esm+cjs+dts+sourcemap and a shebang-bannered cli (`tsup.config.ts`); tsdown covers the same surface, and the shebang banner mechanism is verified at implementation.
- KD2. The dual format stays: dropping CJS would break existing `require()` consumers and is not part of a tooling swap. Governs R2, R7.
- KD3. The house oxlint preset over a bare config (session-settled: user-directed — chosen over staying on ESLint: the owner's stack list). The preset peers pin oxlint ~1.93, so oxlint tracks that range rather than bleeding-edge 1.94. Governs R3. Risk: preset rules target Effect/cell-architecture repos and may need per-rule disables; any disable lands with a one-line reason.
- KD4. dprint runs as a devDependency via `pnpm exec`, not the `bin/dprint` Nix wrapper (session-settled: user-directed for dprint itself; the wrapper deviation is evidence-driven — that wrapper requires a flake this repo will not carry). Governs R4.
- KD5. `engines` stays >=18 while CI tests 22 and 24 (session-settled: user-directed — chosen over bumping engines: minimal consumer-contract preservation; the matrix floor is evidence-driven — oxlint, commitlint 21, and tsdown all require Node >=22 dev-side). Governs R7, R8.
- KD6. pnpm pins to latest 12.x at implementation time (12.21.0 on 2026-11-20). Governs R1.
- KD7. Repo-owned CI restyled from the reusable workflow's conventions instead of calling it: the reusable CI runs commands inside `nix develop` and has no services input, and adopting Nix is not minimal. Governs R8-R10.
- KD8. MIT stays; effect-daemon's Apache-2.0 is not adopted with a tooling swap. Governs R7.
- KD9. vitest stays 3.x and TypeScript stays 5.9 (session-settled: user-directed — "vitest kept"; the rest of the boundary is the minimality ruling). No Effect/tsgo/TS7/catalog/monorepo machinery. Governs R3-R5 context; restated in Scope Boundaries.
- KD10. The declaration-plus-appended-migration boundary is permanent: the package never couples to drizzle-kit's internal diff engine and never waits on upstream drizzle to ship these objects (session-settled: user-approved — Gemini's SOTA ruling relayed by the conductor, accepted 2026-11-20: kit rewrote its migration and snapshot internals, so differ coupling would break on every release, while this package's own snapshot/diff/check layer sits cleanly above kit's table DDL). Governs R11; answers Q1.
- KD11. TimescaleDB naming, floor, and ordering: the follow-up feature PR lands columnstore policy naming (U-G2) first, then continuous aggregates (U-G1); emitted DDL targets the 2.18+ columnstore functions (`add_columnstore_policy`, `remove_columnstore_policy`, `timescaledb.enable_columnstore`) with the `compression` TypeScript property kept as a deprecated alias so v0.6.0 callers do not break; the package floor becomes TimescaleDB 2.18 and CI tests 2.32.x (session-settled: user-approved — same channel: 2.18 standardized the columnstore terminology while the server keeps compression aliases, and U-G2's canonical policy builders are what U-G1's aggregates attach to; U-G1 is a declarative surface with full snapshot/diff/generate/check integration, never a raw SQL wrapper). Governs the U-G1/U-G2 deferred units; answers Q2 and Q3.
- KD12. Export-parity checks adopted now: `@arethetypeswrong/cli` (attw) and publint guard the dual ESM+CJS declaration output; `devExports` and `@microsoft/api-extractor` stay deferred until the Timescale API surface stabilizes (session-settled: user-approved — same channel: the checks directly verify KD2's dual-format output while the heavier machinery needs a stable surface first). Governs R7, U2; answers Q4.
- KD13. Functions stay IN-only and procedures stay out permanently (session-settled: user-approved — same channel: OUT/INOUT/VARIADIC changes pg_proc identity semantics for drop/alter, procedures add distinct transaction-control drop semantics, and there is no demand for either). Answers Q5.

<!-- ce-section: work-relationships -->
### How This Work Fits Together

This plan owns the tooling swap plus the SOTA baseline record. The owner's full directive also contains SOTA gap implementation (units below, in their own later lanes) and dogfooding into a systemfsoftware application, which follows once the tooling lands; both are current understanding, not a committed roadmap.

- Depends on: nothing.
- Enables: dogfooding — a systemfsoftware application consumes a house-styled package.
- Can proceed independently of: downstream application side changes.

### Key Flows

- F1. Contributor loop: clone → `pnpm install` → `format:check` / `lint` / `typecheck` / `test` (integration tests need `POSTGRES_URL`; timescale tests need `TIMESCALE_URL`) → commit through commitlint. Covers R1, R3-R5.
- F2. CI loop: push or PR → frozen install → static checks (format, oxlint, typecheck) → test lanes with services (Postgres: drizzle 0.x and 1.0-rc matrix; TimescaleDB) → PRs additionally lint their squash messages. Covers R8-R10.

### Acceptance Examples

- AE1. **Covers R1, R2, R7.** **Given** a fresh clone, **when** `pnpm install --frozen-lockfile && pnpm build` runs, **then** dist resolves through the unchanged exports map and both `import` and `require` work.
- AE2. **Covers R2, R7.** **Given** a definition change with no new migration, **when** the swapped toolchain builds, **then** `drizzle-pg-extras check` still exits 1 — behavior untouched.
- AE3. **Covers R10.** **Given** a PR that changes only docs, **when** CI runs, **then** the squash message is still linted.
- AE4. **Covers R7.** **Given** a consumer on Node 18 installing the next published version, **then** install succeeds and the CJS entry still resolves.

### Scope Boundaries

- No `src/` behavior changes; source diffs are mechanical dprint reformatting plus oxlint fixes that are named, listed, and behavior-preserving (KTD2) — a rule whose fix cannot stay behavior-preserving is disabled with a reason instead.
- No dependency bumps beyond tooling: drizzle-orm/drizzle-kit stay at current devDeps (0.45.x / 0.31.x; peers already allow 1.0), vitest stays 3.x, TypeScript stays 5.9 (KD9).
- No Nix flake, no turbo/catalog/monorepo, no `bin/` tool wrappers. The Effect toolchain (`@effect/tsgo`, `oxlint-tsgolint`, the `effect` peer) enters only as the oxlint preset's own required dependency set, not as an adopted framework (KD3, U3).
- No publish, no visibility change, no version bump or changelog entry — the owner releases.
- `/tmp/dpe` (rejected tsup-based edits) is ignored; nothing is revived from it.

### Deferred to Follow-Up Work

- The SOTA gap units — U-G2 columnstore-policy naming first, then U-G1 continuous aggregates (KD11) — land together in one follow-up feature PR with full snapshot/diff/generate/check integration.
- A drizzle-kit 1.0-final support pass once 1.0 reaches npm (on 2026-11-20 latest is 0.45.4 / 0.31.11 and `rc` resolves to 1.0.0-rc.5).
- The remaining API-parity machinery — `devExports` and `@microsoft/api-extractor` — deferred per KD12; attw and publint are adopted now (U2).

### SOTA Baseline

Verified 2026-11-20 against primary sources. This package covers functions, triggers, extensions, comments, partitioned tables, and TimescaleDB hypertables.

| Object | Drizzle 1.0 state | Comparator state | Verdict |
| --- | --- | --- | --- |
| Functions, triggers | Issues #843 open; PRs #5373 and #4844 open (gh api, 2026-11-20) | Atlas HCL declares trigger/function/procedure with diffing (atlasgo.io/hcl/postgres; triggers since Atlas v0.17, Jan 2024) | Niche intact; no unit — the boundary is permanent: declaration-plus-appended-migration, never a drizzle-kit differ coupling (KD10) |
| Extensions | #2124 open; 1.0 docs Extensions page: "There is no specific code to create an extension inside the Drizzle schema" | Atlas declares `extension` blocks | Covered; no unit |
| Comments | #886 open | onozaty/drizzle-db-comments-generator (single-purpose) | Covered; no unit |
| Policies, roles, views, matviews, sequences | Native in 1.0 (RLS docs: `pgPolicy`, `pgTable.withRLS`, `entities.roles`; Views docs) | — | Outside this package's identity; rejected |
| Partitioned tables | #2854 open | drizzle-partition rewrites kit's `CREATE TABLE`; Atlas declares partitions | Covered; no unit |
| Continuous aggregates | n/a | TimescaleDB 2.32 flagship: caggs, refresh policies, realtime, hierarchical, JOIN support matrix | **Scheduled — U-G1**, after U-G2, in the follow-up feature PR: declarative aggregates with refresh/retention/columnstore policies and full snapshot/diff/generate/check integration, never a raw SQL wrapper (KD11) |
| Columnstore policy naming | n/a | 2.18+ renames compression to columnstore (`add_columnstore_policy`, hypercore); repo emits `add_compression_policy` (`src/timescale-sql.ts`) | **Scheduled — U-G2**, before U-G1: emit 2.18+ columnstore DDL, keep `compression` as a deprecated TypeScript alias, package floor TimescaleDB 2.18, CI on 2.32.x (KD11) |
| `CREATE TABLE ... WITH (tsdb.hypertable)` | n/a | Newer declarative TimescaleDB form | Rejected: drizzle-kit owns `CREATE TABLE` and this package never rewrites kit files (README Partitioning rationale) |
| Function arg modes beyond IN; procedures (`CALL`) | n/a | Atlas supports OUT/INOUT/VARIADIC args and `procedure` blocks | Rejected permanently: IN-only functions, no procedures (KD13) |

Compared packages alive as of 2026-11-20 (gh api): RagedPanda/drizzle-triggers (pushed 2026-11-08), onozaty/drizzle-db-comments-generator (2026-10-12), Rezarys/drizzle-partition (2026-09-12) — each single-purpose, so the README's one-package breadth claim holds.

### Outstanding Questions

None open. Q1-Q5 were answered by the conductor-relayed Gemini SOTA rulings, accepted 2026-11-20, and are recorded as KD10-KD13 and in the SOTA Baseline verdicts. The continuous-aggregate declaration surface (KD11's U-G1) is designed in its follow-up lane.

### Sources / Research

- `package.json`, `tsup.config.ts`, `eslint.config.js`, `vitest.config.ts`, `tsconfig.json`, `.github/workflows/ci.yml` — current npm/ESLint/tsup state.
- `README.md` — gap table, distribution notes, dual migration-layout support, architecture boundaries.
- `src/index.ts`, `src/defs.ts`, `src/timescale-sql.ts` — public API surface and TimescaleDB coverage.
- systemfsoftware/effect-daemon (cloned 2026-11-20): root and `packages/effect-daemon-spec` package.json, `tsdown.config.ts`, `oxlint.config.ts`, `dprint.json`, `commitlint.config.ts`, `bin/dprint`, `.github/workflows/ci.yml`.
- systemfsoftware/systemfsoftware `.github/workflows/reusable-ci.yml` (fetched via gh api; pinned call SHA `f271b208fd10c56d27380de6bc43f54b9c7ee2a5` in effect-daemon ci.yml).
- Registry, 2026-11-20: pnpm 12.21.0 (node >=18); oxlint 1.94.0 (node ^20.19||>=22.12); `@systemfsoftware/oxlint-config-recommended` 8.0.3 (peer oxlint ~1.93, oxlint-tsgolint 7.0.2007); tsdown 0.23.7 (node ^22.18||^24.11||>=26); dprint 0.65.0; `@commitlint/cli` 21.2.4 (node >=22.12); drizzle-orm latest 0.45.4 / drizzle-kit latest 0.31.11 / `rc` = 1.0.0-rc.5.
- Drizzle 1.0: orm.drizzle.team/docs/v0-v1-changes (kit rewrite, folder layout, policies native); /docs/rls; /docs/extensions ("no specific code to create an extension"); gh api issues #843, #886, #2124, #2854 open; PRs #4844, #5373 open.
- Atlas: atlasgo.io/hcl/postgres (trigger/function/procedure/extension/view/aggregate blocks); atlasgo.io/blog/2024/01/01/atlas-v-0-17 (trigger support since v0.17); Atlas v1.4 announced 2026-11-17.
- TimescaleDB: docs.timescale.com (redirects to tigerdata.com/docs) continuous aggregates page (refresh, realtime since 2.13 disabled by default, hierarchical, JOIN matrix, v2.25 removes pre-2.7 cagg format); columnstore/hypercore policy functions; current release 2.32.1 (2026-11-19, gh api).
- tsdown: Rolldown output `banner` option (rolldown.rs/reference/OutputOptions.banner); shebang-bin precedent yamada-ui#5287 ("add shebang to binary via tsdown banner").
- SOTA rulings: conductor-relayed Gemini review, accepted by the owner 2026-11-20; recorded as KD10-KD13.
- Gate pins verified 2026-11-20: action SHAs dereferenced from real releases via `gh api` (checkout v7.0.1 = `3d3c42e5…`, matching the house reusable workflow's pin; setup-node v7.1.0 = `949feb24…`; pnpm/action-setup v6.1.1 = `73e46992…`); oxlint preset peer set via `npm view @systemfsoftware/oxlint-config-recommended@8.0.3`; TimescaleDB image `2.32.1-pg16` digest `sha256:5d7a2f9d…` via the Docker Hub registry API.

---

## Planning Contract

Product Contract restructured, no scope change: Scope Boundaries' "Deferred for later" items moved to `### Deferred to Follow-Up Work`; all R/A/F/AE/KD IDs unchanged.

The work ships as one PR: U1 through U6 in dependency order, U7 (metadata) independent and placed last. CI proof for U6 is off-host — the workflow can only be exercised by a push (see Verification Contract).

### Key Technical Decisions

- KTD1. tsdown config mirrors `tsup.config.ts` 1:1: entry `index` (esm+cjs, dts, sourcemap, clean, `external: [/^drizzle-orm/]`) and entry `cli` (esm, sourcemap, shebang banner, external drizzle-orm + jiti). (session-settled: user-directed — chosen over keeping tsup: owner ruling "no tsup obviously we use tsdown"; instantiates KD1, Governs R2.) tsdown exposes Rolldown's output `banner`, used upstream for exactly this shebang case; U2 verifies the emitted banner before tsup is removed.
- KTD2. oxlint pins to the preset's peer range `~1.93.0` (not latest 1.94.0), per `@systemfsoftware/oxlint-config-recommended`@8.0.3 peers (KD3). A non-mechanical finding in `src/` is fixed as a named, listed, behavior-preserving change in U3; a rule whose fix cannot stay behavior-preserving is disabled with a one-line reason — the same policy Scope Boundaries states.
- KTD3. The drizzle 1.0-rc lane installs `drizzle-orm@rc` and `drizzle-kit@rc` with `pnpm add -D` inside the ephemeral runner; the committed lockfile is never mutated (R9). The current workflow's `npm install --no-save` line has no direct pnpm equivalent, so the install command changes shape while keeping the matrix semantics.
- KTD4. commitlint runs in CI only, on PR squash messages, with no husky or lint-staged locally — the effect-daemon shape (R5, R8); husky + lint-staged hooks are monorepo machinery this single-package repo does not carry.

### Assumptions

- tsdown 0.23 emits dts and sourcemaps for this entry shape, and the cli banner survives the swap; verified during U2 before tsup is removed.
- The oxlint preset's real peer set — `effect` `^4.1.4`, `@effect/tsgo` `^0.70.0`, `oxlint-tsgolint` `7.0.2007`, `typescript` `>=5.0.0` (verified via `npm view @systemfsoftware/oxlint-config-recommended@8.0.3`) — installs under pnpm 12's auto-installed peers without resolution conflicts. `@effect/tsgo` is genuinely required by the preset (peer and direct dependency), so it is not an excluded dependency — Scope Boundaries agrees.
- The existing vitest 3 suite passes unchanged after the swap; no test files need edits.

---

## Implementation Units

### U1. Switch the package manager to pnpm

- **Goal:** pnpm is the only package manager (R1, KD6).
- **Requirements:** R1. **Dependencies:** none.
- **Files:** `package.json`, `package-lock.json` (delete), `pnpm-lock.yaml` (new).
- **Approach:** set `packageManager` to `pnpm@12.21.0` (latest 12.x at implementation time); delete `package-lock.json`; run `pnpm install` to generate the lockfile; scripts stay as-is.
- **Test expectation:** none — packaging change; smoke verification only.
- **Verification:** `pnpm install --frozen-lockfile` succeeds; `package-lock.json` absent from the tree.

### U2. Replace tsup with tsdown

- **Goal:** the same dist contract produced by tsdown (R2; KD1, KD2, KTD1).
- **Requirements:** R2. **Dependencies:** U1.
- **Files:** `tsdown.config.ts` (new), `tsup.config.ts` (delete), `package.json` (devDeps: `build` script swap, `@arethetypeswrong/cli`, `publint`), `tsconfig.json` (include list: `tsup.config.ts` → `tsdown.config.ts`).
- **Approach:** verify tsdown output parity first, then remove tsup — build with tsdown side by side, confirm the five dist files plus sourcemaps and the cli shebang, then delete `tsup.config.ts` and the tsup dependency in the same commit. The export surface is type-checked, not just runtime-smoked: `pnpm exec attw --pack .` and `pnpm exec publint` guard the dual ESM+CJS declaration output (KD12).
- **Test scenarios:**
  - Covers AE1. Fresh `pnpm install --frozen-lockfile && pnpm build`; a git diff of `package.json` shows the `exports`, `main`, `module`, and `types` fields byte-identical to v0.6.0, and `node --input-type=module -e "import('./dist/index.js')"` plus `node -e "require('./dist/index.cjs')"` both load — the map is proven unchanged by the diff, the artifacts behind it by the loads. (Do not import by bare package name from the repo root: pnpm does not self-link, so `import('drizzle-pg-extras')` cannot resolve there.)
  - Covers AE2. `dist/cli.js` executes directly (`./dist/cli.js --help` — shebang and executable bit, not only `node dist/cli.js`), and the pre-existing `tests/unit/cli.test.ts` suite passes unchanged under vitest — that suite already enforces AE2's check-exits-1 contract, so it passing unmodified is the parity evidence.
- **Verification:** dist file list matches the tsup output; `pnpm typecheck` passes with the updated tsconfig include; `pnpm exec attw --pack .` and `pnpm exec publint` report no export-surface or dual-format type-resolution problems (KD12).

### U3. Replace ESLint with oxlint

- **Goal:** house lint preset (R3; KD3, KTD2).
- **Requirements:** R3. **Dependencies:** U1.
- **Files:** `oxlint.config.ts` (new), `eslint.config.js` (delete), `package.json` (devDeps: `oxlint` `~1.93.0` and `@systemfsoftware/oxlint-config-recommended` `8.0.3`; `lint` script). The preset carries a fixed set with it: its own dependencies (`@systemfsoftware/oxlint-config-dmmf`, `-config-rule-authoring`, `-plugin-effect-platform`, `-plugin-test-discipline`, `-config-cell-architecture`) and its peers, which pnpm auto-installs — `oxlint-tsgolint` `7.0.2007` (the type-aware runner), `@effect/tsgo` `^0.70.0`, `effect` `^4.1.4`, and `typescript` `>=5.0.0` (already satisfied).
- **Approach:** copy the effect-daemon-spec two-line config (`import recommended from '@systemfsoftware/oxlint-config-recommended'`, `defineConfig({ extends: [recommended] })`); script `lint` becomes `oxlint .`; resolve first-run findings per KTD2.
- **Test expectation:** none — lint configuration; proven by exit codes.
- **Verification:** `pnpm lint` exits 0 with the preset proven loaded — oxlint's run summary shows the house preset's active rule count, or a seeded violation the preset catches fires; `git grep -nI -e eslint -e typescript-eslint` returns nothing outside docs/plans and CHANGELOG.

### U4. Add dprint formatting

- **Goal:** house formatter plus one mechanical reformat pass (R4; KD4).
- **Requirements:** R4. **Dependencies:** U1.
- **Files:** `dprint.json` (new), `package.json` (devDep `dprint`, `format`/`format:check` scripts), all formatted `.ts`/`.json`/`.md` sources (mechanical).
- **Approach:** copy effect-daemon `dprint.json` with the same pinned plugins; excludes: `dist/**`, `node_modules`, `pnpm-lock.yaml`, `coverage/**`, and `docs/**` — decision artifacts stay out of format churn; run one repo-wide reformat.
- **Test expectation:** none — formatting; behavior proven by the existing suite after the reformat.
- **Verification:** `pnpm format:check` exits 0; `pnpm typecheck` and the unit tests still pass after the reformat.

### U5. Add commitlint

- **Goal:** commit message conventions (R5).
- **Requirements:** R5. **Dependencies:** U1.
- **Files:** `commitlint.config.ts` (new), `package.json` (devDeps `@commitlint/cli`, `@commitlint/config-conventional`, `@commitlint/types` at ^21).
- **Approach:** copy the effect-daemon `commitlint.config.ts` verbatim — house type-enum list, `no-ai-coauthors` plugin, subtree-squash ignores.
- **Test expectation:** none — configuration; smoke below.
- **Verification:** `printf 'chore: swap tooling\n' | pnpm exec commitlint` passes; `printf 'banana: no\n' | pnpm exec commitlint` fails.

### U6. Restyle CI to house conventions

- **Goal:** house-shaped, repo-owned workflow (R8-R10; KD5, KD7, KTD3).
- **Requirements:** R8, R9, R10. **Dependencies:** U1-U5.
- **Files:** `.github/workflows/ci.yml`.
- **Approach:** keep the two service-backed test jobs (postgres 16 with the drizzle matrix, timescaledb); apply the house conventions from the reusable workflow: `permissions: contents: read`; a concurrency group with `cancel-in-progress` on non-main refs. Every GitHub Action is pinned by full commit SHA with its version in a comment, taken from each action's real releases: `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` # v7.0.1 with `persist-credentials: false` and `fetch-depth: 0` — the commitlint range needs the base commits, which a shallow clone cannot reach; `pnpm/action-setup@73e46992e05b19abd31f2f3c20e0e7370d762115` # v6.1.1 with no version input, so it reads `packageManager` from `package.json` (a version there would collide with the pin); `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1` # v7.1.0 with `cache: pnpm`. The timescale job's image is pinned to the exact tag `timescale/timescaledb:2.32.1-pg16` (digest `sha256:5d7a2f9d9d593315368338aa6054fda37d7707b4a12a912e30dcb7523385e2b4`), per KD11's CI target. Node matrix 22 and 24 on drizzle 0.x with a node 24 + drizzle 1.0-rc include installed per KTD3. The commitlint step is guarded to pull_request (`if: github.event_name == 'pull_request'`) with its refs wired explicitly from the event — step env `BASE: ${{ github.event.pull_request.base.sha }}`, `HEAD: ${{ github.event.pull_request.head.sha }}` — running `pnpm exec commitlint --from "$BASE" --to "$HEAD" --verbose`, which lints the PR's own commits, the content the squash message carries. Tests keep running on PRs as today — this suite is small, and the house fast/full split exists for suite sizes this repo does not have.
- **Covers AE3.** The commitlint step runs on `pull_request` events regardless of which paths changed — the reusable workflow linting docs-only PRs' squash messages is the convention being copied.
- **Test expectation:** none — workflow file; exercised only by a push (off-host).
- **Verification:** structural review against the reusable workflow's conventions — every action is SHA-pinned with a version comment, the timescale image matches the KD11 pin, and the commitlint env wires from `github.event.pull_request`; the first push reports the CI verdict (recorded in the PR).

### U7. Repoint package metadata

- **Goal:** metadata names the maintaining fork, and the development floor is documented (R6; KD5, KD8).
- **Requirements:** R6. **Dependencies:** none (placed last).
- **Files:** `package.json`, `README.md`.
- **Approach:** `repository.url`, `bugs`, `homepage` → `systemfsoftware/drizzle-pg-extras`; nothing else moves in `package.json` — license stays MIT, engines stays >=18. The README gains a one-line development note: Node >=22 to develop, Node >=18 supported for consumers (KD5) — `engines` itself is not touched.
- **Test expectation:** none — metadata and documentation.
- **Verification:** the three fields resolve to the fork (a `node -e` read of `package.json`); the README carries the contributor floor; `pnpm format:check` re-passes with the README edit in place, and the README's tool references (install command, script names, node floor) match the swapped toolchain.

---

## Verification Contract

| Check | Command | Proves | Done signal |
| --- | --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | U1, all | lockfile resolves; no `package-lock.json` |
| Build parity | `pnpm build` | U2 | `dist/index.js`, `index.cjs`, `index.d.ts`, `index.d.cts`, `cli.js` + sourcemaps; `cli.js` starts with `#!/usr/bin/env node` |
| Typecheck | `pnpm typecheck` | U2, U4 | exit 0 |
| Lint | `pnpm lint` | U3 | exit 0 with the preset's active rule count shown (or a seeded violation caught) |
| Export surface | `pnpm exec attw --pack .` && `pnpm exec publint` | U2 | no type-resolution or export-map problems in the dual-format output |
| Format | `pnpm format:check` | U4 | exit 0 |
| Unit tests | `pnpm exec vitest run tests/unit` | U2, U4 (behavior preserved) | green, no test edits needed |
| Integration tests | `pnpm exec vitest run tests/integration` with `POSTGRES_URL`; `TIMESCALE_URL` for the timescale file | U2, U4 | green (this package's own tests only) |
| Commitlint smoke | `printf 'chore: swap tooling\n' \| pnpm exec commitlint` | U5 | valid message passes, invalid type fails |
| CI | push to `systemfsoftware/drizzle-pg-extras` | U6 | green run on the PR (off-host; cannot run locally) |

---

## Definition of Done

- Global: every R1-R12 holds; the dist contract, exports map, engines, and license match v0.6.0; the existing test suite is green under pnpm with no test edits; `git grep -nI -e tsup -e eslint -e 'package-lock'` is clean outside `docs/plans` and `CHANGELOG.md`; nothing was published and visibility is unchanged.
- Cleanup: no scratch scripts or dead config remain; `/tmp/dpe` was not revived; the working tree contains only the plan and the unit changes.
- Per-unit: each unit's Verification row is done before the next dependent unit starts.

