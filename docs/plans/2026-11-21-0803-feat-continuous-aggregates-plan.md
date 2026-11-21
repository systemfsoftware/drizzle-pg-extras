---
title: "Current TimescaleDB Surface: Continuous Aggregates, Hypercore, and Policies - Plan"
type: feat
date: 2026-11-21
topic: continuous-aggregates
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

## Goal Capsule

- **Objective:** A downstream application declares every TimescaleDB object it uses, including hypertables with the hypercore columnstore and sparse indexes, continuous aggregates stacked on other aggregates, and every policy it runs, next to its Drizzle schema; `drizzle-pg-extras generate` turns the declarations into reviewed up/down migrations that `drizzle-kit migrate` applies, and `drizzle-pg-extras check` gates drift, using the current TimescaleDB API rather than names kept only for compatibility.
- **Means:** A `continuousAggregate()` extras declaration, a widened `hypertable()` declaration (columnstore, sparse indexes, retention variants, reorder), and the current SQL vocabulary (`by_range`/`by_hash`, `enable_columnstore`, `add_columnstore_policy`, `drop_created_before`) in one breaking release; the stored snapshot accepts the old compression keys once, for upgrades.
- **Authority:** The brief; TimescaleDB 2.32.1 (released 2026-11-19, the latest release) documentation and release notes; the TimescaleDB SQL definitions; drizzle-kit 0.31.11 and drizzle-orm `main` view and migrator behavior; this repository's snapshot, diff, journal, and README contracts.
- **Open blockers:** None.

---

## Product Contract

### Summary

Declare the current TimescaleDB surface. Hypertables gain the hypercore columnstore with bloom/minmax sparse indexes, columnstore policies with `after` or `created_before`, retention with `drop_after` or `drop_created_before`, and a reorder policy. Continuous aggregates gain hierarchical stacks, real-time aggregation, chunk interval and group-index options, multiple concurrent refresh policies with the current arguments, columnstore settings and policy, and retention. Creation uses the generalized `by_range`/`by_hash` API and the columnstore names; deprecated names are read from old snapshots only.

### Problem Frame

The downstream application hand-writes every TimescaleDB statement it needs. The library covers hypertables, compression settings, retention, and compression policies, but it is behind the current release in three ways: it cannot express a continuous aggregate at all, its hypertable surface stops at the 2.18-era compression vocabulary, and it omits current policy and columnstore options that a hypertable user declares today.

The README excludes continuous aggregates for three reasons, and each one survives scrutiny only with a specific design:

- drizzle-kit owns view DDL, and its materialized-view CREATE has no `timescaledb.*` options. Its typed view config (`PgMaterializedViewWithConfig`) admits storage and autovacuum keys only, so `timescaledb.continuous` cannot pass through. An edited definition is DROP + CREATE, because PostgreSQL has no `CREATE OR REPLACE MATERIALIZED VIEW`. Letting kit own the view therefore produces a plain materialized view, never a continuous aggregate.
- Owning the SELECT appears to make the package responsible for later column changes. It does not have to: the package can store and diff the query text without inferring its output columns, and the typed column contract can stay on a Drizzle view marked `.existing()`.
- The custom migration that the README recommends is the thing this work removes. It has no diff, no down SQL, no idempotent render, and no `check`.

The current release changes the rest of the target. `CREATE TABLE ... WITH (tsdb.hypertable, tsdb.partition_column, tsdb.segmentby, tsdb.orderby, tsdb.sparse_index)` is the documented creation path, but drizzle-kit writes the `CREATE TABLE` and this package does not rewrite that file. The equivalent post-create calls are `create_hypertable(..., by_range(...))`, `ALTER TABLE ... SET (timescaledb.enable_columnstore, ...)`, and the policy functions. `WITH NO DATA` is required inside a transaction, and `ALTER MATERIALIZED VIEW` can flip real-time, change the chunk interval, enable the columnstore, and add a column without a rebuild.

### Current Surface Matrix

Latest release surveyed: **2.32.1, 2026-11-19**. "Declared" means a schema declaration produces SQL through this package; "Not declared" states the reason.

| Surface | Current API in 2.32.1 | Declared | Where, or why not |
| --- | --- | --- | --- |
| Hypertable creation via `CREATE TABLE ... WITH (tsdb.hypertable, ...)` | `tsdb.hypertable`, `tsdb.partition_column`, `tsdb.chunk_interval`, `tsdb.create_default_indexes`, `tsdb.segmentby`, `tsdb.orderby`, `tsdb.sparse_index` | No, equivalent emitted | drizzle-kit writes the table; the package emits the equivalent `create_hypertable`, `ALTER TABLE`, and policy calls (R16, R24) |
| Time and space dimensions | `create_hypertable(relation, by_range(...))`; `add_dimension(relation, by_hash(...))` | Yes | R16 |
| Additional dimensions | `add_dimension(relation, by_range(...) / by_hash(...))` | No | The declaration models the common one time dimension plus one hash dimension; extra dimensions stay hand-written |
| Change the hash partition count | `set_number_partitions` | No | The declaration treats the space dimension as immutable and throws; re-routing is a planned migration, not a silent default |
| Internal chunk schema and prefix | `tsdb.associated_schema`, `tsdb.associated_table_prefix` | No | No generalized `create_hypertable` argument exists; the defaults apply |
| Index options | `CREATE INDEX ... WITH (timescaledb.transaction_per_chunk)` | No | drizzle-kit owns index DDL (R27) |
| Chunk interval | `by_range` interval; `set_chunk_time_interval` | Yes | R16 |
| Default indexes | `create_default_indexes` | Yes | R16 |
| Columnstore enable, segment by, order by | `ALTER TABLE ... SET (timescaledb.enable_columnstore, timescaledb.segmentby, timescaledb.orderby)` | Yes | R13, R14 |
| Sparse indexes | `timescaledb.sparse_index` with `bloom(...)` and `minmax(...)`; automatic `firstlast` on `orderby` | Yes, bloom/minmax | R15; `firstlast` is server-maintained |
| Columnstore policy | `CALL add_columnstore_policy(..., after / created_before)` | Yes | R14 |
| Direct compress | `tsdb.direct_compress`, `timescaledb.direct_compress` | No | Tech preview; it also creates a compaction policy and is a per-table storage option, not a stable DDL contract |
| Compaction policy | `add_compaction_policy` | No | Tech preview; only meaningful with direct compress |
| Retention | `add_retention_policy(..., drop_after / drop_created_before)` | Yes | R13 |
| Reorder policy | `add_reorder_policy(hypertable, index_name)` | Yes | R18 |
| Chunk skipping | `enable_chunk_skipping` | No | Tech preview behind a server GUC |
| Imperative chunk operations | `convert_to_columnstore`, `convert_to_rowstore`, `move_to_columnstore`, `compact_chunk`, `merge_chunks`, `split_chunk`, `reorder_chunk` | No | One-off data operations, not declared state |
| Continuous aggregate creation | `CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous, timescaledb.chunk_interval, timescaledb.create_group_indexes, timescaledb.materialized_only)` | Yes | R4-R6 |
| Hierarchical aggregates | aggregate selecting from a finalized aggregate | Yes | R3 |
| Real-time aggregation | `timescaledb.materialized_only` | Yes | R5 |
| Refresh policies | `add_continuous_aggregate_policy` with `start_offset`, `end_offset`, `schedule_interval`, `initial_start`, `timezone`, `include_tiered_data`, `buckets_per_batch`, `max_batches_per_execution`, `refresh_newest_first` | Yes; multiple per aggregate | R7 |
| Columnstore on an aggregate | `ALTER MATERIALIZED VIEW ... SET (timescaledb.enable_columnstore, timescaledb.segmentby, timescaledb.orderby)`; `add_columnstore_policy` | Yes | R8 |
| Retention on an aggregate | `add_retention_policy` with `drop_after` | Yes | R9 |
| Adding a column to an aggregate without a rebuild | `ALTER MATERIALIZED VIEW ... ADD COLUMN ... GENERATED ALWAYS AS (...) STORED` | No | Requires proving the edit is additive; the declaration is the full SELECT and changes rebuild (R10) |
| Granular refresh | `ALTER TABLE ... SET (timescaledb.cagg_enable_granular_refresh, cagg_granular_refresh_column, cagg_granular_refresh_start_offset, cagg_granular_refresh_end_offset)`; `ALTER MATERIALIZED VIEW ... SET (timescaledb.enable_granular_refresh)` | No | New in 2.30.1/2.31 with no reference page; API is storage parameters over catalogs, so it is revisited when documented (R25) |
| Unified policy API | `timescaledb_experimental.add_policies`, `alter_policies`, `show_policies`, `remove_policies` | No | Experimental schema; the per-policy functions are the stable surface (R26) |
| Session and server behavior | `timescaledb.enable_merge_on_cagg_refresh`, `skip_cagg_invalidation`, `enable_direct_compress_*`, AIC, vectorized DML | No | GUCs, not declared objects |

### Approach Comparison

| Approach | Who creates the view | What drizzle-kit does | A changed query | Verdict |
| --- | --- | --- | --- | --- |
| Kit-owned `pgMaterializedView(...).as(...)` | drizzle-kit | Emits `CREATE MATERIALIZED VIEW` with storage options only; DROP + CREATE when the definition changes | Replaces the continuous aggregate with a plain materialized view | Rejected: loses `timescaledb.continuous` and the materialized data |
| Extras-owned CREATE plus `.existing()` view | This package | Ignores the view (existing views are filtered out of create, drop, rename, alter) | This package emits a guarded rebuild | Chosen: keeps kit out of the DDL and keeps diff/check/down |
| Extras annotation only, query stays a hand migration | A person | Nothing | Nothing generated | Rejected: fails the requirement that generate, check, and down cover it |
| Build the SELECT from Drizzle's query builder | This package | Ignores the view | Rebuild from the rebuilt SELECT | Rejected: makes the package responsible for query compatibility and column inference |

The chosen approach reads the README's three objections as a division of labor, not a prohibition: the package owns the DDL and the query text, drizzle-kit owns the tables the query reads, and the developer owns the typed column view that queries use.

Changing an aggregate's query has three possible mechanisms: refuse and leave the change to a hand migration; rebuild with DROP + CREATE; or emit only `ALTER MATERIALIZED VIEW ... ADD COLUMN ... STORED` for columns that were added. TimescaleDB supports the additive ALTER, but proving a given edit is additive requires parsing and comparing the SELECT, which KD2 rules out. Refusing keeps the snapshot and the database inconsistent until a person edits files by hand. The rebuild is chosen, guarded by declared children (KD3).

### Requirements

**Continuous aggregates**

- R1. `continuousAggregate(name, config)` and `continuousAggregate(view, config)` are collected by `collectExtras()` and recorded in `_pg-extras.json`. A `view` must be a `pgMaterializedView(...).existing()`, and it supplies the name, schema, typed columns, and comment target; a non-existing view is rejected with an error that names `.existing()`.
- R2. `config.query` is a `string` or a Drizzle `SQL`; a `SQL` query is rendered with the project casing and stored as text. The package never parses the query, validates its clauses, or infers its output columns.
- R3. `config.source` is optional and names the declared hypertable or continuous aggregate the query reads. Declared sources create parents before children and drop children before parents. A declaration whose source is removed in the same change must be removed too; otherwise `generate` throws and names both objects.
- R4. Creation emits `CREATE MATERIALIZED VIEW IF NOT EXISTS <name> WITH (timescaledb.continuous[, timescaledb.chunk_interval = INTERVAL ...][, timescaledb.create_group_indexes = false][, timescaledb.materialized_only = false]) AS <query> WITH NO DATA`, preceded by a comment that names the backfill call. `WITH NO DATA` is not configurable.
- R5. `config.realTime` defaults to false. True adds `timescaledb.materialized_only = false` to the create; a later change emits `ALTER MATERIALIZED VIEW ... SET (timescaledb.materialized_only = <bool>)`. A real-time change never rebuilds.
- R6. `config.chunkInterval` adds `timescaledb.chunk_interval = INTERVAL ...` to the create, and a later change emits `ALTER MATERIALIZED VIEW ... SET (timescaledb.chunk_interval = INTERVAL ...)`. `config.createGroupIndexes` defaults to true; false adds `timescaledb.create_group_indexes = false` at create, and a change rebuilds because TimescaleDB only accepts it at create.
- R7. `config.refreshPolicies` is a list. Each entry carries `startOffset`, `endOffset`, `scheduleInterval`, and optional `initialStart`, `timezone`, `includeTieredData`, `bucketsPerBatch`, `maxBatchesPerExecution`, `refreshNewestFirst`; each emits `SELECT add_continuous_aggregate_policy(..., if_not_exists => TRUE)`. Policies are matched by their start/end pair regardless of array order: an entry with a changed schedule or options removes the matched policy with `remove_continuous_aggregate_policy(..., if_exists => TRUE)` and adds it again; a removed entry emits only the remove; a new pair emits only the add. Two entries with the same start/end pair are rejected.
- R8. `config.columnstore` with `segmentBy` and/or `orderBy` emits `ALTER MATERIALIZED VIEW ... SET (timescaledb.enable_columnstore, timescaledb.segmentby = ..., timescaledb.orderby = ...)`; `config.columnstorePolicy.after` emits `CALL add_columnstore_policy(<name>, after => ..., if_not_exists => TRUE)`, and `createdBefore` throws because TimescaleDB does not support it on an aggregate. Changes follow the hypertable rules from R14: settings are re-applied, a changed policy removes and re-adds it, and removing the columnstore converts every chunk with `convert_to_rowstore(chunk, if_columnstore => TRUE)` under a lock before `timescaledb.enable_columnstore = false`.
- R9. `config.retention.dropAfter` emits `add_retention_policy(<name>, drop_after => ..., if_not_exists => TRUE)` on an aggregate. `dropCreatedBefore` throws for an aggregate because TimescaleDB does not support it there. A changed policy removes and re-adds it.
- R10. A changed `query` or `source`, and the `createGroupIndexes` change in R6, emit a rebuild in this order: `DROP MATERIALIZED VIEW IF EXISTS <name>`, the R4 create, then the R7 policies. The up comment states that materialized rows are recomputed from the source and that the view is empty until a refresh.
- R11. A rebuild throws instead of writing a migration when a declared aggregate's `source` is the aggregate whose definition changed. The error names the affected stack and the two-step repair: remove the stack declarations and generate, then re-add them and generate.
- R12. Removing a declaration emits `DROP MATERIALIZED VIEW IF EXISTS <name>`. Down SQL recreates the previous definition and policies `WITH NO DATA`; materialized rows are not restored. Down SQL for R10 recreates the previous definition and policies `WITH NO DATA`. Neither down path calls `refresh_continuous_aggregate`.

**Hypertables, columnstore, and policies**

- R13. The hypertable config renames `compression` to `columnstore`, `compressionPolicy` to `columnstorePolicy`, and `compressAfter` to `after`, with no compatibility aliases. `columnstore` accepts `segmentBy`, `orderBy`, and `sparseIndex`. `columnstorePolicy` accepts `after` or `createdBefore` (mutually exclusive) plus `scheduleInterval`, `initialStart`, and `timezone`. `retention` accepts `dropAfter` or `dropCreatedBefore` (mutually exclusive) plus the same schedule fields, and emits `SELECT add_retention_policy(..., drop_after => ... | drop_created_before => ..., if_not_exists => TRUE)`; a change removes and re-adds the policy, and its down/removal removes it. The declaration adds `reorder: { index: string }` and `createDefaultIndexes?: boolean`.
- R14. Columnstore SQL is `ALTER TABLE ... SET (timescaledb.enable_columnstore, timescaledb.segmentby = ..., timescaledb.orderby = ...)`, `CALL add_columnstore_policy(..., after => ... | created_before => ..., if_not_exists => TRUE)`, and `CALL remove_columnstore_policy(..., if_exists => TRUE)`. Disabling converts every columnstore chunk with `convert_to_rowstore(chunk, if_columnstore => TRUE)` under the existing table lock before `timescaledb.enable_columnstore = false`. A changed policy removes and re-adds it.
- R15. `columnstore.sparseIndex` is a list of `{ type: 'bloom' | 'minmax', columns }` entries, rendered as the TimescaleDB `bloom(...)` / `minmax(...)` grammar and applied with the columnstore settings; declaring it without `columnstore.orderBy` throws. The declaration rejects a bloom or minmax on a `segmentBy` column, a single-column bloom on an `orderBy` column, and two single-column indexes on the same column; it accepts a composite bloom that includes the orderby column and minmax on the orderby column, as the current documentation allows.
- R16. `create_hypertable` emits `create_hypertable(<regclass>, by_range('<time>'[, INTERVAL '<chunk>']), create_default_indexes => <bool>, if_not_exists => TRUE[, migrate_data => TRUE])`. A space dimension follows as `add_dimension(<regclass>, by_hash('<column>', <n>), if_not_exists => TRUE)` in the same migration; a later `chunkTimeInterval` change emits `set_chunk_time_interval`. The positional overload is no longer emitted.
- R17. `migrateData: true` combined with a space dimension throws, because `add_dimension` only runs on an empty hypertable. The message says to drop one of the two options or write the conversion by hand.
- R18. A `reorder` declaration emits `SELECT add_reorder_policy(<regclass>, '<index>'::name, if_not_exists => TRUE)` and its down/removal emits `remove_reorder_policy(..., if_exists => TRUE)`; down re-adds a policy that the up file removed. A changed index removes and re-adds the policy, because TimescaleDB has no alter for it. At most one reorder policy is declared per hypertable.
- R19. A snapshot written by an earlier version with `compression`, `compressionPolicy`, or `compressAfter` loads and normalizes to the columnstore fields without producing a migration when the declaration says the same thing. The public TypeScript config accepts no deprecated key; the deprecated SQL names are never emitted.

**Migration pipeline**

- R20. The snapshot gains `continuousAggregates` entries carrying id, schema, name, query, source kind/schema/name, realTime, chunkInterval, createGroupIndexes, refreshPolicies, columnstore, columnstorePolicy, and retention. Hypertable entries carry the new columnstore, sparse-index, retention-variant, reorder, and default-index fields. A `_pg-extras.json` without any of these keys loads.
- R21. `generate` includes every declaration in the migration it already writes; `check` exits 1 while any statement is pending; an unchanged declaration writes nothing.
- R22. `renderIdempotent` emits creates, columnstore settings, sparse indexes, and every policy with its `if_not_exists` form. It never drops an aggregate or a policy and never disables the columnstore.
- R23. Statement order inside one migration is extension, hypertable conversion, aggregate creates parent-first, aggregate columnstore and policies, retention and reorder policies, then comments on the aggregate. Removals are child-first; a columnstore policy is removed before the columnstore is disabled.
- R24. The package does not emit `CREATE TABLE ... WITH (tsdb.*)` and does not rewrite drizzle-kit's file. README states the equivalence: `tsdb.partition_column` maps to `by_range`, `tsdb.segmentby`/`tsdb.orderby`/`tsdb.sparse_index` map to the columnstore settings, and `tsdb.chunk_interval` maps to the dimension interval. Columnstore is opt-in: unlike `CREATE TABLE WITH`, a declared hypertable without `columnstore` gets no columnstore and no implicit policy.

**Current-surface policy and documentation**

- R25. Preview and undocumented features are not declared: direct compress, the compaction policy, and chunk skipping are tech previews; granular refresh is new in 2.30.1/2.31 and has no reference page, only storage parameters exercised by the upstream test SQL. README lists each with the condition that would bring it in.
- R26. The `timescaledb_experimental` unified policy API is not used; the package emits the stable per-policy functions. README says so.
- R27. Imperative operations are not declarations: `convert_to_columnstore`, `convert_to_rowstore`, `move_to_columnstore`, `compact_chunk`, `merge_chunks`, `split_chunk`, `reorder_chunk`, and every GUC stay outside the schema. Index creation, including `CREATE INDEX ... WITH (timescaledb.transaction_per_chunk)`, stays with drizzle-kit.
- R28. README and compatibility state TimescaleDB 2.29.0 as the floor and the latest tested release (2.32.1 at this writing); each row of the surface matrix names whether the package declares it and why not when it does not. Deprecated names (`compression`, `add_compression_policy`, `decompress_chunk`, positional `create_hypertable`) are described as accepted by the server for existing migrations and never emitted.
- R29. The existing Timescale CI job pins the current release image by digest — `timescale/timescaledb:2.32.1-pg16` when this plan is written — and bumps that pin with the README version in the same change when a newer release ships. It does not test an older minor.

**Tests**

- R30. The Timescale integration test creates a hypertable with `by_range`/`by_hash`, columnstore settings, bloom and minmax sparse indexes, a columnstore policy with `after`, a retention policy with `drop_after`, and a reorder policy; then a two-level aggregate stack with a chunk interval, two concurrent refresh policies, real-time on, columnstore settings and policy, and aggregate retention. It runs through `drizzle-kit migrate`, proves a second `generate` is a no-op, changes one policy and one leaf query, and proves the down file restores the previous definitions child-first.
- R31. Unit tests cover every new SQL string, the sparse-index validation rules, create and drop ordering, the R11 guard, snapshot upgrade from the compression keys, snapshot round-trip, idempotent render, and `check` drift.
- R32. A `.changeset` intent covers the feature and the breaking rename.

### Key Decisions

- KD1. **The package owns the aggregate DDL; drizzle-kit owns the tables; the developer owns the typed view.** A kit-owned materialized view cannot carry `timescaledb.continuous`, and kit replaces an edited definition with DROP + CREATE, which would turn the aggregate into a plain view. `.existing()` keeps kit out of the DDL. Governs R1-R3, R20.
- KD2. **Store the query text, do not infer columns.** Parsing the SELECT to derive a column contract or to prove a change is additive duplicates PostgreSQL and breaks on every function the parser does not know. The typed columns stay on the `.existing()` view. Governs R2, R10.
- KD3. **A changed query is a rebuild, blocked by declared children.** TimescaleDB has no `CREATE OR REPLACE` for a continuous aggregate, and the additive `ADD COLUMN` path needs a proven additive edit. A rebuild is honest and keeps diff/check consistent; a declared child blocks it because dropping the parent would drop the child too. Governs R10-R12.
- KD4. **Create with `WITH NO DATA`.** The Drizzle migrator wraps every pending migration in one transaction, and TimescaleDB requires `WITH NO DATA` inside a transaction. A `WITH DATA` create would fail under `drizzle-kit migrate`. Governs R4, R12.
- KD5. **Adopt `by_range()`/`by_hash()` and accept one narrow loss.** TimescaleDB documents the positional interface as deprecated at 2.13 and `by_range` as the generalized API. The generalized call takes one dimension, and `add_dimension` only runs on an empty hypertable, so `migrateData` together with a space dimension is no longer expressible; it throws rather than silently changing behavior. Governs R16, R17.
- KD6. **Rename the public compression vocabulary to the columnstore, with one upgrade read.** The current release deprecates `timescaledb.compress`, `add_compression_policy`, `remove_compression_policy`, and `decompress_chunk`. Keeping the public keys on the old vocabulary while emitting the new SQL splits one concept across two names; aliases add a second convention. Only the stored snapshot reads the old keys, because that is the upgrade path. Governs R13-R15, R19.
- KD7. **Declare the aggregate columnstore and aggregate retention.** Both are current stable post-create statements (`ALTER MATERIALIZED VIEW`, `add_columnstore_policy`, `add_retention_policy`) and the snapshot already models the equivalent hypertable settings. Deferring them would leave two of the objects the downstream application describes outside the schema. Governs R8, R9.
- KD8. **Target the current API, not compatibility.** The floor is 2.29.0, where the declared surface (automatic `firstlast` sparse indexes since 2.28, concurrent refresh policies on hierarchical aggregates since 2.29) is coherent, and CI tracks the latest release. A newer release bumps the image and the documented version together. Governs R28-R30.
- KD9. **`CREATE TABLE WITH` stays out; emit the equivalent.** The package does not rewrite drizzle-kit's `CREATE TABLE`, so `tsdb.hypertable` cannot be used. `create_hypertable` plus `ALTER TABLE` reaches the same catalog state for the declared options, and the README states the one deliberate difference: no implicit columnstore policy. Governs R24.
- KD10. **Previews and the experimental namespace stay out.** Direct compress, compaction, and chunk skipping are tech previews; granular refresh is undocumented beyond its test SQL; the unified policy functions are experimental. Declaring any of them would freeze an unstable API. Governs R25-R27.

### Key Flows

- F1. **Declare a current-surface hypertable**
  - **Steps:** Declare the table, `hypertable` with a chunk interval, a space dimension, `columnstore` with `segmentBy`, `orderBy`, and bloom/minmax sparse indexes, `columnstorePolicy.after`, `retention.dropAfter`, and `reorder`.
  - **Outcome:** One extras migration emits `create_hypertable(by_range)`, `add_dimension(by_hash)`, the columnstore `ALTER TABLE`, the columnstore policy, retention, and reorder; a second run writes nothing; `check` exits 0; the down file removes policies and disables the columnstore. Covers R13-R19, R21-R23.
- F2. **Declare a two-level aggregate stack**
  - **Steps:** Declare the hourly aggregate with a chunk interval, a policy, real-time on, columnstore settings and policy, and aggregate retention; declare the daily aggregate with `source` set to the hourly declaration and two concurrent refresh policies.
  - **Outcome:** Creates run parent-first with policies after each create; the second generator run writes nothing; `check` exits 0. Covers R1-R9, R20-R23.
- F3. **Change a refresh policy or policy options**
  - **Outcome:** The matched policy is removed and re-added; the aggregate is not rebuilt. Covers R7.
- F4. **Change a leaf query**
  - **Outcome:** Drop, create `WITH NO DATA`, re-add policies; the down file restores the previous definition and policies. Covers R10-R12.
- F5. **Change a parent query in a declared stack**
  - **Outcome:** Generate throws, writes nothing, and names the stack and the two-step repair. Covers R11.

### Acceptance Examples

- AE1. **Covers R1-R9, R20-R23.** **Given** a scratch project with F1 and F2 declarations, **when** both generators and `drizzle-kit migrate` run, **then** the columnstore settings, sparse indexes, every policy, both aggregates, both refresh windows, and the aggregate columnstore and retention exist in the TimescaleDB informational views, a second generator run writes no file, and `check` exits 0.
- AE2. **Covers R4.** **Given** the migration from AE1, **then** every aggregate create ends in `WITH NO DATA`, and each policy call follows its aggregate.
- AE3. **Covers R7.** **Given** a changed refresh window and a changed schedule on a second window, **then** the migration removes and re-adds only those matched policies and emits no `DROP MATERIALIZED VIEW`.
- AE4. **Covers R10-R12.** **Given** a changed leaf query, **then** the migration drops and recreates the aggregate with `WITH NO DATA`; the down file restores the previous query and policies; the source rows are unchanged.
- AE5. **Covers R11.** **Given** a changed parent query with a declared child, **then** generate exits non-zero, writes no migration, and names both aggregates.
- AE6. **Covers R15.** **Given** a bloom index on a `segmentBy` column, **then** the declaration throws; **given** a composite bloom that includes the orderby column, **then** the migration renders it.
- AE7. **Covers R16, R17.** **Given** a hypertable with a chunk interval and a hash dimension, **then** the migration calls `create_hypertable(..., by_range(...))` and `add_dimension(..., by_hash(...))`; the same declaration with `migrateData: true` throws.
- AE8. **Covers R14, R15, R18.** **Given** columnstore settings, a `created_before` columnstore policy, and a reorder policy, **then** the migration uses `timescaledb.enable_columnstore`, `timescaledb.sparse_index`, `CALL add_columnstore_policy(... created_before => ...)`, and `add_reorder_policy`; the down file removes both policies and converts chunks back with `convert_to_rowstore`.
- AE9. **Covers R19.** **Given** a snapshot written with `compression` keys and an equivalent `columnstore` declaration, **when** generate runs, **then** no migration is written and the new snapshot holds the columnstore fields.
- AE10. **Covers R21.** **Given** a declaration edited without generating, **when** `check` runs, **then** it exits 1 and prints the pending statement.

### Scope Boundaries

- Not built: direct compress, compaction policies, chunk skipping, and granular refresh (R25). Each is a tech preview or an undocumented storage-parameter API; the README names the condition for revisiting.
- Not built: the `timescaledb_experimental` unified policy functions (R26).
- Not built: imperative chunk operations and every GUC (R27). They are not declarations and have no snapshot state to diff.
- Not built: automatic `ADD COLUMN ... STORED` for a changed aggregate. Detecting an additive edit requires SQL analysis; the rebuild path covers all edits.
- Not built: `WITH DATA`, a `CASCADE` drop, or a per-aggregate columnstore sparse index (the `ALTER MATERIALIZED VIEW` reference does not expose `sparse_index`).
- Not built: rewriting drizzle-kit's `CREATE TABLE`, so `tsdb.hypertable` and the automatic columnstore policy are not emitted (R24).
- Unchanged: `drizzle-kit push` and `pull` support; the supported path stays generate, then migrate. A push that drops and recreates a source table still drops dependent database objects, as the existing limitations note.

### Assumptions and Risks

- A1. PostgreSQL accepts `CREATE MATERIALIZED VIEW IF NOT EXISTS ... WITH (timescaledb.continuous)`. It is the idempotent form R4 and R22 depend on; the CI integration test proves it before the release. If rejected, the fallback is `DROP MATERIALIZED VIEW IF EXISTS` plus create in the idempotent script.
- A2. `add_dimension(..., by_hash(...))` succeeds inside the same transaction as `create_hypertable(..., by_range(...))` while the table is empty. The integration test proves it.
- A3. Every policy function runs inside the migration transaction, and `add_reorder_policy` accepts an index created by an earlier drizzle-kit migration. The integration test proves both.
- A4. A rebuild of a leaf aggregate is acceptable because the aggregate can always be recomputed from its source; the risk is the rebuild's time and the empty window until refresh. The up comment and R10 state both. A rebuild is refused when it would take a declared child with it.
- A5. Raising the floor to 2.29.0 drops support for older servers. The CI image is 2.32.1 today, and the README states the floor and the tested release; the changeset calls the break out.
- A6. The breaking config rename affects every existing `hypertable()` caller. The release is a minor version under 0.x; the changeset and README map each old key to its replacement, and the snapshot reader is the only place the old keys appear.
- A7. Tech previews can change shape without a major release. Declaring them now would freeze an unstable API, which is why R25 lists them as out.
- A8. TimescaleDB 2.32.1 is the latest release at this writing (2026-11-19). If a newer release ships before implementation, R29 requires the image and README version to move together; the surface matrix is re-surveyed then.

---

## Sources and Research

- Releases surveyed: [2.32.1, 2026-11-19](https://github.com/timescale/timescaledb/releases/tag/2.32.1) (latest), [2.32.0](https://github.com/timescale/timescaledb/releases/tag/2.32.0), [2.31.0](https://github.com/timescale/timescaledb/releases/tag/2.31.0), [2.30.0](https://github.com/timescale/timescaledb/releases/tag/2.30.0), [2.29.0](https://github.com/timescale/timescaledb/releases/tag/2.29.0), [2.28.0](https://github.com/timescale/timescaledb/releases/tag/2.28.0), [2.26.0](https://github.com/timescale/timescaledb/releases/tag/2.26.0), and the [CHANGELOG](https://github.com/timescale/timescaledb/blob/main/CHANGELOG.md).
- Creation and hypercore: [`CREATE TABLE`](https://docs.tigerdata.com/docs/reference/timescaledb/hypertables/create_table/) (`tsdb.*` options, automatic columnstore policy), [`create_hypertable()`](https://docs.tigerdata.com/docs/reference/timescaledb/hypertables/create_hypertable/) (one `by_range`/`by_hash` dimension), [`create_hypertable()` old interface](https://docs.tigerdata.com/docs/reference/timescaledb/hypertables/create_hypertable_old/) ("Deprecated 2.13.0"), [`add_dimension()`](https://docs.tigerdata.com/docs/reference/timescaledb/hypertables/add_dimension/) (empty hypertable), [`ALTER TABLE (hypercore)`](https://docs.tigerdata.com/docs/reference/timescaledb/hypercore/alter_table/) (`enable_columnstore`, `sparse_index`), [sparse indexes](https://docs.tigerdata.com/docs/build/performance-optimization/indexing/) (`bloom`, `minmax`, automatic `firstlast` since 2.28), [`add_columnstore_policy()`](https://docs.tigerdata.com/docs/reference/timescaledb/hypercore/add_columnstore_policy/), [`remove_columnstore_policy()`](https://docs.tigerdata.com/docs/reference/timescaledb/hypercore/remove_columnstore_policy/), [`convert_to_rowstore()`](https://docs.tigerdata.com/docs/reference/timescaledb/hypercore/convert_to_rowstore/).
- Policies and previews: [`add_retention_policy()`](https://docs.tigerdata.com/docs/reference/timescaledb/data-retention/add_retention_policy/) (`drop_after`, `drop_created_before`), [`add_reorder_policy()`](https://docs.tigerdata.com/docs/reference/timescaledb/hypertables/add_reorder_policy/), [`add_compaction_policy()`](https://docs.tigerdata.com/docs/reference/timescaledb/hypercore/add_compaction_policy/) (tech preview), [direct compress](https://docs.tigerdata.com/docs/build/data-management/write-data/insert/#improve-performance-with-direct-compress/) (tech preview), [`enable_chunk_skipping()`](https://docs.tigerdata.com/docs/reference/timescaledb/hypertables/enable_chunk_skipping/) (tech preview, server GUC).
- Continuous aggregates: [`CREATE MATERIALIZED VIEW`](https://docs.tigerdata.com/docs/reference/timescaledb/continuous-aggregates/create_materialized_view/) (`materialized_only`, `chunk_interval`, `create_group_indexes`, `WITH NO DATA` in a transaction), [`ALTER MATERIALIZED VIEW`](https://docs.tigerdata.com/docs/reference/timescaledb/continuous-aggregates/alter_materialized_view/) (real-time, columnstore, chunk interval, `ADD COLUMN ... STORED`), [`add_continuous_aggregate_policy()`](https://docs.tigerdata.com/docs/reference/timescaledb/continuous-aggregates/add_continuous_aggregate_policy/), [`remove_continuous_aggregate_policy()`](https://docs.tigerdata.com/docs/reference/timescaledb/continuous-aggregates/remove_continuous_aggregate_policy/), [`DROP MATERIALIZED VIEW`](https://docs.tigerdata.com/docs/reference/timescaledb/continuous-aggregates/drop_materialized_view/), [hierarchical aggregates](https://docs.tigerdata.com/docs/learn/continuous-aggregates/hierarchical-continuous-aggregates/), [refresh policies](https://docs.tigerdata.com/docs/build/continuous-aggregates/refresh-policies/).
- Granular refresh evidence: [PR #10299 (catalogs)](https://github.com/timescale/timescaledb/pull/10299), [PR #10546 (disable API)](https://github.com/timescale/timescaledb/pull/10546), [PR #10588 (offset changes)](https://github.com/timescale/timescaledb/pull/10588), and the SQL test that exercises the storage parameters (`tsl/test/sql/cagg_granular_refresh_api.sql`). No reference page exists yet.
- SQL definitions in the upstream repository: `sql/ddl_api.sql` (generalized `create_hypertable`, `by_range`, `by_hash`, old `add_dimension` unmarked as deprecated in code), `sql/policy_api.sql` (`add_retention_policy` with `drop_created_before`, `add_reorder_policy`, `add_compaction_policy`, `add_columnstore_policy`, cagg policy signatures, `timescaledb_experimental.add_policies`), `sql/sparse_index.sql`, `sql/maintenance_utils.sql` (`convert_to_columnstore`, `convert_to_rowstore`, `_timescaledb_functions.move_to_columnstore`), `tsl/test/sql/cagg_granular_refresh_api.sql`.
- drizzle-orm repository: `drizzle-kit/src/sqlgenerator.ts` (`PgCreateViewConvertor` emits `CREATE MATERIALIZED VIEW` from the view's typed options only), `drizzle-kit/src/snapshotsDiffer.ts` (an altered definition is DROP + CREATE; `isExisting` views are filtered out), at tag `drizzle-kit@0.31.11` and on `main`; `drizzle-orm/src/pg-core/view.ts` (`PgMaterializedViewWithConfig` has no `timescaledb.*` keys); `drizzle-orm/src/pg-core/dialect.ts` (`PgDialect.migrate` runs all pending migrations in one `session.transaction`). Drizzle docs: [Views](https://orm.drizzle.team/docs/views) (`.existing()`), [v0 to v1 changes](https://orm.drizzle.team/docs/v0-v1-changes).
- This repository: `packages/drizzle-pg-extras/src/defs.ts` (`ExtrasKind`, `Hypertable`), `src/snapshot.ts` (`HypertableSnapshot`, `Snapshot.version`, `viewIdentity`), `src/timescale-sql.ts` (current positional and compression SQL), `src/diff.ts` (`statementsBetween`, `idempotentStatements`, `hypertableChanges`), `src/generate.ts` (`planExtras`, write-on-change), `src/render-sql.ts`, `src/quote.ts`; `README.md` "TimescaleDB", "Timescale limits", "What it does not do yet", "Compatibility"; `.github/workflows/ci.yml` job `timescale`; `tests/integration/timescale.test.ts`; `tests/unit/timescale.test.ts`.
