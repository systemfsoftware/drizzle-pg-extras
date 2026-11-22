# @systemfsoftware/timescale-drizzle

[![npm version](https://img.shields.io/npm/v/@systemfsoftware/timescale-drizzle)](https://www.npmjs.com/package/@systemfsoftware/timescale-drizzle)
[![CI](https://github.com/systemfsoftware/timescale-drizzle/actions/workflows/ci.yml/badge.svg)](https://github.com/systemfsoftware/timescale-drizzle/actions/workflows/ci.yml)

timescale-drizzle adds the Postgres objects Drizzle ORM cannot model yet to your Drizzle schema: functions, triggers, comments, extensions, partitioned tables, TimescaleDB hypertables, continuous aggregates, and views and grants. You declare them in TypeScript next to your tables. `timescale-drizzle generate` writes plain SQL migration files for them, and `drizzle-kit migrate` applies those files like any other migration.

It does not modify `drizzle-orm` or `drizzle-kit`, so the SQL you commit stays valid if Drizzle later generates the same object itself.

## Example: a TimescaleDB hypertable

A hypertable with a columnstore and retention, declared in the same schema file as its table:

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

## Usage

### Generate migrations

Add the CLI to your scripts. Run `drizzle-kit generate` before `timescale-drizzle generate` when a trigger or comment targets a table, so the table migration sorts first:

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate && timescale-drizzle generate",
    "db:check": "timescale-drizzle check",
    "db:migrate": "drizzle-kit migrate"
  }
}
```

The first `generate` writes a migration with `CREATE EXTENSION`, `create_hypertable` and the policy calls. The next `generate` writes nothing until a declaration changes, and then writes only the difference, with a matching `down.sql`.

Run `timescale-drizzle check` in CI. It exits 1 when a declaration changed and no migration was written.

### Triggers and functions

Declare the function, then the trigger that calls it. Both sit next to the Drizzle table they name:

```ts
import { pgFunction, pgTrigger } from '@systemfsoftware/timescale-drizzle'

export const rejectNegative = pgFunction('reject_negative', {
  returns: 'trigger',
  language: 'plpgsql',
  body: `BEGIN
  IF NEW.amount < 0 THEN
    RAISE EXCEPTION 'negative balance';
  END IF;
  RETURN NEW;
END;`,
})

// `balances` is a Drizzle pgTable declared in your schema.
export const balancesAmount = pgTrigger('balances_amount', {
  table: balances,
  timing: 'after',
  events: ['insert', 'update'],
  function: rejectNegative,
})
```

### Programmatic API

Use `generate` directly when you build migrations from code instead of the CLI:

```ts
import { defineExtras, generate, renderIdempotent } from '@systemfsoftware/timescale-drizzle'

const extras = defineExtras({
  functions: [rejectNegative],
  triggers: [balancesAmount],
  tables: [balances], // picks up withComment() on the table and its columns
})

generate({ extras, out: './drizzle', name: 'balances_rules' })

// Full idempotent script, for drizzle-kit push.
console.log(renderIdempotent(extras))
```

The [package README](packages/timescale-drizzle/README.md#programmatic-api) lists every export, the limits of each object, and the files `generate` writes.

## What it covers

| Object                 | Drizzle request                                                             | Docs                                                                      |
| ---------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Functions and triggers | [drizzle-orm#843](https://github.com/drizzle-team/drizzle-orm/issues/843)   | [Triggers](packages/timescale-drizzle/README.md#triggers)                 |
| `COMMENT ON`           | [drizzle-orm#886](https://github.com/drizzle-team/drizzle-orm/issues/886)   | [Programmatic API](packages/timescale-drizzle/README.md#programmatic-api) |
| Extensions             | [drizzle-orm#2124](https://github.com/drizzle-team/drizzle-orm/issues/2124) | [Install](packages/timescale-drizzle/README.md#install)                   |
| Partitioned tables     | [drizzle-orm#2854](https://github.com/drizzle-team/drizzle-orm/issues/2854) | [Partitioning](packages/timescale-drizzle/README.md#partitioning)         |
| TimescaleDB            | [drizzle-orm#2962](https://github.com/drizzle-team/drizzle-orm/issues/2962) | [TimescaleDB](packages/timescale-drizzle/README.md#timescaledb)           |

All five Drizzle requests are open at the time of writing. The [package README](packages/timescale-drizzle/README.md) is the full reference for each object.

## Install

```sh
npm install @systemfsoftware/timescale-drizzle
```

You need:

- Node.js 20.19 or newer. CI runs on Node.js 22 and 24.
- `drizzle-orm` 1.0.0-rc.6 or newer, as a peer dependency. Drizzle 0.x is not supported.
- `drizzle-kit` 1.0.0-rc.6 or newer, optional, needed only to apply migrations.
- PostgreSQL 14 or newer. CI tests PostgreSQL 17.
- TimescaleDB, only if you declare hypertables, columnstores, retention or continuous aggregates.

> [!NOTE]
> `nix.systemfsoftware.com` is the package registry for this project's Nix outputs: `nix build` pulls them from its binary cache. npm publishes the library.

## Common errors

The library throws these messages from the check that rejects the input, so the text below is what your terminal shows when that check fails.

### `config not found: <path>`

The CLI could not find the drizzle config it was pointed at. Run it from the project root, or pass the correct `--config` path.

### `schema path not found: <pattern>`

The `schema` glob in your drizzle config matches no files. Check the path, and confirm the file that declares your tables and extras is exported from it.

### `<path> has no schema path. Set schema in the drizzle config.`

The drizzle config has no `schema` entry. timescale-drizzle reads the schema files from there, so add one.

### `pgGrant(): granting to PUBLIC is not supported. Grant to a named role`

`pgGrant` refuses `PUBLIC`. Pass a role created with Drizzle's `pgRole()`.

### `... Integer time columns are not supported.`

A hypertable's `timeColumn` must be a `date`, `timestamp` or `timestamptz` column. Change the column type.

### `hypertable ...: clearing chunkTimeInterval is not supported.`

Removing a hypertable's `chunkTimeInterval` is refused. Set a new interval instead.

## Compatibility

| Dependency  | Supported                                                  | Tested                                                    |
| ----------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| drizzle-orm | 1.0.0-rc.6 or newer                                        | 1.0.0-rc.6                                                |
| drizzle-kit | 1.0.0-rc.6 or newer, folder-per-migration layout           | 1.0.0-rc.6                                                |
| PostgreSQL  | 14 or newer                                                | 17                                                        |
| TimescaleDB | Hypertables, columnstore, retention, continuous aggregates | The TimescaleDB in the pinned `timescaledb-ha:pg17` image |
| Node.js     | 20.19 or newer                                             | 22 and 24                                                 |

## Migrating from drizzle-pg-extras

> [!NOTE]
> Until 0.9.0 this package was published as `@systemfsoftware/drizzle-pg-extras`. It was renamed to match the repository, and the old package gets no further releases. Install and import `@systemfsoftware/timescale-drizzle`.
> The API names (`defineExtras`, `PgExtras`, `PgExtrasError`) and the `_pg-extras.json` snapshot file are unchanged. The CLI is `timescale-drizzle`.

## Repository

This is a pnpm workspace with one publishable package:

- [`packages/timescale-drizzle`](packages/timescale-drizzle) is the library and CLI, published to npm as `@systemfsoftware/timescale-drizzle`.

## Contributing

Development setup, tests and releases: [CONTRIBUTING.md](CONTRIBUTING.md).

## Support

Report bugs and request features on the [GitHub issue tracker](https://github.com/systemfsoftware/timescale-drizzle/issues).

## License

Apache-2.0. See [LICENSE](packages/timescale-drizzle/LICENSE).
