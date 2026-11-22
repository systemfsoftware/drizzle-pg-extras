import { is, SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

const dialect = new PgDialect()

export function isSqlFragment(value: unknown): value is SQL {
  return is(value, SQL)
}

/** Render a Drizzle `sql` fragment as text, inlining values. DDL cannot take bind parameters. */
export function renderSql(query: SQL): string {
  return dialect.sqlToQuery(query.inlineParams()).sql
}
