---
title: "Continuous aggregate DDL needs its own option and catalog rules"
category: integration-issues
module: timescaledb
date: "2026-11-21"
problem_type: integration_issue
component: migration_generation
severity: high
symptoms:
  - "ALTER MATERIALIZED VIEW ... SET (timescaledb.chunk_interval = INTERVAL ...) fails with a syntax error"
  - "a continuous aggregate declared with realTime true reports materialized_only as true"
  - "a continuous aggregate comment emitted as COMMENT ON MATERIALIZED VIEW fails"
  - "a hierarchical aggregate is rejected when its GROUP BY names the bucket alias"
root_cause: ddl_shape_mismatch
resolution_type: code_fix
related_components:
  - migration_generation
tags:
  - timescaledb
  - continuous-aggregates
  - materialized-view
  - chunk-interval
  - materialized-only
  - comment
---

# Continuous aggregate DDL needs its own option and catalog rules

## Problem

Continuous aggregates are created with `CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous)`, but after creation they do not behave like an ordinary PostgreSQL materialized view. The generator initially treated them as one: it rendered interval options as SQL expressions, assumed the TimescaleDB default matched real-time aggregation, and commented the object as a materialized view. Each mismatch passes unit assertions while failing against a live TimescaleDB 2.32 server.

## Mechanism

1. **WITH and SET options take constants, not expressions.** `timescaledb.chunk_interval` is an option value in both `CREATE MATERIALIZED VIEW ... WITH (...)` and `ALTER MATERIALIZED VIEW ... SET (...)`. `INTERVAL '1 hour'` is an expression and is rejected; `'1 hour'` is the accepted quoted value. Fixing only the create path leaves the alter path broken because both paths must use the same literal renderer.
2. **The materialized-only default is the opposite of real-time intent.** TimescaleDB defaults `timescaledb.materialized_only` to true. A declared `realTime: true` must render `timescaledb.materialized_only = false`; omitting the option does not enable real-time.
3. **The catalog kind is a view.** A continuous aggregate is a view with an internal materialization hypertable, so `COMMENT ON VIEW` is the valid comment target. `COMMENT ON MATERIALIZED VIEW` targets a different relation kind and fails.
4. **The grouping key is the time-bucket expression.** The aggregate query must group by `time_bucket(<interval>, <time column>)`, not by the output alias. The same expression is required when the source is another continuous aggregate; a hierarchical child groups by `time_bucket(<interval>, <parent bucket column>)`.
5. **Live fixtures need valid primary keys.** Two rows inserted with the same timestamp and device identifier collide on the hypertable primary key before refresh; the verification fixture must use distinct timestamps or keys.

## Architectural Invariants

**Phase-Symmetric Option Rendering:** every TimescaleDB option value has one literal representation shared by create and alter. A test that covers only one phase does not cover the option grammar.

**Catalog Kind Drives DDL Target:** comments and other PostgreSQL object commands must target the relation kind TimescaleDB actually creates, not the kind named by the creating statement.

**Defaults Are Not Intent:** an option whose server default contradicts the declared model must be emitted explicitly. Real-time aggregation is opt-in at the SQL layer even when it is the library's default model.

**Expression-Level Grouping:** a continuous aggregate's time dimension is recognized through the `time_bucket` expression in the query, not through an output alias.

## Prevention

- Exercise both create and alter paths against the pinned TimescaleDB server; assert the quoted option value in the generated SQL and run the migration.
- Read the continuous-aggregate informational view after creation to verify `materialized_only` and the declared aggregate names.
- Comment the aggregate through the view relation and assert the comment with `obj_description` on that relation.
- Write hierarchical queries with `time_bucket` in `GROUP BY`; do not rely on select-list aliases.
- Seed live verification tables with distinct primary keys before refreshing aggregates.
