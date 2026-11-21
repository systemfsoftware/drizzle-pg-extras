---
"@systemfsoftware/drizzle-pg-extras": minor
---

Add `continuousAggregate()` for TimescaleDB continuous aggregates. Declare the materialized view with `pgMaterializedView(...).existing()`, pass its SELECT, and optionally its source hypertable or aggregate, real-time setting, chunk interval, and group-index setting. `generate` writes `CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous) ... WITH NO DATA`, rebuilds on a definition change, alters real-time and chunk interval in place, orders stacked aggregates parent-first and drops child-first, and keeps comments through rebuilds. A source table cannot be removed in the same change as its aggregate; a parent aggregate with a declared child cannot be rebuilt in one step.
