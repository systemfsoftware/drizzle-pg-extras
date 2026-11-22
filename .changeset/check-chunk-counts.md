---
"@systemfsoftware/timescale-drizzle": minor
---

`timescale-drizzle check` fails when a hypertable keeps too many chunks.

- The steady-state chunk count is `ceil(dropAfter / chunkTimeInterval)`; the limit is 500, set with `--max-chunks`.
- A hypertable with no `retention` fails unless it declares `retention: 'unbounded'`.
- `expectedHistory` on an unbounded hypertable lets `check` count its chunks over that span.
