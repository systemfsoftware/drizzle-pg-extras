---
"@systemfsoftware/drizzle-pg-extras": minor
---

Declare views and grants, and move to drizzle 1.0.

- `viewDefinition(view, { query })` creates a Drizzle `pgView(...).existing()` from a raw query, in dependency order, and drops and creates it with its readers, comments, and grants when the query changes.
- `pgGrant({ to, on, privileges, onlyIfRoleExists })` grants on tables, views, functions, and schemas, optionally only where the role exists, and revokes what is removed.
- `pgFunction` takes a `schema`, `inout`, `variadic`, and `out` arguments, argument defaults, and `RETURNS TABLE` or `SETOF` results.
- A hypertable declared on a drizzle table accepts a column in a `uniqueIndex` as covering its partition key.
- A damaged `_pg-extras.json` is refused with its path in the message.
- Every statement in an up or down file ends with a semicolon, so the file also runs whole in `psql`.

Breaking: drizzle-orm and drizzle-kit `>=1.0.0-rc.6` and Node.js 20.19 are now required. The drizzle-kit 0.x journal layout and the `migrations.prefix` setting are no longer written; a folder kit 0.x wrote is refused before anything is written, with the advice to run `drizzle-kit up`.
