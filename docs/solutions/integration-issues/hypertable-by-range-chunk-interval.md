---
title: "create_hypertable rejects chunk_time_interval beside by_range"
category: integration-issues
module: timescaledb
date: "2026-11-21"
problem_type: integration_issue
component: migration_generation
severity: high
symptoms:
  - "function create_hypertable(regclass, _timescaledb_internal.dimension_info, chunk_time_interval => interval, if_not_exists => boolean) does not exist"
  - "the generated hypertable migration fails against TimescaleDB 2.32"
root_cause: api_shape_mismatch
resolution_type: code_fix
related_components:
  - migration_generation
tags:
  - timescaledb
  - create-hypertable
  - by-range
  - chunk-interval
  - partition-interval
---

# create_hypertable rejects chunk_time_interval beside by_range

## Problem

In `@systemfsoftware/timescale-drizzle`, the exported `createHypertableSql` renderer — the package's hypertable SQL renderer — generated a migration that combined the generalized dimension constructor `by_range('time'::name)` with the legacy named argument `chunk_time_interval => INTERVAL '1 day'`. TimescaleDB 2.32 has no `create_hypertable` overload that accepts a dimension descriptor and the legacy chunk-interval argument together, so the migration failed before creating the hypertable. Unit tests passed because they asserted the generated text, not the server grammar.

## Mechanism

TimescaleDB exposes two `create_hypertable` shapes:

1. The legacy shape takes the time column name plus `chunk_time_interval` as a top-level argument.
2. The generalized shape takes one or more dimension descriptors, such as `by_range(...)` and `by_hash(...)`, plus table-wide options.

`by_range` returns a dimension descriptor and owns its partition interval through the `partition_interval` argument. The legacy `chunk_time_interval` argument belongs to the first shape only. Passing it after a `by_range` descriptor selects no function signature.

The correct rendering is:

```sql
SELECT create_hypertable(
  'metrics'::regclass,
  by_range('time'::name, partition_interval => INTERVAL '1 day'),
  if_not_exists => TRUE
);
```

## Architectural Invariants

**Dimension-Owned Partitioning:** a dimension constructor owns its interval and partitioning arguments. The outer `create_hypertable` call carries only options that apply to the whole hypertable, such as `if_not_exists`, `migrate_data`, and `create_default_indexes`.

**One Signature per Rendering:** the generator must choose the legacy shape or the generalized shape, never combine arguments from both. A dimension descriptor is a complete replacement for the legacy column-name and chunk-interval pair.

The anti-pattern is a generated call where `by_range(...)` is followed by `chunk_time_interval =>` at the same argument level:

```text
create_hypertable(relation, by_range(column), chunk_time_interval => interval, ...)
```

The invariant form places the interval inside the descriptor:

```text
create_hypertable(relation, by_range(column, partition_interval => interval), ...)
```

## Prevention

- Exercise the generated migration against the pinned TimescaleDB server, not only against expected SQL strings.
- Treat a new `create_hypertable` option as belonging to exactly one layer: the dimension constructor or the outer table-wide call.
- When TimescaleDB adds a generalized constructor, audit every legacy argument and move the dimension-scoped ones into the descriptor.
