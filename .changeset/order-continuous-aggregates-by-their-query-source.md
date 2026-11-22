---
"@systemfsoftware/drizzle-pg-extras": patch
---

Order continuous aggregates by the relation their query reads, so a child never renders before its parent even when `source` is omitted.
