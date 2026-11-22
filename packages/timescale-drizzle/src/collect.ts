import { is } from 'drizzle-orm'
import { isPgEnum, isPgMaterializedView, isPgView, PgTable } from 'drizzle-orm/pg-core'
import {
  type AnyPgEnum,
  type ContinuousAggregate,
  extrasKind,
  type Hypertable,
  isPlainRecord,
  type PartitionedTable,
  type PgComment,
  type PgDetach,
  type PgExtension,
  type PgExtras,
  type PgFunction,
  type PgPartition,
  type PgTrigger,
  type PgViewLike,
} from './defs.js'
import type { PgGrant } from './grant.js'
import type { PgViewDefinition } from './view.js'

export function collectExtras(modules: Record<string, unknown> | readonly Record<string, unknown>[]): PgExtras {
  const extras: PgExtras = {
    functions: [],
    triggers: [],
    extensions: [],
    comments: [],
    tables: [],
    enums: [],
    views: [],
    partitionedTables: [],
    partitions: [],
    detaches: [],
    hypertables: [],
    continuousAggregates: [],
    viewDefinitions: [],
    grants: [],
  }
  const seen = new Set<unknown>()
  const list = Array.isArray(modules) ? modules : [modules]
  for (const mod of list) walk(mod, extras, seen)
  for (const trigger of extras.triggers) {
    const fn = trigger.function
    if (fn && extrasKind(fn) === 'function' && !extras.functions.includes(fn as PgFunction)) {
      extras.functions.push(fn as PgFunction)
    }
  }
  return extras
}

export function defineExtras(input: {
  functions?: readonly PgFunction[]
  triggers?: readonly PgTrigger[]
  extensions?: readonly PgExtension[]
  comments?: readonly PgComment[]
  tables?: readonly PgTable[]
  enums?: readonly AnyPgEnum[]
  views?: readonly PgViewLike[]
  partitionedTables?: readonly PartitionedTable[]
  partitions?: readonly PgPartition[]
  detaches?: readonly PgDetach[]
  hypertables?: readonly Hypertable[]
  continuousAggregates?: readonly ContinuousAggregate[]
  viewDefinitions?: readonly PgViewDefinition[]
  grants?: readonly PgGrant[]
}): PgExtras {
  return collectExtras({
    functions: input.functions ?? [],
    triggers: input.triggers ?? [],
    extensions: input.extensions ?? [],
    comments: input.comments ?? [],
    tables: input.tables ?? [],
    enums: input.enums ?? [],
    views: input.views ?? [],
    partitionedTables: input.partitionedTables ?? [],
    partitions: input.partitions ?? [],
    detaches: input.detaches ?? [],
    hypertables: input.hypertables ?? [],
    continuousAggregates: input.continuousAggregates ?? [],
    viewDefinitions: input.viewDefinitions ?? [],
    grants: input.grants ?? [],
  })
}

function walk(value: unknown, extras: PgExtras, seen: Set<unknown>): void {
  if (value === null || value === undefined) return
  if (typeof value === 'function') {
    if (isPgEnum(value)) pushEnum(extras, value)
    return
  }
  if (typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)

  const kind = extrasKind(value)
  if (kind === 'function') {
    extras.functions.push(value as PgFunction)
    return
  }
  if (kind === 'trigger') {
    extras.triggers.push(value as PgTrigger)
    return
  }
  if (kind === 'extension') {
    extras.extensions.push(value as PgExtension)
    return
  }
  if (kind === 'comment') {
    extras.comments.push(value as PgComment)
    return
  }
  if (kind === 'partitionedTable') {
    const partitioned = value as PartitionedTable
    extras.partitionedTables.push(partitioned)
    if (is(partitioned.table, PgTable)) walk(partitioned.table, extras, seen)
    return
  }
  if (kind === 'partition') {
    extras.partitions.push(value as PgPartition)
    return
  }
  if (kind === 'detach') {
    extras.detaches.push(value as PgDetach)
    return
  }
  if (kind === 'hypertable') {
    const hypertable = value as Hypertable
    extras.hypertables.push(hypertable)
    if (is(hypertable.table, PgTable)) walk(hypertable.table, extras, seen)
    return
  }
  if (kind === 'continuousAggregate') {
    const aggregate = value as ContinuousAggregate
    extras.continuousAggregates.push(aggregate)
    if (aggregate.view) walk(aggregate.view, extras, seen)
    if (aggregate.source) walk(aggregate.source, extras, seen)
    return
  }
  if (kind === 'viewDefinition') {
    const definition = value as PgViewDefinition
    extras.viewDefinitions.push(definition)
    walk(definition.view, extras, seen)
    for (const dependency of definition.dependsOn) walk(dependency, extras, seen)
    return
  }
  if (kind === 'grant') {
    const grant = value as PgGrant
    extras.grants.push(grant)
    walk(grant.on, extras, seen)
    return
  }
  if (isPgView(value) || isPgMaterializedView(value)) {
    pushView(extras, value)
    return
  }
  if (is(value, PgTable)) {
    if (!extras.tables.includes(value)) extras.tables.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, extras, seen)
    return
  }
  if (isPlainRecord(value)) {
    for (const entry of Object.values(value)) walk(entry, extras, seen)
  }
}

function pushEnum(extras: PgExtras, value: unknown): void {
  const enumObject = value as AnyPgEnum
  if (!extras.enums.includes(enumObject)) extras.enums.push(enumObject)
}

function pushView(extras: PgExtras, value: PgViewLike): void {
  if (!extras.views.includes(value)) extras.views.push(value)
}
