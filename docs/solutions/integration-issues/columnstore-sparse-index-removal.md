---
title: "Clearing sparse indexes needs RESET, not an empty string"
category: integration-issues
module: timescaledb
date: "2026-11-21"
problem_type: integration_issue
component: migration_generation
severity: critical
symptoms:
  - "removing every sparseIndex entry produced no timescaledb.sparse_index option"
  - "the hypertable kept its previous bloom or minmax sparse index after regeneration"
  - "timescaledb.sparse_index = '' crashed TimescaleDB 2.32.1 on INSERT, UPDATE, or DELETE against columnstore chunks"
root_cause: unsafe_clear_value
resolution_type: code_fix
related_components:
  - migration_generation
tags:
  - timescaledb
  - columnstore
  - sparse-index
  - alter-table
  - reset
  - diff
---

# Clearing sparse indexes needs RESET, not an empty string

## Problem

In `@systemfsoftware/drizzle-pg-extras`, the exported `enableHypertableColumnstoreSql` renderer built the `ALTER TABLE ... SET (...)` option list only from non-empty collections. When a declaration changed from one or more sparse indexes to none, the renderer emitted no `timescaledb.sparse_index` option. TimescaleDB treats an option absent from `SET` as unchanged, so the previous sparse index survived regeneration even though the schema no longer declared it.

The first correction emitted `timescaledb.sparse_index = ''` to force a change. TimescaleDB 2.32.1 accepts that DDL, then crashes on ordinary `INSERT`, `UPDATE`, or `DELETE` against a chunk in the columnstore. The empty string is a distinct, unsafe configuration, not a neutral clear. The server's documented clear is `ALTER TABLE ... RESET (timescaledb.sparse_index)`, which removes the explicit configuration and re-enables default sparse-index selection.

## Mechanism

`timescaledb.sparse_index` has three states:

1. Never configured: TimescaleDB chooses a default sparse index from the columnstore settings.
2. Configured with one or more indexes: the explicit text value applies to future chunks.
3. Cleared with `RESET`: the explicit configuration is removed and the server default applies again.

Removing the last declared index moves the model from state 2 to state 3. Omitting the option leaves the database in state 2 because `ALTER ... SET` only changes named options. Writing `''` creates a fourth state — an explicit empty configuration — which is accepted at DDL time but crashes DML on columnstore chunks in 2.32.1.

The clearing transition must render a separate statement:

```sql
ALTER TABLE metrics SET (
  timescaledb.segmentby = 'device_id',
  timescaledb.orderby = 'time'
);

ALTER TABLE metrics RESET (timescaledb.sparse_index);
```

## Architectural Invariants

**Absent Is Not Clear:** for an `ALTER ... SET` option, omission means "leave the current value". A collection that can become empty needs an explicit transition, not an absent key.

**Use the Server's Reset Verb:** clearing a configuration means `RESET (option)`. An empty string is a value with its own behavior; it is never a substitute for removing a configuration.

**DML-Verified Clearing:** a clearing migration is verified by running `INSERT`, `UPDATE`, and `DELETE` against a hypertable with columnstore chunks after the migration. DDL success alone does not prove the resulting configuration is safe.

The anti-pattern is a magic empty value:

```text
if (sparseIndexes.length === 0 && previousSparseIndexes.length > 0) {
  options.push("timescaledb.sparse_index = ''");
}
```

The invariant form emits the reset statement after the `SET` list:

```text
const reset = sparseIndexes.length === 0 && previousSparseIndexes.length > 0;
return setStatement + (reset ? "ALTER TABLE ... RESET (timescaledb.sparse_index);" : "");
```

## Prevention

- Test the populated-to-empty transition, not only empty-to-populated; assert that the generated SQL contains `RESET (timescaledb.sparse_index)` and never `timescaledb.sparse_index = ''`.
- After clearing, run `INSERT`, `UPDATE`, and `DELETE` against a hypertable that still has columnstore chunks; all three must succeed.
- Treat every removable option as requiring the server's reset form, not an invented empty value.
