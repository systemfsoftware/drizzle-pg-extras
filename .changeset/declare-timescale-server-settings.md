---
"@systemfsoftware/timescale-drizzle": minor
---

A schema can declare the server its TimescaleDB jobs run on with `timescaleServer`, which derives the worker settings (`max_worker_processes`, `timescaledb.max_background_workers`, parallel workers, `shared_preload_libraries`) as command-line arguments. `generate`, `check` and `renderIdempotent` refuse a schema whose declared policies could never start under its server, and `timescaleServerDrift` compares a running server's settings with the declaration. `PgExtras` gains a `servers` list.
