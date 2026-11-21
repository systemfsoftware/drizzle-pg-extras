import { PgExtrasError } from './errors.js'
import { qualify, quoteIdent, quoteLiteral } from './quote.js'
import type {
  ContinuousAggregateSnapshot,
  HypertableColumnstorePolicySnapshot,
  HypertableColumnstoreSnapshot,
  HypertableRetentionSnapshot,
  HypertableSnapshot,
} from './snapshot.js'

export function createHypertableStatements(ht: HypertableSnapshot): string[] {
  const statements = [createHypertableSql(ht)]
  if (ht.partitioningColumn) statements.push(addHypertableDimensionSql(ht))
  if (ht.columnstore) statements.push(enableHypertableColumnstoreSql(ht, ht.columnstore, null))
  if (ht.columnstorePolicy) statements.push(addColumnstorePolicySql(ht))
  if (ht.retention) statements.push(addRetentionPolicySql(ht))
  if (ht.reorder) statements.push(addReorderPolicySql(ht))
  return statements
}

export function createHypertableSql(ht: HypertableSnapshot): string {
  const range = ht.chunkTimeInterval
    ? `by_range(${nameLiteral(ht.timeColumn)}, partition_interval => ${intervalLiteral(ht.chunkTimeInterval)})`
    : `by_range(${nameLiteral(ht.timeColumn)})`
  const args = [relation(ht), range]
  if (!ht.createDefaultIndexes) args.push('create_default_indexes => FALSE')
  if (ht.migrateData) args.push('migrate_data => TRUE')
  args.push('if_not_exists => TRUE')
  return `-- Convert ${qualify(ht.schema, ht.name)} into a TimescaleDB hypertable on ${
    quoteIdent(ht.timeColumn)
  } using by_range.\nSELECT create_hypertable(${args.join(', ')});`
}

export function setChunkTimeIntervalSql(ht: HypertableSnapshot): string {
  return `-- Set the chunk interval of ${
    qualify(ht.schema, ht.name)
  } to ${ht.chunkTimeInterval}.\nSELECT set_chunk_time_interval(${relation(ht)}, ${
    intervalLiteral(ht.chunkTimeInterval ?? '')
  });`
}

export function addHypertableDimensionSql(ht: HypertableSnapshot): string {
  return `-- Add a space partition on ${quoteIdent(ht.partitioningColumn ?? '')} to ${
    qualify(ht.schema, ht.name)
  }.\nSELECT add_dimension(${relation(ht)}, by_hash(${
    nameLiteral(ht.partitioningColumn ?? '')
  }, ${ht.numberPartitions}), if_not_exists => TRUE);`
}

export function enableHypertableColumnstoreSql(
  ht: Pick<HypertableSnapshot, 'schema' | 'name'>,
  columnstore: HypertableColumnstoreSnapshot,
  previous: HypertableColumnstoreSnapshot | null,
): string {
  const options = ['timescaledb.enable_columnstore']
  const segment = columnstore.segmentBy.map((column) => quoteIdent(column)).join(', ')
  if (segment.length > 0 || (previous?.segmentBy.length ?? 0) > 0) {
    options.push(`timescaledb.segmentby = ${quoteLiteral(segment)}`)
  }
  const order = columnstore.orderBy.map(orderFragment).join(', ')
  if (order.length > 0 || (previous?.orderBy.length ?? 0) > 0) {
    options.push(`timescaledb.orderby = ${quoteLiteral(order)}`)
  }
  const sparse = columnstore.sparseIndex
    .map((index) => `${index.type}(${index.columns.map((column) => quoteIdent(column)).join(', ')})`)
    .join(', ')
  if (sparse.length > 0) options.push(`timescaledb.sparse_index = ${quoteLiteral(sparse)}`)
  const resetSparse = sparse.length === 0 && (previous?.sparseIndex.length ?? 0) > 0
  const setSql = `ALTER TABLE ${qualify(ht.schema, ht.name)} SET (\n  ${options.join(',\n  ')}\n);`
  const resetSql = resetSparse
    ? `\nALTER TABLE ${qualify(ht.schema, ht.name)} RESET (timescaledb.sparse_index);`
    : ''
  return `-- Enable the columnstore on ${qualify(ht.schema, ht.name)}.\n${setSql}${resetSql}`
}

export function disableHypertableColumnstoreSql(ht: Pick<HypertableSnapshot, 'schema' | 'name'>): string {
  return `-- Turn the columnstore off on ${
    qualify(ht.schema, ht.name)
  }. TimescaleDB refuses while any chunk is in the columnstore, so convert those chunks back to the rowstore first. The table lock keeps a concurrent conversion from undoing that before the ALTER.\nDO $drizzle_pg_extras$\nDECLARE\n  chunk regclass;\nBEGIN\n  LOCK TABLE ${
    qualify(ht.schema, ht.name)
  } IN ACCESS EXCLUSIVE MODE;\n  FOR chunk IN SELECT show_chunks(${
    relation(ht)
  }) LOOP\n    CALL convert_to_rowstore(chunk, if_columnstore => TRUE);\n  END LOOP;\n  ALTER TABLE ${
    qualify(ht.schema, ht.name)
  } SET (timescaledb.enable_columnstore = false);\nEND\n$drizzle_pg_extras$;`
}

export function addRetentionPolicySql(ht: HypertableSnapshot): string {
  const policy = ht.retention
  if (!policy) throw new PgExtrasError('addRetentionPolicySql requires a retention policy')
  return policyStatement(
    'Add a retention policy to',
    'add_retention_policy',
    ht,
    retentionArgs(policy),
    false,
  )
}

export function removeRetentionPolicySql(ht: Pick<HypertableSnapshot, 'schema' | 'name'>): string {
  return `-- Remove the retention policy from ${qualify(ht.schema, ht.name)}.\nSELECT remove_retention_policy(${
    relation(ht)
  }, if_exists => TRUE);`
}

export function addReorderPolicySql(ht: Pick<HypertableSnapshot, 'schema' | 'name' | 'reorder'>): string {
  if (!ht.reorder) throw new PgExtrasError('addReorderPolicySql requires an index name')
  return `-- Reorder the rowstore chunks of ${qualify(ht.schema, ht.name)} by ${
    quoteIdent(ht.reorder)
  }.\nSELECT add_reorder_policy(${relation(ht)}, ${nameLiteral(ht.reorder)}, if_not_exists => TRUE);`
}

export function removeReorderPolicySql(ht: Pick<HypertableSnapshot, 'schema' | 'name'>): string {
  return `-- Remove the reorder policy from ${qualify(ht.schema, ht.name)}.\nSELECT remove_reorder_policy(${
    relation(ht)
  }, if_exists => TRUE);`
}

export function addColumnstorePolicySql(ht: HypertableSnapshot): string {
  const policy = ht.columnstorePolicy
  if (!policy) throw new PgExtrasError('addColumnstorePolicySql requires a columnstore policy')
  return policyStatement(
    'Add a columnstore policy to',
    'add_columnstore_policy',
    ht,
    columnstorePolicyArgs(policy),
    true,
  )
}

export function removeColumnstorePolicySql(ht: Pick<HypertableSnapshot, 'schema' | 'name'>): string {
  return `-- Remove the columnstore policy from ${qualify(ht.schema, ht.name)}.\nCALL remove_columnstore_policy(${
    relation(ht)
  }, if_exists => TRUE);`
}

export function createContinuousAggregateSql(aggregate: ContinuousAggregateSnapshot): string {
  const options = ['timescaledb.continuous']
  options.push(`timescaledb.materialized_only = ${aggregate.realTime ? 'false' : 'true'}`)
  if (aggregate.chunkInterval) {
    options.push(`timescaledb.chunk_interval = ${quoteLiteral(aggregate.chunkInterval)}`)
  }
  if (!aggregate.createGroupIndexes) options.push('timescaledb.create_group_indexes = false')
  return `-- Create the continuous aggregate ${
    qualify(aggregate.schema, aggregate.name)
  }.\nCREATE MATERIALIZED VIEW IF NOT EXISTS ${qualify(aggregate.schema, aggregate.name)}\nWITH (\n  ${
    options.join(',\n  ')
  }\n)\nAS\n${stripSemicolon(aggregate.query)}\nWITH NO DATA;`
}

export function dropContinuousAggregateSql(
  aggregate: Pick<ContinuousAggregateSnapshot, 'schema' | 'name'>,
): string {
  return `-- Drop the continuous aggregate ${
    qualify(aggregate.schema, aggregate.name)
  }.\nDROP MATERIALIZED VIEW IF EXISTS ${qualify(aggregate.schema, aggregate.name)};`
}

export function alterContinuousAggregateRealTimeSql(aggregate: ContinuousAggregateSnapshot): string {
  return `-- Set real-time aggregation on ${qualify(aggregate.schema, aggregate.name)} to ${
    aggregate.realTime ? 'on' : 'off'
  }.\nALTER MATERIALIZED VIEW ${qualify(aggregate.schema, aggregate.name)} SET (timescaledb.materialized_only = ${
    aggregate.realTime ? 'false' : 'true'
  });`
}

export function alterContinuousAggregateChunkIntervalSql(aggregate: ContinuousAggregateSnapshot): string {
  return `-- Set the chunk interval of ${
    qualify(aggregate.schema, aggregate.name)
  } to ${aggregate.chunkInterval}.\nALTER MATERIALIZED VIEW ${
    qualify(aggregate.schema, aggregate.name)
  } SET (timescaledb.chunk_interval = ${quoteLiteral(aggregate.chunkInterval ?? '')});`
}

export function createContinuousAggregateStatements(aggregate: ContinuousAggregateSnapshot): string[] {
  const statements = [createContinuousAggregateSql(aggregate)]
  if (aggregate.columnstore) {
    statements.push(enableContinuousAggregateColumnstoreSql(aggregate, aggregate.columnstore))
  }
  if (aggregate.columnstorePolicy) statements.push(addContinuousAggregateColumnstorePolicySql(aggregate))
  if (aggregate.retention) statements.push(addContinuousAggregateRetentionPolicySql(aggregate))
  statements.push(...addContinuousAggregateRefreshPoliciesSql(aggregate))
  return statements
}

export function removeContinuousAggregatePolicies(aggregate: ContinuousAggregateSnapshot): string[] {
  const statements: string[] = []
  if (aggregate.refreshPolicies.length > 0) statements.push(removeContinuousAggregateRefreshPolicySql(aggregate))
  if (aggregate.columnstorePolicy) statements.push(removeContinuousAggregateColumnstorePolicySql(aggregate))
  if (aggregate.retention) statements.push(removeContinuousAggregateRetentionPolicySql(aggregate))
  if (aggregate.columnstore) statements.push(disableContinuousAggregateColumnstoreSql(aggregate))
  return statements
}

export function enableContinuousAggregateColumnstoreSql(
  aggregate: Pick<ContinuousAggregateSnapshot, 'schema' | 'name'>,
  columnstore: HypertableColumnstoreSnapshot,
): string {
  const options = ['timescaledb.enable_columnstore']
  const segment = columnstore.segmentBy.map((column) => quoteIdent(column)).join(', ')
  if (segment.length > 0) options.push(`timescaledb.segmentby = ${quoteLiteral(segment)}`)
  const order = columnstore.orderBy.map(orderFragment).join(', ')
  if (order.length > 0) options.push(`timescaledb.orderby = ${quoteLiteral(order)}`)
  return `-- Enable the columnstore on ${qualify(aggregate.schema, aggregate.name)}.\nALTER MATERIALIZED VIEW ${
    qualify(aggregate.schema, aggregate.name)
  } SET (\n  ${options.join(',\n  ')}\n);`
}

export function disableContinuousAggregateColumnstoreSql(
  aggregate: Pick<ContinuousAggregateSnapshot, 'schema' | 'name'>,
): string {
  return `-- Turn the columnstore off on ${
    qualify(aggregate.schema, aggregate.name)
  }. TimescaleDB refuses while any chunk is in the columnstore, so convert those chunks back to the rowstore first. The table lock keeps a concurrent conversion from undoing that before the ALTER.\nDO $drizzle_pg_extras$\nDECLARE\n  chunk regclass;\nBEGIN\n  LOCK TABLE ${
    qualify(aggregate.schema, aggregate.name)
  } IN ACCESS EXCLUSIVE MODE;\n  FOR chunk IN SELECT show_chunks(${
    relation(aggregate)
  }) LOOP\n    CALL convert_to_rowstore(chunk, if_columnstore => TRUE);\n  END LOOP;\n  ALTER MATERIALIZED VIEW ${
    qualify(aggregate.schema, aggregate.name)
  } SET (timescaledb.enable_columnstore = false);\nEND\n$drizzle_pg_extras$;`
}

export function addContinuousAggregateColumnstorePolicySql(aggregate: ContinuousAggregateSnapshot): string {
  const policy = aggregate.columnstorePolicy
  if (!policy) throw new PgExtrasError('addContinuousAggregateColumnstorePolicySql requires a policy')
  return policyStatement(
    'Add a columnstore policy to',
    'add_columnstore_policy',
    aggregate,
    columnstorePolicyArgs(policy),
    true,
  )
}

export function removeContinuousAggregateColumnstorePolicySql(
  aggregate: Pick<ContinuousAggregateSnapshot, 'schema' | 'name'>,
): string {
  return `-- Remove the columnstore policy from ${
    qualify(aggregate.schema, aggregate.name)
  }.\nCALL remove_columnstore_policy(${relation(aggregate)}, if_exists => TRUE);`
}

export function addContinuousAggregateRetentionPolicySql(aggregate: ContinuousAggregateSnapshot): string {
  const policy = aggregate.retention
  if (!policy) throw new PgExtrasError('addContinuousAggregateRetentionPolicySql requires a policy')
  return policyStatement(
    'Add a retention policy to',
    'add_retention_policy',
    aggregate,
    retentionArgs(policy),
    false,
  )
}

export function removeContinuousAggregateRetentionPolicySql(
  aggregate: Pick<ContinuousAggregateSnapshot, 'schema' | 'name'>,
): string {
  return `-- Remove the retention policy from ${
    qualify(aggregate.schema, aggregate.name)
  }.\nSELECT remove_retention_policy(${relation(aggregate)}, if_exists => TRUE);`
}

export function addContinuousAggregateRefreshPoliciesSql(aggregate: ContinuousAggregateSnapshot): string[] {
  return aggregate.refreshPolicies.map((policy) => {
    const args = [
      `start_offset => ${policy.startOffset === null ? 'NULL' : intervalLiteral(policy.startOffset)}`,
      `end_offset => ${policy.endOffset === null ? 'NULL' : intervalLiteral(policy.endOffset)}`,
      `schedule_interval => ${intervalLiteral(policy.scheduleInterval)}`,
      'if_not_exists => TRUE',
    ]
    if (policy.initialStart) args.push(`initial_start => ${timestampLiteral(policy.initialStart)}`)
    if (policy.timezone) args.push(`timezone => ${quoteLiteral(policy.timezone)}`)
    if (policy.includeTieredData !== null) args.push(`include_tiered_data => ${policy.includeTieredData}`)
    if (policy.bucketsPerBatch !== null) args.push(`buckets_per_batch => ${policy.bucketsPerBatch}`)
    if (policy.maxBatchesPerExecution !== null) {
      args.push(`max_batches_per_execution => ${policy.maxBatchesPerExecution}`)
    }
    if (policy.refreshNewestFirst !== null) args.push(`refresh_newest_first => ${policy.refreshNewestFirst}`)
    return `-- Add a refresh policy to ${
      qualify(aggregate.schema, aggregate.name)
    }.\nSELECT add_continuous_aggregate_policy(${[relation(aggregate), ...args].join(', ')});`
  })
}

export function removeContinuousAggregateRefreshPolicySql(
  aggregate: Pick<ContinuousAggregateSnapshot, 'schema' | 'name'>,
): string {
  return `-- Remove the refresh policy from ${
    qualify(aggregate.schema, aggregate.name)
  }.\nSELECT remove_continuous_aggregate_policy(${relation(aggregate)}, if_exists => TRUE);`
}

export function leaveHypertableDimensionSql(ht: HypertableSnapshot): string {
  return `-- ${qualify(ht.schema, ht.name)} keeps its space partition on ${
    quoteIdent(ht.partitioningColumn ?? '')
  }. This migration does not drop a hash dimension.\nDO $drizzle_pg_extras$\nBEGIN\n  RAISE NOTICE 'drizzle-pg-extras: %.% keeps space partition %', ${
    quoteLiteral(ht.schema)
  }, ${quoteLiteral(ht.name)}, ${quoteLiteral(ht.partitioningColumn ?? '')};\nEND\n$drizzle_pg_extras$;`
}

export function leaveChunkIntervalSql(ht: HypertableSnapshot): string {
  return `-- ${
    qualify(ht.schema, ht.name)
  } keeps chunk interval ${ht.chunkTimeInterval}. Clearing chunkTimeInterval is not generated.\nDO $drizzle_pg_extras$\nBEGIN\n  RAISE NOTICE 'drizzle-pg-extras: %.% keeps chunk interval %', ${
    quoteLiteral(ht.schema)
  }, ${quoteLiteral(ht.name)}, ${quoteLiteral(ht.chunkTimeInterval ?? '')};\nEND\n$drizzle_pg_extras$;`
}

export function leaveHypertableSql(ht: Pick<HypertableSnapshot, 'schema' | 'name'>): string {
  return `-- ${
    qualify(ht.schema, ht.name)
  } stays a hypertable. TimescaleDB cannot turn it back into a regular table from this migration.\nDO $drizzle_pg_extras$\nBEGIN\n  RAISE NOTICE 'drizzle-pg-extras: %.% stays a hypertable', ${
    quoteLiteral(ht.schema)
  }, ${quoteLiteral(ht.name)};\nEND\n$drizzle_pg_extras$;`
}

function retentionArgs(policy: HypertableRetentionSnapshot): string[] {
  const args = [
    policy.dropAfter !== null
      ? `drop_after => ${intervalLiteral(policy.dropAfter)}`
      : `drop_created_before => ${intervalLiteral(policy.dropCreatedBefore ?? '')}`,
  ]
  timingArgs(policy, args)
  return args
}

function columnstorePolicyArgs(policy: HypertableColumnstorePolicySnapshot): string[] {
  const args = [
    policy.after !== null
      ? `after => ${intervalLiteral(policy.after)}`
      : `created_before => ${intervalLiteral(policy.createdBefore ?? '')}`,
  ]
  timingArgs(policy, args)
  return args
}

function timingArgs(
  policy: { scheduleInterval: string | null; initialStart: string | null; timezone: string | null },
  args: string[],
): void {
  if (policy.scheduleInterval) args.push(`schedule_interval => ${intervalLiteral(policy.scheduleInterval)}`)
  if (policy.initialStart) args.push(`initial_start => ${timestampLiteral(policy.initialStart)}`)
  if (policy.timezone) args.push(`timezone => ${quoteLiteral(policy.timezone)}`)
}

function policyStatement(
  comment: string,
  fn: string,
  ht: Pick<HypertableSnapshot, 'schema' | 'name'>,
  args: string[],
  procedure: boolean,
): string {
  const call = procedure ? 'CALL' : 'SELECT'
  return `-- ${comment} ${qualify(ht.schema, ht.name)}.\n${call} ${fn}(${
    [relation(ht), ...args, 'if_not_exists => TRUE'].join(', ')
  });`
}

function relation(ht: Pick<HypertableSnapshot, 'schema' | 'name'>): string {
  return `${quoteLiteral(`${quoteIdent(ht.schema)}.${quoteIdent(ht.name)}`)}::regclass`
}

function nameLiteral(name: string): string {
  return `${quoteLiteral(name)}::name`
}

function intervalLiteral(value: string): string {
  return `INTERVAL ${quoteLiteral(value)}`
}

function timestampLiteral(value: string): string {
  return `${quoteLiteral(value)}::timestamptz`
}

function stripSemicolon(query: string): string {
  return query.trim().replace(/;\s*$/, '')
}

function orderFragment(order: HypertableColumnstoreSnapshot['orderBy'][number]): string {
  const parts = [quoteIdent(order.column)]
  if (order.direction) parts.push(order.direction.toUpperCase())
  if (order.nulls) parts.push(`NULLS ${order.nulls.toUpperCase()}`)
  return parts.join(' ')
}
