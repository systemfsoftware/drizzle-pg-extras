import { Gherkin, Given, it, makeFeature, Then, When } from '@systemfsoftware/effect-gherkin-spec'
import {
  collectExtras,
  hypertable,
  pgExtension,
  renderIdempotent,
  timescaleServer,
  timescaleServerDrift,
} from '@systemfsoftware/timescale-drizzle'
import { integer, pgTable, timestamp } from 'drizzle-orm/pg-core'
import { Effect, Layer } from 'effect'

const Feature = makeFeature({ it })

const readings = pgTable('readings', {
  time: timestamp('time', { withTimezone: true }).notNull(),
  value: integer('value').notNull(),
})

const withPolicies = hypertable(readings, {
  timeColumn: readings.time,
  retention: { dropAfter: '30 days' },
})

const refusal = (render: () => unknown) =>
  Effect.sync(() => {
    try {
      render()
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })

const workerSlots = (args: readonly string[]) =>
  Object.fromEntries(
    args.filter((arg) => arg !== '-c').map((arg) => arg.split('=') as [string, string]).map((
      [name, value],
    ) => [name, value]),
  )

Feature("Declaring the server settings a schema's TimescaleDB jobs need")
  .withLayer(Layer.empty)
  .body(({ scenario }) => {
    scenario(
      'Every TimescaleDB worker the declaration allows has a Postgres worker slot',
      Gherkin.Do.pipe(
        Given('a server for two databases running six jobs at once with two parallel workers')(
          'server',
          () => Effect.succeed(timescaleServer({ databasesWithExtension: 2, concurrentJobs: 6, parallelWorkers: 2 })),
        ),
        When('its command-line settings are read back')(
          'slots',
          (s) => Effect.succeed(workerSlots(s.server.postgresArgs)),
        ),
        Then("the worker pool covers the launcher, the schedulers, the jobs, the parallel workers and Postgres's own")(
          (s, expect) =>
            expect({
              timescaleCoversSchedulersAndJobs: Number(s.slots['timescaledb.max_background_workers']) >= 2 + 6,
              poolCoversEveryWorker: Number(s.slots['max_worker_processes']) >=
                1 + Number(s.slots['timescaledb.max_background_workers']) +
                  Number(s.slots['max_parallel_workers']) + 4,
            }).toEqual({ timescaleCoversSchedulersAndJobs: true, poolCoversEveryWorker: true }),
        ),
      ),
    )

    scenario(
      'A schema whose server runs no job at once is refused before any migration is written',
      Gherkin.Do.pipe(
        Given('a hypertable with a retention policy and a server allowing no concurrent job')(
          'extras',
          () =>
            Effect.succeed(collectExtras({
              timescale: pgExtension('timescaledb'),
              readings,
              withPolicies,
              server: timescaleServer({ databasesWithExtension: 1, concurrentJobs: 0 }),
            })),
        ),
        When('its migration SQL is rendered')('refused', (s) => refusal(() => renderIdempotent(s.extras))),
        Then('rendering is refused and says the jobs cannot start')((s, expect) =>
          expect(s.refused).toContain('allows 0 concurrent jobs')
        ),
      ),
    )

    scenario(
      'A server preloading without TimescaleDB is refused when declared',
      Gherkin.Do.pipe(
        Given('a preload list naming only pg_stat_statements')('preload', () => Effect.succeed(['pg_stat_statements'])),
        When('a server is declared with it')(
          'refused',
          (s) =>
            refusal(() =>
              timescaleServer({ databasesWithExtension: 1, concurrentJobs: 4, preloadLibraries: s.preload })
            ),
        ),
        Then('the declaration is refused')((s, expect) => expect(s.refused).toContain('must include timescaledb')),
      ),
    )

    scenario(
      'A live server is compared against the declaration',
      Gherkin.Do.pipe(
        Given('a declared server')(
          'server',
          () => Effect.succeed(timescaleServer({ databasesWithExtension: 2, concurrentJobs: 8 })),
        ),
        When(
          'the live server runs the default pool, has a pending restart on the TimescaleDB budget and lists its preload libraries with spaces',
        )(
          'drift',
          (s) =>
            Effect.succeed(timescaleServerDrift(
              s.server,
              Object.entries(s.server.settings).map(([name, setting]) => {
                if (name === 'max_worker_processes') return { name, setting: '8', pending_restart: false }
                if (name === 'timescaledb.max_background_workers') return { name, setting, pending_restart: true }
                if (name === 'shared_preload_libraries') {
                  return { name, setting: setting.split(',').join(', '), pending_restart: false }
                }
                return { name, setting, pending_restart: false }
              }),
            )),
        ),
        Then('both settings are reported and nothing else')((s, expect) =>
          expect(s.drift.map((line) => line.split(':')[0])).toEqual([
            'timescaledb.max_background_workers',
            'max_worker_processes',
          ])
        ),
      ),
    )
  })
