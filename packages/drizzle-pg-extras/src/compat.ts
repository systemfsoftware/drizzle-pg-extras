/**
 * Column helpers over drizzle-orm 1.0 internals.
 *
 * - A column declared without a name (`keyAsName`) is named by drizzle-kit's `casing`
 *   setting when kit writes the table, so these declarations follow the same rule.
 * - `column.table` exists at runtime in 1.0 but is not typed.
 */
import { type Casing, toCamelCase, toSnakeCase } from 'drizzle-orm/casing'

export type { Casing }

interface NamedColumn {
  name: string
  keyAsName?: boolean
}

/**
 * Resolve a column's database name the way drizzle-kit does: a column declared
 * without an explicit name (`keyAsName`) gets the configured casing applied to
 * its key; an explicitly named column keeps its name.
 */
export function columnDbName(column: NamedColumn, casing: Casing | undefined): string {
  if (!column.keyAsName || !casing) return column.name
  return casing === 'snake_case' ? toSnakeCase(column.name) : toCamelCase(column.name)
}

/** The table or view a column belongs to. Present at runtime in 1.0, but untyped. */
export function columnTable(column: object): unknown {
  return (column as { table?: unknown }).table
}
