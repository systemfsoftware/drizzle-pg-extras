---
title: "TimescaleDB Continuous Aggregates and the Columnstore Vocabulary - Plan"
type: feat
date: 2026-11-21
topic: continuous-aggregates
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

## Goal Capsule

- **Objective:** A downstream application declares every TimescaleDB continuous aggregate it uses, including aggregates stacked on other aggregates, and their refresh policies next to its Drizzle schema; `drizzle-pg-extras generate` turns them into reviewed up/down migrations that `drizzle-kit migrate` applies, and `drizzle-pg-extras check` gates drift, exactly as it does for hypertables and their policies.
- **Means:** A `continuousAggregate()` extras declaration whose SELECT the package renders and diffs, with the typed read-only view declared separately through Drizzle's `pgMaterializedView(...).existing()`; plus one breaking release that moves the emitted hypertable SQL to the generalized `by_range()`/`by_hash()` form and to the columnstore names.
- **Authority:** The brief; TimescaleDB 2.32 documentation linked under Sources and Research; drizzle-kit 0.31.11 and drizzle-orm `main` view handling, read from the drizzle-orm repository; this repository's existing snapshot, diff, journal, and README contracts.
- **Open blockers:** None.

---

## Product Contract

### Summary

Add a `continuousAggregate()` declaration to the extras snapshot. It emits `CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous) ... WITH NO DATA`, refresh policies, real-time toggles, and guarded rebuilds when a query changes, with the same up/down, idempotent, snapshot-diff and `check` behavior the other objects have. The same release adopts TimescaleDB's generalized hypertable API and its columnstore vocabulary: `by_range()`/`by_hash()`, `enable_columnstore`, `add_columnstore_policy`.

### Problem Frame

The downstream application hand-writes every TimescaleDB statement it needs. The library already covers hypertables, compression settings, retention, and compression policies, but a continuous aggregate cannot be expressed at all, so a hierarchical stack and its refresh policies live outside the schema, outside the snapshot, and outside `check`.

The README excludes continuous aggregates for three reasons, and each one survives scrutiny only with a specific design:

- drizzle-kit owns view DDL, and its materialized-view CREATE has no `timescaledb.*` options. Its typed view config (`PgMaterializedViewWithConfig`) admits storage and autovacuum keys only, so `timescaledb.continuous` cannot pass through. An edited definition is DROP + CREATE, because PostgreSQL has no `CREATE OR REPLACE MATERIALIZED VIEW`. Letting kit own the view therefore produces a plain materialized view, never a continuous aggregate.
- Owning the SELECT appears to make the package responsible for later column changes. It does not have to: the package can store and diff the query text without inferring its output columns, and the typed column contract can stay on a Drizzle view marked `.existing()`.
- The custom migration that the README recommends is the thing this work removes. It has no diff, no down SQL, no idempotent render, and no `check`.

TimescaleDB 2.32 supplies the rest: `WITH NO DATA` is required to create an aggregate inside a transaction, and `ALTER MATERIALIZED VIEW` can flip real-time and add a column without a rebuild. The compression vocabulary the README uses is deprecated since 2.18 in favor of the columnstore.

### Approach Comparison

| Approach | Who creates the view | What drizzle-kit does | A changed query | Verdict |
| --- | --- | --- | --- | --- |
| Kit-owned `pgMaterializedView(...).as(...)` | drizzle-kit | Emits `CREATE MATERIALIZED VIEW` with storage options only; DROP + CREATE when the definition changes | Replaces the continuous aggregate with a plain materialized view | Rejected: loses `timescaledb.continuous` and the materialized data |
| Extras-owned CREATE plus `.existing()` view | This package | Ignores the view (existing views are filtered out of create, drop, rename, alter) | This package emits a guarded rebuild | Chosen: keeps kit out of the DDL and keeps diff/check/down |
| Extras annotation only, query stays a hand migration | A person | Nothing | Nothing generated | Rejected: fails the requirement that generate, check, and down cover it |
| Build the SELECT from Drizzle's query builder | This package | Ignores the view | Rebuild from the rebuilt SELECT | Rejected: makes the package responsible for query compatibility and column inference, which the problem frame avoids |

The chosen approach reads the README's three objections as a division of labor, not as a prohibition: the package owns the DDL and the query text, drizzle-kit owns the tables the query reads, and the developer owns the typed column view that queries use.

Changing an aggregate's query has three possible mechanisms: refuse and leave the change to a hand migration; rebuild with DROP + CREATE; or emit only `ALTER MATERIALIZED VIEW ... ADD COLUMN ... STORED` for columns that were added. TimescaleDB supports the additive ALTER, but proving a given edit is additive requires parsing and comparing the SELECT, which KD2 rules out. Refusing keeps the snapshot and the database inconsistent until a person edits files by hand. The rebuild is chosen, guarded by declared children (KD3).

Real-time aggregation is a `WITH` option at create and an `ALTER MATERIALIZED VIEW ... SET (timescaledb.materialized_only = ...)` afterward, with no data movement, so it is supported (R4). Columnstore on an aggregate is an `ALTER MATERIALIZED VIEW ... SET (timescaledb.enable_columnstore ...)` followed by `add_columnstore_policy`; it is deferred because the downstream application does not use it (KD7).

### Requirements

**Continuous aggregates**

- R1. `continuousAggregate(name, config)` and `continuousAggregate(view, config)` are collected by `collectExtras()` and recorded in `_pg-extras.json`. A `view` must be a `pgMaterializedView(...).existing()`, and it supplies the name, schema, typed columns, and comment target; a non-existing view is rejected with an error that names `.existing()`.
- R2. `config.query` is a `string` or a Drizzle `SQL`; a `SQL` query is rendered with the project casing and stored as text. The package never parses the query, validates its clauses, or infers its output columns.
- R3. `config.source` is optional and names the declared hypertable or continuous aggregate the query reads. Declared sources create parents before children and drop children before parents. A declaration whose source is removed in the same change must be removed too; otherwise `generate` throws and names both objects.
- R4. `config.realTime` defaults to false. True adds `timescaledb.materialized_only = false` to the create; a later change emits `ALTER MATERIALIZED VIEW ... SET (timescaledb.materialized_only = <bool>)`. A real-time change never rebuilds.
- R5. Creation emits `CREATE MATERIALIZED VIEW IF NOT EXISTS <name> WITH (timescaledb.continuous[, timescaledb.materialized_only = false]) AS <query> WITH NO DATA`, preceded by a comment that names the backfill call. `WITH NO DATA` is not configurable.
- R6. `config.refreshPolicy` is `{ startOffset, endOffset, scheduleInterval }` and emits `SELECT add_continuous_aggregate_policy(..., if_not_exists => TRUE)`. A changed policy removes the old one with `remove_continuous_aggregate_policy(..., if_exists => TRUE)` and adds the new one; removing `refreshPolicy` emits only the remove.
- R7. A changed `query` emits a rebuild in this order: `DROP MATERIALIZED VIEW IF EXISTS <name>`, the R5 create, and the R6 policy. The up comment states that materialized rows are recomputed from the source and that the view is empty until a refresh.
- R8. A rebuild throws instead of writing a migration when a declared aggregate's `source` is the aggregate whose query changed. The error names the affected stack and the two-step repair: remove the stack declarations and generate, then re-add them and generate.
- R9. Removing a declaration emits `DROP MATERIALIZED VIEW IF EXISTS <name>`. Down SQL recreates the previous definition and policy `WITH NO DATA`; materialized rows are not restored.
- R10. Down SQL for R7 recreates the previous definition `WITH NO DATA` and its previous policy. Neither down path calls `refresh_continuous_aggregate`.

**Migration pipeline**

- R11. The snapshot gains `continuousAggregates` entries carrying id, schema, name, query, source kind/schema/name, realTime, and refreshPolicy. A `_pg-extras.json` without the key loads, and a `{ name, schema }` declaration works without a typed view.
- R12. `generate` includes aggregates in the migration it already writes; `check` exits 1 while any aggregate statement is pending; an unchanged declaration writes nothing.
- R13. `renderIdempotent` emits the create and policy statements and never drops an aggregate.
- R14. Statement order inside one migration is extension, hypertable conversion, aggregate creates parent-first, aggregate policies, then comments on the aggregate. Removals are child-first.
- R15. A comment declared on the `.existing()` view is emitted after the aggregate exists; the same migration does not emit `CREATE VIEW` or `DROP VIEW` for that view.

**Hypertable SQL vocabulary**

- R16. `create_hypertable` emits the generalized form `create_hypertable(<regclass>, by_range('<time>'[, INTERVAL '<chunk>']), if_not_exists => TRUE[, migrate_data => TRUE])`. A space dimension follows as `add_dimension(<regclass>, by_hash('<column>', <n>), if_not_exists => TRUE)` in the same migration. The positional overload is no longer emitted.
- R17. `migrateData: true` combined with `partitioningColumn` throws, because `add_dimension` only runs on an empty hypertable. The message says to drop one of the two options or write the conversion by hand.
- R18. Columnstore SQL replaces compression SQL: `ALTER TABLE ... SET (timescaledb.enable_columnstore, timescaledb.segmentby = ..., timescaledb.orderby = ...)`, `CALL add_columnstore_policy(..., after => ..., if_not_exists => TRUE)`, `CALL remove_columnstore_policy(..., if_exists => TRUE)`, and a disable path that calls `convert_to_rowstore(chunk, if_columnstore => TRUE)` for every columnstore chunk under the existing table lock before `timescaledb.enable_columnstore = false`.
- R19. The hypertable config renames `compression` to `columnstore`, `compressionPolicy` to `columnstorePolicy`, and `compressAfter` to `after`, with no compatibility aliases. The changeset and the README migration note state the break and map each old key to its replacement.
- R20. README and compatibility state TimescaleDB 2.18 as the floor, which the columnstore names set and which also covers `by_range` (2.13). CI stays on `timescale/timescaledb:2.32.1-pg16`.

**Tests and documentation**

- R21. The existing Timescale CI job runs an integration test that creates a hypertable and a two-level aggregate stack through `drizzle-kit migrate`; inspects the installed refresh policies; proves a second `generate` is a no-op; changes one policy and one leaf query; proves the down file restores both previous definitions child-first; toggles real-time; and reads `timescaledb_information.hypertable_columnstore_settings`.
- R22. Unit tests cover every new SQL string, create and drop ordering, the R8 guard, snapshot round-trip, idempotent render, and `check` drift.
- R23. The README's TimescaleDB section documents the declaration, the `.existing()` view, `WITH NO DATA` and the backfill call, hierarchical stacks, and real-time. "Timescale limits" replaces the exclusion with the surviving limits, "What it does not do yet" drops continuous aggregates, and every compression reference becomes columnstore.
- R24. A `.changeset` intent covers the feature and the breaking rename.

### Key Decisions

- KD1. **The package owns the aggregate DDL; drizzle-kit owns the tables; the developer owns the typed view.** A kit-owned materialized view cannot carry `timescaledb.continuous`, and kit replaces an edited definition with DROP + CREATE, which would turn the aggregate into a plain view. `.existing()` keeps kit out of the DDL. Governs R1-R3, R11, R15.
- KD2. **Store the query text, do not infer columns.** The alternative, parsing the SELECT to derive a column contract or to prove a change is additive, duplicates PostgreSQL and breaks on every function the parser does not know. The typed columns stay on the `.existing()` view. Governs R2, R11.
- KD3. **A changed query is a rebuild, blocked by declared children.** TimescaleDB has no `CREATE OR REPLACE` for a continuous aggregate, so there is no in-place alternative. A rebuild is honest and keeps diff/check consistent; a declared child blocks it because dropping the parent would drop the child too. Governs R7-R10.
- KD4. **Create with `WITH NO DATA`.** The Drizzle migrator wraps every pending migration in one transaction, and TimescaleDB requires `WITH NO DATA` inside a transaction. A `WITH DATA` create would fail under `drizzle-kit migrate`; making it configurable would offer a setting that cannot run. Governs R5, R9, R10.
- KD5. **Adopt `by_range()`/`by_hash()` and accept one narrow loss.** TimescaleDB marks the positional interface deprecated as of 2.13, and it documents `by_range` as the generalized API. The generalized call takes one dimension, and `add_dimension` only runs on an empty hypertable, so `migrateData` together with a hash dimension is no longer expressible; it throws rather than silently changing behavior. Governs R16, R17.
- KD6. **Rename the public compression vocabulary to the columnstore.** TimescaleDB deprecated `timescaledb.compress`, `add_compression_policy`, `remove_compression_policy`, and `decompress_chunk` in 2.18. Keeping the public keys on the old vocabulary while emitting the new SQL splits one concept across two names; compatibility aliases add a second convention. The package is 0.x and the release records the break. Governs R18-R20, R24.
- KD7. **Defer columnstore on an aggregate.** TimescaleDB supports it through `ALTER MATERIALIZED VIEW ... SET (timescaledb.enable_columnstore ...)` plus `add_columnstore_policy`, and the downstream application does not use it. The release covers what the goal needs; adding it later does not change the declaration shape. No requirement depends on this entry.

### Key Flows

- F1. **Declare a two-level stack**
  - **Trigger:** A project needs an hourly and a daily aggregate over one hypertable.
  - **Steps:** Declare the hypertable, the hourly aggregate with its refresh policy, the daily aggregate with `source` set to the hourly declaration and its own policy, and an `.existing()` materialized view for each aggregate the application queries.
  - **Outcome:** One run of `drizzle-kit generate`, then `drizzle-pg-extras generate`, writes the table migration and one extras migration; `drizzle-kit migrate` applies both; a second run of both generators writes nothing; `drizzle-pg-extras check` exits 0. Covers R1-R6, R11-R14.
- F2. **Change a refresh policy**
  - **Trigger:** The application widens the refresh window.
  - **Steps:** Edit `refreshPolicy`; run `drizzle-pg-extras generate`.
  - **Outcome:** One migration removes the policy and adds it again; the aggregate is not rebuilt. Covers R6, R12.
- F3. **Change a leaf query**
  - **Trigger:** A new aggregate column is needed in an aggregate with no declared children.
  - **Steps:** Edit `query` and the `.existing()` view's columns; generate.
  - **Outcome:** One migration drops and recreates the aggregate `WITH NO DATA` and re-adds its policy; the down file restores the previous definition. Covers R7, R9, R10.
- F4. **Change a parent query in a declared stack**
  - **Trigger:** The hourly aggregate's query changes while the daily aggregate declares it as `source`.
  - **Steps:** Run generate.
  - **Outcome:** Generate throws, writes nothing, and names the stack and the two-step repair. Covers R8.

### Acceptance Examples

- AE1. **Covers R1-R6, R11-R14.** **Given** a scratch project with a hypertable and a two-level stack, **when** both generators and `drizzle-kit migrate` run, **then** both aggregates exist in `timescaledb_information.continuous_aggregates`, both refresh jobs exist with the declared offsets, a second generator run writes no file, and `drizzle-pg-extras check` exits 0.
- AE2. **Covers R5.** **Given** the migration file from AE1, **then** every create ends in `WITH NO DATA`, and the policy call follows its aggregate.
- AE3. **Covers R6.** **Given** a changed refresh window, **when** generate runs, **then** the migration contains `remove_continuous_aggregate_policy` before `add_continuous_aggregate_policy` and no `DROP MATERIALIZED VIEW`.
- AE4. **Covers R7-R10.** **Given** a changed leaf query, **then** the migration drops and recreates the aggregate with `WITH NO DATA`; applying the down file restores the previous query and policy; the source table's rows are unchanged.
- AE5. **Covers R8.** **Given** a changed parent query with a declared child, **when** generate runs, **then** it exits non-zero, writes no migration, and names both aggregates.
- AE6. **Covers R16, R17.** **Given** a hypertable with a chunk interval and a hash dimension, **then** the migration calls `create_hypertable(..., by_range(...))` and `add_dimension(..., by_hash(...))`; the same declaration with `migrateData: true` throws.
- AE7. **Covers R18, R19.** **Given** a hypertable with columnstore settings and a columnstore policy, **then** the migration uses `timescaledb.enable_columnstore`, `timescaledb.segmentby`, `timescaledb.orderby`, and `CALL add_columnstore_policy`; the down file converts chunks back with `convert_to_rowstore` before disabling the columnstore.
- AE8. **Covers R12.** **Given** a declaration edited without generating, **when** `drizzle-pg-extras check` runs, **then** it exits 1 and prints the pending statement.

### Scope Boundaries

- Not built: columnstore settings or policies on a continuous aggregate (KD7). The declaration shape leaves room for a later `columnstore` key.
- Not built: retention policies on a continuous aggregate. The downstream application uses retention on hypertables only.
- Not built: generating or running `refresh_continuous_aggregate`. Creation uses `WITH NO DATA`, so the README tells the operator to backfill after `drizzle-kit migrate`.
- Not built: validation of continuous-aggregate query eligibility, including `time_bucket`, immutable functions, JOIN rules, and hierarchical bucket multiples. TimescaleDB rejects an ineligible query with its own error at migrate time.
- Not built: `time_bucket_gapfill`, window functions, and mutable functions in a query. They pass through as text when TimescaleDB accepts them.
- Not built: a per-aggregate chunk interval, `WITH DATA`, or a `CASCADE` drop. A parent drop must be expressed by removing the stack.
- Unchanged: `drizzle-kit push` and `pull` support; the supported path stays generate, then migrate. A push that drops and recreates a source table still drops dependent database objects, as the existing limitations note.

### Assumptions and Risks

- A1. PostgreSQL accepts `CREATE MATERIALIZED VIEW IF NOT EXISTS ... WITH (timescaledb.continuous)`. It is the idempotent form R5 and R13 depend on; the CI integration test proves it before the release. If it is rejected, the fallback is `DROP MATERIALIZED VIEW IF EXISTS` plus create in the idempotent script, which the test would then cover.
- A2. `add_dimension(..., by_hash(...))` succeeds inside the same transaction as `create_hypertable(..., by_range(...))` while the table is empty. The integration test proves it.
- A3. `add_continuous_aggregate_policy` and `remove_continuous_aggregate_policy` run inside the migration transaction. The integration test proves it.
- A4. A rebuild of a leaf aggregate is acceptable because the aggregate can always be recomputed from its source; the risk is the rebuild's time and the empty window until refresh. The up comment and R7 state both. A rebuild is refused when it would take a declared child with it.
- A5. Raising the floor to 2.18 drops support for older servers. The package has no released floor today beyond "tested with 2.32", and the CI image is 2.32.1, so the README states the new floor and the changeset calls it out.
- A6. The breaking config rename affects every existing `hypertable()` caller. The release is a minor version under 0.x; the changeset and README map each old key to its replacement, and no alias is kept.

---

## Sources and Research

- TimescaleDB 2.32: [`create_hypertable()`](https://docs.timescale.com/api/latest/hypertable/create_hypertable/) (generalized API; one `by_range`/`by_hash` dimension), [`create_hypertable()` old interface](https://docs.timescale.com/api/latest/hypertable/create_hypertable_old/) ("Deprecated 2.13.0"), [`add_dimension()`](https://docs.timescale.com/api/latest/hypertable/add_dimension/) (empty hypertable; `by_hash`), [`ALTER TABLE (hypercore)`](https://docs.timescale.com/api/latest/hypercore/alter_table/) (`enable_columnstore`; replaces compression, deprecated 2.18.0), [`add_columnstore_policy()`](https://docs.timescale.com/api/latest/hypercore/add_columnstore_policy/), [`remove_columnstore_policy()`](https://docs.timescale.com/api/latest/hypercore/remove_columnstore_policy/), [`convert_to_rowstore()`](https://docs.timescale.com/api/latest/hypercore/convert_to_rowstore/).
- TimescaleDB continuous aggregates: [`CREATE MATERIALIZED VIEW`](https://docs.timescale.com/api/latest/continuous-aggregates/create_materialized_view/) (`materialized_only`, `WITH NO DATA` inside a transaction), [`ALTER MATERIALIZED VIEW`](https://docs.timescale.com/api/latest/continuous-aggregates/alter_materialized_view/) (real-time, columnstore, `ADD COLUMN ... STORED`), [`add_continuous_aggregate_policy()`](https://docs.timescale.com/api/latest/continuous-aggregates/add_continuous_aggregate_policy/), [`remove_continuous_aggregate_policy()`](https://docs.timescale.com/api/latest/continuous-aggregates/remove_continuous_aggregate_policy/), [`DROP MATERIALIZED VIEW`](https://docs.timescale.com/api/latest/continuous-aggregates/drop_materialized_view/), [hierarchical continuous aggregates](https://docs.tigerdata.com/docs/learn/continuous-aggregates/hierarchical-continuous-aggregates) (finalized parent, bucket multiple, real-time stacking), [refresh policies](https://docs.tigerdata.com/docs/build/continuous-aggregates/refresh-policies).
- [timescale/timescaledb#6829](https://github.com/timescale/timescaledb/issues/6829): a hierarchical stack must be dropped child-first.
- drizzle-orm repository: `drizzle-kit/src/sqlgenerator.ts` (`PgCreateViewConvertor` emits `CREATE MATERIALIZED VIEW` from the view's typed options only), `drizzle-kit/src/snapshotsDiffer.ts` (an altered definition is DROP + CREATE; `isExisting` views are filtered out), at tag `drizzle-kit@0.31.11` and on `main`; `drizzle-orm/src/pg-core/view.ts` (`PgMaterializedViewWithConfig` has no `timescaledb.*` keys); `drizzle-orm/src/pg-core/dialect.ts` (`PgDialect.migrate` runs all pending migrations in one `session.transaction`). Drizzle docs: [Views](https://orm.drizzle.team/docs/views) (`.existing()`), [v0 to v1 changes](https://orm.drizzle.team/docs/v0-v1-changes) (folder-per-migration, `migrate` applies every missing migration).
- This repository: `packages/drizzle-pg-extras/src/defs.ts` (`ExtrasKind`, `Hypertable`), `src/snapshot.ts` (`HypertableSnapshot`, `Snapshot.version`, `viewIdentity`), `src/timescale-sql.ts` (current positional and compression SQL), `src/diff.ts` (`statementsBetween`, `idempotentStatements`, `hypertableChanges`), `src/generate.ts` (`planExtras`, write-on-change), `src/render-sql.ts` (`renderSql`), `src/quote.ts`; `README.md` "TimescaleDB", "Timescale limits", "What it does not do yet", "Compatibility"; `.github/workflows/ci.yml` job `timescale`; `tests/integration/timescale.test.ts`; `tests/unit/timescale.test.ts`.
