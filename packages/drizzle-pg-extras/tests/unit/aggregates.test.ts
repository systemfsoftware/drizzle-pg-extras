import { sql } from 'drizzle-orm'
import { integer, pgMaterializedView, pgTable, pgView, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  collectExtras,
  continuousAggregate,
  defineExtras,
  diffSnapshots,
  emptySnapshot,
  hypertable,
  parseSnapshot,
  pgExtension,
  renderIdempotent,
  snapshotExtras,
  withComment,
} from '../../src/index.js'

function metricsTable() {
  return pgTable('metrics', {
    time: timestamp('time', { withTimezone: true }).notNull(),
    deviceId: text('device_id').notNull(),
    value: integer('value').notNull(),
  }, (t) => [primaryKey({ columns: [t.time, t.deviceId] })])
}

function viewOf(name: string) {
  return pgView(name, { value: integer() }).existing()
}

function setup() {
  const table = metricsTable()
  const ht = hypertable(table, { timeColumn: table.time, chunkTimeInterval: '1 day' })
  const hourlyView = viewOf('metrics_hourly')
  const hourly = continuousAggregate(hourlyView, {
    query: `SELECT time_bucket('1 hour', time) AS bucket, device_id, avg(value) AS value
FROM metrics GROUP BY time_bucket('1 hour', time), device_id`,
    source: ht,
    chunkInterval: '1 hour',
  })
  return { table, ht, hourlyView, hourly }
}

function extras(
  caggs: Parameters<typeof defineExtras>[0]['continuousAggregates'],
  table: ReturnType<typeof metricsTable>,
  ht: ReturnType<typeof hypertable>,
) {
  return defineExtras({
    extensions: [pgExtension('timescaledb')],
    tables: [table],
    hypertables: [ht],
    continuousAggregates: caggs,
  })
}

describe('continuous aggregates', () => {
  it('creates a materialized view with timescaledb.continuous and WITH NO DATA', () => {
    const { table, ht, hourly } = setup()
    const diff = diffSnapshots(emptySnapshot(), snapshotExtras(extras([hourly], table, ht)))
    const up = diff.up.join('\n')
    expect(up).toContain('CREATE MATERIALIZED VIEW IF NOT EXISTS "public"."metrics_hourly"')
    expect(up).toContain('timescaledb.continuous')
    expect(up).toContain("timescaledb.chunk_interval = '1 hour'")
    expect(up).toContain('WITH NO DATA')
    expect(up).toContain("FROM metrics GROUP BY time_bucket('1 hour', time), device_id")
    expect(diff.down.join('\n')).toContain('DROP MATERIALIZED VIEW IF EXISTS "public"."metrics_hourly"')
    expect(diffSnapshots(snapshotExtras(extras([hourly], table, ht)), snapshotExtras(extras([hourly], table, ht))).up)
      .toEqual([])
    expect(renderIdempotent(extras([hourly], table, ht))).toContain('CREATE MATERIALIZED VIEW IF NOT EXISTS')
  })

  it('orders a parent aggregate before a child that reads it without a declared source', () => {
    const { table, ht } = setup()
    const hourly = continuousAggregate(viewOf('metrics_hourly'), { query: 'SELECT 1 AS value', source: ht })
    const daily = continuousAggregate(viewOf('metrics_daily'), {
      query: 'SELECT max(value) AS value FROM "public"."metrics_hourly"',
    })
    const childFirst = snapshotExtras(extras([daily, hourly], table, ht))
    const up = diffSnapshots(emptySnapshot(), childFirst).up.join('\n')
    expect(up.indexOf('CREATE MATERIALIZED VIEW IF NOT EXISTS "public"."metrics_hourly"')).toBeLessThan(
      up.indexOf('CREATE MATERIALIZED VIEW IF NOT EXISTS "public"."metrics_daily"'),
    )
    const idempotent = renderIdempotent(extras([daily, hourly], table, ht))
    expect(idempotent.indexOf('"public"."metrics_hourly"')).toBeLessThan(
      idempotent.indexOf('"public"."metrics_daily"'),
    )
  })

  it('renders real-time off, chunk intervals, and group indexes', () => {
    const { table, ht } = setup()
    const view = viewOf('metrics_daily')
    const daily = continuousAggregate(view, {
      query: 'SELECT 1 AS value',
      source: ht,
      realTime: false,
      chunkInterval: '2 days',
      createGroupIndexes: false,
    })
    const up = diffSnapshots(emptySnapshot(), snapshotExtras(extras([daily], table, ht))).up.join('\n')
    expect(up).toContain('timescaledb.materialized_only = true')
    expect(up).toContain("timescaledb.chunk_interval = '2 days'")
    expect(up).toContain('timescaledb.create_group_indexes = false')
    expect(renderIdempotent(extras([daily], table, ht))).toContain('CREATE MATERIALIZED VIEW IF NOT EXISTS')
  })

  it('alters real time and chunk interval without a rebuild', () => {
    const { table, ht, hourly } = setup()
    const before = snapshotExtras(extras([hourly], table, ht))
    const realTime = continuousAggregate(viewOf('metrics_hourly'), {
      query: `SELECT time_bucket('1 hour', time) AS bucket, device_id, avg(value) AS value
FROM metrics GROUP BY time_bucket('1 hour', time), device_id`,
      source: ht,
      chunkInterval: '1 hour',
      realTime: false,
    })
    const alter = diffSnapshots(before, snapshotExtras(extras([realTime], table, ht))).up.join('\n')
    expect(alter).toContain(
      'ALTER MATERIALIZED VIEW "public"."metrics_hourly" SET (timescaledb.materialized_only = true)',
    )
    expect(alter).not.toContain('DROP MATERIALIZED VIEW')
    expect(alter).not.toContain('CREATE MATERIALIZED VIEW')

    const chunked = continuousAggregate(viewOf('metrics_hourly'), {
      query: `SELECT time_bucket('1 hour', time) AS bucket, device_id, avg(value) AS value
FROM metrics GROUP BY time_bucket('1 hour', time), device_id`,
      source: ht,
      chunkInterval: '2 hours',
    })
    const chunkAlter = diffSnapshots(before, snapshotExtras(extras([chunked], table, ht))).up.join('\n')
    expect(chunkAlter).toContain(
      `ALTER MATERIALIZED VIEW "public"."metrics_hourly" SET (timescaledb.chunk_interval = '2 hours')`,
    )
    expect(chunkAlter).not.toContain('INTERVAL')
    expect(chunkAlter).not.toContain('DROP MATERIALIZED VIEW')
  })

  it('rebuilds on a query change and refuses a parent change with a declared child', () => {
    const { table, ht, hourly } = setup()
    const before = snapshotExtras(extras([hourly], table, ht))
    const rebuilt = continuousAggregate(viewOf('metrics_hourly'), {
      query: `SELECT time_bucket('1 hour', time) AS bucket, device_id, max(value) AS value
FROM metrics GROUP BY time_bucket('1 hour', time), device_id`,
      source: ht,
      chunkInterval: '1 hour',
    })
    const up = diffSnapshots(before, snapshotExtras(extras([rebuilt], table, ht))).up.join('\n')
    expect(up).toContain('DROP MATERIALIZED VIEW IF EXISTS "public"."metrics_hourly"')
    expect(up).toContain('CREATE MATERIALIZED VIEW IF NOT EXISTS "public"."metrics_hourly"')
    expect(up.indexOf('DROP MATERIALIZED VIEW IF EXISTS "public"."metrics_hourly"')).toBeLessThan(
      up.indexOf('CREATE MATERIALIZED VIEW IF NOT EXISTS "public"."metrics_hourly"'),
    )

    const daily = continuousAggregate(viewOf('metrics_daily'), { query: 'SELECT 1 AS value', source: hourly })
    const rebuiltDaily = continuousAggregate(viewOf('metrics_daily'), {
      query: 'SELECT 1 AS value',
      source: rebuilt,
    })
    const withChild = snapshotExtras(extras([hourly, daily], table, ht))
    const withRebuiltParent = snapshotExtras(extras([rebuilt, rebuiltDaily], table, ht))
    expect(() => diffSnapshots(withChild, withRebuiltParent)).toThrow(
      /sources an aggregate whose definition changed/,
    )
  })

  it('orders parent before child, and drops child before parent', () => {
    const { table, ht, hourly } = setup()
    const daily = continuousAggregate(viewOf('metrics_daily'), {
      query: 'SELECT 1 AS value',
      source: hourly,
    })
    const snap = snapshotExtras(extras([daily, hourly], table, ht))
    const up = diffSnapshots(emptySnapshot(), snap).up.join('\n')
    expect(up.indexOf('"public"."metrics_hourly"')).toBeLessThan(up.indexOf('"public"."metrics_daily"'))
    const down = diffSnapshots(emptySnapshot(), snap).down.join('\n')
    expect(down.indexOf('"public"."metrics_daily"')).toBeLessThan(down.indexOf('"public"."metrics_hourly"'))
  })

  it('re-emits a comment on rebuild and skips the null comment on drop', () => {
    const { table, ht } = setup()
    const view = withComment(viewOf('metrics_hourly'), 'Hourly metrics')
    const hourly = continuousAggregate(view, { query: 'SELECT 1 AS value', source: ht })
    const before = snapshotExtras(extras([hourly], table, ht))
    const changed = continuousAggregate(view, { query: 'SELECT 2 AS value', source: ht })
    const up = diffSnapshots(before, snapshotExtras(extras([changed], table, ht))).up.join('\n')
    expect(up).toContain(`COMMENT ON VIEW "public"."metrics_hourly" IS 'Hourly metrics'`)
    const drop = diffSnapshots(before, snapshotExtras(extras([], table, ht))).up.join('\n')
    expect(drop).toContain('DROP MATERIALIZED VIEW IF EXISTS "public"."metrics_hourly"')
    expect(drop).not.toContain('COMMENT ON VIEW "public"."metrics_hourly" IS NULL')
  })

  it('refuses a source table removed with its aggregate', () => {
    const { table, ht, hourly } = setup()
    const before = snapshotExtras(extras([hourly], table, ht))
    expect(() => diffSnapshots(before, emptySnapshot())).toThrow(/removed in one change/)
  })

  it('adds refresh policies, columnstore, and retention to a continuous aggregate', () => {
    const { table, ht } = setup()
    const view = viewOf('metrics_hourly')
    const cagg = continuousAggregate(view, {
      query: 'SELECT 1 AS value',
      source: ht,
      refreshPolicies: [
        { startOffset: '1 month', endOffset: '1 hour', scheduleInterval: '1 hour' },
        {
          startOffset: null,
          endOffset: '1 day',
          scheduleInterval: '1 day',
          initialStart: '2024-02-01T00:00:00Z',
          timezone: 'UTC',
          includeTieredData: true,
          bucketsPerBatch: 10,
          maxBatchesPerExecution: 5,
          refreshNewestFirst: false,
        },
      ],
      columnstore: {
        segmentBy: ['device_id'],
        orderBy: [{ column: 'bucket', direction: 'desc', nulls: 'last' }],
      },
      columnstorePolicy: { after: '7 days', scheduleInterval: '1 hour' },
      retention: { dropAfter: '6 months' },
    })
    const up = diffSnapshots(emptySnapshot(), snapshotExtras(extras([cagg], table, ht))).up.join('\n')
    expect(up).toContain(`ALTER MATERIALIZED VIEW "public"."metrics_hourly" SET (`)
    expect(up).toContain(`timescaledb.segmentby = '"device_id"'`)
    expect(up).toContain(`timescaledb.orderby = '"bucket" DESC NULLS LAST'`)
    expect(up).toContain(
      `CALL add_columnstore_policy('"public"."metrics_hourly"'::regclass, after => INTERVAL '7 days', schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE);`,
    )
    expect(up).toContain(
      `SELECT add_retention_policy('"public"."metrics_hourly"'::regclass, drop_after => INTERVAL '6 months', if_not_exists => TRUE);`,
    )
    expect(up.match(/add_continuous_aggregate_policy/g)).toHaveLength(2)
    expect(up).toContain(
      `start_offset => INTERVAL '1 month', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE`,
    )
    expect(up).toContain("start_offset => NULL, end_offset => INTERVAL '1 day'")
    expect(up).toContain('include_tiered_data => true')
    expect(up).toContain('buckets_per_batch => 10')
    expect(up).toContain('max_batches_per_execution => 5')
    expect(up).toContain('refresh_newest_first => false')
    expect(up).toContain("initial_start => '2024-02-01T00:00:00Z'::timestamptz")
    expect(up).toContain("timezone => 'UTC'")
  })

  it('removes and re-adds the refresh policy set when a window changes', () => {
    const { table, ht } = setup()
    const before = continuousAggregate(viewOf('metrics_hourly'), {
      query: 'SELECT 1 AS value',
      source: ht,
      refreshPolicies: [{ startOffset: '1 month', endOffset: '1 hour', scheduleInterval: '1 hour' }],
    })
    const after = continuousAggregate(viewOf('metrics_hourly'), {
      query: 'SELECT 1 AS value',
      source: ht,
      refreshPolicies: [{ startOffset: '2 months', endOffset: '1 hour', scheduleInterval: '2 hours' }],
    })
    const up = diffSnapshots(
      snapshotExtras(extras([before], table, ht)),
      snapshotExtras(extras([after], table, ht)),
    ).up.join('\n')
    expect(up).toContain('remove_continuous_aggregate_policy')
    expect(up.indexOf('remove_continuous_aggregate_policy')).toBeLessThan(
      up.indexOf(`start_offset => INTERVAL '2 months'`),
    )
    expect(up).not.toContain('DROP MATERIALIZED VIEW')
    const reordered = continuousAggregate(viewOf('metrics_hourly'), {
      query: 'SELECT 1 AS value',
      source: ht,
      refreshPolicies: [
        { startOffset: '1 month', endOffset: '1 hour', scheduleInterval: '1 hour' },
        { startOffset: '2 months', endOffset: '1 hour', scheduleInterval: '1 hour' },
      ],
    })
    const swapped = continuousAggregate(viewOf('metrics_hourly'), {
      query: 'SELECT 1 AS value',
      source: ht,
      refreshPolicies: [
        { startOffset: '2 months', endOffset: '1 hour', scheduleInterval: '1 hour' },
        { startOffset: '1 month', endOffset: '1 hour', scheduleInterval: '1 hour' },
      ],
    })
    expect(
      diffSnapshots(
        snapshotExtras(extras([reordered], table, ht)),
        snapshotExtras(extras([swapped], table, ht)),
      ).up,
    ).toEqual([])
  })

  it('rejects unsupported aggregate policy variants and duplicate windows', () => {
    const { ht } = setup()
    expect(() =>
      continuousAggregate('metrics_hourly', {
        query: 'SELECT 1',
        source: ht,
        refreshPolicies: [
          { startOffset: '1 month', endOffset: '1 hour', scheduleInterval: '1 hour' },
          { startOffset: '1 month', endOffset: '1 hour', scheduleInterval: '2 hours' },
        ],
      })
    ).toThrow(/declared more than once/)
    expect(() =>
      continuousAggregate('metrics_hourly', {
        query: 'SELECT 1',
        source: ht,
        columnstore: {},
        columnstorePolicy: { after: '1 day', createdBefore: '1 year' } as never,
      })
    ).toThrow(/createdBefore is not supported/)
    expect(() =>
      continuousAggregate('metrics_hourly', {
        query: 'SELECT 1',
        source: ht,
        retention: { dropAfter: '1 day', dropCreatedBefore: '1 year' } as never,
      })
    ).toThrow(/dropCreatedBefore is not supported/)
    expect(() =>
      continuousAggregate('metrics_hourly', {
        query: 'SELECT 1',
        source: ht,
        columnstorePolicy: { after: '1 day' },
      })
    ).toThrow(/requires columnstore/)
  })

  it('validates the declaration and reads an old snapshot without aggregates', () => {
    const table = metricsTable()
    const ht = hypertable(table, { timeColumn: table.time })
    expect(() =>
      continuousAggregate(pgMaterializedView('bad', { value: integer() }).as(sql`select 1`), {
        query: 'SELECT 1',
        source: ht,
      })
    ).toThrow(/existing/)
    expect(() =>
      continuousAggregate('bad', {
        query: ' ',
        source: ht,
      })
    ).toThrow(/query is empty/)
    expect(() =>
      continuousAggregate('bad', {
        query: 'SELECT 1',
        source: table as never,
      })
    ).toThrow(/source must be/)
    const parsed = parseSnapshot({ version: 1, functions: [], triggers: [], extensions: [], comments: [] })
    expect(parsed.continuousAggregates).toEqual([])
    const collected = setup()
    expect(
      collectExtras({ timescale: pgExtension('timescaledb'), metrics: collected.table, ht: collected.ht })
        .continuousAggregates,
    ).toHaveLength(0)
    expect(
      collectExtras({
        timescale: pgExtension('timescaledb'),
        metrics: collected.table,
        ht: collected.ht,
        agg: collected.hourly,
      }).continuousAggregates,
    ).toHaveLength(1)
  })
})
