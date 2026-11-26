---
"@systemfsoftware/timescale-drizzle": patch
---

Render the `timeBucket` origin as a typed `timestamptz` literal so PostgreSQL selects the `time_bucket(interval, timestamptz, timestamptz)` origin overload instead of resolving the untyped literal to the `timezone text` overload and failing with `time zone "..." not recognized`.
