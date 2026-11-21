---
"@systemfsoftware/drizzle-pg-extras": minor
---

The hypertable config now uses the current TimescaleDB columnstore vocabulary: `compression`, `compressionPolicy`, and `compressAfter` are replaced by `columnstore`, `columnstorePolicy`, and `after`. The emitted SQL uses `timescaledb.enable_columnstore`, `timescaledb.segmentby`, `timescaledb.orderby`, `add_columnstore_policy`, and `convert_to_rowstore`. Old snapshots still read. `create_hypertable` now uses `by_range` and a separate `add_dimension(..., by_hash(...))`, so `migrateData` cannot be combined with a space partition. Retention accepts `dropCreatedBefore`, and both policies accept `scheduleInterval`, `initialStart`, and `timezone`. `createDefaultIndexes: false` omits create_hypertable's default index.
