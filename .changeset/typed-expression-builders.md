---
"@systemfsoftware/timescale-drizzle": minor
---

Add a runtime query-expression surface, exported from `./expressions` and the package root, so consumers compose typed SQL fragments instead of raw `sql` templates: `greatest`, `least`, `coalesce`, `concat`, `concatWs`, `jsonbBuildObject` / `jsonbGet` / `jsonbText` / `jsonbArrayElements(Text)`, `interval`, `now`, `addInterval` / `subInterval`, `makeInterval`, `isDistinctFrom` (scalar and row tuple), `epochSeconds` / `epochMs`, `rowNumber`, `rowKey`, `excluded`, and `onConflictUpdateChanged`. The subpath imports only `drizzle-orm` and `drizzle-orm/pg-core`.
