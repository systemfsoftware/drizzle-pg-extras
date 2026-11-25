import { Gherkin, Given, it, makeFeature, Then } from '@systemfsoftware/effect-gherkin-spec'
import {
  filterWhere,
  first,
  generateTimestampSeries,
  last,
  PgExtrasError,
  timeBucket,
  timeInterval,
} from '@systemfsoftware/timescale-drizzle'
import { integer, PgDialect, pgTable, timestamp } from 'drizzle-orm/pg-core'
import { Effect, Layer } from 'effect'

const Feature = makeFeature({ it })

const dialect = new PgDialect()

const render = (fragment: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(fragment)

const metrics = pgTable('metrics', {
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
  value: integer('value').notNull(),
})

const caughtRefusal = (run: () => unknown): Effect.Effect<Error, never, never> =>
  Effect.suspend(() => {
    try {
      run()
      return Effect.die(new Error('expected the call to be refused, but it was accepted'))
    } catch (cause) {
      return Effect.succeed(cause instanceof Error ? cause : new Error(String(cause)))
    }
  })

const refusal = (error: Error) => ({ message: error.message, isPgExtrasError: error instanceof PgExtrasError })

Feature('Structured Timescale query builders render through the pinned Postgres dialect')
  .withScenarioLayer(Layer.empty)
  .body(({ scenario, scenarioOutline }) => {
    scenario(
      'A five-minute bucket over a timestamptz column renders without an origin',
      Gherkin.Do.pipe(
        Given('a five-minute bucket over the recorded_at column')(
          'query',
          () => Effect.succeed(render(timeBucket(timeInterval(5, 'minute'), metrics.recordedAt))),
        ),
        Then('the rendered query is a time_bucket call with no bind parameters')((scope, expect) =>
          expect({ sql: scope.query.sql, params: scope.query.params }).toEqual({
            sql: 'time_bucket(interval \'5 minute\', "metrics"."recorded_at")',
            params: [],
          })
        ),
      ),
    )

    scenario(
      'A one-hour bucket with a structured origin renders the origin as a timestamp literal',
      Gherkin.Do.pipe(
        Given('a one-hour bucket with a fixed origin')('query', () =>
          Effect.succeed(
            render(
              timeBucket(timeInterval(1, 'hour'), metrics.recordedAt, {
                origin: new Date('2024-03-01T00:00:00.000Z'),
              }),
            ),
          )),
        Then('the rendered query inlines the origin as a timestamp literal')((scope, expect) =>
          expect({ sql: scope.query.sql, params: scope.query.params }).toEqual({
            sql: 'time_bucket(interval \'1 hour\', "metrics"."recorded_at", \'2024-03-01T00:00:00.000Z\')',
            params: [],
          })
        ),
      ),
    )

    scenario(
      'First and last pick the value ordered by a timestamptz column',
      Gherkin.Do.pipe(
        Given('a first aggregate and a last aggregate over the metrics table')('aggregates', () =>
          Effect.succeed({
            first: render(first(metrics.value, metrics.recordedAt)),
            last: render(last(metrics.value, metrics.recordedAt)),
          })),
        Then('each aggregate renders its value and ordering column as quoted identifiers')((scope, expect) =>
          expect({
            first: { sql: scope.aggregates.first.sql, params: scope.aggregates.first.params },
            last: { sql: scope.aggregates.last.sql, params: scope.aggregates.last.params },
          }).toEqual({
            first: { sql: 'first("metrics"."value", "metrics"."recorded_at")', params: [] },
            last: { sql: 'last("metrics"."value", "metrics"."recorded_at")', params: [] },
          })
        ),
      ),
    )

    scenario(
      'A first aggregate filtered by a condition appends a FILTER clause',
      Gherkin.Do.pipe(
        Given('a first aggregate filtered to rows ordered by recorded_at')(
          'query',
          () => Effect.succeed(render(filterWhere(first(metrics.value, metrics.recordedAt), metrics.recordedAt))),
        ),
        Then('the rendered query appends the filter to the aggregate')((scope, expect) =>
          expect({ sql: scope.query.sql, params: scope.query.params }).toEqual({
            sql: 'first("metrics"."value", "metrics"."recorded_at") FILTER (WHERE "metrics"."recorded_at")',
            params: [],
          })
        ),
      ),
    )

    scenario(
      'A generated timestamp series exposes a lateral source and a qualified value column',
      Gherkin.Do.pipe(
        Given('a timestamp series aliased as bucket')('series', () =>
          Effect.succeed(
            (() => {
              const series = generateTimestampSeries(
                {
                  start: new Date('2024-01-01T00:00:00.000Z'),
                  stop: new Date('2024-01-02T00:00:00.000Z'),
                  step: timeInterval(30, 'minute'),
                },
                'bucket',
              )
              return { source: render(series.source), value: render(series.value) }
            })(),
          )),
        Then('the source is a generate_series lateral and the value is the qualified bucket column')((scope, expect) =>
          expect({
            source: { sql: scope.series.source.sql, params: scope.series.source.params },
            value: { sql: scope.series.value.sql, params: scope.series.value.params },
          }).toEqual({
            source: {
              sql:
                "generate_series('2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z', interval '30 minute') as \"bucket\"(\"value\")",
              params: [],
            },
            value: { sql: '"bucket"."value"', params: [] },
          })
        ),
      ),
    )

    scenario(
      'An interval input that is not a positive whole number is refused',
      Gherkin.Do.pipe(
        Given('the value is passed to timeInterval')('error', () => caughtRefusal(() => timeInterval(2.5, 'minute'))),
        Then('the refusal names the value it rejected')((scope, expect) =>
          expect(refusal(scope.error)).toEqual({
            message: 'interval value must be a positive whole number, got 2.5',
            isPgExtrasError: true,
          })
        ),
      ),
    )

    scenarioOutline(
      'An unsafe or exponent-notation interval value never reaches SQL',
      [
        { value: Number.MAX_SAFE_INTEGER + 1, printed: '9007199254740992' },
        { value: 1e21, printed: '1e+21' },
        { value: 5e-1, printed: '0.5' },
      ],
      ({ value, printed }) =>
        Gherkin.Do.pipe(
          Given('the value is passed to timeInterval')(
            'error',
            () => caughtRefusal(() => timeInterval(value, 'minute')),
          ),
          Then('the value is refused before any SQL is built')((scope, expect) =>
            expect(refusal(scope.error)).toEqual({
              message: `interval value must be a positive whole number, got ${printed}`,
              isPgExtrasError: true,
            })
          ),
        ),
    )

    scenario(
      'A timeBucket call with a fractional interval refuses with its call site',
      Gherkin.Do.pipe(
        Given('a fractional interval is passed to timeBucket')(
          'error',
          () => caughtRefusal(() => timeBucket({ value: 1.5, unit: 'minute' }, metrics.recordedAt)),
        ),
        Then('the refusal names the timeBucket call site')((scope, expect) =>
          expect(refusal(scope.error)).toEqual({
            message: 'timeBucket(): interval value must be a positive whole number, got 1.5',
            isPgExtrasError: true,
          })
        ),
      ),
    )

    scenario(
      'A generated timestamp series with a zero-length step refuses with its call site',
      Gherkin.Do.pipe(
        Given('a zero-length step is passed to generateTimestampSeries')(
          'error',
          () =>
            caughtRefusal(() =>
              generateTimestampSeries(
                {
                  start: new Date('2024-01-01T00:00:00.000Z'),
                  stop: new Date('2024-01-02T00:00:00.000Z'),
                  step: { value: 0, unit: 'second' },
                },
                'bucket',
              )
            ),
        ),
        Then('the refusal names the generateTimestampSeries call site')((scope, expect) =>
          expect(refusal(scope.error)).toEqual({
            message: 'generateTimestampSeries(): interval value must be a positive whole number, got 0',
            isPgExtrasError: true,
          })
        ),
      ),
    )
  })
