# @systemfsoftware/timescale-drizzle

[![npm version](https://img.shields.io/npm/v/@systemfsoftware/timescale-drizzle)](https://www.npmjs.com/package/@systemfsoftware/timescale-drizzle)
[![CI](https://github.com/systemfsoftware/timescale-drizzle/actions/workflows/ci.yml/badge.svg)](https://github.com/systemfsoftware/timescale-drizzle/actions/workflows/ci.yml)

Drizzle ORM cannot yet model several Postgres objects. timescale-drizzle lets you declare them next to your Drizzle tables: functions, triggers, comments, extensions, partitioned tables, and TimescaleDB hypertables and continuous aggregates. `timescale-drizzle generate` writes plain SQL migration files for them, and `drizzle-kit migrate` applies those files like any other migration.

It does not modify `drizzle-orm` or `drizzle-kit`, so the SQL you commit stays valid if Drizzle later generates the same object itself.

## Example

A TimescaleDB hypertable with a columnstore and retention, declared in the same schema file as its table:

```ts
import { hypertable, pgExtension } from '@systemfsoftware/timescale-drizzle'
import { integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

export const timescale = pgExtension('timescaledb')

export const metrics = pgTable('metrics', {
  time: timestamp('time', { withTimezone: true }).notNull(),
  deviceId: text('device_id').notNull(),
  value: integer('value').notNull(),
}, (t) => [primaryKey({ columns: [t.time, t.deviceId] })])

export const metricsHypertable = hypertable(metrics, {
  timeColumn: metrics.time,
  chunkTimeInterval: '1 day',
  columnstore: { segmentBy: [metrics.deviceId] },
  columnstorePolicy: { after: '7 days' },
  retention: { dropAfter: '6 months' },
})
```

## Quick start

```sh
npm install @systemfsoftware/timescale-drizzle
drizzle-kit generate && timescale-drizzle generate && drizzle-kit migrate
```

The first `generate` writes a migration with `CREATE EXTENSION`, `create_hypertable` and the policy calls. The next `generate` writes nothing until a declaration changes, and then writes only the difference, with a matching `down.sql`.

Add the CLI to your scripts, and run `timescale-drizzle check` in CI. It exits 1 when a declaration changed and no migration was written:

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate && timescale-drizzle generate",
    "db:check": "timescale-drizzle check",
    "db:migrate": "drizzle-kit migrate"
  }
}
```

## Requirements

- Node.js 20.19 or newer. CI runs on Node.js 22 and 24.
- `drizzle-orm` 1.0.0-rc.6 or newer (a peer dependency). Drizzle 0.x is not supported.
- `drizzle-kit` 1.0.0-rc.6 or newer, optional, needed only to apply migrations.
- PostgreSQL 14 or newer. CI tests PostgreSQL 17.
- TimescaleDB, only if you declare hypertables, columnstores, retention or continuous aggregates.

> [!NOTE]
> `nix.systemfsoftware.com` is the package registry for this project's Nix outputs: `nix build` pulls them from its binary cache. npm publishes the library.

## What it covers

| Object                 | Drizzle request                                                             | Docs                                                                      |
| ---------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Functions and triggers | [drizzle-orm#843](https://github.com/drizzle-team/drizzle-orm/issues/843)   | [Triggers](packages/timescale-drizzle/README.md#triggers)                 |
| `COMMENT ON`           | [drizzle-orm#886](https://github.com/drizzle-team/drizzle-orm/issues/886)   | [Programmatic API](packages/timescale-drizzle/README.md#programmatic-api) |
| Extensions             | [drizzle-orm#2124](https://github.com/drizzle-team/drizzle-orm/issues/2124) | [Install](packages/timescale-drizzle/README.md#install)                   |
| Partitioned tables     | [drizzle-orm#2854](https://github.com/drizzle-team/drizzle-orm/issues/2854) | [Partitioning](packages/timescale-drizzle/README.md#partitioning)         |
| TimescaleDB            | [drizzle-orm#2962](https://github.com/drizzle-team/drizzle-orm/issues/2962) | [TimescaleDB](packages/timescale-drizzle/README.md#timescaledb)           |

The [package README](packages/timescale-drizzle/README.md) is the full reference: the files `generate` writes for drizzle-kit 1.0, the limits of each object, `drizzle-kit push`, and what is not supported yet.

## Compatibility

| Dependency  | Supported                                   | Tested                                                             |
| ----------- | ------------------------------------------- | ------------------------------------------------------------------ |
| drizzle-orm | 1.0.0-rc.6 or newer                         | 1.0.0-rc.6                                                         |
| drizzle-kit | 1.0.0-rc.6 or newer (folder-per-migration)  | 1.0.0-rc.6                                                         |
| PostgreSQL  | 14 or newer                                 | 17                                                                 |
| TimescaleDB | Hypertables, columnstore, retention, continuous aggregates | The TimescaleDB in the pinned `timescaledb-ha:pg17` image |
| Node.js     | 20.19 or newer                              | 22 and 24                                                          |

## Migrating from drizzle-pg-extras

> [!NOTE]
> Until 0.9.0 this package was published as `@systemfsoftware/drizzle-pg-extras`. It was renamed to match the repository, and the old package gets no further releases. Install and import `@systemfsoftware/timescale-drizzle`.
> The API names (`defineExtras`, `PgExtras`, `PgExtrasError`) and the `_pg-extras.json` snapshot file are unchanged. The CLI is `timescale-drizzle`.

## Repository

This repository is a pnpm workspace. It holds one publishable package:

- [`packages/timescale-drizzle`](packages/timescale-drizzle) is the library and CLI, published to npm as `@systemfsoftware/timescale-drizzle`.

## Contributing

Development setup, tests and releases: [CONTRIBUTING.md](CONTRIBUTING.md).

## Support

Report bugs and request features on the [GitHub issue tracker](https://github.com/systemfsoftware/timescale-drizzle/issues).

## License

Apache-2.0. See [LICENSE](packages/timescale-drizzle/LICENSE).
