import { type Column, type SQL, sql, type SQLWrapper } from 'drizzle-orm'
import { PgExtrasError } from './errors.js'
import { assertIdentifier, quoteIdent, quoteLiteral } from './quote.js'

const INTERVAL_UNITS = [
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

export type TimeIntervalUnit = (typeof INTERVAL_UNITS)[number]

export type TimeInterval = {
  readonly value: number
  readonly unit: TimeIntervalUnit
}

export function timeInterval(value: number, unit: TimeIntervalUnit): TimeInterval {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PgExtrasError(`interval value must be a positive whole number, got ${String(value)}`)
  }
  if (!INTERVAL_UNITS.includes(unit)) {
    throw new PgExtrasError(`interval unit must be one of ${INTERVAL_UNITS.join(', ')}, got ${String(unit)}`)
  }
  return { value, unit }
}

export type SqlData<T extends SQLWrapper> = T extends Column<infer Config>
  ? (Config extends { data: infer Data } ? Data : unknown)
  : T extends SQL<infer Data> ? Data
  : unknown

function assertTimeInterval(interval: TimeInterval, where: string): TimeInterval {
  try {
    return timeInterval(interval.value, interval.unit)
  } catch (error) {
    throw new PgExtrasError(`${where}: ${error instanceof PgExtrasError ? error.message : String(error)}`)
  }
}

function intervalValueLiteral(interval: TimeInterval): string {
  return quoteLiteral(`${String(interval.value)} ${interval.unit}`)
}

function dateLiteral(value: Date, kind: string): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new PgExtrasError(`${kind} must be a valid Date`)
  }
  return quoteLiteral(value.toISOString())
}

export function timeBucket<T = Date>(
  interval: TimeInterval,
  value: SQLWrapper,
  options?: { readonly origin?: Date },
): SQL<T> {
  const bucket = assertTimeInterval(interval, 'timeBucket()')
  const origin = options?.origin === undefined ? undefined : dateLiteral(options.origin, 'bucket origin')
  return origin === undefined
    ? sql<T>`time_bucket(interval ${sql.raw(intervalValueLiteral(bucket))}, ${value})`
    : sql<T>`time_bucket(interval ${sql.raw(intervalValueLiteral(bucket))}, ${value}, ${sql.raw(origin)})`
}

export function first<T extends SQLWrapper>(value: T, orderBy: SQLWrapper): SQL<SqlData<T> | null> {
  return sql<SqlData<T> | null>`first(${value}, ${orderBy})`
}

export function last<T extends SQLWrapper>(value: T, orderBy: SQLWrapper): SQL<SqlData<T> | null> {
  return sql<SqlData<T> | null>`last(${value}, ${orderBy})`
}

export function filterWhere<T>(expression: SQL<T>, condition: SQLWrapper): SQL<T | null> {
  return sql<T | null>`${expression} FILTER (WHERE ${condition})`
}

export type TimestampSeriesConfig = {
  readonly start: Date
  readonly stop: Date
  readonly step: TimeInterval
}

/**
 * A generated time axis. `source` is the set-returning table for a lateral
 * join, carrying both table and column aliases in its body because the pinned
 * Drizzle renderer drops an `SQL.Aliased` chunk's body in FROM or JOIN;
 * `value` is the qualified bucket column for selection and ordering. Join
 * `source` with {@link trueCondition} as the join condition.
 */
export type TimestampSeries = {
  readonly source: SQL<unknown>
  readonly value: SQL<Date>
}

export function generateTimestampSeries(
  config: TimestampSeriesConfig,
  alias: string,
): TimestampSeries {
  assertIdentifier('series alias', alias)
  const start = dateLiteral(config.start, 'series start')
  const stop = dateLiteral(config.stop, 'series stop')
  const step = intervalValueLiteral(assertTimeInterval(config.step, 'generateTimestampSeries()'))
  const quotedAlias = quoteIdent(alias)
  return {
    source: sql<unknown>`generate_series(${sql.raw(start)}, ${sql.raw(stop)}, interval ${sql.raw(step)}) as ${
      sql.raw(quotedAlias)
    }("value")`,
    value: sql<Date>`${sql.raw(quotedAlias)}."value"`,
  }
}

export function trueCondition(): SQL<boolean> {
  return sql<boolean>`TRUE`
}
