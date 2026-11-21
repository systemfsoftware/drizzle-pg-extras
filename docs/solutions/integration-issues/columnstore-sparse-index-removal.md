---
title: "Removing the last sparse index left the old columnstore setting"
category: integration-issues
module: timescaledb
date: "2026-11-21"
problem_type: integration_issue
component: migration_generation
severity: high
symptoms:
  - "removing every sparseIndex entry produced no timescaledb.sparse_index option"
  - "the hypertable kept its previous bloom or minmax sparse index after regeneration"
root_cause: omission_is_not_reset
resolution_type: code_fix
related_components:
  - migration_generation
tags:
  - timescaledb
  - columnstore
  - sparse-index
  - alter-table
  - diff
---

# Removing the last sparse index left the old columnstore setting

## Problem

The columnstore settings renderer built the `ALTER TABLE ... SET (...)` option list only from non-empty collections. When a declaration changed from one or more sparse indexes to none, the renderer emitted no `timescaledb.sparse_index` option. TimescaleDB treats an option absent from `SET` as unchanged, so the previous sparse index survived regeneration even though the schema no longer declared it. The diff looked correct at the declaration level and wrong at the database level.

## Mechanism

`timescaledb.sparse_index` is a single text option on the hypertable. Its lifecycle has three distinct states:

1. Never configured: TimescaleDB chooses a default sparse index from the columnstore settings.
2. Configured with one or more indexes: the explicit text value applies to future chunks.
3. Explicitly empty: no sparse index is selected.

Removing the last declared index moves the model from state 2 to state 3. Omitting the option moves the database to state 1 only if it was never configured; on an existing hypertable it performs no change. The generated `SET` list therefore must contain an explicit empty value on the transition, not an absent key.

The clearing transition renders:

```sql
ALTER TABLE metrics SET (
  timescaledb.segmentby = 'device_id',
  timescaledb.orderby = 'time',
  timescaledb.sparse_index = ''
);
```

## Architectural Invariants

**Absent Is Not Clear:** for an `ALTER ... SET` option, omission means "leave the current value". A collection that can become empty needs an explicit clearing value in the option list; the renderer must branch on the transition, not only on the new collection's length.

**Model State Is Explicit:** every nullable or collection-valued setting has a rendered representation for each state, including empty. A conditional that only pushes non-empty values silently drops the empty state.

The anti-pattern is an option builder with no empty branch:

```text
if (sparseIndexes.length > 0) {
  options.push(sparseIndexOption(sparseIndexes));
}
```

The invariant form also emits the clearing option when the previous state was non-empty:

```text
if (sparseIndexes.length > 0) {
  options.push(sparseIndexOption(sparseIndexes));
} else if (previousSparseIndexes.length > 0) {
  options.push(emptySparseIndexOption());
}
```

The empty-string setting explicitly disables sparse indexing. Re-enabling the server's default selection is a different operation, `ALTER TABLE ... RESET (timescaledb.sparse_index)`, and must not be conflated with clearing an explicit declaration.

## Prevention

- Test the populated-to-empty transition, not only empty-to-populated; assert that the generated SQL contains the clearing option.
- Treat every removable collection in an `ALTER ... SET` renderer as requiring an empty-state branch.
- Compare the declarative model with the database after the clearing migration, not only the generated SQL text.
