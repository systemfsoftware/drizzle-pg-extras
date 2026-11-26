---
"@systemfsoftware/timescale-drizzle": patch
---

Render the `timeBucket` origin as a typed `timestamptz` literal so the 3-argument call binds the `origin` parameter of `time_bucket(interval, timestamptz, timezone text, origin, offset)`. The untyped literal previously bound the `timezone text` parameter and failed with `time zone "..." not recognized`.
