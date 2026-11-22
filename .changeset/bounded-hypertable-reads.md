---
"@systemfsoftware/timescale-drizzle": minor
---

A hypertable is read through a time bound, so one query cannot plan every chunk.

- `hypertable()` returns a declaration that is not a Drizzle table, so `db.select().from(hypertable)` does not compile. Its `table` and the aggregate's `view` properties are gone.
- `hypertable.within({ gte, lt })` returns a Drizzle subquery with `time >= $1 AND time < $2` written into it.
- `hypertable.latest(db, { where, maxLookbackChunks, until })` finds the newest row with probes that widen from the chunk interval, and returns `{ found, row }` or `{ found: false, searchedFrom }`.
- `hypertable.unsafeUnbounded()` returns the plain table for migrations and admin code.
- `continuousAggregate(view, { bucketColumn })` adds the same `within` and `unsafeUnbounded` to an aggregate.

Breaking: read `hypertable.table` and `aggregate.view` through your own Drizzle table and view.
