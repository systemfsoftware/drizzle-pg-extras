import { and, desc, gte, lt, type SQL, type SQLWrapper } from 'drizzle-orm'
import {
  type PgColumn,
  type PgDatabase,
  type PgQueryResultHKT,
  QueryBuilder,
  type SubqueryWithSelection,
} from 'drizzle-orm/pg-core'
import { PgExtrasError } from './errors.js'

export type TimeBounds<TTime extends PgColumn> = {
  readonly gte: TTime['_']['data'] | SQLWrapper
  readonly lt: TTime['_']['data'] | SQLWrapper
}

export type Latest<TRow> =
  | { readonly found: true; readonly row: TRow }
  | { readonly found: false; readonly searchedFrom: Date }

export type LatestOptions<TWindow> = {
  readonly where?: (window: TWindow) => SQL | undefined
  readonly maxLookbackChunks?: number
  readonly until?: Date
}

export type AnyPgDatabase = PgDatabase<PgQueryResultHKT>

export type BoundedSource = Parameters<ReturnType<QueryBuilder['select']>['from']>[0]

const DEFAULT_CHUNK_INTERVAL = '7 days'
const DEFAULT_MAX_LOOKBACK_CHUNKS = 64
const WIDENING_FACTOR = 4
const FIRST_PROBE_INTERVALS = 2

const UNIT_MS: Record<string, number> = {
  microsecond: 0.001,
  millisecond: 1,
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
}

export function intervalMilliseconds(interval: string): number {
  let total = 0
  for (const part of interval.matchAll(/(\d+(?:\.\d+)?)\s+([a-z]+?)s?(?=\s|$)/gi)) {
    const unit = UNIT_MS[part[2]!.toLowerCase()]
    if (unit === undefined) throw new PgExtrasError(`Cannot read interval "${interval}"`)
    total += Number(part[1]) * unit
  }
  if (!(total > 0)) throw new PgExtrasError(`Cannot read interval "${interval}"`)
  return total
}

function assertWindow(bounds: { gte: unknown; lt: unknown }): void {
  const { gte: from, lt: to } = bounds
  if (from instanceof Date && to instanceof Date) {
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new PgExtrasError('within(): the bounds must be valid dates')
    }
    if (from.getTime() >= to.getTime()) throw new PgExtrasError('within(): gte must be before lt')
  }
}

export function boundedSubquery<TAlias extends string>(
  source: BoundedSource,
  timeColumn: PgColumn,
  bounds: { gte: unknown; lt: unknown },
  alias: TAlias,
): SubqueryWithSelection<Record<string, PgColumn>, TAlias> {
  assertWindow(bounds)
  return new QueryBuilder()
    .select()
    .from(source)
    .where(and(gte(timeColumn, bounds.gte), lt(timeColumn, bounds.lt)))
    .as(alias) as unknown as SubqueryWithSelection<Record<string, PgColumn>, TAlias>
}

type ProbeDatabase = {
  select(): {
    from(source: unknown): {
      where(filter: SQL | undefined): {
        orderBy(order: SQL): { limit(count: number): PromiseLike<unknown[]> }
      }
    }
  }
}

type AnyWindow = Record<string, PgColumn>

export function probeWindows(
  until: Date,
  chunkIntervalMs: number,
  maxLookbackChunks: number,
): { from: Date; to: Date }[] {
  const reach = chunkIntervalMs * maxLookbackChunks
  const origin = until.getTime() - reach
  const windows: { from: Date; to: Date }[] = []
  let to = until.getTime()
  let width = chunkIntervalMs * FIRST_PROBE_INTERVALS
  while (to > origin) {
    const from = Math.max(to - width, origin)
    windows.push({ from: new Date(from), to: new Date(to) })
    to = from
    width *= WIDENING_FACTOR
  }
  return windows
}

export async function latestRow<TRow>(
  db: AnyPgDatabase,
  read: {
    readonly source: BoundedSource
    readonly timeColumn: PgColumn
    readonly timeKey: string
    readonly alias: string
    readonly chunkInterval: string | null
  },
  options: LatestOptions<AnyWindow> | undefined,
): Promise<Latest<TRow>> {
  const maxLookbackChunks = options?.maxLookbackChunks ?? DEFAULT_MAX_LOOKBACK_CHUNKS
  if (!Number.isInteger(maxLookbackChunks) || maxLookbackChunks < 1) {
    throw new PgExtrasError('latest(): maxLookbackChunks must be a positive integer')
  }
  const chunkIntervalMs = intervalMilliseconds(read.chunkInterval ?? DEFAULT_CHUNK_INTERVAL)
  const until = options?.until ?? new Date(Date.now() + chunkIntervalMs)
  const windows = probeWindows(until, chunkIntervalMs, maxLookbackChunks)
  for (const window of windows) {
    const probe = boundedSubquery(read.source, read.timeColumn, { gte: window.from, lt: window.to }, read.alias)
    const columns = probe as unknown as AnyWindow
    const filter = options?.where?.(columns)
    const rows = await (db as unknown as ProbeDatabase)
      .select()
      .from(probe)
      .where(filter)
      .orderBy(desc(columns[read.timeKey]!))
      .limit(1)
    const row = rows[0] as TRow | undefined
    if (row !== undefined) return { found: true, row }
  }
  const searchedFrom = windows.at(-1)?.from ?? until
  return { found: false, searchedFrom }
}
