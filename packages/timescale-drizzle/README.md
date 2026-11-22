# timescale-drizzle

Declare the Postgres objects Drizzle still can't model — functions, triggers, views, grants, comments, extensions, partitioned tables, and TimescaleDB hypertables — in TypeScript next to your Drizzle tables, and turn them into ordinary SQL migration files.

`drizzle-kit migrate` applies those files. This package does not patch Drizzle. If Drizzle later generates the same objects itself, the SQL you already committed stays valid.

## Why

These are open Drizzle requests, and the v1.0.0-rc.6 notes don't add them. [PR #4844](https://github.com/drizzle-team/drizzle-orm/pull/4844) is still unmerged.

| Gap                                                                                    | Request                                                                     |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `CREATE FUNCTION` / `CREATE TRIGGER`                                                   | [drizzle-orm#843](https://github.com/drizzle-team/drizzle-orm/issues/843)   |
| `COMMENT ON` tables, columns, enums, views, routines, indexes, constraints, extensions | [drizzle-orm#886](https://github.com/drizzle-team/drizzle-orm/issues/886)   |
| `CREATE EXTENSION`                                                                     | [drizzle-orm#2124](https://github.com/drizzle-team/drizzle-orm/issues/2124) |
| Partitioned tables                                                                     | [drizzle-orm#2854](https://github.com/drizzle-team/drizzle-orm/issues/2854) |
| TimescaleDB hypertables                                                                | [drizzle-orm#2962](https://github.com/drizzle-team/drizzle-orm/issues/2962) |

Smaller packages already cover one of those pieces each: [`drizzle-triggers`](https://github.com/RagedPanda/drizzle-triggers), [`@onozaty/drizzle-db-comments-generator`](https://github.com/onozaty/drizzle-db-comments-generator), and [`drizzle-partition`](https://github.com/Rezarys/drizzle-partition). This package is the Postgres slice people keep asking to put in one schema: functions, triggers, comments, extensions, partitions, and TimescaleDB hypertables. `drizzle-partition` rewrites the `CREATE TABLE` drizzle-kit already wrote. This package leaves that file alone and appends a migration. See [Partitioning](#partitioning) and [TimescaleDB](#timescaledb).

## Example

```ts
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

```sh
drizzle-kit generate && timescale-drizzle generate && drizzle-kit migrate
```

`updatedAtTrigger` is the case from issue #843: a `BEFORE UPDATE` trigger that sets the column to `now()` for every update, including ones that never go through Drizzle. A hand-written function looks like this:

```ts
export const setUpdatedAt = pgFunction('set_updated_at', {
  returns: 'trigger',
  language: 'plpgsql',
  body: 'BEGIN NEW.updated_at = now(); RETURN NEW; END;',
})

export const touchUsers = pgTrigger('users_set_updated_at', {
  table: users,
  timing: 'before',
  events: ['update'],
  columns: [users.email], // UPDATE OF, and the column must belong to `users`
  when: ({ OLD, NEW }) => sql`${OLD.email} IS DISTINCT FROM ${NEW.email}`,
  function: setUpdatedAt,
})
```

`columns` is `UPDATE OF`. `when` is rendered to text and scanned when `pgTrigger` runs. [Triggers](#triggers) lists what that scan rejects and what is left for Postgres. Constraint triggers, transition tables, `INSTEAD OF` on a view, and `enabled: false` are in that section too.

The first `generate` writes a migration. The next one writes nothing until a definition changes. Only the difference is emitted, and the statements themselves are idempotent (`CREATE OR REPLACE`, `IF NOT EXISTS`, `DROP … IF EXISTS`).

## Install

```sh
npm install @systemfsoftware/timescale-drizzle
```

Peer dependency: `drizzle-orm` `>=1.0.0-rc.6`. `drizzle-kit` `>=1.0.0-rc.6` is optional and only needed to apply migrations. Node.js 20.19 or newer. Drizzle 0.x is not supported; see [Compatibility](#compatibility).

Put the definitions in the same files your `drizzle.config.ts` `schema` already points at, and export them. The CLI reads that config (dialect, schema, `out`, `casing`, `breakpoints`).

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate && timescale-drizzle generate",
    "db:check": "timescale-drizzle check",
    "db:migrate": "drizzle-kit migrate"
  }
}
```

`timescale-drizzle check` exits 1 when a definition changed and no migration was written. Use it in CI.

Run `drizzle-kit generate` first when a trigger or comment targets a table. The table migration has to sort before the trigger migration in the migrations folder. Extensions that a column type depends on (PostGIS, for example) are the opposite: that `CREATE EXTENSION` has to run before the table migration. On a new project, generate the extension migration before the first `drizzle-kit generate`, then add triggers and generate again. This package only appends migrations. It will not insert one in front of a migration you have already committed.

## What gets written

drizzle-kit 1.0 keeps one folder per migration, named by a UTC timestamp. `generate` writes the same shape:

```
drizzle/
  20261118090000_users/        written by drizzle-kit generate
  20261118090100_pg_extras/
    migration.sql              applied by drizzle-kit migrate
    down.sql                   not applied by drizzle-kit
    snapshot.json              empty diff, prevIds -> the users snapshot
  _pg-extras.json              full extras snapshot, commit this
```

`snapshot.json` is what `drizzle-kit generate --custom` writes for a migration with no schema change: `type: "diff"`, a new id, `prevIds` pointing at the previous snapshot, and no deltas. A later `drizzle-kit generate` still diffs your tables, not these extras. The folder always sorts after the last one, even when both were written in the same second, so kit never sees two base snapshots. A first migration in an empty folder has no snapshot to chain to and gets none; drizzle-kit writes its base snapshot in the next folder. `_pg-extras.json` is not a kit snapshot, and kit does not read it.

A folder that drizzle-kit 0.x wrote (`meta/_journal.json`, or a snapshot without `type`) is refused before anything is written. Run `drizzle-kit up` with drizzle-kit 1.0 to convert it first.

Up SQL is split on `--> statement-breakpoint`, which is what `drizzle-kit migrate` and `migrate()` from `drizzle-orm` expect.

Down SQL is the reverse diff: restore the previous function body, drop a trigger that was added, `COMMENT … IS NULL` for a comment that was removed. `drizzle-kit migrate` does not run `down.sql`, and applying it does not delete the row in `__drizzle_migrations`. To roll back, run the down file yourself, then delete the folder and the matching migration row if kit's history should forget it too.

## Programmatic API

```ts
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

// Full idempotent script. See "drizzle-kit push" below.
console.log(renderIdempotent(extras))
```

| Export                                            | Role                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pgFunction(name, config)`                        | `plpgsql` or `sql`, in a schema (`schema: 'app'` or a Drizzle `pgSchema`). Args are `in`, `inout`, `variadic`, or `out`, with SQL defaults. `returns` is a type, `{ kind: 'table', columns }`, or `{ kind: 'setof', type }`. See [Views and grants](#views-and-grants). |
| `pgTrigger(name, config)`                         | Table, `pgView()`, or `{ name, schema }`. `columns` is `UPDATE OF`. `when` is SQL or `` ({ OLD, NEW }) => sql`…` ``. `constraint`, `referencing`, and `enabled: false` are in [Triggers](#triggers).                                                                    |
| `updatedAtTrigger(table, column)`                 | `BEFORE UPDATE` trigger. `column` must be `date`, `time`, or `timestamp`. Tables that share a database column name share one function, `set_<column>`.                                                                                                                  |
| `pgExtension(name, { schema, version, cascade })` | `CREATE EXTENSION IF NOT EXISTS`, optionally `WITH SCHEMA` and `VERSION`.                                                                                                                                                                                               |
| `withComment(target, text)`                       | Table, column builder, enum, finished view or materialized view, `pgFunction`, trigger, extension, or an index / `unique` / `check` / `primaryKey` / `foreignKey` builder. Returns the same object. Does not change Drizzle's SQL.                                      |
| `commentOn(target, text)`                         | Same `COMMENT ON` output for a table, column, enum, view, function, trigger, or extension you already hold. Indexes and constraints use `withComment` inside the table callback.                                                                                        |
| `partitionedTable(table, { method, columns })`    | Marks a drizzle-kit table as `RANGE`, `LIST`, or `HASH`. The migration converts the empty table. See [Partitioning](#partitioning).                                                                                                                                     |
| `pgPartition(name, { parent, ...bounds })`        | `CREATE TABLE ... PARTITION OF`. Bounds are `from`/`to`, `in`, `modulus`/`remainder`, or `default: true`.                                                                                                                                                               |
| `pgAttachPartition(table, { parent, ...bounds })` | `ALTER TABLE ... ATTACH PARTITION` for a table drizzle-kit already created.                                                                                                                                                                                             |
| `pgDetachPartition(table, { parent })`            | `ALTER TABLE ... DETACH PARTITION`. The table is kept.                                                                                                                                                                                                                  |
| `hypertable(table, config)`                       | `create_hypertable` with `by_range` and `if_not_exists`, plus optional columnstore settings, a retention policy, a columnstore policy, and a reorder policy. Requires `pgExtension("timescaledb")`. See [TimescaleDB](#timescaledb).                                    |
| `viewDefinition(view, { query })`                 | `CREATE OR REPLACE VIEW` for a Drizzle `pgView(...).existing()`. See [Views and grants](#views-and-grants).                                                                                                                                                             |
| `pgGrant({ to, on, privileges })`                 | `GRANT` on a table, view, function, or schema, optionally only when the role exists. See [Views and grants](#views-and-grants).                                                                                                                                         |
| `continuousAggregate(view, config)`               | `CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous)` from your query, plus refresh, columnstore, and retention policies. See [Continuous aggregates](#continuous-aggregates).                                                                                   |
| `defineExtras` / `collectExtras`                  | Bundle objects, or scan a module's exports (the CLI does the scan).                                                                                                                                                                                                     |
| `generate` / `diffSnapshots` / `snapshotExtras`   | Diff against the stored snapshot and write files.                                                                                                                                                                                                                       |
| `renderIdempotent`                                | Create-or-replace script for everything currently declared. No drops.                                                                                                                                                                                                   |

`casing` from `drizzle.config.ts` is applied to key-named columns (`updatedAt` with `snake_case` becomes `updated_at`), same as drizzle-kit. Explicit database names are left alone.

A function's identity is `schema.name(arg types)`. Two overloads can coexist. A body, volatility, security, or `search_path` change is `CREATE OR REPLACE` (the oid stays, so triggers are left in place). A return type or argument type change is `DROP FUNCTION` plus create, and triggers that call that function are dropped and created around it. Postgres will not `CREATE OR REPLACE` a new return type.

Comments that disappear become `COMMENT … IS NULL`. If the table, column, enum, view, index, or constraint also left the schema, the null comment is omitted: drizzle-kit's migration drops the comment with the object. The same omission applies when this package drops the function, trigger, or extension in the same file. Removing a column that a trigger's `UPDATE OF` or `WHEN` still references takes two generates: change the trigger first, then drop the column. Postgres will not drop the column while the trigger depends on it.

```ts
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

`COMMENT ON` is idempotent. A removed comment is `COMMENT … IS NULL`. Run `drizzle-kit generate` before `timescale-drizzle generate` when the comment targets an enum, view, index, or constraint, so that object exists before the comment runs. A later `drizzle-kit generate` still reports no schema changes: the comment is not part of the kit snapshot.

## Triggers

These sit next to the Drizzle tables they name. `profileEmails` is a `pgView`. The functions return `trigger`.

```ts
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

`constraint: true` is `CREATE CONSTRAINT TRIGGER ... NOT DEFERRABLE`. `deferrable: true` defaults to `INITIALLY IMMEDIATE`. `initially: "deferred"` requires `deferrable: true`. `from` is the referenced table in `FROM`. These are the deferrable trigger case from [drizzle-orm#1429](https://github.com/drizzle-team/drizzle-orm/issues/1429). `SET CONSTRAINTS` uses the trigger name. Postgres has no `CREATE OR REPLACE` for constraint triggers, so the first migration is `DROP TRIGGER IF EXISTS` plus `CREATE`, and a later change drops and creates again. A comment on that trigger is written again in the same migration.

`referencing` is `REFERENCING OLD TABLE AS ... NEW TABLE AS ...`. The names are quoted identifiers. The trigger function reads them as tables (`SELECT count(*) FROM inserted`). `oldTable` is the before-image (`UPDATE` or `DELETE`). `newTable` is the after-image (`INSERT` or `UPDATE`). One event only. `FOR EACH ROW` and `FOR EACH STATEMENT` are both valid. The transition table is the whole statement either way.

`enabled: false` appends `ALTER TABLE ... DISABLE TRIGGER`. `enabled: true` after that emits `ENABLE TRIGGER` and leaves the definition in place. `CREATE OR REPLACE` turns a trigger back on, so a body change that stays disabled emits `DISABLE` again.

`withComment` on a trigger still emits `COMMENT ON TRIGGER ... ON table`. A normal `CREATE OR REPLACE` keeps that comment. A constraint trigger that is dropped and created gets the comment statement again.

`when` is a string or a `sql` fragment, or, on a Drizzle table, `` ({ OLD, NEW }) => sql`…` `` (the callback may return a string). TypeScript types `OLD` and `NEW` as that table's columns. The callback inserts each column as `OLD."name"` or `NEW."name"`. A string is used as written. A `sql` fragment is rendered to text. Neither is compared to the table's columns, and the expression is not checked as a boolean. `pgTrigger` renders the clause, omits an empty one, and strips a trailing `;`. It throws if a `;` is still present, if the trigger is `INSTEAD OF`, or if a scan of the text finds the word `SELECT` or `EXISTS`, the word `OLD` or `NEW` on a statement trigger, `OLD` when the events include `INSERT`, or `NEW` when the events include `DELETE`. The scan skips comments, quoted strings, quoted identifiers, and dollar quotes, and it does not parse SQL. The snapshot render runs that scan again, with the same casing rules as the rest of the snapshot. The stored text is written as `WHEN ( ... )`. Postgres reports any other error when the migration runs.

### Trigger limits

- Constraint triggers are `AFTER` and `FOR EACH ROW` on a table. `WHEN` on one is evaluated when the row changes, including when the trigger itself is deferred.
- `UNIQUE` and foreign keys are still drizzle-kit's. This package does not add `DEFERRABLE` to those table constraints. `from` does not create a foreign key.
- Transition tables are `AFTER` triggers on tables, with one of `INSERT`, `UPDATE`, or `DELETE`. They cannot be combined with `UPDATE OF`, `TRUNCATE`, a constraint trigger, or a view.
- `INSTEAD OF` is a view trigger, `FOR EACH ROW`, without `WHEN`, without `UPDATE OF`, and without `TRUNCATE`.
- `BEFORE` and `AFTER` on a view are `forEach: "statement"`. Materialized views cannot have triggers.
- `WHEN` is the text scan above: the words `SELECT` or `EXISTS`, `OLD` or `NEW` on a statement trigger, `OLD` when the events include `INSERT`, and `NEW` when the events include `DELETE`.
- `ALTER TABLE ... DISABLE TRIGGER` does not work on a view, so `enabled: false` is rejected for views and for `INSTEAD OF`. `ENABLE REPLICA` and `ENABLE ALWAYS` are not emitted.
- A `{ name, schema }` relation skips the checks that need a Drizzle table or view. Postgres still rejects a view trigger that was declared as a table.
- Row-level transition triggers on a partition are rejected by Postgres when the migration runs. Foreign tables are not detected through `{ name, schema }`.
- A view column is matched by view name and column name. Drizzle's view column alias does not carry the schema, so two views with the same name in different schemas are not told apart.

## Views and grants

A view whose query uses Postgres that Drizzle's query builder cannot express (lateral joins, set-returning functions, window clauses) is declared as a Drizzle view with `.existing()`, so drizzle-kit leaves it alone, and given its query here. Interpolated tables, views, and functions render schema-qualified, so the schema name lives in one place.

```ts
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

Views are created in dependency order: a view that reads another view, or calls a declared function, comes after it. A changed query drops and creates the view, together with every declared view that reads it, and writes their comments and grants again. Removing a view that another declared view still reads is refused; change the reader in the same change. `securityInvoker`, `securityBarrier`, and `checkOption` map to the view options of the same names.

`onlyIfRoleExists` wraps the statement in a `DO` block that checks `pg_roles`, for a role that exists in some environments only. Without it, a missing role fails the migration. Grants to `PUBLIC` are refused. A removed grant is a `REVOKE` of the removed privileges.

`RETURNS TABLE` cannot be combined with `out` or `inout` arguments, and only `out` arguments can follow a `variadic` one. A function's identity uses its `in`, `inout`, and `variadic` argument types, so adding an `out` argument is a new signature.

## Partitioning

Postgres accepts `PARTITION BY` only on `CREATE TABLE`. There is no `ALTER TABLE ... PARTITION BY`. drizzle-kit has already written a normal `CREATE TABLE` by the time this package runs, and this package does not rewrite that file (that is what `drizzle-partition` does).

`partitionedTable()` takes the other road. You keep the table in the Drizzle schema, so drizzle-kit still owns columns, indexes, and foreign keys. `generate` appends a migration that rebuilds the table as partitioned **when it is empty**, and raises when it has any rows. Run `drizzle-kit generate` first, then `timescale-drizzle generate`, then `drizzle-kit migrate`, and load data after that. Doing it in one `drizzle-kit migrate` is the normal case: kit creates the empty table, then this migration converts it, before the application writes rows.

The tradeoff is that conversion is a rebuild, not a flag. It is safe on an empty table and refused on a table that already has data. A helper that emitted the parent `CREATE TABLE` itself would avoid the rebuild, but then the table would have to stay out of drizzle-kit or kit would create it a second time, and this package would have to own later column changes. Keeping the table in the Drizzle schema is the point of fitting the rest of this package.

```ts
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
  method: 'range', // "list" or "hash"
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
// export const detachArchive = pgDetachPartition(eventsArchive, { parent: events });
```

`pgPartition` creates a child with `CREATE TABLE ... PARTITION OF`. List bounds use `in: ["en", "en-US"]` (a tuple per row when the key has several columns). Hash bounds use `modulus` and `remainder`. `from: ["MINVALUE"]` and `to: ["MAXVALUE"]` are the range keywords, not strings. Export `partitionedTable()` as well as the children. The CLI only sees what the schema module exports.

Every primary key and unique constraint on a Drizzle table has to include the partition columns. Postgres requires that, and `partitionedTable()` rejects the table when one does not. A `{ name, schema }` parent skips that check because the columns are only strings.

Removing a `pgPartition` drops the child when the child is empty. `onRemove: "detach"` keeps the table and its rows instead. `pgAttachPartition` always detaches on remove, because drizzle-kit still owns that table. `pgDetachPartition` is the explicit form of that detach. Set `onRemove` when you declare the partition. It is written into `_pg-extras.json` the next time a migration is generated. Changing only `onRemove` does not write a migration file.

The statements are idempotent. Running the migration twice is a no-op when the parent is already partitioned the same way and the children are already attached. `renderIdempotent` emits the same create-or-attach script and does not drop partitions you removed from the schema.

The conversion copies columns, defaults, identity, indexes, checks, and column comments with `CREATE TABLE ... (LIKE ... INCLUDING ALL)`, then puts back outgoing and incoming foreign keys, triggers, row level security policies, grants, the table comment, and ownership. `serial` sequences are reassigned with `ALTER SEQUENCE ... OWNED BY` before the old table is dropped, so `nextval` keeps working. Index and constraint names are renamed back to the names drizzle-kit recorded. A later `drizzle-kit generate` still diffs your tables and reports no schema changes.

### Partition limits

- Empty parents only. A table that already has rows is not converted. Move those rows yourself.
- The partition key cannot be changed in place. `generate` throws. It also throws when a child bound changes. Recreating a partition would drop its rows, and this package will not do that quietly. Detach, copy, and attach in a migration you write.
- Hash parents cannot have a `DEFAULT` partition. Postgres rejects it.
- A table you attach has to match the parent already: column order, `NOT NULL`, unique indexes, and check constraints. Postgres checks that at `ATTACH` and the error is Postgres's.
- Views and materialized views that depend on the parent are not rewritten. The migration raises and leaves the table in place. Drop the views first.
- No expression keys such as `PARTITION BY RANGE (date_trunc('month', created_at))`, no sub-partitions, and no tablespaces.
- No `DETACH PARTITION CONCURRENTLY`. `drizzle-kit migrate` runs each migration in a transaction, and `CONCURRENTLY` cannot run there.
- `drizzle-kit push` does not read these definitions. Partition children are real tables kit did not declare, so push can offer to drop them. The supported path is generate, then migrate. If you push anyway, exclude the children with `tablesFilter`.
- A later drizzle-kit migration that drops and recreates the parent (some column type changes) drops the partitions with it. The extras snapshot already says the table is partitioned, so this package will not emit the conversion again. Repair that kit migration by hand.
- Down SQL drops created partitions when they are empty, detaches attached tables, and converts the parent back when it is empty. It raises when a created partition still has rows. `drizzle-kit migrate` does not run the down file.

## TimescaleDB

This is a community package. It is not an official Timescale or Tiger Data tool, and it is not part of Drizzle. Nobody at Timescale reviewed this SQL. It generates the calls people asked for on [drizzle-orm#2962](https://github.com/drizzle-team/drizzle-orm/issues/2962): turn a normal table into a hypertable, then optionally use its columnstore and add retention, columnstore, and reorder policies. It also declares continuous aggregates over a hypertable or over another aggregate.

The table stays in the Drizzle schema, so drizzle-kit still owns columns, indexes, and keys. `generate` appends `SELECT create_hypertable(..., by_range(...), if_not_exists => TRUE)`. That is the same shape as the custom migration in the issue thread. Timescale's newer `CREATE TABLE ... WITH (tsdb.hypertable)` has to be on the `CREATE TABLE` itself, and this package does not rewrite the file drizzle-kit already wrote.

`pgExtension("timescaledb")` has to be exported from the schema. `generate` throws if it is missing, and it writes `CREATE EXTENSION` before `create_hypertable` when both are new. A hypertable does not need the extension before the table: drizzle-kit creates an ordinary table, then this migration converts it. Run `drizzle-kit generate`, then `timescale-drizzle generate`, then `drizzle-kit migrate`, and load data after that.

```ts
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
  chunkTimeInterval: '1 day', // omitted: Timescale's default is 7 days
  partitioningColumn: metrics.deviceId, // hash dimension; requires numberPartitions
  numberPartitions: 4,
  migrateData: false, // true makes create_hypertable copy rows that are already in the table
  createDefaultIndexes: true, // false omits create_hypertable's default time index
  columnstore: {
    segmentBy: [metrics.deviceId],
    orderBy: [{ column: metrics.time, direction: 'desc', nulls: 'last' }],
    sparseIndex: [{ type: 'bloom', columns: [metrics.value] }],
  },
  retention: { dropAfter: '6 months', scheduleInterval: '1 day' },
  columnstorePolicy: { after: '7 days' },
  reorder: 'metrics_time_idx', // an index on the table; Timescale names the default one <table>_<time column>_idx
})
```

`chunkTimeInterval`, `dropAfter`, `dropCreatedBefore`, `after`, `createdBefore`, and `scheduleInterval` are interval strings such as `"7 days"` or `"1 day 12 hours"`. They are quoted into `INTERVAL '...'`. `initialStart` is a timestamp such as `"2024-01-01T00:00:00Z"`, quoted into `TIMESTAMPTZ '...'`. Set `dropAfter` or `dropCreatedBefore`, not both, and `after` or `createdBefore`, not both. `columnstore: {}` enables the columnstore with Timescale's defaults. A columnstore policy requires `columnstore`, because Timescale rejects the policy until the columnstore is on.

Every primary key and unique index on a Drizzle table has to include the time column and the space column, when you set one. Timescale requires that, and `hypertable()` rejects the table when one does not. The time column has to be `NOT NULL` and a `date`, `timestamp`, or `timestamptz`. A `{ name, schema }` table with string column names skips those checks.

The statements are idempotent. `create_hypertable`, `add_retention_policy`, `add_columnstore_policy`, and `add_reorder_policy` all pass `if_not_exists => TRUE`, and the columnstore `ALTER TABLE` can run again. Running the migration twice is a no-op when the hypertable, settings, and policies are already in place. `if_not_exists` does not change an existing policy's interval, so a later edit removes the policy and adds it again. A later `chunkTimeInterval` emits `set_chunk_time_interval`. Adding `partitioningColumn` after the hypertable exists emits `add_dimension`. `migrateData` and `createDefaultIndexes` are read only when the hypertable is first created; changing them later does not write a migration. A later `reorder` change removes the reorder policy and adds it again.

### Reading a hypertable

A query that names no time range makes Postgres plan every chunk, and it takes a lock on each chunk and each of its indexes. With a few thousand chunks, one `ORDER BY time DESC LIMIT 1` exhausts `max_locks_per_transaction` (SQLSTATE 53200), even though the executor stops after the first chunk. So `hypertable()` returns a declaration that is not a Drizzle table. `db.select().from(metricsHypertable)` does not compile; read it through one of these.

```ts
const window = metricsHypertable.within({ gte: start, lt: end })
const rows = await db
  .select({ value: window.value })
  .from(window)
  .where(eq(window.deviceId, deviceId))

const newest = await metricsHypertable.latest(db, {
  where: (w) => eq(w.deviceId, deviceId),
  maxLookbackChunks: 64,
})
if (newest.found) resumeFrom(newest.row.time)
else startAt(newest.searchedFrom)
```

- `within({ gte, lt })` returns a Drizzle subquery with `time >= $1 AND time < $2` written into it, so the planner excludes chunks outside the window. A `Date` bound is written into the SQL as a `timestamptz` literal, not a `$n` parameter, so chunk exclusion happens at plan time even in a prepared statement that has switched to a generic plan. A column, table or subquery is refused as a bound, since `time >= time` bounds nothing. It is a subquery rather than a pre-filtered builder because chaining `.where()` on a builder replaces the earlier `where`, and a caller could erase the bound without noticing. Pass `{ as: 'name' }` to alias it when you join two windows of one table.
- `latest(db, { where, maxLookbackChunks, until })` finds the newest row with bounded probes. The first covers two chunk intervals ending at `until` (default: now plus one interval); each later one reaches four times further back, up to `maxLookbackChunks` intervals in total (default 64). A steady-state ingester finds its row on the first probe and locks one to three chunks. It returns `{ found: true, row }`, or `{ found: false, searchedFrom }` when nothing is that recent, so a missing row is never confused with an old one. Probe widths come from `chunkTimeInterval` (7 days when unset), with a month counted as 30 days and a year as 365; they size the probes and never decide which rows match. A row dated after `until` is not seen.
- `unsafeUnbounded()` returns the plain Drizzle table, for migrations, backfills and admin scripts. Its name is the point: an app can ban the call with a lint rule.

The compiler can only guard what the app imports. Keep the Drizzle table in a schema module that drizzle-kit reads, and import only the hypertable from application code; `latest` is for occasional resume points, and a cursor read on every write belongs in a plain table you update on insert.

A continuous aggregate is a hypertable underneath, so an unbounded read of it locks every chunk of its materialization. Pass `bucketColumn` when you declare it over a view and read it the same way:

```ts
export const metricsHourlyAggregate = continuousAggregate(metricsHourly, { bucketColumn: 'bucket', query: '...' })

const window = metricsHourlyAggregate.within({ gte: start, lt: end })
```

An aggregate declared without `bucketColumn`, or by name, has no `within`.

A later `drizzle-kit generate` still diffs your tables and reports no schema changes. `_pg-extras.json` from 0.4.0 still loads. Hypertable keys are added the next time a migration is written.

### Timescale limits

- The time column cannot be an integer. Integer time needs `set_integer_now_func` and integer chunk sizes, and the policies below are intervals.
- The time column cannot be changed. An existing space partition cannot be removed or pointed at a different column or partition count. `generate` throws. Move the data in a migration you write. The down file for a migration that only added a space partition leaves that dimension in place.
- Clearing `chunkTimeInterval` is not generated. Set the new interval. The down file for a migration that set an interval for the first time leaves that interval in place.
- Removing `hypertable()` while the Drizzle table stays is an error. This package will not pretend it turned the hypertable back into a regular table. Remove the table from the Drizzle schema in the same change and `drizzle-kit` drops it, or drop it in a custom migration.
- Down SQL removes policies and turns the columnstore off. It converts columnstore chunks back with `convert_to_rowstore` before it sets `timescaledb.enable_columnstore = false`. It leaves the hypertable in place, and it does not `DROP EXTENSION timescaledb` while that hypertable still exists, because the drop would fail. `drizzle-kit migrate` does not run the down file.
- `create_hypertable` errors with `table "..." is not empty` unless `migrateData: true`. Migrating data takes a lock and rewrites the rows into chunks.
- The columnstore is emitted as `timescaledb.enable_columnstore`, `timescaledb.segmentby`, `timescaledb.orderby`, `timescaledb.sparse_index`, and `add_columnstore_policy`. Removing every `sparseIndex` entry emits `ALTER TABLE ... RESET (timescaledb.sparse_index)`. The package never emits `timescaledb.sparse_index = ''`, because after it TimescaleDB 2.32.1 crashes on ordinary `INSERT`, `UPDATE` and `DELETE`.
- No tablespaces.
- `create_hypertable` creates its default index on the time column unless `createDefaultIndexes: false`. That index is not in the Drizzle schema.
- Chunks live in `_timescaledb_internal`, next to the `_timescaledb_catalog` and `_timescaledb_config` schemas. `drizzle-kit push` and `drizzle-kit pull` can treat those as tables you forgot to declare. `generate` does not. The supported path is generate, then migrate.
- A later drizzle-kit migration that drops and recreates the parent (some column type changes) drops the hypertable with it. The extras snapshot already says the table is a hypertable, so this package will not emit `create_hypertable` again. Repair that kit migration by hand.
- A `{ name, schema }` parent skips the NOT NULL, type, and unique-index checks.

### Continuous aggregates

`continuousAggregate()` writes `CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous) AS <query> WITH NO DATA`, so the migration does not block on materializing history; the refresh policy fills it. drizzle-kit rewrites views it generates and would drop the `timescaledb.continuous` option, so declare the view for queries with Drizzle's `materializedView(...).existing()` and pass it, or pass a `{ name, schema }`:

```ts
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

- `source` is the hypertable or the continuous aggregate the query reads. Name it so `generate` creates a parent before its child and drops a child before its parent. An aggregate over an aggregate is hierarchical.
- `realTime: false` sets `timescaledb.materialized_only = true`. `chunkInterval` sets the aggregate's chunk interval; it can be changed later but not cleared. `createGroupIndexes` maps to `timescaledb.create_group_indexes`.
- `refreshPolicies` takes one or more refresh windows with `startOffset`, `endOffset` and `scheduleInterval`, plus Timescale's optional `initialStart`, `timezone`, `includeTieredData`, `bucketsPerBatch`, `maxBatchesPerExecution` and `refreshNewestFirst`.
- `columnstore`, `columnstorePolicy` and `retention` work as on a hypertable.
- A change to `query`, `source` or `createGroupIndexes` drops the aggregate and creates it again empty. `generate` throws when that aggregate is the source of another one: drop the child first, generate and migrate the parent change, then declare the child again.
- Removing an aggregate and its source table in the same change throws. Remove the aggregate, generate and migrate, then remove the table.
- To comment an aggregate with `withComment`, declare it with `pgView(...).existing()`. TimescaleDB accepts `COMMENT ON VIEW` for a continuous aggregate, and a `pgMaterializedView` would emit `COMMENT ON MATERIALIZED VIEW`.

## drizzle-kit push

`drizzle-kit push` does not read this package and does not run files in the migrations folder. It will not create functions, triggers, comments, extensions, partitions, or hypertables.

drizzle-kit has no trigger diff, so push does not drop a trigger it never declared. A push that drops or recreates the table still drops that table's triggers and comments, because Postgres drops them with the table. Functions are not attached to the table and stay. Extensions are not created. An extension that installs its own tables (PostGIS) can show up as relations push wants to delete; set `extensionsFilters: ["postgis"]` in `drizzle.config.ts` for that case. Partition children show up the same way: they are tables in the database that are not in the Drizzle schema, and push can try to drop them. Timescale chunks and catalog tables show up the same way. Exclude those names with `tablesFilter` if you push, or don't push.

The supported path is `drizzle-kit generate`, then `timescale-drizzle generate`, then `drizzle-kit migrate`. If you use push for tables, apply the extras yourself with `renderIdempotent` (or by running the latest up file) after a push that recreated a table. See [Known limitations](#known-limitations).

## Known limitations

`generate` and `check` diff the current declarations against `_pg-extras.json`. They do not read the database catalog. When drizzle-kit drops and recreates a table, Postgres drops the triggers and comments on that table. The snapshot still contains them, and the schema still declares them, so the next `generate` writes nothing for them. Functions are not attached to the table and stay. Partitions and hypertables are the same kind of gap; see [Partition limits](#partition-limits) and [Timescale limits](#timescale-limits).

`renderIdempotent(extras)` snapshots the declarations you pass and prints idempotent SQL for them. Functions and ordinary triggers are `CREATE OR REPLACE`. A constraint trigger is `DROP TRIGGER IF EXISTS` plus `CREATE`. `enabled: false` adds `DISABLE TRIGGER`. Comments are `COMMENT ON`. Extensions are `CREATE EXTENSION IF NOT EXISTS`. Partitions are the conversion, create, attach, and detach statements. Hypertables are `create_hypertable` with `if_not_exists`, plus the columnstore `ALTER TABLE`, reorder and policy calls with `if_not_exists` when those are set, and continuous aggregates with their columnstore and policy calls. It does not drop objects removed from the schema. Run that script once the table exists again. An up file only repeats its own diff, so the latest up file recreates a trigger only when that `CREATE` is in the file.

## Compatibility

|             |                                                                                                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| drizzle-orm | `>=1.0.0-rc.6`. Tested with 1.0.0-rc.6, which still does not generate functions, triggers, views with raw queries, grants, comments, extensions, partitions, or hypertables. Drizzle 0.x is not supported.                                                                   |
| drizzle-kit | `>=1.0.0-rc.6`, folder-per-migration layout. Tested with 1.0.0-rc.6: `migrate` applies the folder, and the next `generate` reports no schema changes. Convert a 0.x journal folder with `drizzle-kit up` first.                                                              |
| PostgreSQL  | 14 or newer (`CREATE OR REPLACE TRIGGER`). Tested on 17.                                                                                                                                                                                                                     |
| TimescaleDB | Hypertables, columnstore settings and sparse indexes, retention policies, columnstore policies, reorder policies, and continuous aggregates with refresh policies. Tested on PostgreSQL 17 with the TimescaleDB that the pinned `timescale/timescaledb-ha:pg17` image ships. |
| Node.js     | 20.19 or newer, which drizzle-kit 1.0 needs. ESM and CJS builds.                                                                                                                                                                                                             |

## What it does not do yet

- Row level security policies. drizzle-kit already generates policies. The partition conversion copies policies that already exist on a parent; it does not author new ones.
- Materialized views other than continuous aggregates. drizzle-kit creates those. This package comments them.
- `DEFERRABLE` on `UNIQUE` and foreign keys. Deferrable constraint triggers are in [Triggers](#triggers).
- Comments on policies, sequences, rules, or individual enum labels.
- Comments on a column-level `.unique()`, `.primaryKey()`, or `.references()`. Declare `unique()`, `primaryKey()`, or `foreignKey()` in the extra config and wrap that builder.
- An index whose key is a SQL expression needs an explicit name before it can be commented. drizzle-kit requires that name too.
- `updatedAtTrigger`'s generated function has no comment of its own. Comment the trigger, or declare the function with `pgFunction` and comment that.
- Call `.as()` or `.existing()` before `withComment` on a view, and `.on()` before `withComment` on an index or unique constraint.
- Pulling the live database back into the snapshot. The diff is against `_pg-extras.json`, not `pg_catalog`. See [Known limitations](#known-limitations).
- MySQL, SQLite, and SingleStore.
- Creating the schema named in `WITH SCHEMA`. The schema has to exist (drizzle-kit can create it).
- Clearing an extension version pin, or moving an extension back to "no schema clause". Set the new version or schema explicitly. `ALTER EXTENSION … UPDATE` still depends on that extension shipping a downgrade path.
- Editing migrations that have already been applied. Generate a new file.

## CLI

```text
timescale-drizzle generate [--config drizzle.config.ts] [--name touch_updated_at]
timescale-drizzle check [--config drizzle.config.ts]
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
