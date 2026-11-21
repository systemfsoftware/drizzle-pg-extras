# drizzle-pg-extras

Declare the Postgres objects Drizzle can't model yet, next to your Drizzle tables, and get ordinary SQL migration files for them: functions, triggers, comments, extensions, partitioned tables, and TimescaleDB hypertables and continuous aggregates.

`drizzle-kit migrate` applies those files like any other migration. Nothing in Drizzle is patched, so if Drizzle later learns to generate one of these objects itself, the SQL you already committed stays valid.

## Example

A TimescaleDB hypertable with a columnstore and retention, declared in the same schema file as the table:

```ts
import { hypertable, pgExtension } from '@systemfsoftware/drizzle-pg-extras'
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

```sh
drizzle-kit generate && drizzle-pg-extras generate && drizzle-kit migrate
```

The first `generate` writes a migration with `CREATE EXTENSION`, `create_hypertable` and the policy calls. The next one writes nothing until a declaration changes, and then only the difference, with a matching down file.

## Install

```sh
npm install @systemfsoftware/drizzle-pg-extras
```

It needs `drizzle-orm` 0.36.4 or newer, including 1.0, and Node.js 18 or newer. `drizzle-kit` 0.31 or 1.0 applies the migrations. Add the CLI to your scripts and run `check` in CI, where it exits 1 when a declaration changed and no migration was written:

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate && drizzle-pg-extras generate",
    "db:check": "drizzle-pg-extras check",
    "db:migrate": "drizzle-kit migrate"
  }
}
```

## What it covers

| Object                 | Drizzle request                                                             | Docs                                                                      |
| ---------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Functions and triggers | [drizzle-orm#843](https://github.com/drizzle-team/drizzle-orm/issues/843)   | [Triggers](packages/drizzle-pg-extras/README.md#triggers)                 |
| `COMMENT ON`           | [drizzle-orm#886](https://github.com/drizzle-team/drizzle-orm/issues/886)   | [Programmatic API](packages/drizzle-pg-extras/README.md#programmatic-api) |
| Extensions             | [drizzle-orm#2124](https://github.com/drizzle-team/drizzle-orm/issues/2124) | [Install](packages/drizzle-pg-extras/README.md#install)                   |
| Partitioned tables     | [drizzle-orm#2854](https://github.com/drizzle-team/drizzle-orm/issues/2854) | [Partitioning](packages/drizzle-pg-extras/README.md#partitioning)         |
| TimescaleDB            | [drizzle-orm#2962](https://github.com/drizzle-team/drizzle-orm/issues/2962) | [TimescaleDB](packages/drizzle-pg-extras/README.md#timescaledb)           |

The [package README](packages/drizzle-pg-extras/README.md) is the full reference: the files `generate` writes for drizzle-kit 0.31 and 1.0, the limits of each object, `drizzle-kit push`, and what is not supported yet.

## Compatibility

Tested with drizzle-orm 0.45 and 1.0.0-rc.5, drizzle-kit 0.31 and 1.0.0-rc.5, PostgreSQL 16 (14 or newer is required), and TimescaleDB 2.32 on PostgreSQL 16. CI runs the integration tests against real Postgres and TimescaleDB servers.

## Contributing

Development setup, tests and releases: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](packages/drizzle-pg-extras/LICENSE)
