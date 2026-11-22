# Contributing

The library lives in [`packages/timescale-drizzle`](packages/timescale-drizzle). The repository root holds the workspace, the toolchain and the release configuration.

## Setup

The toolchain is pinned in `flake.nix`. With Nix installed:

```sh
nix develop
pnpm install
```

## Checks

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

Unit tests cover SQL generation and the snapshot diff, including comments, trigger rules, partition bounds and hypertable SQL.

The integration tests run against real servers and are skipped unless their URL is set:

- `POSTGRES_URL` points the Postgres tests at a server. One runs `drizzle-kit migrate`, checks that the trigger fires, and checks the comments on the table, column, enum, view, function, trigger, index, constraint and extension. Another checks a deferred constraint trigger, transition tables, `INSTEAD OF` on a view, `UPDATE OF` / `WHEN` and `DISABLE TRIGGER`. The partition test checks range, list and hash routing, attach, the empty-table guard and the down file.
- `TIMESCALE_URL` points the Timescale test at a server with the extension. It checks `create_hypertable`, compression, both policies, a second generate that changes the chunk interval, the down file, and that `drizzle-kit generate` reports no schema changes.

CI runs the Postgres tests on PostgreSQL 17 and the Timescale test in its own job on the `timescale/timescaledb-ha:pg17` image.

## Changes and releases

Each change to the package carries a changeset intent in [`.changeset/`](.changeset/README.md). Pull requests merge through the merge queue once CI is green and the change is approved. The Release workflow turns pending intents into a version pull request, writes `CHANGELOG.md`, tags the release and publishes to npm through trusted publishing, with no npm token stored in the repository. `nix.systemfsoftware.com` is the package registry for this project's Nix outputs: `nix build` pulls them from its binary cache, and npm publishes the library.
