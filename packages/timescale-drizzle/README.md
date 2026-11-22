# @systemfsoftware/timescale-drizzle

`@systemfsoftware/timescale-drizzle` lets you declare PostgreSQL and TimescaleDB objects that `drizzle-orm` and `drizzle-kit` do not model natively—functions, triggers, views, grants, comments, extensions, partitioned tables, TimescaleDB hypertables, and continuous aggregates—in TypeScript alongside your Drizzle schema and compile them into idempotent SQL migration files for `drizzle-kit`.

`drizzle-kit migrate` applies those generated SQL files directly. This package does not patch `drizzle-orm` or rewrite migrations that `drizzle-kit` already generated, so any SQL you commit remains valid even if `drizzle-kit` later adds native support for the same objects.

**Package rename:** In 0.9.0, this package was renamed from `@systemfsoftware/drizzle-pg-extras` to `@systemfsoftware/timescale-drizzle`. The old package receives no further releases. The API (`defineExtras`, `PgExtras`, `PgExtrasError`) and the `_pg-extras.json` snapshot file format are unchanged.

## Why Use @systemfsoftware/timescale-drizzle

`drizzle-orm` (1.0.0-rc.6, with PR #4844 still unmerged) leaves several core PostgreSQL and TimescaleDB features open as feature requests:

| Missing PostgreSQL / TimescaleDB Feature                                               | Upstream Request   |
| -------------------------------------------------------------------------------------- | ------------------ |
| `CREATE FUNCTION` / `CREATE TRIGGER`                                                   | `drizzle-orm#843`  |
| `COMMENT ON` tables, columns, enums, views, routines, indexes, constraints, extensions | `drizzle-orm#886`  |
| `CREATE EXTENSION`                                                                     | `drizzle-orm#2124` |
| Partitioned tables                                                                     | `drizzle-orm#2854` |
| TimescaleDB hypertables                                                                | `drizzle-orm#2962` |

Single-purpose packages such as `drizzle-triggers`, `@onozaty/drizzle-db-comments-generator`, and `drizzle-partition` each cover one piece. `@systemfsoftware/timescale-drizzle` combines functions, triggers, views, grants, comments, extensions, partitioning, TimescaleDB hypertables, and continuous aggregates in one schema—and unlike `drizzle-partition`, it appends a new migration instead of rewriting existing `CREATE TABLE` files written by `drizzle-kit`.

## Install

Install `@systemfsoftware/timescale-drizzle` from npm:

```bash
npm install @systemfsoftware/timescale-drizzle
```

nix.systemfsoftware.com is the package registry for this project's Nix outputs: nix build pulls them from its binary cache, and npm publishes the library.

### Requirements

- **Node.js:** 20.19 or newer (ships both ESM and CJS builds).
- **`drizzle-orm`:** `>=1.0.0-rc.6` (peer dependency; Drizzle 0.x is not supported).
- **`drizzle-kit`:** `>=1.0.0-rc.6` (optional; needed only to generate table migrations and apply migrations with `drizzle-kit migrate`).
- **PostgreSQL:** 14 or newer (`CREATE OR REPLACE TRIGGER`).
- **TimescaleDB:** required only if you declare hypertables or continuous aggregates.

## Quick Start

Export your extensions, functions, triggers, comments, views, grants, partitions, hypertables, and continuous aggregates from the same schema files configured in `drizzle.config.ts`.

```typescript
import { pgExtension, updatedAtTrigger, withComment } from '@systemfsoftware/timescale-drizzle'
import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'

export const pgcrypto = pgExtension('pgcrypto')

export const users = withComment(
  pgTable('users', {
    id: serial('id').primaryKey(),
    email: withComment(text('email').notNull(), 'Login email'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  }),
  'Application users',
)

export const touchUsers = updatedAtTrigger(users, users.updatedAt)
```

Add scripts to `package.json` and run `drizzle-kit generate`, `timescale-drizzle generate`, and `drizzle-kit migrate`:

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate && timescale-drizzle generate",
    "db:check": "timescale-drizzle check",
    "db:migrate": "drizzle-kit migrate"
  }
}
```

```bash
drizzle-kit generate && timescale-drizzle generate && drizzle-kit migrate
```

The first `timescale-drizzle generate` writes a migration folder. Subsequent runs write nothing until a declaration changes. Only the diff is emitted, and generated statements are idempotent (`CREATE OR REPLACE`, `IF NOT EXISTS`, `DROP … IF EXISTS`).

### Migration Ordering Rules

- **Tables before dependents:** Run `drizzle-kit generate` before `timescale-drizzle generate` whenever a trigger, comment, partition, or hypertable targets a table so the table migration sorts earlier in the migrations folder.
- **Extensions before dependent column types:** If a table column type depends on an extension (such as PostGIS), declare and generate the extension migration before running the first `drizzle-kit generate`. `timescale-drizzle` only appends migrations and never inserts a migration before one you have already committed.

## CLI

The CLI loads the file given by `--config` (default `drizzle.config.ts`), so its `schema` glob decides which files are read.

The `timescale-drizzle` binary reads `dialect`, `schema`, `out`, `casing`, and `breakpoints` from your Drizzle config file.

```plaintext
timescale-drizzle generate [--config drizzle.config.ts] [--name pg_extras]
timescale-drizzle check [--config drizzle.config.ts]
```

| Command / Option      | Description                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `generate`            | Scans exported extras in your schema files, diffs against `_pg-extras.json`, and writes a new migration folder if definitions changed. |
| `check`               | Exits with code 1 when definitions changed without a generated migration. Use this command in CI.                                      |
| `--config, -c <file>` | Path to the Drizzle configuration file (default: `drizzle.config.ts`).                                                                 |
| `--name <name>`       | Suffix for the generated migration folder name (default: `pg_extras`).                                                                 |

## Migration File Layout

Each folder name is a UTC timestamp, so folders sort in the order they were written.

`drizzle-kit` (`>=1.0.0-rc.6`) stores one UTC-timestamped folder per migration, and `timescale-drizzle generate` writes the same folder layout:

```plaintext
drizzle/
  20261118090000_users/        written by drizzle-kit generate
  20261118090100_pg_extras/
    migration.sql              applied by drizzle-kit migrate
    down.sql                   reverse diff (not applied by drizzle-kit)
    snapshot.json              empty diff chaining prevIds to the users snapshot
  _pg-extras.json              full extras snapshot (commit this file)
```

- **`snapshot.json`:** Matches the output of `drizzle-kit generate --custom` for a migration with no table schema change (`type: "diff"`, a new `id`, `prevIds` pointing to the previous snapshot, and empty deltas). Subsequent `drizzle-kit generate` runs continue diffing your Drizzle tables normally. Generated folders always sort after the latest folder—even within the same second—so `drizzle-kit` never sees two base snapshots. When run in an empty migrations directory, no `snapshot.json` is written; `drizzle-kit` writes its base snapshot in the next folder.
- **`_pg-extras.json`:** Tracks the full state of your declared extras across migrations. Commit this file to version control; `drizzle-kit` ignores it.
- **`migration.sql`:** Up SQL split on `--> statement-breakpoint`, matching what `drizzle-kit migrate` and `migrate()` from `drizzle-orm` expect.
- **`down.sql`:** Reverse diff (restoring a prior function body, dropping a newly added trigger, emitting `COMMENT … IS NULL` for a removed comment). `drizzle-kit migrate` does not run `down.sql`, and running it manually does not remove the tracking row in `__drizzle_migrations`. To roll back manually, execute `down.sql`, delete the migration folder, and delete its row from `__drizzle_migrations`.
- **Legacy 0.x folders:** Directories created by `drizzle-kit` 0.x (containing `meta/_journal.json` or snapshots without `type`) are refused before writing files. Convert them first with `drizzle-kit up`.

## Programmatic API

**Mechanism:** `defineExtras` gathers the declarations, so `generate` writes the migration folder from them, and `renderIdempotent` returns the same SQL as one script.

You can build and render extras directly in TypeScript without using the CLI:

```typescript
import {
  defineExtras,
  generate,
  pgExtension,
  pgFunction,
  pgTrigger,
  renderIdempotent,
} from '@systemfsoftware/timescale-drizzle'

const extras = defineExtras({
  extensions: [pgExtension('vector', { schema: 'extensions' })],
  functions: [setUpdatedAt],
  triggers: [touchUsers],
  tables: [users], // picks up withComment() on the table and its columns
})

generate({ extras, out: './drizzle', name: 'touch_updated_at' })

// Full idempotent script without drops (useful after drizzle-kit push)
console.log(renderIdempotent(extras))
```

### Exports Reference

| Export                                          | Purpose                                                                                                                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pgFunction(name, config)`                      | Declares a `plpgsql` or `sql` function in a schema (`schema: 'app'` or a Drizzle `pgSchema`). Supports `in`, `inout`, `variadic`, and `out` arguments with SQL defaults, and `returns` as a type, `{ kind: 'table', columns }`, or `{ kind: 'setof', type }`. |
| `pgTrigger(name, config)`                       | Declares a trigger on a Drizzle table, `pgView()`, or `{ name, schema }`. Supports `columns` (`UPDATE OF`), `when`, `constraint`, `referencing`, and `enabled: false`.                                                                                        |
| `updatedAtTrigger(table, column)`               | Creates a `BEFORE UPDATE` trigger setting a `date`, `time`, or `timestamp` column to `now()`. Tables sharing the same database column name share one `set_<column>` function.                                                                                 |
| `pgExtension(name, options)`                    | Emits `CREATE EXTENSION IF NOT EXISTS` with optional `schema`, `version`, and `cascade`.                                                                                                                                                                      |
| `withComment(target, text)`                     | Attaches a `COMMENT ON` declaration to a table, column builder, enum, finished view or materialized view, `pgFunction`, trigger, extension, or an `index` / `unique` / `check` / `primaryKey` / `foreignKey` builder. Returns the target unchanged.           |
| `commentOn(target, text)`                       | Attaches `COMMENT ON` to an existing table, column, enum, view, function, trigger, or extension reference. Use `withComment` for indexes and constraints inside a table callback.                                                                             |
| `partitionedTable(table, config)`               | Marks a Drizzle table as `range`, `list`, or `hash` partitioned and converts the empty table during migration.                                                                                                                                                |
| `pgPartition(name, config)`                     | Emits `CREATE TABLE ... PARTITION OF` with `from`/`to` range bounds, `in` list values, `modulus`/`remainder` hash bounds, or `default: true`.                                                                                                                 |
| `pgAttachPartition(table, config)`              | Emits `ALTER TABLE ... ATTACH PARTITION` for an existing Drizzle-managed table.                                                                                                                                                                               |
| `pgDetachPartition(table, config)`              | Emits `ALTER TABLE ... DETACH PARTITION` while keeping the detached table.                                                                                                                                                                                    |
| `hypertable(table, config)`                     | Emits `create_hypertable` with `by_range` and `if_not_exists => TRUE`, plus optional columnstore settings and retention, columnstore, and reorder policies. Requires `pgExtension('timescaledb')`.                                                            |
| `viewDefinition(view, config)`                  | Emits `CREATE OR REPLACE VIEW` for a Drizzle `pgView(...).existing()` definition.                                                                                                                                                                             |
| `pgGrant(config)`                               | Emits `GRANT` on a table, view, function, or schema, optionally guarded by `onlyIfRoleExists: true`.                                                                                                                                                          |
| `continuousAggregate(view, config)`             | Emits `CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous)` from a query, plus refresh, columnstore, and retention policies.                                                                                                                           |
| `defineExtras` / `collectExtras`                | Bundles extra definitions manually (`defineExtras`) or scans exported definitions from a module (`collectExtras`).                                                                                                                                            |
| `generate` / `diffSnapshots` / `snapshotExtras` | Computes snapshot diffs against `_pg-extras.json` and writes migration files.                                                                                                                                                                                 |
| `renderIdempotent`                              | Renders a create-or-replace SQL script for all currently declared objects without `DROP` statements.                                                                                                                                                          |
| `PgExtras` / `PgExtrasError`                    | TypeScript types and error class exported for programmatic consumers.                                                                                                                                                                                         |

## Casing, Function Overloads, and Comments

- **Identifier casing:** `casing` from `drizzle.config.ts` is applied to key-named columns (`updatedAt` with `snake_case` becomes `updated_at`), matching `drizzle-kit`. Explicit database column names are preserved as written.
- **Function signatures:** A function's identity is `schema.name(arg types)`, allowing overloaded functions to coexist. Changes to a function's body, volatility, security, or `search_path` emit `CREATE OR REPLACE`, preserving its OID and keeping dependent triggers intact. Changing argument types or return types emits `DROP FUNCTION` followed by `CREATE` and recreates dependent triggers around it, because PostgreSQL does not allow `CREATE OR REPLACE` to alter a return type.
- **Comments lifecycle:** Removed comments emit `COMMENT … IS NULL`, except when the target table, column, enum, view, index, constraint, function, trigger, or extension is dropped in the same change. Removing a column referenced in a trigger's `UPDATE OF` or `WHEN` clause requires two `generate` cycles: update the trigger first, then drop the column.

```typescript
import { pgFunction, withComment } from '@systemfsoftware/timescale-drizzle'
import { sql } from 'drizzle-orm'
import { check, index, pgEnum, pgTable, pgView, serial, text, unique } from 'drizzle-orm/pg-core'

export const role = withComment(pgEnum('user_role', ['admin', 'member']), 'Account role')

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  role: role('role').notNull(),
}, (table) => [
  withComment(index('users_email_idx').on(table.email), 'Lookup by email'),
  withComment(unique('users_email_key').on(table.email), 'One email'),
  withComment(check('users_email_check', sql`length(${table.email}) > 0`), 'Email is not empty'),
])

export const activeUsers = withComment(
  pgView('active_users', { email: withComment(text('email'), 'Visible email') }).as(sql`select email from users`),
  'Users visible to the app',
)

export const setUpdatedAt = withComment(
  pgFunction('set_updated_at', {
    returns: 'trigger',
    language: 'plpgsql',
    body: 'BEGIN NEW.updated_at = now(); RETURN NEW; END;',
  }),
  'Sets updated_at',
)
```

When commenting an enum, view, index, or constraint, run `drizzle-kit generate` before `timescale-drizzle generate` so the object exists before `COMMENT ON` runs. Subsequent `drizzle-kit generate` runs report no schema drift.

## Triggers

`pgTrigger` defines custom `BEFORE`, `AFTER`, and `INSTEAD OF` triggers, deferrable constraint triggers, statement transition tables, and disabled triggers alongside your Drizzle tables and views.

```typescript
export const setUpdatedAt = pgFunction('set_updated_at', {
  returns: 'trigger',
  language: 'plpgsql',
  body: 'BEGIN NEW.updated_at = now(); RETURN NEW; END;',
})

export const touchUsers = pgTrigger('users_set_updated_at', {
  table: users,
  timing: 'before',
  events: ['update'],
  columns: [users.email], // UPDATE OF; column must belong to `users`
  when: ({ OLD, NEW }) => sql`${OLD.email} IS DISTINCT FROM ${NEW.email}`,
  function: setUpdatedAt,
})

export const balancesAmount = pgTrigger('balances_amount', {
  table: balances,
  timing: 'after',
  events: ['insert', 'update'],
  columns: [balances.amount],
  constraint: { deferrable: true, initially: 'deferred', from: customers },
  function: rejectNegative,
})

export const ledgerInserted = pgTrigger('ledger_inserted', {
  table: ledger,
  timing: 'after',
  events: ['insert'],
  forEach: 'statement',
  referencing: { newTable: 'inserted' },
  function: countInserted,
})

export const profileEmailsInsert = pgTrigger('profile_emails_insert', {
  table: profileEmails, // pgView(...)
  timing: 'instead of',
  events: ['insert'],
  function: insertProfile,
})

export const profilesGuard = pgTrigger('profiles_guard', {
  table: profiles,
  timing: 'before',
  events: ['delete'],
  function: raiseAlways,
  enabled: false, // ALTER TABLE ... DISABLE TRIGGER
})
```

- **Constraint triggers (`constraint`):** Addresses deferrable trigger cases (`drizzle-orm#1429`). `constraint: true` emits `CREATE CONSTRAINT TRIGGER ... NOT DEFERRABLE`. `deferrable: true` defaults to `INITIALLY IMMEDIATE`, `initially: 'deferred'` requires `deferrable: true`, and `from` emits `FROM <referenced_table>`. Because PostgreSQL has no `CREATE OR REPLACE` for constraint triggers, they are emitted as `DROP TRIGGER IF EXISTS` followed by `CREATE` (and any trigger comment is re-emitted).
- **Transition tables (`referencing`):** Emits `REFERENCING OLD TABLE AS ... NEW TABLE AS ...` with quoted identifiers so the trigger function can query `oldTable` (`UPDATE`/`DELETE`) or `newTable` (`INSERT`/`UPDATE`) as a relation. Supports a single event with either `FOR EACH ROW` or `FOR EACH STATEMENT`.
- **Enable/disable (`enabled`):** `enabled: false` appends `ALTER TABLE ... DISABLE TRIGGER`. Switching back to `enabled: true` emits `ENABLE TRIGGER`. Because `CREATE OR REPLACE` re-enables a trigger, modifying a disabled trigger re-emits `DISABLE TRIGGER`.
- **`when` validation:** Accepts a string, a `sql` fragment, or `` ({ OLD, NEW }) => sql`…` `` (where `OLD` and `NEW` are typed to the table's columns and render as `OLD."col"` / `NEW."col"`). `pgTrigger` strips a trailing `;` and rejects expressions containing another `;`, `INSTEAD OF` timing, `SELECT` or `EXISTS`, `OLD` or `NEW` on statement triggers, `OLD` when events include `INSERT`, or `NEW` when events include `DELETE`. The lexical scan skips comments, quoted strings, quoted identifiers, and dollar-quoted blocks, and runs again when rendering snapshots.

### Trigger Limits

- Constraint triggers must be `AFTER` and `FOR EACH ROW` on a table; `WHEN` is evaluated at row modification time even when deferred.
- `UNIQUE` and `FOREIGN KEY` table constraints remain owned by `drizzle-kit`; `from` does not create a foreign key.
- Transition tables require an `AFTER` trigger on a table with a single event (`INSERT`, `UPDATE`, or `DELETE`) and cannot be combined with `UPDATE OF`, `TRUNCATE`, `constraint`, or views.
- `INSTEAD OF` triggers require a view, `FOR EACH ROW`, and cannot use `WHEN`, `UPDATE OF`, or `TRUNCATE`.
- `BEFORE` and `AFTER` triggers on views require `forEach: 'statement'`. Materialized views cannot have triggers.
- `ALTER TABLE ... DISABLE TRIGGER` is unsupported on views, so `enabled: false` is rejected for views and `INSTEAD OF` triggers. `ENABLE REPLICA` and `ENABLE ALWAYS` are not emitted.
- Passing `{ name, schema }` skips Drizzle table/view metadata checks; PostgreSQL validates the target at migration time.
- Row-level transition triggers on partitioned tables are rejected by PostgreSQL during migration; foreign tables are not detected through `{ name, schema }`.
- View columns are matched by view name and column name; Drizzle view column aliases do not carry schema names, so two views sharing a name in different schemas are not distinguished.

## Views and Grants

`viewDefinition` manages SQL views that `drizzle-kit` cannot express—such as lateral joins, set-returning functions, or window clauses—by pairing a Drizzle `pgView(...).existing()` stub with a raw SQL query, while `pgGrant` manages role privileges.

```typescript
import { pgFunction, pgGrant, viewDefinition } from '@systemfsoftware/timescale-drizzle'
import { sql } from 'drizzle-orm'
import { integer, pgSchema, text, timestamp } from 'drizzle-orm/pg-core'

export const app = pgSchema('app')

export const orders = app.table('orders', {
  id: integer('id').primaryKey(),
  customer: text('customer').notNull(),
  placedAt: timestamp('placed_at', { withTimezone: true }).notNull(),
})

export const ordersSince = pgFunction('orders_since', {
  schema: app,
  args: [{ name: 'p_since', type: 'timestamptz', default: "now() - interval '1 day'" }],
  returns: { kind: 'table', columns: [{ name: 'customer', type: 'text' }, { name: 'orders', type: 'bigint' }] },
  language: 'sql',
  volatility: 'stable',
  body: sql`SELECT customer, count(*) FROM ${orders} WHERE placed_at >= p_since GROUP BY customer`,
})

export const recentOrders = viewDefinition(app.view('recent_orders', {}).existing(), {
  query: sql`SELECT * FROM ${ordersSince}()`,
})

export const reporting = [
  pgGrant({ to: 'reporting', on: recentOrders.view, privileges: ['select'], onlyIfRoleExists: true }),
  pgGrant({ to: 'reporting', on: ordersSince, privileges: ['execute'], onlyIfRoleExists: true }),
]
```

- **Dependency ordering:** Views are created in topological order after the functions and upstream views they reference. Changing a view's query drops and recreates that view along with any declared views that read from it, re-applying their comments and grants. Removing a view while another declared view still reads from it is refused unless you update or remove the dependent view in the same change.
- **View options:** `securityInvoker`, `securityBarrier`, and `checkOption` map to the corresponding PostgreSQL `WITH (...)` view options.
- **Grants and revokes:** `onlyIfRoleExists: true` wraps `GRANT` in a `DO` block checking `pg_roles` so migrations succeed in environments where optional roles do not exist. Grants to `PUBLIC` are rejected. Removing privileges from `pgGrant` emits `REVOKE`.
- **Function argument rules:** `RETURNS TABLE` cannot be combined with `out` or `inout` arguments, and only `out` arguments may follow a `variadic` argument. Function identity is determined by `in`, `inout`, and `variadic` argument types.

## Partitioning

`partitionedTable()` keeps your parent table in your Drizzle schema—so `drizzle-kit` continues owning columns, indexes, and foreign keys—and appends a migration that converts the empty table into a partitioned parent (`RANGE`, `LIST`, or `HASH`).

PostgreSQL only accepts `PARTITION BY` inside `CREATE TABLE`, not `ALTER TABLE`. Rather than rewriting `drizzle-kit`'s generated `CREATE TABLE` file, `timescale-drizzle` rebuilds the table when empty and raises an error if the table already contains rows. Run `drizzle-kit generate`, then `timescale-drizzle generate`, then `drizzle-kit migrate` before loading data.

```typescript
import { partitionedTable, pgAttachPartition, pgPartition } from '@systemfsoftware/timescale-drizzle'
import { integer, pgTable, primaryKey, serial, text, timestamp } from 'drizzle-orm/pg-core'

export const events = pgTable('events', {
  id: serial('id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  region: text('region').notNull(),
  payload: text('payload').notNull(),
}, (t) => [
  primaryKey({ columns: [t.id, t.createdAt] }),
])

export const eventsByTime = partitionedTable(events, {
  method: 'range', // 'list' or 'hash'
  columns: [events.createdAt],
})

export const events2024 = pgPartition('events_2024', {
  parent: events,
  from: ['2024-01-01'],
  to: ['2025-01-01'],
})

export const eventsDefault = pgPartition('events_default', {
  parent: events,
  default: true,
})

export const eventsArchive = pgTable('events_archive', {
  id: integer('id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  region: text('region').notNull(),
  payload: text('payload').notNull(),
}, (t) => [
  primaryKey({ columns: [t.id, t.createdAt] }),
])

export const attachArchive = pgAttachPartition(eventsArchive, {
  parent: events,
  from: ['2020-01-01'],
  to: ['2024-01-01'],
})

// Later, instead of attachArchive:
// export const detachArchive = pgDetachPartition(eventsArchive, { parent: events })
```

- **Partition bounds:** `pgPartition` emits `CREATE TABLE ... PARTITION OF`. Range bounds use `from` and `to` (including unquoted `MINVALUE` and `MAXVALUE` keywords); list bounds use `in` (tuples when partitioning on multiple columns); hash bounds use `modulus` and `remainder`. Export both the parent `partitionedTable()` and all child partitions.
- **Constraint validation:** Every primary key and unique constraint on a Drizzle table must include all partition key columns. `partitionedTable()` validates this unless the parent is passed as `{ name, schema }`.
- **Removal behavior:** Removing a `pgPartition` drops the child partition if empty, or detaches it with data preserved when `onRemove: 'detach'` is set. Removing `pgAttachPartition` always detaches the table because `drizzle-kit` still owns it; `pgDetachPartition` makes detachment explicit. Updating only `onRemove` updates `_pg-extras.json` on the next migration without creating a new SQL file.
- **Rebuild mechanics and idempotency:** The conversion runs `CREATE TABLE ... (LIKE ... INCLUDING ALL)`, restores outgoing and incoming foreign keys, triggers, row-level security policies, grants, table comments, and ownership, reassigns serial sequences via `ALTER SEQUENCE ... OWNED BY`, and renames indexes and constraints back to the names `drizzle-kit` expects. Re-running the migration or `renderIdempotent` is a no-op once partitioned.

### Partition Limits

- Only empty parent tables can be converted; move existing rows manually before converting.
- Changing the partition key or a child partition's bounds throws during `generate` so existing partition data is never dropped silently. Detach, copy rows, and re-attach in a custom migration.
- Hash-partitioned tables cannot have a `DEFAULT` partition.
- Attached tables must already match the parent's column order, `NOT NULL` constraints, unique indexes, and check constraints.
- Dependent views and materialized views are not rewritten automatically; drop them before converting the parent table.
- Expression partition keys (such as `date_trunc('month', created_at)`), sub-partitioning, and tablespaces are not supported.
- `DETACH PARTITION CONCURRENTLY` is not emitted because `drizzle-kit migrate` runs migrations inside a transaction.
- `drizzle-kit push` does not read partition definitions and may offer to drop unmanaged partition child tables; exclude them with `tablesFilter` if you use `push`.
- If a later `drizzle-kit` migration drops and recreates the parent table (for example on certain column type changes), child partitions are dropped with it and must be repaired manually because `_pg-extras.json` already records the table as partitioned.
- `down.sql` drops empty created partitions, detaches attached tables, and converts an empty parent back to a standard table, raising an error if created partitions still hold rows.

## TimescaleDB

The hypertable is created by `create_hypertable` in the generated migration file, so each policy is added by its own `add_*_policy` call in that same file.

`hypertable()` converts a standard Drizzle-managed table into a TimescaleDB hypertable using `SELECT create_hypertable(..., by_range(...), if_not_exists => TRUE)` and configures columnstore settings and background policies.

`pgExtension('timescaledb')` must be exported from your schema; `generate` throws if it is missing and emits `CREATE EXTENSION` before `create_hypertable` when both are created together. Run `drizzle-kit generate`, then `timescale-drizzle generate`, then `drizzle-kit migrate` before loading data.

```typescript
import { hypertable, pgExtension } from '@systemfsoftware/timescale-drizzle'
import { integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

export const timescale = pgExtension('timescaledb')

export const metrics = pgTable('metrics', {
  time: timestamp('time', { withTimezone: true }).notNull(),
  deviceId: text('device_id').notNull(),
  value: integer('value').notNull(),
}, (t) => [
  primaryKey({ columns: [t.time, t.deviceId] }),
])

export const metricsHypertable = hypertable(metrics, {
  timeColumn: metrics.time,
  chunkTimeInterval: '1 day', // omitted: TimescaleDB defaults to 7 days
  partitioningColumn: metrics.deviceId, // hash space dimension; requires numberPartitions
  numberPartitions: 4,
  migrateData: false, // true copies existing rows during create_hypertable
  createDefaultIndexes: true, // false skips the default time index
  columnstore: {
    segmentBy: [metrics.deviceId],
    orderBy: [{ column: metrics.time, direction: 'desc', nulls: 'last' }],
    sparseIndex: [{ type: 'bloom', columns: [metrics.value] }],
  },
  retention: { dropAfter: '6 months', scheduleInterval: '1 day' },
  columnstorePolicy: { after: '7 days' },
  reorder: 'metrics_time_idx',
})
```

- **Intervals and timestamps:** `chunkTimeInterval`, `dropAfter`, `dropCreatedBefore`, `after`, `createdBefore`, and `scheduleInterval` accept PostgreSQL interval strings (such as `'7 days'` or `'1 day 12 hours'`) rendered as `INTERVAL '...'`. `initialStart` renders as `TIMESTAMPTZ '...'`. Set either `dropAfter` or `dropCreatedBefore` (not both), and either `after` or `createdBefore` (not both).
- **Columnstore configuration:** `columnstore: {}` enables the columnstore with TimescaleDB defaults. `columnstorePolicy` requires `columnstore` to be enabled.
- **Schema validation:** Every primary key and unique index on a Drizzle table must include `timeColumn` (and `partitioningColumn` when configured). `timeColumn` must be `NOT NULL` with type `date`, `timestamp`, or `timestamptz`. Passing `{ name, schema }` skips Drizzle column/index checks.
- **Idempotency and updates:** `create_hypertable`, `add_retention_policy`, `add_columnstore_policy`, and `add_reorder_policy` use `if_not_exists => TRUE`. Updating policy intervals or `reorder` removes and re-adds the policy; updating `chunkTimeInterval` emits `set_chunk_time_interval`; adding `partitioningColumn` later emits `add_dimension`. `migrateData` and `createDefaultIndexes` apply only on initial hypertable creation.

### TimescaleDB Limits

- Integer `timeColumn` types are not supported; use `date`, `timestamp`, or `timestamptz`.
- Changing `timeColumn` or removing/altering an existing `partitioningColumn` or `numberPartitions` throws during `generate`.
- Clearing `chunkTimeInterval` is not supported; provide a replacement interval instead.
- Removing `hypertable()` while keeping the underlying Drizzle table throws an error. Drop the table in the Drizzle schema in the same change or drop it in a custom migration.
- `down.sql` removes policies, converts compressed chunks back with `convert_to_rowstore`, and disables `timescaledb.enable_columnstore`, while leaving the hypertable and `timescaledb` extension in place.
- `create_hypertable` fails if the target table already contains rows unless `migrateData: true` is set (which locks the table while migrating rows into chunks).
- Columnstore settings emit `timescaledb.enable_columnstore`, `timescaledb.segmentby`, `timescaledb.orderby`, `timescaledb.sparse_index`, and `add_columnstore_policy`. Removing all `sparseIndex` entries emits `ALTER TABLE ... RESET (timescaledb.sparse_index)` rather than setting an empty string, preventing TimescaleDB crashes on `INSERT`, `UPDATE`, and `DELETE`.
- Unless `createDefaultIndexes: false`, `create_hypertable` creates a default `<table>_<time_column>_idx` index that is not declared in the Drizzle schema.
- Chunks and metadata reside in `_timescaledb_internal`, `_timescaledb_catalog`, and `_timescaledb_config`; `drizzle-kit push` and `drizzle-kit pull` may treat those internal tables as unmanaged unless excluded.
- If a later `drizzle-kit` migration drops and recreates the parent table, the hypertable is dropped with it and must be repaired manually because `_pg-extras.json` already records the table as partitioned.
- Passing `{ name, schema }` skips `NOT NULL`, column type, and unique-index checks.

## Continuous Aggregates

`continuousAggregate()` emits `CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous) AS <query> WITH NO DATA` so migrations do not block while materializing historical data. Declare the view stub with `pgMaterializedView(...).existing()` (or `pgView(...).existing()` if you attach `withComment`) so `drizzle-kit` does not overwrite the `timescaledb.continuous` storage option.

```typescript
import { continuousAggregate } from '@systemfsoftware/timescale-drizzle'
import { doublePrecision, pgMaterializedView, text, timestamp } from 'drizzle-orm/pg-core'

export const metricsHourly = pgMaterializedView('metrics_hourly', {
  bucket: timestamp('bucket', { withTimezone: true }),
  deviceId: text('device_id'),
  avgValue: doublePrecision('avg_value'),
}).existing()

export const metricsHourlyAggregate = continuousAggregate(metricsHourly, {
  source: metricsHypertable,
  query: `SELECT time_bucket('1 hour', time) AS bucket, device_id, avg(value) AS avg_value
FROM metrics GROUP BY bucket, device_id`,
  realTime: false,
  refreshPolicies: [{ startOffset: '3 days', endOffset: '1 hour', scheduleInterval: '1 hour' }],
  columnstore: { segmentBy: ['device_id'] },
  columnstorePolicy: { after: '30 days' },
  retention: { dropAfter: '2 years' },
})
```

- **Hierarchical aggregates:** Set `source` to either a `hypertable()` or a parent `continuousAggregate()` so `generate` creates parents before children and drops children before parents.
- **Options and policies:** `realTime: false` sets `timescaledb.materialized_only = true`. `chunkInterval` configures the aggregate chunk interval (updatable, cannot be cleared). `createGroupIndexes` maps to `timescaledb.create_group_indexes`. `refreshPolicies` accepts one or more windows with `startOffset`, `endOffset`, and `scheduleInterval`, plus optional `initialStart`, `timezone`, `includeTieredData`, `bucketsPerBatch`, `maxBatchesPerExecution`, and `refreshNewestFirst`. `columnstore`, `columnstorePolicy`, and `retention` work identically to hypertables.
- **Recreating and removing:** Changing `query`, `source`, or `createGroupIndexes` drops and recreates the aggregate empty, and throws if a child continuous aggregate depends on it (remove the child first, migrate the parent change, then re-add the child). Removing an aggregate and its source table in the same change throws; remove the aggregate first.
- **Commenting aggregates:** Declare the aggregate with `pgView(...).existing()` when wrapping with `withComment()`, because TimescaleDB expects `COMMENT ON VIEW` for continuous aggregates rather than `COMMENT ON MATERIALIZED VIEW`.

## Using with drizzle-kit push

**Mechanism:** declarations reach the database only through the migration files `timescale-drizzle generate` writes, so `drizzle-kit push` needs the output of `renderIdempotent` instead.

`drizzle-kit push` does not read `@systemfsoftware/timescale-drizzle` declarations or execute SQL files in your migrations folder.

If `drizzle-kit push` drops and recreates a table, PostgreSQL drops that table's triggers and comments while standalone functions remain.

Extensions that create tables (such as PostGIS), partition child tables, and TimescaleDB chunk/catalog tables (`_timescaledb_internal`, `_timescaledb_catalog`, `_timescaledb_config`) appear to `drizzle-kit push` as unmanaged tables. Configure `extensionsFilters` (for example `extensionsFilters: ['postgis']`) and `tablesFilter` in `drizzle.config.ts` if you use `push`.

The recommended workflow is `drizzle-kit generate` followed by `timescale-drizzle generate` and `drizzle-kit migrate`. If you use `push`, run `renderIdempotent(extras)` (or re-apply the relevant up migration) after recreating tables.

## Known Limitations

`generate` and `check` diff your TypeScript declarations against `_pg-extras.json` rather than inspecting `pg_catalog` in a live database. If `drizzle-kit` drops and recreates a table, PostgreSQL drops attached triggers, comments, partitions, or hypertable state while `_pg-extras.json` still records them, so the next `generate` writes no diff.

`renderIdempotent(extras)` outputs an idempotent SQL script for all currently declared objects—`CREATE OR REPLACE` for functions and standard triggers, `DROP TRIGGER IF EXISTS` + `CREATE` for constraint triggers, `DISABLE TRIGGER` when `enabled: false`, `COMMENT ON`, `CREATE EXTENSION IF NOT EXISTS`, partition conversion/create/attach/detach statements, `create_hypertable(..., if_not_exists => TRUE)`, and continuous aggregates with their policies—without dropping objects removed from your schema. Run its output to restore extras after a table recreation.

### What It Does Not Do Yet

- Authoring row-level security policies (`drizzle-kit` generates RLS policies natively; partition conversion preserves existing parent policies).
- Managing standard materialized views other than TimescaleDB continuous aggregates (`drizzle-kit` creates standard materialized views, and `withComment` can comment them).
- Adding `DEFERRABLE` to `UNIQUE` or `FOREIGN KEY` constraints (use deferrable constraint triggers in `pgTrigger` instead).
- Comments on policies, sequences, rules, or individual enum labels.
- Comments on inline column `.unique()`, `.primaryKey()`, or `.references()` chains (declare `unique()`, `primaryKey()`, or `foreignKey()` in the table callback and wrap that builder with `withComment`).
- Comments on expression-keyed indexes without an explicit index name.
- Separate comments on the helper function generated by `updatedAtTrigger` (comment the trigger or define the function explicitly with `pgFunction`).
- Wrapping a view before `.as()` / `.existing()` or an index/unique constraint before `.on()` with `withComment`.
- Introspecting a live database into `_pg-extras.json`.
- MySQL, SQLite, or SingleStore dialects.
- Creating the target schema referenced by `WITH SCHEMA` in `pgExtension` (create the schema with `pgSchema` / `drizzle-kit` first).
- Clearing a pinned extension version or removing an extension's schema clause (`ALTER EXTENSION … UPDATE` also requires the extension to provide a downgrade script).
- Modifying already-applied migrations in place (always generate a new migration).

## Compatibility

| Component                            | Supported Versions & Notes                                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@systemfsoftware/timescale-drizzle` | `0.9.0` (renamed from `@systemfsoftware/drizzle-pg-extras`; ESM and CJS builds).                                                                                                                       |
| `drizzle-orm`                        | `>=1.0.0-rc.6` (peer dependency; tested with `1.0.0-rc.6`; Drizzle 0.x is not supported).                                                                                                              |
| `drizzle-kit`                        | `>=1.0.0-rc.6` (optional, required only to apply migrations; tested with `1.0.0-rc.6`; folder-per-migration layout; convert 0.x journal folders with `drizzle-kit up` first).                          |
| PostgreSQL                           | 14 or newer (`CREATE OR REPLACE TRIGGER`; tested on PostgreSQL 17).                                                                                                                                    |
| TimescaleDB                          | Hypertables, columnstore settings and sparse indexes, retention/columnstore/reorder policies, and continuous aggregates with refresh policies (tested with the `timescale/timescaledb-ha:pg17` image). |
| Node.js                              | 20.19 or newer (tested on Node 22 and 24).                                                                                                                                                             |

## Common Errors

Each message is thrown by the check that rejects the input, so the text below is what your terminal shows when that check fails.

### `config not found: <path>`

The Drizzle config file does not exist at the specified path. Pass `--config <file>` (or `-c <file>`) pointing to your `drizzle.config.ts`.

### `schema path not found: <pattern>`

No files matched the `schema` path or glob configured in `drizzle.config.ts`. Verify the `schema` setting and confirm the files exist.

### `<path> has no schema path. Set schema in the drizzle config.`

Your `drizzle.config.ts` does not define a `schema` property. Add `schema` pointing to the TypeScript files that export your Drizzle schema and extras.

### `pgGrant(): granting to PUBLIC is not supported. Grant to a named role`

`pgGrant()` rejects `to: 'PUBLIC'`. Pass a named database role string or a Drizzle `pgRole` reference instead.

### `... Use date, timestamp, or timestamptz. Integer time columns are not supported.`

`hypertable()` was configured with an integer `timeColumn`. Use a `NOT NULL` `date`, `timestamp`, or `timestamptz` column instead.

### `hypertable ...: clearing chunkTimeInterval is not supported. Set a new interval instead of removing it.`

`chunkTimeInterval` was removed from an existing `hypertable()` definition. Specify a new interval string instead of deleting the property.

### `pg extras snapshot version <n> is not supported`

`_pg-extras.json` has a snapshot version that this release cannot read. Upgrade `@systemfsoftware/timescale-drizzle` or regenerate `_pg-extras.json` with a matching version.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
