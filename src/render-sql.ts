import { is, SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { type Casing, dialectConfig } from './compat.js'

const dialects = new Map<string, PgDialect>()

function dialectFor(casing: Casing | undefined): PgDialect {
  const key = casing ?? ''
  let dialect = dialects.get(key)
  if (!dialect) {
    // PgDialect's config differs between drizzle-kit 0.x (casing) and 1.0 (no casing).
    // oxlint-disable-next-line typescript/no-explicit-any
    dialect = new PgDialect(dialectConfig(casing) as any)
    dialects.set(key, dialect)
  }
  return dialect
}

export function isSqlFragment(value: unknown): value is SQL {
  return is(value, SQL)
}

/** Render a Drizzle `sql` fragment as text, inlining values. DDL cannot take bind parameters. */
export function renderSql(query: SQL, casing?: Casing): string {
  return dialectFor(casing).sqlToQuery(query.inlineParams()).sql
}
