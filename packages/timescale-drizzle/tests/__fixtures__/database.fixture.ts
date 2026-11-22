import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { layer as nodeServicesLayer } from '@effect/platform-node/NodeServices'
import { MicroVM } from '@systemfsoftware/effect-microsandbox'
import { Readiness } from '@systemfsoftware/effect-readiness'
import { generate, type GenerateResult, type PgExtras } from '@systemfsoftware/timescale-drizzle'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Context, Data, Duration, Effect, Layer, Schedule, Schema } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { integresqlBinary } from './integresql-binary.js'

export class DatabaseFailed
  extends Data.TaggedError('DatabaseFailed')<{ readonly step: string; readonly cause: unknown }>
{
  override get message(): string {
    return `${this.step}: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`
  }
}

const POSTGRES = {
  image:
    'mirror.gcr.io/library/postgres:17-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536',
  binaries: '/usr/lib/postgresql/17/bin',
  settings: '',
}

const TIMESCALE = {
  image: 'timescale/timescaledb-ha:pg17@sha256:d6405a7b770db48fe8ae32aa7a1765077b698d5ae916b775e0d3820580e4baad',
  binaries: '/usr/lib/postgresql/17/bin',
  // No background workers: IntegreSQL copies and drops databases only while nothing is connected to them,
  // and a TimescaleDB scheduler connects to every database. Scenarios refresh and read jobs themselves.
  settings:
    '-c shared_preload_libraries=timescaledb -c timescaledb.telemetry_level=off -c timescaledb.max_background_workers=0',
}

const POSTGRES_PORT = 5432
const INTEGRESQL_PORT = 5000
const TEMPLATE = 'empty'
const GUEST = '/opt/database-server'
const RAM = '/dev/shm/database-server'
const READY = 'database server ready'
const FAILED = 'database server failed'
const STATUS = `${RAM}/boot-status`

const bootScript = (binaries: string, settings: string) =>
  `#!/bin/bash
set -eu
trap 'code=$?; [ "$code" -eq 0 ] || { [ -e ${STATUS} ] || printf "boot.sh exited with status %s" "$code" > ${STATUS} || true; echo "${FAILED}"; }' EXIT
mkdir -p ${RAM}
if [ "$(id -u)" -eq 0 ]; then chown postgres ${RAM}; as() { gosu postgres "$@"; }; else as() { "$@"; }; fi
as ${binaries}/initdb --no-sync --encoding=UTF8 --locale=C.UTF-8 --username=postgres --auth=trust -D ${RAM}/data > ${RAM}/initdb.log 2>&1
echo 'host all all 0.0.0.0/0 trust' >> ${RAM}/data/pg_hba.conf
as ${binaries}/pg_ctl -D ${RAM}/data -l ${RAM}/postgres.log -w -t 60 -o "-c listen_addresses=* -c port=${POSTGRES_PORT} -c max_connections=200 -c fsync=off -c synchronous_commit=off -c full_page_writes=off ${settings}" start
cp ${GUEST}/integresql /tmp/integresql
chmod +x /tmp/integresql
INTEGRESQL_PORT=${INTEGRESQL_PORT} INTEGRESQL_PGHOST=127.0.0.1 INTEGRESQL_PGPORT=${POSTGRES_PORT} INTEGRESQL_PGUSER=postgres \\
  INTEGRESQL_TEST_INITIAL_POOL_SIZE=2 INTEGRESQL_TEST_MAX_POOL_SIZE=8 /tmp/integresql > ${RAM}/integresql.log 2>&1 &
server=$!
until ( exec 3<>/dev/tcp/127.0.0.1/${INTEGRESQL_PORT} ) 2>/dev/null; do
  kill -0 "$server" || { printf 'integresql exited' > ${STATUS}; exit 1; }
  sleep 0.2
done
printf 'ready' > ${STATUS}
echo '${READY}'
wait "$server"
`

const guestFile = (vm: MicroVM.RunningVM, file: string) =>
  MicroVM.exec(vm, 'cat', [file]).pipe(Effect.map(({ stdout, stderr }) => `${stdout}${stderr}`))

const booted = (vm: MicroVM.RunningVM) =>
  Effect.gen(function*() {
    const status = yield* guestFile(vm, STATUS)
    if (status === 'ready') return
    const logs = yield* Effect.all([
      guestFile(vm, `${RAM}/initdb.log`),
      guestFile(vm, `${RAM}/postgres.log`),
      guestFile(vm, `${RAM}/integresql.log`),
    ])
    return yield* new DatabaseFailed({ step: 'boot the database server', cause: `${status}\n${logs.join('\n')}` })
  })

export class Server extends Context.Service<Server, {
  readonly integresqlPort: number
  readonly postgresPort: number
}>()('timescale-drizzle/tests/Server') {}

const TestDatabase = Schema.Struct({
  id: Schema.Int,
  database: Schema.Struct({ config: Schema.Struct({ database: Schema.String }) }),
})

const templates = (port: number) => `http://127.0.0.1:${port}/api/v1/templates`

const server = (flavour: typeof POSTGRES) =>
  Layer.effect(Server)(
    Effect.gen(function*() {
      const binary = yield* integresqlBinary
      const vm = yield* MicroVM.spec(flavour.image)
        .withFiles({
          [`${GUEST}/boot.sh`]: bootScript(flavour.binaries, flavour.settings),
          [`${GUEST}/integresql`]: binary,
        })
        .withCommand(['bash', `${GUEST}/boot.sh`])
        .withMemoryLimit(2048)
        .withExposedPorts([INTEGRESQL_PORT, POSTGRES_PORT])
        .withWaitStrategy(MicroVM.Wait.forLog(`${READY}|${FAILED}`))
        .scoped
      yield* booted(vm)
      const integresqlPort = yield* MicroVM.port(vm, INTEGRESQL_PORT)
      const postgresPort = yield* MicroVM.port(vm, POSTGRES_PORT)
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
      yield* client.execute(
        HttpClientRequest.post(templates(integresqlPort)).pipe(
          HttpClientRequest.bodyJsonUnsafe({ hash: TEMPLATE }),
        ),
      )
      yield* client.execute(HttpClientRequest.put(`${templates(integresqlPort)}/${TEMPLATE}`))
      return { integresqlPort, postgresPort }
    }),
  ).pipe(
    Layer.provide(Layer.mergeAll(
      nodeServicesLayer,
      NodeCrypto.layerSecureRandom,
      Readiness.NodeHostProber.layer,
      FetchHttpClient.layer,
    )),
    Layer.orDie,
  )

export const postgresServer = server(POSTGRES)
export const timescaleServer = server(TIMESCALE)

export class Database extends Context.Service<Database, {
  readonly url: string
  readonly out: string
  readonly pool: pg.Pool
}>()('timescale-drizzle/tests/Database') {}

const attempt = <A>(step: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new DatabaseFailed({ step, cause }) })

const backendsOn = (postgresPort: number, database: string) =>
  attempt('count backends', async () => {
    const admin = new pg.Client({ connectionString: `postgres://postgres@127.0.0.1:${postgresPort}/postgres` })
    await admin.connect()
    try {
      const { rows } = await admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
        [database],
      )
      return rows[0]?.n ?? 0
    } finally {
      await admin.end()
    }
  })

const drained = (postgresPort: number, database: string) =>
  backendsOn(postgresPort, database).pipe(
    Effect.filterOrFail(
      (backends) => backends === 0,
      (backends) => new DatabaseFailed({ step: 'drain', cause: `${backends} backend(s) on ${database} remain` }),
    ),
    Effect.retry({ schedule: Schedule.spaced(Duration.millis(100)), times: 50 }),
  )

export const freshDatabase = Layer.effect(Database)(
  Effect.gen(function*() {
    const { integresqlPort, postgresPort } = yield* Server
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
    const tests = `${templates(integresqlPort)}/${TEMPLATE}/tests`
    const { id, database } = yield* Effect.acquireRelease(
      client.get(tests).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(TestDatabase))),
      ({ id, database }) =>
        drained(postgresPort, database.config.database).pipe(
          Effect.andThen(client.execute(HttpClientRequest.post(`${tests}/${id}/recreate`))),
          Effect.orDie,
        ),
    )
    const url = `postgres://postgres@127.0.0.1:${postgresPort}/${database.config.database}`
    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => new pg.Pool({ connectionString: url, max: 4 })),
      (pool) => Effect.promise(() => pool.end()),
    )
    const out = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(path.join(tmpdir(), `timescale-drizzle-${id}-`))),
      (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    )
    return { url, out, pool }
  }),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.orDie)

export const query = <Row extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
) => Effect.flatMap(Database, ({ pool }) => attempt(text, async () => (await pool.query<Row>(text, [...values])).rows))

export const queryAs = <Row extends pg.QueryResultRow = pg.QueryResultRow>(role: string, text: string) =>
  Effect.flatMap(Database, ({ pool }) =>
    attempt(`as ${role}: ${text}`, async () => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`SET LOCAL ROLE ${role}`)
        return (await client.query<Row>(text)).rows
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    }))

export const generated = (extras: PgExtras, name: string) =>
  Effect.flatMap(Database, ({ out }) =>
    Effect.try({
      try: (): GenerateResult => generate({ extras, out, name }),
      catch: (cause) => new DatabaseFailed({ step: `generate ${name}`, cause }),
    }))

export const migrated = Effect.flatMap(Database, ({ pool, out }) =>
  attempt('migrate', async () => {
    const client = await pool.connect()
    try {
      await migrate(drizzle({ client }), { migrationsFolder: out })
    } finally {
      client.release()
    }
  }))
