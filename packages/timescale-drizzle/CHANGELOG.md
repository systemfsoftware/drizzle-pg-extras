# Changelog

## 0.8.0

Declare views and grants, and move to drizzle 1.0.

- `viewDefinition(view, { query })` creates a Drizzle `pgView(...).existing()` from a raw query, in dependency order, and drops and creates it with its readers, comments, and grants when the query changes.
- `pgGrant({ to, on, privileges, onlyIfRoleExists })` grants on tables, views, functions, and schemas, optionally only where the role exists, and revokes what is removed.
- `pgFunction` takes a `schema`, `inout`, `variadic`, and `out` arguments, argument defaults, and `RETURNS TABLE` or `SETOF` results.
- A hypertable declared on a drizzle table accepts a column in a `uniqueIndex` as covering its partition key.
- A damaged `_pg-extras.json` is refused with its path in the message.
- Every statement in an up or down file ends with a semicolon, so the file also runs whole in `psql`.

Breaking: drizzle-orm and drizzle-kit `>=1.0.0-rc.6` and Node.js 20.19 are now required. The drizzle-kit 0.x journal layout and the `migrations.prefix` setting are no longer written; a folder kit 0.x wrote is refused before anything is written, with the advice to run `drizzle-kit up`.

Order continuous aggregates by the relation their query reads, so a child never renders before its parent even when `source` is omitted.

## 0.7.0

Continuous aggregates now accept `refreshPolicies`, `columnstore`, `columnstorePolicy`, and `retention`. Refresh policies render `add_continuous_aggregate_policy` with the declared windows, schedule, timezone, initial start, tiered data, batch limits, and newest-first option; a policy-set change removes the old policy and re-adds the declared set. Aggregate columnstore renders `ALTER MATERIALIZED VIEW ... SET (enable_columnstore, segmentby, orderby)`, its policy renders `CALL add_columnstore_policy`, and retention renders `add_retention_policy`. `createdBefore` and `dropCreatedBefore` are rejected on an aggregate.

The license is now Apache-2.0. `NOTICE` retains the MIT grant for code published under the earlier license.

Add `continuousAggregate()` for TimescaleDB continuous aggregates. Declare the materialized view with `pgMaterializedView(...).existing()`, pass its SELECT, and optionally its source hypertable or aggregate, real-time setting, chunk interval, and group-index setting. `generate` writes `CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous) ... WITH NO DATA`, rebuilds on a definition change, alters real-time and chunk interval in place, orders stacked aggregates parent-first and drops child-first, and keeps comments through rebuilds. A source table cannot be removed in the same change as its aggregate; a parent aggregate with a declared child cannot be rebuilt in one step.

The hypertable config now uses the current TimescaleDB columnstore vocabulary: `compression`, `compressionPolicy`, and `compressAfter` are replaced by `columnstore`, `columnstorePolicy`, and `after`. The emitted SQL uses `timescaledb.enable_columnstore`, `timescaledb.segmentby`, `timescaledb.orderby`, `add_columnstore_policy`, and `convert_to_rowstore`. Old snapshots still read. `create_hypertable` now uses `by_range` and a separate `add_dimension(..., by_hash(...))`, so `migrateData` cannot be combined with a space partition. Retention accepts `dropCreatedBefore`, and both policies accept `scheduleInterval`, `initialStart`, and `timezone`. `createDefaultIndexes: false` omits create_hypertable's default index.

Hypertables now accept `columnstore.sparseIndex` with `bloom` and `minmax` entries, validated against the documented restrictions and rendered into `timescaledb.sparse_index`. They also accept `reorder`, which names an index for `add_reorder_policy` and is removed or replaced when the declaration changes.

## Unreleased

- Turning off compression on a hypertable no longer fails once chunks are compressed. The generated SQL (in a down file, or when `compression` is removed from a declaration) now decompresses every compressed chunk before it switches compression off, because TimescaleDB refuses the switch while any chunk is compressed. On a large hypertable this rewrites the data, so allow for the time and disk space.

## 0.6.0

Drizzle 1.0 support, for [#6](https://github.com/Robertpaschal/drizzle-pg-extras/issues/6).

- Works with `drizzle-orm` and `drizzle-kit` 1.0 (tested on `1.0.0-rc.5`) as well as 0.x. The peer ranges now admit 1.0 prereleases.
- Internals that moved in 1.0 go through a small compatibility layer: `Casing` and `CasingCache` (gone from `drizzle-orm` / `drizzle-orm/casing`), `PgDialect`'s `casing` option, `PgArray` (now `dimensions` on the column), and the untyped `column.table`. `withComment()` accepts 1.0 column builders, which no longer extend `ColumnBuilder` at runtime.
- drizzle-kit 1.0 folders: the new migration's `snapshot.json` is an empty `diff` chained through `prevIds`, the same thing `drizzle-kit generate --custom` writes, instead of a copy of the previous snapshot. The folder name always sorts after the last one, even within the same second, so kit never reports two base snapshots.
- An empty migrations folder follows the installed drizzle-kit: folder-per-migration for 1.0, the journal for 0.x.
- CI runs the suite against drizzle 0.x on Node 18 and 22, and against the 1.0 release candidate on Node 22.

## 0.5.0

TimescaleDB hypertables, for [drizzle-orm#2962](https://github.com/drizzle-team/drizzle-orm/issues/2962).

- `hypertable()` appends `create_hypertable(..., if_not_exists => TRUE)` for a table drizzle-kit already created. Optional `chunkTimeInterval`, `partitioningColumn` / `numberPartitions`, and `migrateData`.
- Optional compression settings, `add_retention_policy`, and `add_compression_policy`.
- `pgExtension("timescaledb")` is required. `generate` throws if it is not in the schema.
- Continuous aggregates are not generated. This is a community package, not an official Timescale or Drizzle release.
- `_pg-extras.json` from 0.4.0 still loads. Hypertable keys are added the next time a migration is written.

## 0.4.0

The rest of `CREATE TRIGGER`, for [drizzle-orm#843](https://github.com/drizzle-team/drizzle-orm/issues/843) and the deferrable trigger case in [drizzle-orm#1429](https://github.com/drizzle-team/drizzle-orm/issues/1429).

- `constraint: true`, or `{ deferrable, initially, from }`, emits `CREATE CONSTRAINT TRIGGER`. `initially: "deferred"` requires `deferrable: true`. `from` is the referenced table. Postgres has no `OR REPLACE` for these, so a new or changed constraint trigger is `DROP TRIGGER IF EXISTS` plus create. Its comment is written again when the trigger is replaced.
- `referencing: { oldTable, newTable }` emits `REFERENCING OLD TABLE AS ... NEW TABLE AS ...` on an `AFTER` trigger, for one event, at row or statement level.
- `WHEN` and `UPDATE OF` were already emitted. They are now rejected at declaration when Postgres would reject them: `INSTEAD OF`, a statement `WHEN` that reads `OLD` or `NEW`, an `INSERT` `WHEN` that reads `OLD`, and a `DELETE` `WHEN` that reads `NEW`.
- `INSTEAD OF` accepts a `pgView()`. `BEFORE` and `AFTER` on a view must be `forEach: "statement"`. Materialized views cannot have triggers.
- `enabled: false` appends `ALTER TABLE ... DISABLE TRIGGER`. Turning it back on emits `ENABLE TRIGGER` without recreating the trigger. `CREATE OR REPLACE` enables a trigger, so a definition change that stays disabled emits `DISABLE` again.
- `_pg-extras.json` from 0.3.0 still loads. A trigger comment stored there still clears with `COMMENT ON TRIGGER ... IS NULL`.

## 0.3.0

Comments for the rest of the objects in [drizzle-orm#886](https://github.com/drizzle-team/drizzle-orm/issues/886).

- `withComment` and `commentOn` now cover enums, views, materialized views, `pgFunction` functions, triggers, and extensions.
- `withComment` on an index, unique index, `unique`, `check`, `primaryKey`, or `foreignKey` builder emits `COMMENT ON INDEX` or `COMMENT ON CONSTRAINT`. Put it inside the table extra-config callback.
- Removing a comment emits `COMMENT … IS NULL`. If the object itself was dropped, that statement is omitted.
- The statements are idempotent. A later `drizzle-kit generate` still reports no schema changes.
- `_pg-extras.json` from 0.1.0 and 0.2.0 still loads.

## 0.2.0

Declarative Postgres partitioning, for [drizzle-orm#2854](https://github.com/drizzle-team/drizzle-orm/issues/2854).

- `partitionedTable()` declares a `RANGE`, `LIST`, or `HASH` parent. The table stays in the Drizzle schema. `generate` converts the empty table drizzle-kit created and refuses to run when the table has rows.
- `pgPartition()` creates a child: `FOR VALUES FROM/TO`, `IN`, `WITH (MODULUS, REMAINDER)`, or `DEFAULT`.
- `pgAttachPartition()` and `pgDetachPartition()` attach and detach an existing table.
- Postgres 14 or newer. `generate` and `drizzle-kit migrate` only. `drizzle-kit push` is not supported.
- `_pg-extras.json` from 0.1.0 still loads. Partition keys are added the next time a migration is written.

## 0.1.0

Initial release. Functions, triggers, table and column comments, and extensions, written as drizzle-kit migrations.
