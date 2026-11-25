---
"@systemfsoftware/timescale-drizzle": minor
---

Typed query-side builders for TimescaleDB aggregates: `timeBucket` buckets a timestamp column with a structured `timeInterval` (a positive whole number and a closed unit union, never a raw interval string); `first` and `last` pick a value by a typed ordering expression; `filterWhere` adds a typed `FILTER (WHERE ...)` clause to an aggregate; `generateTimestampSeries` builds a `generate_series(start, stop, step)` time axis from `Date` bounds and a structured step, returning both the lateral-join table (`source`, carrying its own table and column aliases) and the qualified bucket column (`value`) for selection and ordering; and `trueCondition` supplies the typed boolean a lateral join against a set-returning function needs.
