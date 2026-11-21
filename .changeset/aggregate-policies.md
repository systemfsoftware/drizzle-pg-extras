---
"@systemfsoftware/drizzle-pg-extras": minor
---

Continuous aggregates now accept `refreshPolicies`, `columnstore`, `columnstorePolicy`, and `retention`. Refresh policies render `add_continuous_aggregate_policy` with the declared windows, schedule, timezone, initial start, tiered data, batch limits, and newest-first option; a policy-set change removes the old policy and re-adds the declared set. Aggregate columnstore renders `ALTER MATERIALIZED VIEW ... SET (enable_columnstore, segmentby, orderby)`, its policy renders `CALL add_columnstore_policy`, and retention renders `add_retention_policy`. `createdBefore` and `dropCreatedBefore` are rejected on an aggregate.
