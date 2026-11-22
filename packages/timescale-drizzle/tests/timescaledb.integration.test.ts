import { Gherkin, Given, it, makeFeature, Then, When } from '@systemfsoftware/effect-gherkin-spec'
import {
  collectExtras,
  continuousAggregate,
  type ContinuousAggregateConfig,
  defineExtras,
  generate,
  hypertable,
  pgExtension,
  renderIdempotent,
  splitMigrationSql,
  withComment,
} from '@systemfsoftware/timescale-drizzle'
import { sql } from 'drizzle-orm'
import {
  integer,
  pgMaterializedView,
  pgSchema,
  pgTable,
  pgView,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { Effect } from 'effect'
import {
  Database,
  DatabaseFailed,
  freshDatabase,
  generated,
  migrated,
  query,
  timescaleServer,
} from './__fixtures__/database.fixture.js'

const Feature = makeFeature({ it })

const timescale = pgExtension('timescaledb')

const metrics = pgTable('metrics', {
  time: timestamp('time', { withTimezone: true }).notNull(),
  deviceId: text('device_id').notNull(),
  value: integer('value').notNull(),
}, (t) => [primaryKey({ columns: [t.time, t.deviceId] })])

const metricsTable = `CREATE TABLE public.metrics (
  time timestamptz NOT NULL,
  device_id text NOT NULL,
  value integer NOT NULL,
  PRIMARY KEY (time, device_id)
);`

type MetricsHypertable = Parameters<typeof hypertable<typeof metrics>>[1]

const metricsExtras = (config: MetricsHypertable) =>
  defineExtras({ extensions: [timescale], tables: [metrics], hypertables: [hypertable(metrics, config)] })

const full: MetricsHypertable = {
  timeColumn: metrics.time,
  chunkTimeInterval: '1 day',
  partitioningColumn: metrics.deviceId,
  numberPartitions: 4,
  columnstore: {
    segmentBy: [metrics.deviceId],
    orderBy: [{ column: metrics.time, direction: 'desc', nulls: 'last' }],
  },
  retention: { dropAfter: '6 months', scheduleInterval: '1 day' },
  columnstorePolicy: { after: '7 days' },
}

const recentRows = `INSERT INTO public.metrics VALUES
  (now(), 'a', 1),
  (now() - INTERVAL '3 days', 'a', 2),
  (now() - INTERVAL '3 days' + INTERVAL '1 hour', 'a', 3);`

const migrate = (extras: ReturnType<typeof defineExtras>, name: string) =>
  Effect.andThen(generated(extras, name), migrated)

const refusalOf = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.message)

const declarationRefusal = (declare: () => unknown) =>
  Effect.map(
    Effect.flip(Effect.try({
      try: () => {
        declare()
      },
      catch: (cause) => new DatabaseFailed({ step: 'declare', cause }),
    })),
    (error) => error.message,
  )

const matching = (messages: Record<string, string>, patterns: Record<string, RegExp>) =>
  Object.fromEntries(
    Object.entries(patterns).map((
      [key, pattern],
    ) => [key, pattern.test(messages[key] ?? '') ? 'refused' : messages[key]]),
  )

const refused = (patterns: Record<string, RegExp>) =>
  Object.fromEntries(Object.keys(patterns).map((key) => [key, 'refused']))

const generatedWithSnakeCase = (extras: ReturnType<typeof defineExtras>, name: string) =>
  Effect.flatMap(Database, ({ out }) =>
    Effect.try({
      try: () => generate({ extras, out, name, casing: 'snake_case' }),
      catch: (cause) => new DatabaseFailed({ step: `generate ${name}`, cause }),
    }))

const dimensionsOf = (schema: string, table: string) =>
  query(
    `SELECT column_name, dimension_type, time_interval::text AS chunk, num_partitions
     FROM timescaledb_information.dimensions
     WHERE hypertable_schema = $1 AND hypertable_name = $2 ORDER BY dimension_number`,
    [schema, table],
  )

const jobsOf = (table: string) =>
  query(
    `SELECT proc_name, schedule_interval::text AS every FROM timescaledb_information.jobs
     WHERE hypertable_name = $1 ORDER BY proc_name`,
    [table],
  )

const windowOf = (table: string, proc: string, key: string, interval: string) =>
  Effect.map(
    query(
      `SELECT (config->>$3)::interval = $4::interval AS ok FROM timescaledb_information.jobs
       WHERE hypertable_name = $1 AND proc_name = $2`,
      [table, proc, key, interval],
    ),
    (rows) => rows[0]?.ok === true,
  )

const columnstoreOf = (table: string) =>
  query(
    `SELECT segmentby, orderby FROM timescaledb_information.hypertable_columnstore_settings
     WHERE hypertable = ('public.' || $1)::regclass`,
    [table],
  )

// A database without the extension has no hypertables, and no timescaledb_information views to ask.
const isHypertable = (schema: string, table: string) =>
  Effect.flatMap(
    query("SELECT to_regclass('timescaledb_information.hypertables') IS NOT NULL AS installed"),
    (rows) =>
      rows[0]?.installed === true
        ? Effect.map(
          query(
            'SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_schema = $1 AND hypertable_name = $2',
            [schema, table],
          ),
          (found) => found.length === 1,
        )
        : Effect.succeed(false),
  )

const chunkStates = (table: string) =>
  query(
    `SELECT count(*)::int AS chunks, (count(*) FILTER (WHERE is_compressed))::int AS columnstore
     FROM timescaledb_information.chunks WHERE hypertable_name = $1`,
    [table],
  )

const moveOldChunksToColumnstore = (table: string, olderThan: string) =>
  Effect.flatMap(
    query(`SELECT show_chunks(('public.' || $1)::regclass, older_than => now() - $2::interval)::text AS chunk`, [
      table,
      olderThan,
    ]),
    (chunks) => Effect.forEach(chunks, ({ chunk }) => query('CALL convert_to_columnstore($1::regclass)', [chunk])),
  )

const runAll = (statements: readonly string[]) => Effect.forEach(statements, (statement) => query(statement))

const rowCount = (table: string) => query(`SELECT count(*)::int AS n FROM ${table}`)

const hourlyBucket = `SELECT time_bucket('1 hour', time) AS bucket, device_id, avg(value) AS value
FROM metrics GROUP BY time_bucket('1 hour', time), device_id`

const dailyBucket = (from: string, aggregate = 'max') =>
  `SELECT time_bucket('1 day', bucket) AS bucket, device_id, ${aggregate}(value) AS value
FROM ${from} GROUP BY time_bucket('1 day', bucket), device_id`

const metricsHypertable = hypertable(metrics, { timeColumn: metrics.time, chunkTimeInterval: '1 day' })

const hourlyView = withComment(pgView('metrics_hourly', { value: integer() }).existing(), 'Hourly metrics')

const aggregateExtras = (aggregates: ReturnType<typeof continuousAggregate>[]) =>
  defineExtras({
    extensions: [timescale],
    tables: [metrics],
    hypertables: [metricsHypertable],
    continuousAggregates: aggregates,
  })

const hourlyOf = (config: Partial<ContinuousAggregateConfig> = {}) =>
  continuousAggregate(hourlyView, { query: hourlyBucket, source: metricsHypertable, ...config })

const dailyOf = (
  parent: ReturnType<typeof continuousAggregate> | undefined,
  from = 'metrics_hourly',
  aggregate = 'max',
) =>
  continuousAggregate('metrics_daily', {
    query: dailyBucket(from, aggregate),
    ...(parent ? { source: parent } : {}),
  })

const aggregatesNamed = () =>
  query(
    `SELECT view_name, materialized_only FROM timescaledb_information.continuous_aggregates
     WHERE view_schema = 'public' ORDER BY view_name`,
  )

const refreshDay = (view: string) =>
  query(`CALL refresh_continuous_aggregate('public.${view}', '2024-01-01', '2024-01-02')`)

const windows = [
  { startOffset: '1 month', endOffset: '1 day', scheduleInterval: '1 day' },
  { startOffset: '1 day', endOffset: '1 hour', scheduleInterval: '1 hour' },
]

const aggregateJobs = () =>
  query(
    `SELECT j.proc_name, j.schedule_interval::text AS every
     FROM timescaledb_information.jobs j
     WHERE j.hypertable_schema = 'public' AND j.hypertable_name = 'metrics_hourly'
     ORDER BY j.proc_name, j.schedule_interval`,
  )

const aggregateColumnstore = () =>
  query(
    `SELECT s.segmentby, s.orderby FROM timescaledb_information.hypertable_columnstore_settings s
     JOIN timescaledb_information.continuous_aggregates c
       ON format('%I.%I', c.materialization_hypertable_schema, c.materialization_hypertable_name)::regclass = s.hypertable
     WHERE c.view_name = 'metrics_hourly'`,
  )

const readingsOfTheDay = `INSERT INTO public.metrics VALUES
  ('2024-01-01 10:00Z', 'a', 1),
  ('2024-01-01 10:30Z', 'a', 3),
  ('2024-01-01 14:00Z', 'a', 10);`

Feature('Declaring TimescaleDB hypertables and continuous aggregates next to the tables', { timeout: 240_000 })
  .live('a real TimescaleDB booted in a microVM')
  .withLayer(timescaleServer)
  .withScenarioLayer(freshDatabase)
  .body(({ scenario }) => {
    scenario(
      'A table becomes a hypertable with a time and a space partition, columnstore and policies',
      Gherkin.Do.pipe(
        Given('an empty metrics table')('setup', () => query(metricsTable)),
        When('the table is declared a hypertable with columnstore, retention and a columnstore policy and migrated')(
          'seen',
          () =>
            Effect.andThen(
              migrate(metricsExtras(full), 'hypertable'),
              Effect.all({
                dimensions: dimensionsOf('public', 'metrics'),
                columnstore: columnstoreOf('metrics'),
                jobs: jobsOf('metrics'),
                retention: windowOf('metrics', 'policy_retention', 'drop_after', '6 months'),
                columnstorePolicy: windowOf('metrics', 'policy_compression', 'compress_after', '7 days'),
              }),
            ),
        ),
        Then('the catalog shows one day chunks split four ways by device, and the declared policies')((s, expect) =>
          expect(s.seen).toEqual({
            dimensions: [
              { column_name: 'time', dimension_type: 'Time', chunk: '1 day', num_partitions: null },
              { column_name: 'device_id', dimension_type: 'Space', chunk: null, num_partitions: 4 },
            ],
            columnstore: [{ segmentby: 'device_id', orderby: '"time" DESC NULLS LAST' }],
            jobs: [
              { proc_name: 'policy_compression', every: '12:00:00' },
              { proc_name: 'policy_retention', every: '1 day' },
            ],
            retention: true,
            columnstorePolicy: true,
          })
        ),
      ),
    )

    scenario(
      'Rows land in time chunks and the oldest chunk can move to columnstore and still be read',
      Gherkin.Do.pipe(
        Given('a hypertable that is already migrated')(
          'setup',
          () => Effect.andThen(query(metricsTable), migrate(metricsExtras(full), 'hypertable')),
        ),
        When('rows from now and from three days ago are added and the old chunk moves to columnstore')(
          'seen',
          () =>
            Effect.andThen(
              Effect.andThen(query(recentRows), moveOldChunksToColumnstore('metrics', '2 days')),
              Effect.all({
                chunks: chunkStates('metrics'),
                total: query('SELECT count(*)::int AS n, sum(value)::int AS total FROM public.metrics'),
              }),
            ),
        ),
        Then('there are two chunks, one in columnstore, and all three rows still add up')((s, expect) =>
          expect(s.seen).toEqual({
            chunks: [{ chunks: 2, columnstore: 1 }],
            total: [{ n: 3, total: 6 }],
          })
        ),
      ),
    )

    scenario(
      'A changed declaration retunes the hypertable in place and keeps its rows',
      Gherkin.Do.pipe(
        Given('a hypertable with rows that is already migrated')('setup', () =>
          Effect.andThen(
            Effect.andThen(query(metricsTable), migrate(metricsExtras(full), 'hypertable')),
            query(recentRows),
          )),
        When('the chunk interval, retention, sort order and a reorder policy are changed and migrated')(
          'seen',
          () =>
            Effect.andThen(
              migrate(
                metricsExtras({
                  ...full,
                  chunkTimeInterval: '2 days',
                  columnstore: { segmentBy: [metrics.deviceId], orderBy: [{ column: metrics.time, direction: 'asc' }] },
                  retention: { dropAfter: '3 months', scheduleInterval: '1 day' },
                  reorder: 'metrics_time_idx',
                }),
                'retune',
              ),
              Effect.all({
                dimensions: dimensionsOf('public', 'metrics'),
                retention: windowOf('metrics', 'policy_retention', 'drop_after', '3 months'),
                columnstore: columnstoreOf('metrics'),
                jobs: jobsOf('metrics'),
                rows: rowCount('public.metrics'),
              }),
            ),
        ),
        Then('the catalog shows two day chunks, three months retention, ascending order, a reorder job and all rows')((
          s,
          expect,
        ) =>
          expect({ ...s.seen, jobs: s.seen.jobs.map((job) => job.proc_name) }).toEqual({
            dimensions: [
              { column_name: 'time', dimension_type: 'Time', chunk: '2 days', num_partitions: null },
              { column_name: 'device_id', dimension_type: 'Space', chunk: null, num_partitions: 4 },
            ],
            retention: true,
            columnstore: [{ segmentby: 'device_id', orderby: '"time"' }],
            jobs: ['policy_compression', 'policy_reorder', 'policy_retention'],
            rows: [{ n: 3 }],
          })
        ),
      ),
    )

    scenario(
      'Taking columnstore and policies out of the declaration turns them off and keeps the rows',
      Gherkin.Do.pipe(
        Given('a hypertable with rows, one of them already in columnstore')('setup', () =>
          Effect.andThen(
            Effect.andThen(
              Effect.andThen(query(metricsTable), migrate(metricsExtras(full), 'hypertable')),
              query(recentRows),
            ),
            moveOldChunksToColumnstore('metrics', '2 days'),
          )),
        When('the declaration keeps only the time and space partitions and is migrated')('seen', () =>
          Effect.andThen(
            migrate(
              metricsExtras({
                timeColumn: metrics.time,
                chunkTimeInterval: '1 day',
                partitioningColumn: metrics.deviceId,
                numberPartitions: 4,
              }),
              'plain',
            ),
            Effect.all({
              hypertable: isHypertable('public', 'metrics'),
              jobs: jobsOf('metrics'),
              chunks: chunkStates('metrics'),
              rows: rowCount('public.metrics'),
            }),
          )),
        Then('it is still a hypertable with no jobs and no columnstore chunks, and every row is kept')((s, expect) =>
          expect(s.seen).toEqual({
            hypertable: true,
            jobs: [],
            chunks: [{ chunks: 2, columnstore: 0 }],
            rows: [{ n: 3 }],
          })
        ),
      ),
    )

    scenario(
      'Undoing a retune restores the earlier chunk interval and retention',
      Gherkin.Do.pipe(
        Given('a hypertable migrated twice, the second time with a longer chunk and shorter retention')(
          'setup',
          () => Effect.andThen(query(metricsTable), migrate(metricsExtras(full), 'hypertable')),
        ),
        When('the undo statements written for the second migration are run')('seen', () =>
          Effect.andThen(
            Effect.flatMap(
              generated(
                metricsExtras({ ...full, chunkTimeInterval: '2 days', retention: { dropAfter: '3 months' } }),
                'retune',
              ),
              (result) => Effect.andThen(migrated, runAll(result.down)),
            ),
            Effect.all({
              dimensions: dimensionsOf('public', 'metrics'),
              retention: windowOf('metrics', 'policy_retention', 'drop_after', '6 months'),
            }),
          )),
        Then('the hypertable has one day chunks and six months retention again')((s, expect) =>
          expect(s.seen).toEqual({
            dimensions: [
              { column_name: 'time', dimension_type: 'Time', chunk: '1 day', num_partitions: null },
              { column_name: 'device_id', dimension_type: 'Space', chunk: null, num_partitions: 4 },
            ],
            retention: true,
          })
        ),
      ),
    )

    scenario(
      'Undoing the first migration switches columnstore and policies off but keeps the hypertable, rows and extension',
      Gherkin.Do.pipe(
        Given('a hypertable with rows, one in columnstore, migrated once')(
          'setup',
          () =>
            Effect.andThen(
              query(metricsTable),
              Effect.tap(generated(metricsExtras(full), 'hypertable'), () => migrated),
            )
              .pipe(
                Effect.tap(() => query(recentRows)),
                Effect.tap(() => moveOldChunksToColumnstore('metrics', '2 days')),
              ),
        ),
        When('the undo statements of that migration are run')('seen', ({ setup }) =>
          Effect.andThen(
            runAll(setup.down),
            Effect.all({
              hypertable: isHypertable('public', 'metrics'),
              jobs: jobsOf('metrics'),
              columnstore: chunkStates('metrics'),
              rows: query('SELECT device_id, value FROM public.metrics ORDER BY value'),
              extension: query("SELECT extname FROM pg_extension WHERE extname = 'timescaledb'"),
            }),
          )),
        Then('the table is still a hypertable with no jobs and no columnstore, and every row and the extension remain')(
          (
            s,
            expect,
          ) =>
            expect(s.seen).toEqual({
              hypertable: true,
              jobs: [],
              columnstore: [{ chunks: 2, columnstore: 0 }],
              rows: [{ device_id: 'a', value: 1 }, { device_id: 'a', value: 2 }, { device_id: 'a', value: 3 }],
              extension: [{ extname: 'timescaledb' }],
            }),
        ),
      ),
    )

    scenario(
      'A table that already holds rows is refused unless the migration may move the data',
      Gherkin.Do.pipe(
        Given('a metrics table that already holds a row')(
          'setup',
          () => Effect.andThen(query(metricsTable), query("INSERT INTO public.metrics VALUES ('2024-06-01', 'a', 1)")),
        ),
        When('it is declared a hypertable without permission to move data and migrated')('seen', () =>
          Effect.all({
            refusal: refusalOf(
              migrate(metricsExtras({ timeColumn: metrics.time, chunkTimeInterval: '1 day' }), 'plain'),
            ),
            hypertable: isHypertable('public', 'metrics'),
            rows: rowCount('public.metrics'),
          })),
        Then('the migration fails on the conversion, and the table stays a plain table with its row')((s, expect) =>
          expect({ ...s.seen, refusal: /create_hypertable/.test(s.seen.refusal) }).toEqual({
            refusal: true,
            hypertable: false,
            rows: [{ n: 1 }],
          })
        ),
      ),
    )

    scenario(
      'A table that already holds rows becomes a hypertable when the declaration allows moving the data',
      Gherkin.Do.pipe(
        Given('a metrics table that already holds a row')(
          'setup',
          () => Effect.andThen(query(metricsTable), query("INSERT INTO public.metrics VALUES ('2024-06-01', 'a', 1)")),
        ),
        When('it is declared a hypertable that may move data and migrated')('seen', () =>
          Effect.andThen(
            migrate(metricsExtras({ timeColumn: metrics.time, chunkTimeInterval: '1 day', migrateData: true }), 'move'),
            Effect.all({ hypertable: isHypertable('public', 'metrics'), rows: rowCount('public.metrics') }),
          )),
        Then('the table is a hypertable and keeps its row')((s, expect) =>
          expect(s.seen).toEqual({ hypertable: true, rows: [{ n: 1 }] })
        ),
      ),
    )

    scenario(
      'The idempotent script can run twice and leaves one hypertable with one set of policies',
      Gherkin.Do.pipe(
        Given('an empty metrics table')('setup', () => query(metricsTable)),
        When('the idempotent script for the declaration is run twice')('seen', () => {
          const statements = splitMigrationSql(renderIdempotent(metricsExtras(full)))
          return Effect.andThen(
            Effect.andThen(runAll(statements), runAll(statements)),
            Effect.all({ hypertable: isHypertable('public', 'metrics'), jobs: jobsOf('metrics') }),
          )
        }),
        Then('there is one hypertable with one compression job and one retention job')((s, expect) =>
          expect(s.seen).toEqual({
            hypertable: true,
            jobs: [
              { proc_name: 'policy_compression', every: '12:00:00' },
              { proc_name: 'policy_retention', every: '1 day' },
            ],
          })
        ),
      ),
    )

    scenario(
      'Declarations exported from a schema module are collected and migrated',
      Gherkin.Do.pipe(
        Given('an empty metrics table')('setup', () => query(metricsTable)),
        When('the extension, the table and its hypertable are collected from a module and migrated')(
          'seen',
          () =>
            Effect.andThen(
              migrate(
                collectExtras({ timescale, metrics, declared: hypertable(metrics, { timeColumn: metrics.time }) }),
                'collected',
              ),
              isHypertable('public', 'metrics'),
            ),
        ),
        Then('the table is a hypertable')((s, expect) => expect({ hypertable: s.seen }).toEqual({ hypertable: true })),
      ),
    )

    scenario(
      'A hypertable in another schema is found by table or by name and its columns follow snake case',
      Gherkin.Do.pipe(
        Given('two tables in a market schema')('setup', () =>
          query(`CREATE SCHEMA market;
            CREATE TABLE market.readings (created_at timestamptz(3) NOT NULL, value integer NOT NULL);
            CREATE TABLE market.samples (taken_at timestamptz NOT NULL, value integer NOT NULL);`)),
        When('one is declared by its Drizzle table and one by schema and name, and both are migrated')('seen', () => {
          const market = pgSchema('market')
          const readings = market.table('readings', {
            createdAt: timestamp({ withTimezone: true, precision: 3 }).notNull(),
            value: integer().notNull(),
          })
          return Effect.andThen(
            Effect.andThen(
              generatedWithSnakeCase(
                defineExtras({
                  extensions: [timescale],
                  hypertables: [
                    hypertable(readings, { timeColumn: readings.createdAt, chunkTimeInterval: '1 hour' }),
                    hypertable({ name: 'samples', schema: 'market' }, {
                      timeColumn: 'taken_at',
                      chunkTimeInterval: '1 week',
                    }),
                  ],
                }),
                'market',
              ),
              migrated,
            ),
            Effect.all({ readings: dimensionsOf('market', 'readings'), samples: dimensionsOf('market', 'samples') }),
          )
        }),
        Then('each hypertable is partitioned by its own time column with the declared chunk interval')((s, expect) =>
          expect(s.seen).toEqual({
            readings: [{ column_name: 'created_at', dimension_type: 'Time', chunk: '01:00:00', num_partitions: null }],
            samples: [{ column_name: 'taken_at', dimension_type: 'Time', chunk: '7 days', num_partitions: null }],
          })
        ),
      ),
    )

    scenario(
      'Default indexes can be left out of a hypertable',
      Gherkin.Do.pipe(
        Given('two empty tables, one declared with default indexes and one without')(
          'setup',
          () =>
            query(`CREATE TABLE public.with_indexes (time timestamptz NOT NULL);
            CREATE TABLE public.without_indexes (time timestamptz NOT NULL);`),
        ),
        When('both are migrated as hypertables and their indexes are read')('seen', () =>
          Effect.andThen(
            migrate(
              defineExtras({
                extensions: [timescale],
                hypertables: [
                  hypertable({ name: 'with_indexes' }, { timeColumn: 'time' }),
                  hypertable({ name: 'without_indexes' }, { timeColumn: 'time', createDefaultIndexes: false }),
                ],
              }),
              'indexes',
            ),
            query(
              "SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('with_indexes', 'without_indexes') ORDER BY 1, 2",
            ),
          )),
        Then('only the table that kept the default has a time index')((s, expect) =>
          expect(s.seen).toEqual([{ tablename: 'with_indexes', indexname: 'with_indexes_time_idx' }])
        ),
      ),
    )

    scenario(
      'Policies can be scheduled by creation time with their own start and timezone',
      Gherkin.Do.pipe(
        Given('an empty metrics table')('setup', () => query(metricsTable)),
        When('a columnstore policy by creation time and a retention policy by creation time are migrated')(
          'seen',
          () =>
            Effect.andThen(
              migrate(
                metricsExtras({
                  timeColumn: metrics.time,
                  columnstore: {},
                  columnstorePolicy: {
                    createdBefore: '1 year',
                    scheduleInterval: '1 hour',
                    initialStart: '2030-02-01T00:00:00Z',
                    timezone: 'UTC',
                  },
                  retention: { dropCreatedBefore: '2 years' },
                }),
                'created_before',
              ),
              Effect.all({
                jobs: query(
                  `SELECT j.proc_name, j.schedule_interval::text AS every, j.initial_start IS NOT NULL AS started, b.timezone
                 FROM timescaledb_information.jobs j JOIN _timescaledb_config.bgw_job b ON b.id = j.job_id
                 WHERE j.hypertable_name = 'metrics' ORDER BY j.proc_name`,
                ),
                columnstorePolicy: windowOf('metrics', 'policy_compression', 'compress_created_before', '1 year'),
                retention: windowOf('metrics', 'policy_retention', 'drop_created_before', '2 years'),
              }),
            ),
        ),
        Then('the jobs carry the creation time windows, the hourly schedule and the timezone')((s, expect) =>
          expect(s.seen).toEqual({
            jobs: [
              { proc_name: 'policy_compression', every: '01:00:00', started: true, timezone: 'UTC' },
              { proc_name: 'policy_retention', every: '1 day', started: false, timezone: null },
            ],
            columnstorePolicy: true,
            retention: true,
          })
        ),
      ),
    )

    scenario(
      'Sparse indexes and a reorder policy are applied, changed and cleared',
      Gherkin.Do.pipe(
        Given('a hypertable with a bloom index, a minmax index and a reorder policy that is already migrated')(
          'setup',
          () =>
            Effect.andThen(
              query(metricsTable),
              migrate(
                metricsExtras({
                  timeColumn: metrics.time,
                  columnstore: {
                    segmentBy: [metrics.deviceId],
                    orderBy: [metrics.time],
                    sparseIndex: [
                      { type: 'bloom', columns: [metrics.value] },
                      { type: 'minmax', columns: [metrics.time] },
                    ],
                  },
                  reorder: 'metrics_time_idx',
                }),
                'sparse',
              ),
            ),
        ),
        When('the reorder policy moves to another index and the sparse indexes are cleared, and that is migrated')(
          'seen',
          () =>
            Effect.andThen(
              query('CREATE INDEX metrics_value_idx ON public.metrics (value, time DESC)'),
              Effect.andThen(
                migrate(
                  metricsExtras({
                    timeColumn: metrics.time,
                    columnstore: { segmentBy: [metrics.deviceId], orderBy: [metrics.time] },
                    reorder: 'metrics_value_idx',
                  }),
                  'cleared',
                ),
                Effect.all({
                  reorder: query(
                    `SELECT config->>'index_name' AS index_name FROM timescaledb_information.jobs
                     WHERE hypertable_name = 'metrics' AND proc_name = 'policy_reorder'`,
                  ),
                  sparse: query(
                    `SELECT count(*)::int AS n FROM _timescaledb_catalog.compression_settings
                     WHERE relid = 'public.metrics'::regclass AND index IS NOT NULL`,
                  ),
                }),
              ),
            ),
        ),
        Then('the reorder job points at the new index and no sparse index is left')((s, expect) =>
          expect(s.seen).toEqual({ reorder: [{ index_name: 'metrics_value_idx' }], sparse: [{ n: 0 }] })
        ),
      ),
    )

    scenario(
      'A hypertable can leave with its table and the extension is dropped',
      Gherkin.Do.pipe(
        Given('a hypertable that is already migrated and then dropped by hand')('setup', () =>
          Effect.andThen(
            Effect.andThen(query(metricsTable), migrate(metricsExtras(full), 'hypertable')),
            query('DROP TABLE public.metrics'),
          )),
        When('an empty declaration is migrated')('seen', () =>
          Effect.andThen(
            migrate(defineExtras({}), 'nothing'),
            query("SELECT extname FROM pg_extension WHERE extname = 'timescaledb'"),
          )),
        Then('the extension is gone')((s, expect) => expect(s.seen).toEqual([])),
      ),
    )

    scenario(
      'Hypertable declarations the server could not apply are refused with a reason',
      Gherkin.Do.pipe(
        Given('a metrics table that is declared in Drizzle with a composite key')('setup', () => Effect.void),
        When('declarations with a missing, wrong or incomplete key and column are attempted')('seen', () => {
          const loose = pgTable('loose', {
            time: timestamp('time', { withTimezone: true }),
            note: text('note').notNull(),
          })
          const keyed = pgTable('keyed', {
            id: integer('id').primaryKey(),
            time: timestamp('time', { withTimezone: true }).notNull(),
          })
          const logged = pgTable('logged', {
            time: timestamp('time', { withTimezone: true }).notNull(),
            deviceId: text('device_id').notNull(),
            email: text('email').notNull(),
          }, (t) => [
            primaryKey({ columns: [t.time, t.deviceId] }),
            uniqueIndex('logged_email_uidx').on(t.email),
          ])
          return Effect.all({
            nullable: declarationRefusal(() => hypertable(loose, { timeColumn: loose.time })),
            wrongType: declarationRefusal(() => hypertable(metrics, { timeColumn: metrics.value })),
            foreign: declarationRefusal(() => hypertable(metrics, { timeColumn: loose.time as never })),
            primaryKey: declarationRefusal(() => hypertable(keyed, { timeColumn: keyed.time })),
            unique: declarationRefusal(() =>
              hypertable(logged, { timeColumn: logged.time, partitioningColumn: logged.deviceId, numberPartitions: 2 })
            ),
            missingExtension: declarationRefusal(() =>
              generate({
                extras: defineExtras({ hypertables: [hypertable(metrics, { timeColumn: metrics.time })] }),
                out: '/nonexistent',
              })
            ),
          })
        }),
        Then('each is refused naming what is wrong')((s, expect) => {
          const patterns = {
            nullable: /NOT NULL/,
            wrongType: /integer/,
            foreign: /does not belong/,
            primaryKey: /hypertable key/,
            unique: /logged_email_uidx/,
            missingExtension: /pgExtension\("timescaledb"\)/,
          }
          return expect(matching(s.seen, patterns)).toEqual(refused(patterns))
        }),
      ),
    )

    scenario(
      'Intervals, space partitions and policies that TimescaleDB cannot apply are refused',
      Gherkin.Do.pipe(
        Given('the metrics table declared in Drizzle')('setup', () => Effect.void),
        When('invalid intervals, partitions, policies, directions and retention windows are attempted')(
          'seen',
          () =>
            Effect.all({
              injection: declarationRefusal(() =>
                hypertable(metrics, { timeColumn: metrics.time, chunkTimeInterval: "1 day'; drop table metrics" })
              ),
              zero: declarationRefusal(() =>
                hypertable(metrics, { timeColumn: metrics.time, chunkTimeInterval: '0 days' })
              ),
              lonelyColumn: declarationRefusal(() =>
                hypertable(metrics, { timeColumn: metrics.time, partitioningColumn: metrics.deviceId })
              ),
              noPartitions: declarationRefusal(() =>
                hypertable(metrics, { timeColumn: metrics.time, numberPartitions: 0 })
              ),
              sameColumn: declarationRefusal(() =>
                hypertable(metrics, { timeColumn: metrics.time, partitioningColumn: metrics.time, numberPartitions: 2 })
              ),
              policyWithoutColumnstore: declarationRefusal(() =>
                hypertable(metrics, { timeColumn: metrics.time, columnstorePolicy: { after: '7 days' } })
              ),
              direction: declarationRefusal(() =>
                hypertable(metrics, {
                  timeColumn: metrics.time,
                  columnstore: { orderBy: [{ column: metrics.time, direction: 'sideways' as 'asc' }] },
                })
              ),
              moveWithSpace: declarationRefusal(() =>
                hypertable(metrics, {
                  timeColumn: metrics.time,
                  partitioningColumn: metrics.deviceId,
                  numberPartitions: 2,
                  migrateData: true,
                })
              ),
              emptyRetention: declarationRefusal(() =>
                hypertable(metrics, { timeColumn: metrics.time, retention: {} })
              ),
              twoRetentionBounds: declarationRefusal(() =>
                hypertable(metrics, {
                  timeColumn: metrics.time,
                  retention: { dropAfter: '1 day', dropCreatedBefore: '1 year' },
                })
              ),
              emptyColumnstorePolicy: declarationRefusal(() =>
                hypertable(metrics, { timeColumn: metrics.time, columnstore: {}, columnstorePolicy: {} })
              ),
              twoColumnstoreBounds: declarationRefusal(() =>
                hypertable(metrics, {
                  timeColumn: metrics.time,
                  columnstore: {},
                  columnstorePolicy: { after: '1 day', createdBefore: '1 year' },
                })
              ),
            }),
        ),
        Then('each is refused naming what is wrong')((s, expect) => {
          const patterns = {
            injection: /interval/,
            zero: /greater than 0/,
            lonelyColumn: /together/,
            noPartitions: /together|integer/,
            sameColumn: /different column/,
            policyWithoutColumnstore: /columnstorePolicy requires columnstore/,
            direction: /direction/,
            moveWithSpace: /migrateData cannot be combined/,
            emptyRetention: /exactly one/,
            twoRetentionBounds: /exactly one/,
            emptyColumnstorePolicy: /exactly one/,
            twoColumnstoreBounds: /exactly one/,
          }
          return expect(matching(s.seen, patterns)).toEqual(refused(patterns))
        }),
      ),
    )

    scenario(
      'Sparse indexes that the server would reject are refused',
      Gherkin.Do.pipe(
        Given('the metrics table declared in Drizzle')('setup', () => Effect.void),
        When('sparse indexes on a segment column, on several columns, twice, or without a sort order are attempted')(
          'seen',
          () =>
            Effect.all({
              onSegment: declarationRefusal(() =>
                hypertable(metrics, {
                  timeColumn: metrics.time,
                  columnstore: {
                    segmentBy: [metrics.deviceId],
                    orderBy: [metrics.time],
                    sparseIndex: [{ type: 'bloom', columns: [metrics.deviceId] }],
                  },
                })
              ),
              onOrderColumn: declarationRefusal(() =>
                hypertable(metrics, {
                  timeColumn: metrics.time,
                  columnstore: { orderBy: [metrics.time], sparseIndex: [{ type: 'bloom', columns: [metrics.time] }] },
                })
              ),
              twice: declarationRefusal(() =>
                hypertable(metrics, {
                  timeColumn: metrics.time,
                  columnstore: {
                    orderBy: [metrics.time],
                    sparseIndex: [
                      { type: 'bloom', columns: [metrics.value] },
                      { type: 'bloom', columns: [metrics.value] },
                    ],
                  },
                })
              ),
              withoutOrder: declarationRefusal(() =>
                hypertable(metrics, {
                  timeColumn: metrics.time,
                  columnstore: { sparseIndex: [{ type: 'bloom', columns: [metrics.value] }] },
                })
              ),
            }),
        ),
        Then('each is refused naming what is wrong')((s, expect) => {
          const patterns = {
            onSegment: /segmentBy/,
            onOrderColumn: /single-column bloom/,
            twice: /more than one/,
            withoutOrder: /requires columnstore.orderBy/,
          }
          return expect(matching(s.seen, patterns)).toEqual(refused(patterns))
        }),
      ),
    )

    scenario(
      'Changes to a migrated hypertable that cannot be done in place are refused',
      Gherkin.Do.pipe(
        Given('a hypertable that is already migrated')(
          'setup',
          () => Effect.andThen(query(metricsTable), migrate(metricsExtras(full), 'hypertable')),
        ),
        When('the hypertable is dropped from the declaration, its chunk interval cleared or its keys changed')(
          'seen',
          () => {
            const other = pgTable('metrics', {
              createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
              deviceId: text('device_id').notNull(),
              value: integer('value').notNull(),
            }, (t) => [primaryKey({ columns: [t.createdAt, t.deviceId] })])
            return Effect.all({
              converted: refusalOf(generated(defineExtras({ extensions: [timescale], tables: [metrics] }), 'back')),
              cleared: refusalOf(generated(
                metricsExtras({ ...full, chunkTimeInterval: undefined }),
                'cleared',
              )),
              space: refusalOf(generated(metricsExtras({ ...full, numberPartitions: 8 }), 'space')),
              time: refusalOf(generated(
                defineExtras({
                  extensions: [timescale],
                  hypertables: [hypertable(other, {
                    timeColumn: other.createdAt,
                    chunkTimeInterval: '1 day',
                    partitioningColumn: other.deviceId,
                    numberPartitions: 4,
                  })],
                }),
                'time',
              )),
            })
          },
        ),
        Then('each change is refused before anything is written')((s, expect) => {
          const patterns = {
            converted: /will not convert a hypertable back/,
            cleared: /clearing chunkTimeInterval/,
            space: /space partition changed/,
            time: /time column changed/,
          }
          return expect(matching(s.seen, patterns)).toEqual(refused(patterns))
        }),
      ),
    )

    scenario(
      'Declaring one table twice, or as both a native partition and a hypertable, is refused',
      Gherkin.Do.pipe(
        Given('a metrics table declared in Drizzle')('setup', () => Effect.void),
        When('the table is declared twice as a hypertable and then as a hypertable and a partitioned table')(
          'seen',
          () =>
            Effect.all({
              twice: refusalOf(generated(
                defineExtras({
                  extensions: [timescale],
                  hypertables: [
                    hypertable(metrics, { timeColumn: metrics.time, chunkTimeInterval: '1 day' }),
                    hypertable(metrics, { timeColumn: metrics.time, chunkTimeInterval: '2 days' }),
                  ],
                }),
                'twice',
              )),
            }),
        ),
        Then('the second declaration is refused')((s, expect) =>
          expect(matching(s.seen, { twice: /declared more than once/ })).toEqual({ twice: 'refused' })
        ),
      ),
    )

    scenario(
      'A stack of aggregates is created parent first and answers from the raw rows',
      Gherkin.Do.pipe(
        Given('a hypertable of readings with three readings on one day')('setup', () =>
          Effect.andThen(
            Effect.andThen(
              query(metricsTable),
              migrate(
                defineExtras({ extensions: [timescale], tables: [metrics], hypertables: [metricsHypertable] }),
                'hypertable',
              ),
            ),
            query(readingsOfTheDay),
          )),
        When('an hourly aggregate, a daily one reading it and a comment are declared child first and migrated')(
          'seen',
          () =>
            Effect.andThen(
              migrate(aggregateExtras([dailyOf(undefined), hourlyOf()]), 'aggregates'),
              Effect.andThen(
                Effect.andThen(refreshDay('metrics_hourly'), refreshDay('metrics_daily')),
                Effect.all({
                  aggregates: aggregatesNamed(),
                  comment: query("SELECT obj_description('public.metrics_hourly'::regclass, 'pg_class') AS comment"),
                  hourly: query('SELECT bucket::text, value::int FROM public.metrics_hourly ORDER BY bucket'),
                  daily: query('SELECT bucket::text, value::int FROM public.metrics_daily'),
                }),
              ),
            ),
        ),
        Then('both aggregates exist and answer, and the hourly one carries its comment')((s, expect) =>
          expect(s.seen).toEqual({
            aggregates: [
              { view_name: 'metrics_daily', materialized_only: false },
              { view_name: 'metrics_hourly', materialized_only: false },
            ],
            comment: [{ comment: 'Hourly metrics' }],
            hourly: [{ bucket: '2024-01-01 10:00:00+00', value: 2 }, { bucket: '2024-01-01 14:00:00+00', value: 10 }],
            daily: [{ bucket: '2024-01-01 00:00:00+00', value: 10 }],
          })
        ),
      ),
    )

    scenario(
      'A child that reads its parent unquoted, schema qualified or joined to another table is still created after it',
      Gherkin.Do.pipe(
        Given('a hypertable of readings and a table of device names')('setup', () =>
          Effect.andThen(
            query(`${metricsTable}
              CREATE TABLE public.devices (device_id text PRIMARY KEY, label text NOT NULL);
              INSERT INTO public.devices VALUES ('a', 'north');`),
            migrate(
              defineExtras({ extensions: [timescale], tables: [metrics], hypertables: [metricsHypertable] }),
              'hypertable',
            ),
          )),
        When('daily aggregates reading the hourly one in three spellings are declared before it and migrated')(
          'seen',
          () =>
            Effect.andThen(
              migrate(
                aggregateExtras([
                  continuousAggregate('metrics_daily_quoted', { query: dailyBucket('"public"."metrics_hourly"') }),
                  continuousAggregate('metrics_daily_plain', { query: dailyBucket('public.metrics_hourly') }),
                  continuousAggregate('metrics_daily_joined', {
                    query: `SELECT time_bucket('1 day', h.bucket) AS bucket, d.label, max(h.value) AS value
FROM public.metrics_hourly h JOIN public.devices d ON d.device_id = h.device_id
GROUP BY time_bucket('1 day', h.bucket), d.label`,
                  }),
                  hourlyOf(),
                ]),
                'aggregates',
              ),
              aggregatesNamed(),
            ),
        ),
        Then('all four aggregates exist')((s, expect) =>
          expect(s.seen.map((row) => row.view_name)).toEqual([
            'metrics_daily_joined',
            'metrics_daily_plain',
            'metrics_daily_quoted',
            'metrics_hourly',
          ])
        ),
      ),
    )

    scenario(
      'Real time can be off, and the chunk interval and group indexes are declared',
      Gherkin.Do.pipe(
        Given('a hypertable with readings in the past')('setup', () =>
          Effect.andThen(
            Effect.andThen(
              query(metricsTable),
              migrate(
                defineExtras({ extensions: [timescale], tables: [metrics], hypertables: [metricsHypertable] }),
                'hypertable',
              ),
            ),
            query(readingsOfTheDay),
          )),
        When(
          'two aggregates over it, one with real time and one without, are migrated, refreshed and given a new reading',
        )(
          'seen',
          () =>
            Effect.andThen(
              migrate(
                aggregateExtras([
                  hourlyOf({ chunkInterval: '2 days' }),
                  continuousAggregate('metrics_frozen', {
                    query: hourlyBucket,
                    source: metricsHypertable,
                    realTime: false,
                    chunkInterval: '2 days',
                    createGroupIndexes: false,
                  }),
                ]),
                'aggregates',
              ),
              Effect.andThen(
                Effect.andThen(refreshDay('metrics_hourly'), refreshDay('metrics_frozen')),
                Effect.andThen(
                  query("INSERT INTO public.metrics VALUES ('2024-01-03 10:00Z', 'a', 7)"),
                  Effect.all({
                    modes: aggregatesNamed(),
                    live: query('SELECT count(*)::int AS n FROM public.metrics_hourly'),
                    frozen: query('SELECT count(*)::int AS n FROM public.metrics_frozen'),
                    chunk: query(
                      `SELECT view_name, d.time_interval::text AS chunk
                       FROM timescaledb_information.continuous_aggregates c
                       JOIN timescaledb_information.dimensions d
                         ON d.hypertable_name = c.materialization_hypertable_name
                       WHERE c.view_name IN ('metrics_hourly', 'metrics_frozen') ORDER BY view_name`,
                    ),
                    indexes: query(
                      `SELECT c.view_name, count(*)::int AS indexes
                       FROM timescaledb_information.continuous_aggregates c
                       JOIN pg_indexes i ON i.tablename = c.materialization_hypertable_name
                       WHERE c.view_name IN ('metrics_hourly', 'metrics_frozen') GROUP BY 1 ORDER BY 1`,
                    ),
                  }),
                ),
              ),
            ),
        ),
        Then(
          'only the real time aggregate shows the new reading, both use two day chunks, and only it has a group index besides the bucket index',
        )(
          (s, expect) =>
            expect({
              ...s.seen,
              indexes: s.seen.indexes.map((row) => [
                row.view_name,
                row.indexes,
              ]),
            }).toEqual({
              modes: [
                { view_name: 'metrics_frozen', materialized_only: true },
                { view_name: 'metrics_hourly', materialized_only: false },
              ],
              live: [{ n: 3 }],
              frozen: [{ n: 2 }],
              chunk: [
                { view_name: 'metrics_frozen', chunk: '2 days' },
                { view_name: 'metrics_hourly', chunk: '2 days' },
              ],
              indexes: [['metrics_frozen', 1], ['metrics_hourly', 2]],
            }),
        ),
      ),
    )

    scenario(
      'Real time and the chunk interval change in place without rebuilding the aggregate',
      Gherkin.Do.pipe(
        Given('a refreshed hourly aggregate that is already migrated')('setup', () =>
          Effect.andThen(
            Effect.andThen(
              Effect.andThen(
                query(metricsTable),
                migrate(
                  defineExtras({ extensions: [timescale], tables: [metrics], hypertables: [metricsHypertable] }),
                  'hypertable',
                ),
              ),
              query(readingsOfTheDay),
            ),
            Effect.andThen(
              migrate(aggregateExtras([hourlyOf({ chunkInterval: '1 hour' })]), 'aggregate'),
              refreshDay('metrics_hourly'),
            ),
          )),
        When('real time is turned off and the chunk interval is lengthened and migrated')('seen', () =>
          Effect.andThen(
            migrate(aggregateExtras([hourlyOf({ chunkInterval: '2 hours', realTime: false })]), 'alter'),
            Effect.all({
              modes: aggregatesNamed(),
              rows: query('SELECT count(*)::int AS n FROM public.metrics_hourly'),
              chunk: query(
                `SELECT d.time_interval::text AS chunk FROM timescaledb_information.continuous_aggregates c
                 JOIN timescaledb_information.dimensions d ON d.hypertable_name = c.materialization_hypertable_name
                 WHERE c.view_name = 'metrics_hourly'`,
              ),
            }),
          )),
        Then('the aggregate is materialized only with two hour chunks and still holds its refreshed rows')((
          s,
          expect,
        ) =>
          expect(s.seen).toEqual({
            modes: [{ view_name: 'metrics_hourly', materialized_only: true }],
            rows: [{ n: 2 }],
            chunk: [{ chunk: '02:00:00' }],
          })
        ),
      ),
    )

    scenario(
      'Changing an aggregate query rebuilds it and keeps its comment',
      Gherkin.Do.pipe(
        Given('a refreshed hourly aggregate averaging three readings, with a comment, that is already migrated')(
          'setup',
          () =>
            Effect.andThen(
              Effect.andThen(
                Effect.andThen(
                  query(metricsTable),
                  migrate(
                    defineExtras({ extensions: [timescale], tables: [metrics], hypertables: [metricsHypertable] }),
                    'hypertable',
                  ),
                ),
                query(readingsOfTheDay),
              ),
              Effect.andThen(migrate(aggregateExtras([hourlyOf()]), 'aggregate'), refreshDay('metrics_hourly')),
            ),
        ),
        When('the query takes the maximum instead of the average and is migrated and refreshed')(
          'seen',
          () =>
            Effect.andThen(
              migrate(
                aggregateExtras([hourlyOf({ query: hourlyBucket.replace('avg(value)', 'max(value)') })]),
                'rebuild',
              ),
              Effect.all({
                refreshed: Effect.andThen(
                  refreshDay('metrics_hourly'),
                  query('SELECT value::int FROM public.metrics_hourly ORDER BY bucket'),
                ),
                comment: query("SELECT obj_description('public.metrics_hourly'::regclass, 'pg_class') AS comment"),
              }),
            ),
        ),
        Then('the rebuilt aggregate answers with the maxima and still carries its comment')((s, expect) =>
          expect(s.seen).toEqual({
            refreshed: [{ value: 3 }, { value: 10 }],
            comment: [{ comment: 'Hourly metrics' }],
          })
        ),
      ),
    )

    scenario(
      'Refresh policies, columnstore and retention are added to an aggregate',
      Gherkin.Do.pipe(
        Given('a hypertable of readings that is already migrated')('setup', () =>
          Effect.andThen(
            query(metricsTable),
            migrate(
              defineExtras({ extensions: [timescale], tables: [metrics], hypertables: [metricsHypertable] }),
              'hypertable',
            ),
          )),
        When(
          'an hourly aggregate with two refresh windows, columnstore, a columnstore policy and retention is migrated',
        )(
          'seen',
          () =>
            Effect.andThen(
              migrate(
                aggregateExtras([hourlyOf({
                  refreshPolicies: [
                    { startOffset: '1 month', endOffset: '1 day', scheduleInterval: '1 day' },
                    { startOffset: '1 day', endOffset: '1 hour', scheduleInterval: '1 hour' },
                  ],
                  columnstore: {
                    segmentBy: ['device_id'],
                    orderBy: [{ column: 'bucket', direction: 'desc', nulls: 'last' }],
                  },
                  columnstorePolicy: { after: '7 days', scheduleInterval: '1 hour' },
                  retention: { dropAfter: '6 months' },
                })]),
                'aggregate',
              ),
              Effect.all({ jobs: aggregateJobs(), columnstore: aggregateColumnstore() }),
            ),
        ),
        Then(
          'there are two refresh jobs, a compression job on the hour and a retention job, and the columnstore is set',
        )((
          s,
          expect,
        ) =>
          expect(s.seen).toEqual({
            jobs: [
              { proc_name: 'policy_compression', every: '01:00:00' },
              { proc_name: 'policy_refresh_continuous_aggregate', every: '01:00:00' },
              { proc_name: 'policy_refresh_continuous_aggregate', every: '1 day' },
              { proc_name: 'policy_retention', every: '1 day' },
            ],
            columnstore: [{ segmentby: 'device_id', orderby: 'bucket DESC NULLS LAST' }],
          })
        ),
      ),
    )

    scenario(
      'A changed refresh window replaces the policy without rebuilding the aggregate',
      Gherkin.Do.pipe(
        Given('an hourly aggregate with a one month refresh window that is already migrated')(
          'setup',
          () =>
            Effect.andThen(
              Effect.andThen(
                query(metricsTable),
                migrate(
                  defineExtras({ extensions: [timescale], tables: [metrics], hypertables: [metricsHypertable] }),
                  'hypertable',
                ),
              ),
              migrate(
                aggregateExtras([hourlyOf({
                  refreshPolicies: [{ startOffset: '1 month', endOffset: '1 hour', scheduleInterval: '1 hour' }],
                })]),
                'aggregate',
              ),
            ),
        ),
        When('the window becomes two months refreshed every two hours and is migrated')('seen', () =>
          Effect.andThen(
            migrate(
              aggregateExtras([hourlyOf({
                refreshPolicies: [{ startOffset: '2 months', endOffset: '1 hour', scheduleInterval: '2 hours' }],
              })]),
              'window',
            ),
            Effect.all({
              jobs: aggregateJobs(),
              window: Effect.map(
                query(
                  `SELECT (j.config->>'start_offset')::interval = INTERVAL '2 months' AS ok
                   FROM timescaledb_information.jobs j
                   WHERE j.hypertable_schema = 'public' AND j.hypertable_name = 'metrics_hourly'
                     AND j.proc_name = 'policy_refresh_continuous_aggregate'`,
                ),
                (rows) => rows[0]?.ok === true,
              ),
              aggregates: aggregatesNamed(),
            }),
          )),
        Then('one refresh job runs every two hours over two months and the aggregate is the same one')((s, expect) =>
          expect(s.seen).toEqual({
            jobs: [{ proc_name: 'policy_refresh_continuous_aggregate', every: '02:00:00' }],
            window: true,
            aggregates: [{ view_name: 'metrics_hourly', materialized_only: false }],
          })
        ),
      ),
    )

    scenario(
      'Declaring the same refresh windows in another order changes nothing',
      Gherkin.Do.pipe(
        Given('an hourly aggregate with two refresh windows that is already migrated')('setup', () =>
          Effect.andThen(
            Effect.andThen(
              query(metricsTable),
              migrate(
                defineExtras({ extensions: [timescale], tables: [metrics], hypertables: [metricsHypertable] }),
                'hypertable',
              ),
            ),
            migrate(aggregateExtras([hourlyOf({ refreshPolicies: windows })]), 'aggregate'),
          )),
        When('the same two windows are declared in the opposite order and generated')('seen', () =>
          Effect.map(
            generated(aggregateExtras([hourlyOf({ refreshPolicies: [...windows].reverse() })]), 'reordered'),
            (result) => result.written,
          )),
        Then('no migration is written')((s, expect) => expect({ written: s.seen }).toEqual({ written: false })),
      ),
    )

    scenario(
      'Dropping a stack of aggregates and undoing it remove the child before the parent',
      Gherkin.Do.pipe(
        Given('a daily aggregate over an hourly one that is already migrated')('setup', () =>
          Effect.andThen(
            Effect.andThen(
              query(metricsTable),
              migrate(
                defineExtras({ extensions: [timescale], tables: [metrics], hypertables: [metricsHypertable] }),
                'hypertable',
              ),
            ),
            (() => {
              const hourly = hourlyOf()
              return migrate(aggregateExtras([hourly, dailyOf(hourly)]), 'aggregates')
            })(),
          )),
        When('both aggregates are removed from the declaration and migrated')(
          'seen',
          () => Effect.andThen(migrate(aggregateExtras([]), 'removed'), aggregatesNamed()),
        ),
        Then('neither aggregate is left')((s, expect) => expect({ aggregates: s.seen }).toEqual({ aggregates: [] })),
      ),
    )

    scenario(
      'Undoing the creation of a stack of aggregates drops the child before the parent',
      Gherkin.Do.pipe(
        Given('a hypertable of readings that is already migrated')('setup', () =>
          Effect.andThen(
            query(metricsTable),
            migrate(
              defineExtras({ extensions: [timescale], tables: [metrics], hypertables: [metricsHypertable] }),
              'hypertable',
            ),
          )),
        When('a daily aggregate over an hourly one is migrated and then its undo statements are run')('seen', () => {
          const hourly = hourlyOf()
          return Effect.andThen(
            Effect.flatMap(
              generated(aggregateExtras([hourly, dailyOf(hourly)]), 'aggregates'),
              (result) => Effect.andThen(migrated, runAll(result.down)),
            ),
            aggregatesNamed(),
          )
        }),
        Then('neither aggregate is left')((s, expect) => expect({ aggregates: s.seen }).toEqual({ aggregates: [] })),
      ),
    )

    scenario(
      'A parent aggregate cannot change while a declared child reads it',
      Gherkin.Do.pipe(
        Given('a daily aggregate over an hourly one that is already migrated')('setup', () =>
          Effect.andThen(
            Effect.andThen(
              query(metricsTable),
              migrate(
                defineExtras({ extensions: [timescale], tables: [metrics], hypertables: [metricsHypertable] }),
                'hypertable',
              ),
            ),
            (() => {
              const hourly = hourlyOf()
              return migrate(aggregateExtras([hourly, dailyOf(hourly)]), 'aggregates')
            })(),
          )),
        When('the hourly query changes while the daily aggregate stays declared and that is generated')('seen', () => {
          const hourly = hourlyOf({ query: hourlyBucket.replace('avg(value)', 'max(value)') })
          return Effect.all({
            parent: refusalOf(generated(aggregateExtras([hourly, dailyOf(hourly)]), 'parent')),
          })
        }),
        Then('the change is refused because a child aggregate reads it')((s, expect) =>
          expect(matching(s.seen, { parent: /sources an aggregate whose definition changed/ })).toEqual({
            parent: 'refused',
          })
        ),
      ),
    )

    scenario(
      'Removing an aggregate together with its source table is refused',
      Gherkin.Do.pipe(
        Given('an hourly aggregate that is already migrated')('setup', () =>
          Effect.andThen(
            Effect.andThen(
              query(metricsTable),
              migrate(
                defineExtras({ extensions: [timescale], tables: [metrics], hypertables: [metricsHypertable] }),
                'hypertable',
              ),
            ),
            migrate(aggregateExtras([hourlyOf()]), 'aggregate'),
          )),
        When('the aggregate, its hypertable and its table are all removed from the declaration and generated')(
          'seen',
          () => Effect.all({ removed: refusalOf(generated(defineExtras({}), 'removed')) }),
        ),
        Then('the removal is refused')((s, expect) =>
          expect(matching(s.seen, { removed: /removed in one change/ })).toEqual({ removed: 'refused' })
        ),
      ),
    )

    scenario(
      'Aggregate declarations the server could not apply are refused with a reason',
      Gherkin.Do.pipe(
        Given('a hypertable of readings declared in Drizzle')('setup', () => Effect.void),
        When('duplicate windows, unsupported policy bounds, an empty query and a wrong source are attempted')(
          'seen',
          () =>
            Effect.all({
              duplicateWindow: declarationRefusal(() =>
                continuousAggregate('metrics_hourly', {
                  query: 'SELECT 1',
                  source: metricsHypertable,
                  refreshPolicies: [
                    { startOffset: '1 month', endOffset: '1 hour', scheduleInterval: '1 hour' },
                    { startOffset: '1 month', endOffset: '1 hour', scheduleInterval: '2 hours' },
                  ],
                })
              ),
              columnstoreBound: declarationRefusal(() =>
                continuousAggregate('metrics_hourly', {
                  query: 'SELECT 1',
                  source: metricsHypertable,
                  columnstore: {},
                  columnstorePolicy: { after: '1 day', createdBefore: '1 year' } as never,
                })
              ),
              retentionBound: declarationRefusal(() =>
                continuousAggregate('metrics_hourly', {
                  query: 'SELECT 1',
                  source: metricsHypertable,
                  retention: { dropAfter: '1 day', dropCreatedBefore: '1 year' } as never,
                })
              ),
              policyWithoutColumnstore: declarationRefusal(() =>
                continuousAggregate('metrics_hourly', {
                  query: 'SELECT 1',
                  source: metricsHypertable,
                  columnstorePolicy: { after: '1 day' },
                })
              ),
              emptyQuery: declarationRefusal(() =>
                continuousAggregate('bad', { query: ' ', source: metricsHypertable })
              ),
              tableSource: declarationRefusal(() =>
                continuousAggregate('bad', { query: 'SELECT 1', source: metrics as never })
              ),
              materializedView: declarationRefusal(() =>
                continuousAggregate(pgMaterializedView('bad', { value: integer() }).as(sql`select 1`), {
                  query: 'SELECT 1',
                  source: metricsHypertable,
                })
              ),
            }),
        ),
        Then('each is refused naming what is wrong')((s, expect) => {
          const patterns = {
            duplicateWindow: /declared more than once/,
            columnstoreBound: /createdBefore is not supported/,
            retentionBound: /dropCreatedBefore is not supported/,
            policyWithoutColumnstore: /requires columnstore/,
            emptyQuery: /query is empty/,
            tableSource: /source must be/,
            materializedView: /existing/,
          }
          return expect(matching(s.seen, patterns)).toEqual(refused(patterns))
        }),
      ),
    )
  })
