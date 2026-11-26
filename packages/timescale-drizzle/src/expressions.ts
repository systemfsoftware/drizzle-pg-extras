import { type Column, getTableColumns, type Placeholder, type SQL, sql, type SQLWrapper } from 'drizzle-orm'
import type { AnyPgColumn, PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { PgExtrasError } from './errors.js'
import { assertIdentifier, quoteIdent, quoteLiteral } from './quote.js'

export type SqlInput<T = unknown> =
  | SQL<T>
  | SQL.Aliased<T>
  | Placeholder<string, T>
  | (AnyPgColumn & { readonly _: { readonly data: T } })

export type InferSqlType<E> = E extends SQL<infer T> ? T
  : E extends SQL.Aliased<infer T> ? T
  : E extends Placeholder<string, infer T> ? T
  : E extends Column<infer C> ? (C['notNull'] extends true ? C['data'] : C['data'] | null)
  : unknown

const commaSeparated = (values: readonly SqlInput<unknown>[]) => sql.join([...values], sql.raw(', '))

const atLeast = (functionName: string, values: readonly unknown[]): void => {
  if (values.length < 2) {
    throw new PgExtrasError(`${functionName}() needs at least two arguments, got ${values.length}`)
  }
}

export function greatest<T>(first: SqlInput<T>, second: SqlInput<T>, ...rest: SqlInput<T>[]): SQL<T> {
  atLeast('greatest', [first, second, ...rest])
  return sql<T>`greatest(${commaSeparated([first, second, ...rest])})`
}

export function least<T>(first: SqlInput<T>, second: SqlInput<T>, ...rest: SqlInput<T>[]): SQL<T> {
  atLeast('least', [first, second, ...rest])
  return sql<T>`least(${commaSeparated([first, second, ...rest])})`
}

export function coalesce<T>(
  first: SqlInput<T | null>,
  second: SqlInput<NonNullable<T>>,
  ...rest: SqlInput<T | null>[]
): SQL<NonNullable<T>> {
  return sql<NonNullable<T>>`coalesce(${commaSeparated([first, second, ...rest])})`
}

export function concat(first: SqlInput<unknown>, second: SqlInput<unknown>, ...rest: SqlInput<unknown>[]): SQL<string> {
  atLeast('concat', [first, second, ...rest])
  return sql<string>`concat(${commaSeparated([first, second, ...rest])})`
}

export function concatWs(
  separator: string | SqlInput<string>,
  first: SqlInput<unknown>,
  ...rest: SqlInput<unknown>[]
): SQL<string> {
  return sql<string>`concat_ws(${separator}, ${commaSeparated([first, ...rest])})`
}

export type InferJsonbObject<TShape extends Record<string, SqlInput<unknown>>> = {
  readonly [K in keyof TShape]: InferSqlType<TShape[K]>
}

const JSONB_BUILD_OBJECT_MAX_PAIRS = 50

const jsonbBuildPairs = (entries: ReadonlyArray<readonly [string, SqlInput<unknown>]>) =>
  sql`jsonb_build_object(${sql.join(entries.map(([key, value]) => sql`${key}::text, ${value}`), sql.raw(', '))})`

export function jsonbBuildObject<TShape extends Record<string, SqlInput<unknown>>>(
  shape: TShape,
): SQL<InferJsonbObject<TShape>> {
  const entries = Object.entries(shape) as Array<readonly [string, SqlInput<unknown>]>
  if (entries.length === 0) return sql<InferJsonbObject<TShape>>`'{}'::jsonb`
  const chunks: SQL[] = []
  for (let index = 0; index < entries.length; index += JSONB_BUILD_OBJECT_MAX_PAIRS) {
    chunks.push(jsonbBuildPairs(entries.slice(index, index + JSONB_BUILD_OBJECT_MAX_PAIRS)))
  }
  return sql<InferJsonbObject<TShape>>`(${sql.join(chunks, sql.raw(' || '))})`
}

const jsonbKey = (key: string | number) => {
  if (typeof key !== 'number') return sql`${key}::text`
  if (!Number.isInteger(key)) throw new PgExtrasError(`jsonb key must be an integer, got ${String(key)}`)
  return sql`${key}::int`
}

export function jsonbGet<T = unknown>(target: SqlInput<unknown>, key: string | number): SQL<T | null> {
  return sql<T | null>`(${target} -> ${jsonbKey(key)})`
}

export function jsonbText(target: SqlInput<unknown>, key: string | number): SQL<string | null> {
  return sql<string | null>`(${target} ->> ${jsonbKey(key)})`
}

export interface JsonbElementsRelation<T> {
  readonly from: SQL<unknown>
  readonly value: SQL<T>
}

const jsonbArrayElementsAs = <T>(
  fn: 'jsonb_array_elements' | 'jsonb_array_elements_text',
  target: SqlInput<unknown>,
  alias: string,
  columnAlias: string,
): JsonbElementsRelation<T> => {
  assertIdentifier('jsonb array element alias', alias)
  assertIdentifier('jsonb array element column alias', columnAlias)
  const quotedAlias = quoteIdent(alias)
  return {
    from: sql<unknown>`${sql.raw(fn)}(${target}) AS ${sql.raw(quotedAlias)}(${sql.raw(quoteIdent(columnAlias))})`,
    value: sql<T>`${sql.raw(quotedAlias)}.${sql.raw(quoteIdent(columnAlias))}`,
  }
}

export function jsonbArrayElements<T = unknown>(
  target: SqlInput<unknown>,
  alias: string,
  columnAlias = 'value',
): JsonbElementsRelation<T> {
  return jsonbArrayElementsAs<T>('jsonb_array_elements', target, alias, columnAlias)
}

export function jsonbArrayElementsText(
  target: SqlInput<unknown>,
  alias: string,
  columnAlias = 'value',
): JsonbElementsRelation<string | null> {
  return jsonbArrayElementsAs<string | null>('jsonb_array_elements_text', target, alias, columnAlias)
}

const INTERVAL_LITERAL_UNITS = [
  'microsecond',
  'millisecond',
  'second',
  'minute',
  'hour',
  'day',
  'week',
  'month',
  'year',
] as const

export type IntervalLiteralUnit = (typeof INTERVAL_LITERAL_UNITS)[number]

const literalInterval = (amount: number, unit: IntervalLiteralUnit): string => {
  if (!Number.isFinite(amount)) throw new PgExtrasError(`interval amount must be finite, got ${String(amount)}`)
  if (!INTERVAL_LITERAL_UNITS.includes(unit)) {
    throw new PgExtrasError(`interval unit must be one of ${INTERVAL_LITERAL_UNITS.join(', ')}, got ${String(unit)}`)
  }
  return quoteLiteral(`${String(amount)} ${unit}`)
}

export function interval(amount: number, unit: IntervalLiteralUnit): SQL<string> {
  return sql<string>`interval ${sql.raw(literalInterval(amount, unit))}`
}

export function now(): SQL<Date> {
  return sql<Date>`now()`
}

export function addInterval(ts: SqlInput<Date | string>, span: SqlInput<string>): SQL<Date> {
  return sql<Date>`(${ts} + ${span})`
}

export function subInterval(ts: SqlInput<Date | string>, span: SqlInput<string>): SQL<Date> {
  return sql<Date>`(${ts} - ${span})`
}

export interface MakeIntervalArgs {
  readonly years?: number | SqlInput<number>
  readonly months?: number | SqlInput<number>
  readonly weeks?: number | SqlInput<number>
  readonly days?: number | SqlInput<number>
  readonly hours?: number | SqlInput<number>
  readonly minutes?: number | SqlInput<number>
  readonly seconds?: number | SqlInput<number>
}

export type RequireAtLeastOne<T> = { [K in keyof T]-?: Required<Pick<T, K>> & Partial<Omit<T, K>> }[keyof T]

const MAKE_INTERVAL_FIELDS = [
  ['years', 'years', 'int'],
  ['months', 'months', 'int'],
  ['weeks', 'weeks', 'int'],
  ['days', 'days', 'int'],
  ['hours', 'hours', 'int'],
  ['minutes', 'mins', 'int'],
  ['seconds', 'secs', 'double precision'],
] as const

export function makeInterval(args: RequireAtLeastOne<MakeIntervalArgs>): SQL<string> {
  const parts: SQL[] = []
  for (const [field, keyword, castType] of MAKE_INTERVAL_FIELDS) {
    const value = args[field]
    if (value === undefined) continue
    parts.push(sql`${sql.raw(keyword)} => ${value}::${sql.raw(castType)}`)
  }
  if (parts.length === 0) throw new PgExtrasError('makeInterval() needs at least one field')
  return sql<string>`make_interval(${sql.join(parts, sql.raw(', '))})`
}

const tupleIsDistinctFrom = (
  left: readonly SqlInput<unknown>[],
  right: readonly SqlInput<unknown>[],
): SQL<boolean> => {
  if (left.length !== right.length) {
    throw new PgExtrasError('isDistinctFrom() tuple arguments must be arrays of equal length')
  }
  if (left.length === 0) throw new PgExtrasError('isDistinctFrom() tuple arguments cannot be empty')
  return sql<boolean>`((${commaSeparated(left)}) IS DISTINCT FROM (${commaSeparated(right)}))`
}

export function isDistinctFrom<T>(left: SqlInput<T>, right: SqlInput<T>): SQL<boolean>
export function isDistinctFrom<TLeft extends readonly [SqlInput<unknown>, ...SqlInput<unknown>[]]>(
  left: TLeft,
  right: { readonly [K in keyof TLeft]: SqlInput<InferSqlType<TLeft[K]>> },
): SQL<boolean>
export function isDistinctFrom(
  left: SqlInput<unknown> | readonly SqlInput<unknown>[],
  right: SqlInput<unknown> | readonly SqlInput<unknown>[],
): SQL<boolean> {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      throw new PgExtrasError('isDistinctFrom() tuple arguments must both be arrays')
    }
    return tupleIsDistinctFrom(left, right)
  }
  return sql<boolean>`(${left} IS DISTINCT FROM ${right})`
}

export function epochSeconds(ts: SqlInput<Date | string>): SQL<number> {
  return sql<number>`(EXTRACT(EPOCH FROM ${ts}))::double precision`
}

export function epochMs(ts: SqlInput<Date | string>): SQL<number> {
  return sql<number>`(trunc(EXTRACT(EPOCH FROM ${ts}) * 1000))::double precision`
}

export interface RowNumberSpec {
  readonly partitionBy?: readonly SqlInput<unknown>[]
  readonly orderBy: readonly [SqlInput<unknown>, ...SqlInput<unknown>[]]
}

export function rowNumber(spec: RowNumberSpec): SQL<number> {
  const partition = spec.partitionBy === undefined || spec.partitionBy.length === 0
    ? sql.raw('')
    : sql`PARTITION BY ${commaSeparated(spec.partitionBy)} `
  return sql<number>`(row_number() OVER (${partition}ORDER BY ${commaSeparated(spec.orderBy)}))::int`
}

export function rowKey(first: SqlInput<unknown>, ...rest: SqlInput<unknown>[]): SQL<string> {
  return sql<string>`md5(jsonb_build_array(${commaSeparated([first, ...rest])})::text)`
}

export function excluded<TCol extends AnyPgColumn>(column: TCol): SQL<InferSqlType<TCol>> {
  return sql<InferSqlType<TCol>>`excluded.${sql.identifier(column.name)}`
}

export interface DrizzleOnConflictUpdateConfig {
  readonly target: PgColumn[]
  readonly set: Record<string, SQLWrapper>
  readonly setWhere?: SQL
}

export interface UpsertChangedOptions<TTable extends PgTable> {
  readonly target: readonly [PgColumn, ...PgColumn[]]
  readonly columns?: readonly (keyof TTable['_']['columns'])[]
  readonly set?: Partial<Record<keyof TTable['_']['columns'], SQLWrapper>>
  readonly where?: SQL
}

export function onConflictUpdateChanged<TTable extends PgTable>(
  table: TTable,
  options: UpsertChangedOptions<TTable>,
): DrizzleOnConflictUpdateConfig {
  const columns = getTableColumns(table) as Record<string, PgColumn>
  const targetNames = new Set(options.target.map((column) => column.name))
  const explicit = options.columns as readonly string[] | undefined
  const overrideNames = Object.keys(options.set ?? {})
  const names = Array.from(
    new Set([...(explicit ?? Object.keys(columns)), ...overrideNames]),
  ).filter((name) => !targetNames.has(columns[name]?.name))
  const set: Record<string, SQLWrapper> = {}
  const guarded: PgColumn[] = []
  for (const name of names) {
    const column = columns[name]
    if (column === undefined) throw new PgExtrasError(`onConflictUpdateChanged() does not know the column ${name}`)
    const override = options.set?.[name as keyof TTable['_']['columns']]
    set[name] = override ?? excluded(column)
    if (override === undefined) guarded.push(column)
  }
  if (Object.keys(set).length === 0) {
    throw new PgExtrasError('onConflictUpdateChanged() produced no SET columns; pass a column to update')
  }
  const setWhere = options.where ??
    (guarded.length === 0 ? undefined : tupleIsDistinctFrom(guarded.map((column) => excluded(column)), guarded))
  return { target: [...options.target], set, ...(setWhere === undefined ? {} : { setWhere }) }
}
