import { PgExtrasError } from './errors.js'
import {
  attachPartitionSql,
  convertPartitionedTableSql,
  createPartitionSql,
  detachPartitionSql,
  dropPartitionSql,
} from './partition-sql.js'
import { quoteIdent, quoteLiteral } from './quote.js'
import type {
  CommentSnapshot,
  ContinuousAggregateSnapshot,
  HypertableSnapshot,
  InventoryView,
  PartitionedTableSnapshot,
  Snapshot,
  TriggerSnapshot,
} from './snapshot.js'
import { functionSignature, sameFunction, sameTriggerShape } from './snapshot.js'
import {
  alterTriggerEnabledSql,
  commentSql,
  createExtensionSql,
  createFunctionSql,
  createTriggerSql,
  dropExtensionSql,
  dropFunctionSql,
  dropTriggerSql,
} from './statements.js'
import {
  addColumnstorePolicySql,
  addContinuousAggregateColumnstorePolicySql,
  addContinuousAggregateRefreshPoliciesSql,
  addContinuousAggregateRetentionPolicySql,
  addHypertableDimensionSql,
  addReorderPolicySql,
  addRetentionPolicySql,
  alterContinuousAggregateChunkIntervalSql,
  alterContinuousAggregateRealTimeSql,
  createContinuousAggregateStatements,
  createHypertableStatements,
  disableContinuousAggregateColumnstoreSql,
  disableHypertableColumnstoreSql,
  dropContinuousAggregateSql,
  enableContinuousAggregateColumnstoreSql,
  enableHypertableColumnstoreSql,
  leaveChunkIntervalSql,
  leaveHypertableDimensionSql,
  leaveHypertableSql,
  removeColumnstorePolicySql,
  removeContinuousAggregateColumnstorePolicySql,
  removeContinuousAggregatePolicies,
  removeContinuousAggregateRefreshPolicySql,
  removeContinuousAggregateRetentionPolicySql,
  removeReorderPolicySql,
  removeRetentionPolicySql,
  setChunkTimeIntervalSql,
} from './timescale-sql.js'

export type SqlDiff = {
  up: string[]
  down: string[]
}

export function diffSnapshots(from: Snapshot, to: Snapshot): SqlDiff {
  return {
    up: statementsBetween(from, to, true),
    down: statementsBetween(to, from, false),
  }
}

/**
 * Idempotent SQL for the whole snapshot. Useful after `drizzle-kit push`, which
 * does not run migration files. It does not drop objects removed from the snapshot.
 */
export function idempotentStatements(snapshot: Snapshot): string[] {
  const statements: string[] = []
  for (const ext of snapshot.extensions) statements.push(createExtensionSql(ext))
  const sqlFunctions = snapshot.functions.some((fn) => fn.language === 'sql')
  if (sqlFunctions) statements.push('SET check_function_bodies = off')
  for (const fn of snapshot.functions) statements.push(createFunctionSql(fn))
  if (sqlFunctions) statements.push('SET check_function_bodies = on')
  statements.push(...partitionStatements(snapshot))
  for (const hypertable of snapshot.hypertables) statements.push(...createHypertableStatements(hypertable))
  for (const aggregate of orderedContinuousAggregates(snapshot.continuousAggregates)) {
    statements.push(...createContinuousAggregateStatements(aggregate))
  }
  for (const comment of snapshot.comments) {
    if (comment.kind !== 'trigger') statements.push(commentSql(comment, comment.text))
  }
  for (const trigger of snapshot.triggers) pushTriggerBody(statements, trigger, trigger.constraint === true)
  for (const comment of snapshot.comments) {
    if (comment.kind === 'trigger') statements.push(commentSql(comment, comment.text))
  }
  return statements
}

function partitionStatements(snapshot: Snapshot): string[] {
  const statements: string[] = []
  for (const parent of snapshot.partitionedTables) statements.push(convertPartitionedTableSql(parent, 'partition'))
  for (const partition of snapshot.partitions) {
    statements.push(partition.mode === 'attach' ? attachPartitionSql(partition) : createPartitionSql(partition))
  }
  for (const detach of snapshot.detaches) statements.push(detachPartitionSql(detach))
  return statements
}

function statementsBetween(from: Snapshot, to: Snapshot, skipDroppedTables: boolean): string[] {
  const fromFns = new Map(from.functions.map((fn) => [fn.id, fn]))
  const toFns = new Map(to.functions.map((fn) => [fn.id, fn]))
  const fromTriggers = new Map(from.triggers.map((trigger) => [trigger.id, trigger]))
  const toTriggers = new Map(to.triggers.map((trigger) => [trigger.id, trigger]))
  const fromExt = new Map(from.extensions.map((ext) => [ext.id, ext]))
  const toExt = new Map(to.extensions.map((ext) => [ext.id, ext]))
  const fromComments = new Map(from.comments.map((comment) => [comment.id, comment]))
  const toComments = new Map(to.comments.map((comment) => [comment.id, comment]))

  const dropFnIds = new Set<string>()
  for (const [id, fn] of fromFns) {
    const next = toFns.get(id)
    if (!next || next.returns !== fn.returns) dropFnIds.add(id)
  }

  const triggersToDrop: TriggerSnapshot[] = []
  for (const trigger of from.triggers) {
    const next = toTriggers.get(trigger.id)
    const fnDropped = trigger.functionId !== null && dropFnIds.has(trigger.functionId)
    const constraintReplace = !!next && (trigger.constraint || next.constraint) && !sameTriggerShape(trigger, next)
    const removed = !next
    if (
      (removed || fnDropped || constraintReplace) &&
      !(skipDroppedTables && removed && tableGone(from, to, trigger.schema, trigger.table))
    ) {
      triggersToDrop.push(trigger)
    }
  }
  triggersToDrop.sort((a, b) => a.id.localeCompare(b.id))
  const droppedTriggerIds = new Set(triggersToDrop.map((trigger) => trigger.id))

  const statements: string[] = []
  const caggs = continuousAggregateChanges(from, to, skipDroppedTables)
  for (const trigger of triggersToDrop) statements.push(dropTriggerSql(trigger))
  statements.push(...partitionChanges(from, to, skipDroppedTables))
  statements.push(...caggs.drop)

  const fnIds = [...dropFnIds].sort()
  for (const id of fnIds) statements.push(dropFunctionSql(fromFns.get(id)!))

  for (const ext of [...to.extensions].sort((a, b) => a.id.localeCompare(b.id))) {
    const prev = fromExt.get(ext.id)
    if (!prev) {
      statements.push(createExtensionSql(ext))
      continue
    }
    if (ext.schema && prev.schema !== ext.schema) {
      statements.push(`ALTER EXTENSION ${quoteIdent(ext.name)} SET SCHEMA ${quoteIdent(ext.schema)};`)
    }
    if (ext.version && prev.version !== ext.version) {
      statements.push(`ALTER EXTENSION ${quoteIdent(ext.name)} UPDATE TO ${quoteLiteral(ext.version)};`)
    }
  }

  statements.push(...hypertableChanges(from, to, skipDroppedTables))

  const fnsToWrite = to.functions.filter((fn) => {
    const prev = fromFns.get(fn.id)
    return !prev || !sameFunction(prev, fn)
  })
  const needsBodyOff = fnsToWrite.some((fn) => fn.language === 'sql')
  if (needsBodyOff) statements.push('SET check_function_bodies = off')
  for (const fn of fnsToWrite) statements.push(createFunctionSql(fn))
  if (needsBodyOff) statements.push('SET check_function_bodies = on')
  statements.push(...caggs.write)

  emitComments(
    statements,
    from,
    to,
    fromComments,
    toComments,
    dropFnIds,
    toFns,
    droppedTriggerIds,
    toTriggers,
    toExt,
    skipDroppedTables,
    caggs.rebuilt,
    caggs.dropped,
    'other',
  )

  for (const trigger of to.triggers) {
    const prev = fromTriggers.get(trigger.id)
    const dropped = droppedTriggerIds.has(trigger.id)
    const shapeChanged = !prev || !sameTriggerShape(prev, trigger)
    if (shapeChanged || dropped) {
      pushTriggerBody(statements, trigger, trigger.constraint === true && !dropped)
      continue
    }
    if (prev.enabled !== trigger.enabled) statements.push(alterTriggerEnabledSql(trigger))
  }

  emitComments(
    statements,
    from,
    to,
    fromComments,
    toComments,
    dropFnIds,
    toFns,
    droppedTriggerIds,
    toTriggers,
    toExt,
    skipDroppedTables,
    caggs.rebuilt,
    caggs.dropped,
    'trigger',
  )

  for (const ext of [...from.extensions].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!toExt.has(ext.id)) {
      // Down SQL for a new hypertable leaves the table as a hypertable, so dropping
      // timescaledb in that same file would fail. A forward drop still emits DROP EXTENSION.
      if (
        ext.name === 'timescaledb' && !skipDroppedTables &&
        (from.hypertables.length > 0 || from.continuousAggregates.length > 0)
      ) continue
      statements.push(dropExtensionSql(ext))
    }
  }

  return statements
}

function pushTriggerBody(statements: string[], trigger: TriggerSnapshot, dropFirst: boolean): void {
  if (dropFirst) statements.push(dropTriggerSql(trigger))
  statements.push(createTriggerSql(trigger))
  if (trigger.enabled === false) statements.push(alterTriggerEnabledSql(trigger))
}

function emitComments(
  statements: string[],
  from: Snapshot,
  to: Snapshot,
  fromComments: Map<string, CommentSnapshot>,
  toComments: Map<string, CommentSnapshot>,
  dropFnIds: Set<string>,
  toFns: Map<string, Snapshot['functions'][number]>,
  droppedTriggerIds: Set<string>,
  toTriggers: Map<string, TriggerSnapshot>,
  toExt: Map<string, Snapshot['extensions'][number]>,
  skipDroppedTables: boolean,
  rebuiltCaggs: Set<string>,
  droppedCaggs: Set<string>,
  mode: 'trigger' | 'other',
): void {
  const ids = [...new Set([...fromComments.keys(), ...toComments.keys()])].sort()
  for (const id of ids) {
    const prev = fromComments.get(id)
    const next = toComments.get(id)
    const subject = next ?? prev
    if (!subject) continue
    if (mode === 'trigger' ? subject.kind !== 'trigger' : subject.kind === 'trigger') continue
    if (
      prev && next && prev.text === next.text &&
      !commentRewritten(next, dropFnIds, toFns, droppedTriggerIds, toTriggers, rebuiltCaggs)
    ) {
      continue
    }
    if (!next && prev) {
      if (skipCommentNull(prev, to, toFns, toTriggers, toExt, skipDroppedTables, from, droppedCaggs)) continue
      statements.push(commentSql(prev, null))
      continue
    }
    if (next) statements.push(commentSql(next, next.text))
  }
}

function commentRewritten(
  comment: CommentSnapshot,
  dropFnIds: Set<string>,
  toFns: Map<string, Snapshot['functions'][number]>,
  droppedTriggerIds: Set<string>,
  toTriggers: Map<string, TriggerSnapshot>,
  rebuiltCaggs: Set<string>,
): boolean {
  if (comment.kind === 'function') {
    const id = functionSignature(comment.schema, comment.name, comment.argTypes ?? [])
    return dropFnIds.has(id) && toFns.has(id)
  }
  if (comment.kind === 'trigger') return droppedTriggerIds.has(comment.id) && toTriggers.has(comment.id)
  if (comment.kind === 'materializedView' || comment.kind === 'view') {
    return rebuiltCaggs.has(`${comment.schema}.${comment.name}`)
  }
  return false
}

function skipCommentNull(
  comment: CommentSnapshot,
  to: Snapshot,
  toFns: Map<string, Snapshot['functions'][number]>,
  toTriggers: Map<string, TriggerSnapshot>,
  toExt: Map<string, Snapshot['extensions'][number]>,
  skipDroppedTables: boolean,
  from: Snapshot,
  droppedCaggs: Set<string>,
): boolean {
  if (comment.kind === 'function') {
    return !toFns.has(functionSignature(comment.schema, comment.name, comment.argTypes ?? []))
  }
  if (comment.kind === 'trigger') return !toTriggers.has(comment.id)
  if (comment.kind === 'extension') return !toExt.has(comment.name)
  if (comment.kind === 'materializedView' || comment.kind === 'view') {
    if (droppedCaggs.has(`${comment.schema}.${comment.name}`)) return true
  }
  return skipDroppedTables && targetGone(from, to, comment)
}

function hypertableChanges(from: Snapshot, to: Snapshot, forward: boolean): string[] {
  const statements: string[] = []
  const fromTables = new Map(from.hypertables.map((item) => [item.id, item]))
  const toTables = new Map(to.hypertables.map((item) => [item.id, item]))

  for (const prev of from.hypertables) {
    if (toTables.has(prev.id)) continue
    if (forward && tableGone(from, to, prev.schema, prev.name)) continue
    if (forward) {
      throw new PgExtrasError(
        `hypertable ${prev.schema}.${prev.name} was removed from the schema. This package will not convert a hypertable back into a regular table. Keep hypertable(), or remove the Drizzle table in the same change so drizzle-kit drops it.`,
      )
    }
    statements.push(...undoHypertable(prev))
  }

  for (const next of to.hypertables) {
    const prev = fromTables.get(next.id)
    if (!prev) {
      statements.push(...createHypertableStatements(next))
      continue
    }
    statements.push(...alterHypertable(prev, next, forward))
  }
  return statements
}

function undoHypertable(ht: HypertableSnapshot): string[] {
  const statements: string[] = []
  if (ht.reorder) statements.push(removeReorderPolicySql(ht))
  if (ht.columnstorePolicy) statements.push(removeColumnstorePolicySql(ht))
  if (ht.retention) statements.push(removeRetentionPolicySql(ht))
  if (ht.columnstore) statements.push(disableHypertableColumnstoreSql(ht))
  statements.push(leaveHypertableSql(ht))
  return statements
}

function alterHypertable(prev: HypertableSnapshot, next: HypertableSnapshot, forward: boolean): string[] {
  if (prev.timeColumn !== next.timeColumn) {
    throw new PgExtrasError(
      `hypertable ${next.schema}.${next.name} time column changed from "${prev.timeColumn}" to "${next.timeColumn}". The time column cannot be changed in place.`,
    )
  }
  const statements: string[] = []
  if (prev.partitioningColumn !== next.partitioningColumn || prev.numberPartitions !== next.numberPartitions) {
    if (prev.partitioningColumn === null && next.partitioningColumn !== null) {
      statements.push(addHypertableDimensionSql(next))
    } else if (!forward && next.partitioningColumn === null) {
      statements.push(leaveHypertableDimensionSql(prev))
    } else {
      throw new PgExtrasError(
        `hypertable ${next.schema}.${next.name} space partition changed from ${describeSpace(prev)} to ${
          describeSpace(next)
        }. create_hypertable does not alter an existing hash dimension. Keep partitioningColumn and numberPartitions.`,
      )
    }
  }
  if (prev.chunkTimeInterval !== next.chunkTimeInterval) {
    if (next.chunkTimeInterval === null) {
      if (forward) {
        throw new PgExtrasError(
          `hypertable ${next.schema}.${next.name}: clearing chunkTimeInterval is not supported. Set a new interval instead of removing it.`,
        )
      }
      statements.push(leaveChunkIntervalSql(prev))
    } else {
      statements.push(setChunkTimeIntervalSql(next))
    }
  }
  const columnstoreChanged = JSON.stringify(prev.columnstore) !== JSON.stringify(next.columnstore)
  const columnstorePolicyChanged = JSON.stringify(prev.columnstorePolicy) !== JSON.stringify(next.columnstorePolicy)
  const retentionChanged = JSON.stringify(prev.retention) !== JSON.stringify(next.retention)
  if (columnstorePolicyChanged && prev.columnstorePolicy) statements.push(removeColumnstorePolicySql(prev))
  if (columnstoreChanged) {
    if (next.columnstore) {
      statements.push(enableHypertableColumnstoreSql(next, next.columnstore, prev.columnstore))
    } else {
      statements.push(disableHypertableColumnstoreSql(next))
    }
  }
  if (columnstorePolicyChanged && next.columnstorePolicy) statements.push(addColumnstorePolicySql(next))
  if (retentionChanged && prev.retention) statements.push(removeRetentionPolicySql(prev))
  if (retentionChanged && next.retention) statements.push(addRetentionPolicySql(next))
  if (prev.reorder !== next.reorder) {
    if (prev.reorder) statements.push(removeReorderPolicySql(prev))
    if (next.reorder) statements.push(addReorderPolicySql(next))
  }
  return statements
}

function describeSpace(ht: HypertableSnapshot): string {
  if (!ht.partitioningColumn) return 'none'
  return `${ht.partitioningColumn} (${ht.numberPartitions})`
}

type ContinuousAggregateChanges = {
  drop: string[]
  write: string[]
  rebuilt: Set<string>
  dropped: Set<string>
}

function continuousAggregateChanges(
  from: Snapshot,
  to: Snapshot,
  forward: boolean,
): ContinuousAggregateChanges {
  const fromMap = new Map(from.continuousAggregates.map((item) => [item.id, item]))
  const toMap = new Map(to.continuousAggregates.map((item) => [item.id, item]))
  const removed: ContinuousAggregateSnapshot[] = []
  const dropped = new Set<string>()

  for (const prev of from.continuousAggregates) {
    if (toMap.has(prev.id)) continue
    if (forward) assertAggregateSourceStillDeclared(prev, to)
    removed.push(prev)
    dropped.add(`${prev.schema}.${prev.name}`)
  }

  const creates: ContinuousAggregateSnapshot[] = []
  const alters: string[] = []
  const rebuilt = new Set<string>()
  const changedIds = new Set<string>()

  for (const next of to.continuousAggregates) {
    const prev = fromMap.get(next.id)
    if (!prev) {
      assertAggregateSourceDeclared(next, to)
      creates.push(next)
      continue
    }
    if (aggregateDefinitionChanged(prev, next)) {
      removed.push(prev)
      changedIds.add(next.id)
      creates.push(next)
      rebuilt.add(`${next.schema}.${next.name}`)
      continue
    }
    if (prev.realTime !== next.realTime) alters.push(alterContinuousAggregateRealTimeSql(next))
    if (prev.chunkInterval !== next.chunkInterval) {
      if (next.chunkInterval === null) {
        throw new PgExtrasError(
          `continuous aggregate ${next.schema}.${next.name}: clearing chunkInterval is not supported. Set a new interval instead of removing it.`,
        )
      }
      alters.push(alterContinuousAggregateChunkIntervalSql(next))
    }
    if (JSON.stringify(prev.refreshPolicies) !== JSON.stringify(next.refreshPolicies)) {
      if (prev.refreshPolicies.length > 0) alters.push(removeContinuousAggregateRefreshPolicySql(prev))
      alters.push(...addContinuousAggregateRefreshPoliciesSql(next))
    }
    if (JSON.stringify(prev.columnstore) !== JSON.stringify(next.columnstore)) {
      if (next.columnstore) {
        alters.push(enableContinuousAggregateColumnstoreSql(next, next.columnstore))
      } else {
        alters.push(disableContinuousAggregateColumnstoreSql(next))
      }
    }
    if (JSON.stringify(prev.columnstorePolicy) !== JSON.stringify(next.columnstorePolicy)) {
      if (prev.columnstorePolicy) alters.push(removeContinuousAggregateColumnstorePolicySql(prev))
      if (next.columnstorePolicy) alters.push(addContinuousAggregateColumnstorePolicySql(next))
    }
    if (JSON.stringify(prev.retention) !== JSON.stringify(next.retention)) {
      if (prev.retention) alters.push(removeContinuousAggregateRetentionPolicySql(prev))
      if (next.retention) alters.push(addContinuousAggregateRetentionPolicySql(next))
    }
  }

  if (changedIds.size > 0) {
    for (const child of [...from.continuousAggregates, ...to.continuousAggregates]) {
      const parentId = child.source?.kind === 'continuousAggregate'
        ? JSON.stringify(['continuousAggregate', child.source.schema, child.source.name])
        : null
      if (parentId && changedIds.has(parentId)) {
        throw new PgExtrasError(
          `continuous aggregate ${child.schema}.${child.name} sources an aggregate whose definition changed. Drop the child first, generate and migrate the parent change, then recreate the child.`,
        )
      }
    }
  }

  const drop = [...orderedContinuousAggregates(removed)].reverse().flatMap((item) => [
    ...removeContinuousAggregatePolicies(item),
    dropContinuousAggregateSql(item),
  ])
  const write = [
    ...orderedContinuousAggregates(creates).flatMap((item) => createContinuousAggregateStatements(item)),
    ...alters,
  ]
  return { drop, write, rebuilt, dropped }
}

function aggregateDefinitionChanged(prev: ContinuousAggregateSnapshot, next: ContinuousAggregateSnapshot): boolean {
  return prev.query !== next.query ||
    JSON.stringify(prev.source) !== JSON.stringify(next.source) ||
    prev.createGroupIndexes !== next.createGroupIndexes
}

function assertAggregateSourceStillDeclared(
  aggregate: ContinuousAggregateSnapshot,
  to: Snapshot,
): void {
  if (!aggregate.source || aggregate.source.kind !== 'hypertable') return
  const declared = to.hypertables.some((ht) =>
    ht.schema === aggregate.source!.schema && ht.name === aggregate.source!.name
  )
  if (!declared) {
    throw new PgExtrasError(
      `continuous aggregate ${aggregate.schema}.${aggregate.name} and its source table ${aggregate.source.schema}.${aggregate.source.name} were removed in one change. Remove the aggregate, generate and migrate, then remove the table.`,
    )
  }
}

function assertAggregateSourceDeclared(
  aggregate: ContinuousAggregateSnapshot,
  to: Snapshot,
): void {
  const source = aggregate.source
  if (!source) return
  if (source.kind === 'hypertable') {
    if (!to.hypertables.some((ht) => ht.schema === source.schema && ht.name === source.name)) {
      throw new PgExtrasError(
        `continuous aggregate ${aggregate.schema}.${aggregate.name} sources ${source.schema}.${source.name}, which is not a declared hypertable. Declare the hypertable or change source.`,
      )
    }
    return
  }
  if (!to.continuousAggregates.some((item) => item.schema === source.schema && item.name === source.name)) {
    throw new PgExtrasError(
      `continuous aggregate ${aggregate.schema}.${aggregate.name} sources ${source.schema}.${source.name}, which is not a declared continuous aggregate. Declare it or change source.`,
    )
  }
}

type RelationReference = {
  readonly schema: string | null
  readonly name: string
}

const unquoted = (part: string): string => part.startsWith('"') ? part.slice(1, -1) : part.toLowerCase()

const relationPattern = /\b(?:FROM|JOIN)\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)/gi

function relationReferenceOf(target: string): RelationReference {
  const [first = '', second] = target.split(/\s*\.\s*/)
  return second === undefined
    ? { schema: null, name: unquoted(first) }
    : { schema: unquoted(first), name: unquoted(second) }
}

function relationsReadBy(query: string): RelationReference[] {
  return [...query.matchAll(relationPattern)].map((match) => relationReferenceOf(match[1] ?? ''))
}

const nameMatches = (reference: RelationReference, candidate: ContinuousAggregateSnapshot): boolean =>
  reference.name === candidate.name

const schemaMatches = (reference: RelationReference, candidate: ContinuousAggregateSnapshot): boolean =>
  reference.schema === null || reference.schema === candidate.schema

const readsCandidate = (reference: RelationReference, candidate: ContinuousAggregateSnapshot): boolean =>
  nameMatches(reference, candidate) && schemaMatches(reference, candidate)

function readsAggregate(
  references: readonly RelationReference[],
  candidate: ContinuousAggregateSnapshot,
): boolean {
  return references.some((reference) => readsCandidate(reference, candidate))
}

function declaredParentOf(
  aggregate: ContinuousAggregateSnapshot,
  byId: Map<string, ContinuousAggregateSnapshot>,
): ContinuousAggregateSnapshot | undefined {
  if (aggregate.source?.kind !== 'continuousAggregate') return undefined
  return byId.get(JSON.stringify(['continuousAggregate', aggregate.source.schema, aggregate.source.name]))
}

const otherAggregateOf =
  (aggregate: ContinuousAggregateSnapshot) => (candidate: ContinuousAggregateSnapshot): boolean =>
    candidate.id !== aggregate.id

function referencedParentsOf(
  aggregate: ContinuousAggregateSnapshot,
  aggregates: readonly ContinuousAggregateSnapshot[],
): ContinuousAggregateSnapshot[] {
  const references = relationsReadBy(aggregate.query)
  return aggregates.filter(otherAggregateOf(aggregate))
    .filter((candidate) => readsAggregate(references, candidate))
}

const distinctFromParent =
  (declared: ContinuousAggregateSnapshot | undefined) => (candidate: ContinuousAggregateSnapshot): boolean =>
    candidate.id !== declared?.id

function parentsOf(
  aggregate: ContinuousAggregateSnapshot,
  aggregates: readonly ContinuousAggregateSnapshot[],
  byId: Map<string, ContinuousAggregateSnapshot>,
): ContinuousAggregateSnapshot[] {
  const declared = declaredParentOf(aggregate, byId)
  const referenced = referencedParentsOf(aggregate, aggregates).filter(distinctFromParent(declared))
  return declared ? [declared, ...referenced] : referenced
}

function orderedContinuousAggregates(
  aggregates: readonly ContinuousAggregateSnapshot[],
): ContinuousAggregateSnapshot[] {
  const byId = new Map(aggregates.map((item) => [item.id, item]))
  const ordered: ContinuousAggregateSnapshot[] = []
  const done = new Set<string>()
  const visiting = new Set<string>()
  const visit = (aggregate: ContinuousAggregateSnapshot): void => {
    if (done.has(aggregate.id)) return
    if (visiting.has(aggregate.id)) {
      throw new PgExtrasError(
        `continuous aggregate ${aggregate.schema}.${aggregate.name} has a source cycle`,
      )
    }
    visiting.add(aggregate.id)
    for (const parent of parentsOf(aggregate, aggregates, byId)) visit(parent)
    visiting.delete(aggregate.id)
    done.add(aggregate.id)
    ordered.push(aggregate)
  }
  for (const aggregate of aggregates) visit(aggregate)
  return ordered
}

function partitionChanges(from: Snapshot, to: Snapshot, skipDroppedTables: boolean): string[] {
  const statements: string[] = []
  const handled = new Set<string>()
  const fromParents = new Map(from.partitionedTables.map((item) => [item.id, item]))
  const toParents = new Map(to.partitionedTables.map((item) => [item.id, item]))
  const fromPartitions = new Map(from.partitions.map((item) => [item.id, item]))
  const toPartitions = new Map(to.partitions.map((item) => [item.id, item]))
  const fromDetaches = new Set(from.detaches.map((item) => item.id))

  for (const partition of from.partitions) {
    if (toPartitions.has(partition.id)) continue
    if (
      skipDroppedTables &&
      (tableGone(from, to, partition.parentSchema, partition.parentName) ||
        tableGone(from, to, partition.schema, partition.name))
    ) {
      continue
    }
    if (partition.mode === 'attach' || partition.onRemove === 'detach') statements.push(detachPartitionSql(partition))
    else statements.push(dropPartitionSql(partition))
    handled.add(childKey(partition.schema, partition.name, partition.parentSchema, partition.parentName))
  }

  for (const parent of from.partitionedTables) {
    if (toParents.has(parent.id)) continue
    if (skipDroppedTables && tableGone(from, to, parent.schema, parent.name)) continue
    statements.push(convertPartitionedTableSql(parent, 'unpartition'))
  }

  for (const parent of to.partitionedTables) {
    const previous = fromParents.get(parent.id)
    if (!previous) {
      statements.push(convertPartitionedTableSql(parent, 'partition'))
      continue
    }
    if (previous.method !== parent.method || previous.columns.join('\0') !== parent.columns.join('\0')) {
      throw new PgExtrasError(
        `partitioned table ${parent.schema}.${parent.name} changed from ${describeKey(previous)} to ${
          describeKey(parent)
        }. Postgres cannot change a partition key in place. Keep the original partitionedTable() and move the data in a custom migration if you need a different key.`,
      )
    }
  }

  for (const partition of to.partitions) {
    const previous = fromPartitions.get(partition.id)
    if (!previous) {
      statements.push(partition.mode === 'attach' ? attachPartitionSql(partition) : createPartitionSql(partition))
      continue
    }
    if (
      previous.mode !== partition.mode || previous.boundSql !== partition.boundSql ||
      previous.boundKind !== partition.boundKind
    ) {
      throw new PgExtrasError(
        `partition ${partition.schema}.${partition.name} of ${partition.parentSchema}.${partition.parentName} changed (${previous.mode} ${previous.boundSql} -> ${partition.mode} ${partition.boundSql}). Postgres cannot alter partition bounds in place, and this package will not detach and recreate a partition because that drops rows. Move the rows in a custom migration.`,
      )
    }
  }

  for (const detach of to.detaches) {
    if (fromDetaches.has(detach.id)) continue
    if (handled.has(childKey(detach.schema, detach.name, detach.parentSchema, detach.parentName))) continue
    if (
      skipDroppedTables &&
      (tableGone(from, to, detach.parentSchema, detach.parentName) || tableGone(from, to, detach.schema, detach.name))
    ) {
      continue
    }
    statements.push(detachPartitionSql(detach))
  }

  return statements
}

function childKey(schema: string, name: string, parentSchema: string, parentName: string): string {
  return JSON.stringify([schema, name, parentSchema, parentName])
}

function describeKey(parent: PartitionedTableSnapshot): string {
  return `${parent.method.toUpperCase()} (${parent.columns.join(', ')})`
}

function tableGone(from: Snapshot, to: Snapshot, schema: string, table: string): boolean {
  if (!from.inventory.scanned || !to.inventory.scanned) return false
  const had = from.inventory.tables.some((item) => item.schema === schema && item.name === table)
  const has = to.inventory.tables.some((item) => item.schema === schema && item.name === table)
  return had && !has
}

function targetGone(from: Snapshot, to: Snapshot, comment: CommentSnapshot): boolean {
  if (!from.inventory.scanned || !to.inventory.scanned) return false
  const relation = comment.relation ?? comment.name
  if (comment.kind === 'table' || comment.kind === 'column') {
    if (tableGone(from, to, comment.schema, relation)) return true
    if (comment.kind !== 'column' || !comment.column) return false
    const prev = from.inventory.tables.find((item) => item.schema === comment.schema && item.name === relation)
    const next = to.inventory.tables.find((item) => item.schema === comment.schema && item.name === relation)
    if (prev && next) return prev.columns.includes(comment.column) && !next.columns.includes(comment.column)
    return viewColumnGone(from, to, comment.schema, relation, comment.column)
  }
  if (comment.kind === 'enum') return namedGone(from.inventory.enums, to.inventory.enums, comment.schema, comment.name)
  if (comment.kind === 'view' || comment.kind === 'materializedView') {
    return viewGone(
      from.inventory.views,
      to.inventory.views,
      comment.schema,
      comment.name,
      comment.kind === 'materializedView',
    )
  }
  if (comment.kind === 'index') {
    return listedGone(from.inventory.indexes, to.inventory.indexes, comment.schema, comment.name)
  }
  if (comment.kind === 'constraint') {
    const had = from.inventory.constraints.some((item) =>
      item.schema === comment.schema && item.table === relation && item.name === comment.name
    )
    const has = to.inventory.constraints.some((item) =>
      item.schema === comment.schema && item.table === relation && item.name === comment.name
    )
    return had && !has
  }
  return false
}

function namedGone(
  from: readonly { schema: string; name: string }[],
  to: readonly { schema: string; name: string }[],
  schema: string,
  name: string,
): boolean {
  const had = from.some((item) => item.schema === schema && item.name === name)
  const has = to.some((item) => item.schema === schema && item.name === name)
  return had && !has
}

function listedGone(
  from: readonly { schema: string; name: string }[],
  to: readonly { schema: string; name: string }[],
  schema: string,
  name: string,
): boolean {
  return namedGone(from, to, schema, name)
}

function viewGone(
  from: readonly InventoryView[],
  to: readonly InventoryView[],
  schema: string,
  name: string,
  materialized: boolean,
): boolean {
  const had = from.some((item) => item.schema === schema && item.name === name && item.materialized === materialized)
  const has = to.some((item) => item.schema === schema && item.name === name && item.materialized === materialized)
  return had && !has
}

function viewColumnGone(from: Snapshot, to: Snapshot, schema: string, relation: string, column: string): boolean {
  const prev = from.inventory.views.find((item) => item.schema === schema && item.name === relation)
  const next = to.inventory.views.find((item) => item.schema === schema && item.name === relation)
  if (prev && !next) return true
  if (!prev || !next) return false
  return prev.columns.includes(column) && !next.columns.includes(column)
}
