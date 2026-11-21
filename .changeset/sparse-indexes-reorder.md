---
"@systemfsoftware/drizzle-pg-extras": minor
---

Hypertables now accept `columnstore.sparseIndex` with `bloom` and `minmax` entries, validated against the documented restrictions and rendered into `timescaledb.sparse_index`. They also accept `reorder`, which names an index for `add_reorder_policy` and is removed or replaced when the declaration changes.
