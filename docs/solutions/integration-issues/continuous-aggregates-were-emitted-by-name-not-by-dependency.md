---
title: "Continuous aggregates were ordered by name, so a generated baseline created a child before the parent it reads"
category: integration-issues
module: diff_planner
date: "2026-11-22"
problem_type: integration_issue
component: database
severity: high
symptoms:
  - "applying a generated baseline to an empty TimescaleDB schema failed with relation \"<schema>.candle_5m\" does not exist while creating the <schema>.candle_15m materialized view"
  - "the failure only appeared when the baseline ran against an empty database; generation and typechecking stayed green"
root_cause: ordering
resolution_type: code_fix
related_components:
  - migration_generator
tags:
  - timescaledb
  - continuous-aggregates
  - migration
  - ordering
  - dependencies
---

# Continuous aggregates were ordered by name, so a generated baseline created a child before the parent it reads

## Problem

A consumer declared a continuous aggregate hierarchy by query alone: `candle_5m` over a hypertable, then `candle_15m` with `FROM "<schema>"."candle_5m"`, then `candle_1h` and `candle_1d` in turn, and declared `source` only on `candle_5m`. The generated baseline migration created `candle_15m`, `candle_1d` and `candle_1h` before `candle_5m`, so applying it to an empty schema failed:

```
relation "<schema>.candle_5m" does not exist
```

## Root cause

The emit order lives in the diff planner of `@systemfsoftware/drizzle-pg-extras`, in the internal `orderedContinuousAggregates` used by the exported `diffSnapshots` and `renderIdempotent`. It recorded a dependency only when an aggregate declared `source: <another aggregate>`. Without that declaration it fell back to the snapshot order, which `snapshotExtras` sorts by name — so a child whose name sorts before its parent's was emitted first.

The declaration was accepted and rendered without error; nothing checked that every relation an aggregate reads is created earlier in the same migration.

## Fix

Ordering now resolves a dependency from a declared `source` when present, and otherwise from the relations the aggregate's own query reads. Extraction scans every `FROM` and `JOIN` target, quoted or unquoted, schema-qualified or bare, and matches it against the declared continuous aggregates in the snapshot; a declared parent is still visited first and a cycle still fails generation.

Unit tests cover the queried parent declared after the child, an unquoted `FROM public.metrics_hourly`, and a parent reached through a `JOIN` after another relation. Each fails on the previous ordering and passes with the dependency scan.

## Prevention

A generator that emits dependent DDL must derive order from what each object reads, not from the name or the declaration order. Accepting a declaration without its dependency silently produces a migration that only fails on the empty database it was written for.
