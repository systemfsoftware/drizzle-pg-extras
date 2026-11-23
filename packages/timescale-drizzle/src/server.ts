import { brand, type ContinuousAggregate, type Hypertable, KIND, type PgExtras } from './defs.js'
import { PgExtrasError } from './errors.js'

export type TimescaleServer = {
  readonly [KIND]: 'timescaleServer'
  readonly databasesWithExtension: number
  readonly concurrentJobs: number
  readonly parallelWorkers: number
  readonly reservedPostgresWorkers: number
  readonly preloadLibraries: readonly string[]
  readonly settings: Readonly<Record<string, string>>
  readonly postgresArgs: readonly string[]
}

export type TimescaleServerConfig = {
  databasesWithExtension: number
  concurrentJobs: number
  parallelWorkers?: number
  reservedPostgresWorkers?: number
  preloadLibraries?: readonly string[]
}

const TIMESCALE_LAUNCHER = 1
const POSTGRES_PARALLEL_PER_GATHER_DEFAULT = 2

function count(where: string, name: string, value: number, minimum: number): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new PgExtrasError(`${where}: ${name} must be an integer of at least ${minimum}; got ${value}`)
  }
  return value
}

export function timescaleServer(config: TimescaleServerConfig): TimescaleServer {
  const where = 'timescaleServer'
  const databasesWithExtension = count(where, 'databasesWithExtension', config.databasesWithExtension, 1)
  const concurrentJobs = count(where, 'concurrentJobs', config.concurrentJobs, 0)
  const parallelWorkers = count(where, 'parallelWorkers', config.parallelWorkers ?? 0, 0)
  const reservedPostgresWorkers = count(where, 'reservedPostgresWorkers', config.reservedPostgresWorkers ?? 4, 0)
  const preloadLibraries = [...(config.preloadLibraries ?? ['timescaledb'])]
  if (!preloadLibraries.includes('timescaledb')) {
    throw new PgExtrasError(`${where}: preloadLibraries must include timescaledb, or its jobs never start`)
  }
  for (const library of preloadLibraries) {
    if (!/^[A-Za-z0-9_]+$/.test(library)) {
      throw new PgExtrasError(`${where}: preload library "${library}" is not a plain library name`)
    }
  }
  const backgroundWorkers = databasesWithExtension + concurrentJobs
  const perGather = Math.min(parallelWorkers, POSTGRES_PARALLEL_PER_GATHER_DEFAULT)
  const settings: Record<string, string> = {
    shared_preload_libraries: preloadLibraries.join(','),
    'timescaledb.max_background_workers': String(backgroundWorkers),
    max_parallel_workers: String(parallelWorkers),
    max_parallel_workers_per_gather: String(perGather),
    max_parallel_maintenance_workers: String(perGather),
    max_worker_processes: String(TIMESCALE_LAUNCHER + backgroundWorkers + parallelWorkers + reservedPostgresWorkers),
  }
  return brand({
    databasesWithExtension,
    concurrentJobs,
    parallelWorkers,
    reservedPostgresWorkers,
    preloadLibraries,
    settings,
    postgresArgs: Object.entries(settings).flatMap(([name, value]) => ['-c', `${name}=${value}`]),
  }, 'timescaleServer')
}

function hypertableJobs(hypertable: Hypertable): number {
  return [hypertable.columnstorePolicy, hypertable.retention, hypertable.reorder].filter((job) => job !== null).length
}

function aggregateJobs(aggregate: ContinuousAggregate): number {
  return aggregate.refreshPolicies.length +
    [aggregate.columnstorePolicy, aggregate.retention].filter((job) => job !== null).length
}

export function declaredJobCount(extras: PgExtras): number {
  return extras.hypertables.reduce((sum, hypertable) => sum + hypertableJobs(hypertable), 0) +
    extras.continuousAggregates.reduce((sum, aggregate) => sum + aggregateJobs(aggregate), 0)
}

export function assertTimescaleServer(extras: PgExtras): void {
  const problems = timescaleServerProblems(extras)
  if (problems.length > 0) throw new PgExtrasError(`timescaleServer: ${problems.join('; ')}`)
}

export function timescaleServerProblems(extras: PgExtras): string[] {
  if (extras.servers.length === 0) return []
  if (extras.servers.length > 1) {
    return [`the schema declares ${extras.servers.length} timescaleServer values; declare one`]
  }
  const server = extras.servers[0]!
  const jobs = declaredJobCount(extras)
  if (jobs > 0 && server.concurrentJobs === 0) {
    return [`the schema declares ${jobs} TimescaleDB jobs and its timescaleServer allows 0 concurrent jobs`]
  }
  return []
}

export const TIMESCALE_SERVER_SETTINGS_QUERY =
  'SELECT name, setting, pending_restart FROM pg_settings WHERE name = ANY($1::text[])'

export type LiveSetting = { readonly name: string; readonly setting: string; readonly pending_restart: boolean }

const comparable = (name: string, value: string): string =>
  name === 'shared_preload_libraries'
    ? value.split(',').map((library) => library.trim()).filter((library) => library !== '').join(',')
    : value

export function timescaleServerDrift(server: TimescaleServer, rows: readonly LiveSetting[]): string[] {
  return Object.entries(server.settings).flatMap(([name, declared]) => {
    const live = rows.find((row) => row.name === name)
    if (!live) return [`${name}: the server does not report it; declared ${declared}`]
    if (live.pending_restart) return [`${name}: changed but waiting on a restart; declared ${declared}`]
    if (comparable(name, live.setting) !== comparable(name, declared)) {
      return [`${name}: the server runs ${live.setting}; declared ${declared}`]
    }
    return []
  })
}
