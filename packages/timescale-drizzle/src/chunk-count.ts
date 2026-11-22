import type { HypertableDeclaration } from './defs.js'
import { hypertableRelation, tableIdentity } from './defs.js'
import { PgExtrasError } from './errors.js'
import { intervalMilliseconds } from './read.js'

export const DEFAULT_MAX_CHUNKS = 500
const DEFAULT_CHUNK_INTERVAL = '7 days'

export type ChunkCountFinding =
  | { readonly kind: 'tooManyChunks'; readonly table: string; readonly chunks: number; readonly max: number }
  | { readonly kind: 'noRetention'; readonly table: string }
  | { readonly kind: 'unboundedTooLong'; readonly table: string; readonly chunks: number; readonly max: number }
  | { readonly kind: 'unboundedUnknown'; readonly table: string }

function chunksOver(span: string, hypertable: HypertableDeclaration): number {
  const slices = Math.ceil(
    intervalMilliseconds(span) / intervalMilliseconds(hypertable.chunkTimeInterval ?? DEFAULT_CHUNK_INTERVAL),
  )
  return slices * (hypertable.numberPartitions ?? 1)
}

export function chunkCountFindings(
  hypertables: readonly HypertableDeclaration[],
  maxChunks: number,
): ChunkCountFinding[] {
  if (!Number.isInteger(maxChunks) || maxChunks < 1) {
    throw new PgExtrasError('maxChunks must be a positive whole number')
  }
  const findings: ChunkCountFinding[] = []
  for (const hypertable of hypertables) {
    const identity = tableIdentity(hypertableRelation(hypertable))
    const table = `${identity.schema}.${identity.name}`
    const retained = hypertable.retention?.dropAfter ?? hypertable.retention?.dropCreatedBefore ?? null
    if (retained !== null) {
      const chunks = chunksOver(retained, hypertable)
      if (chunks > maxChunks) findings.push({ kind: 'tooManyChunks', table, chunks, max: maxChunks })
    } else if (!hypertable.unboundedRetention) {
      findings.push({ kind: 'noRetention', table })
    } else if (hypertable.expectedHistory === null) {
      findings.push({ kind: 'unboundedUnknown', table })
    } else {
      const chunks = chunksOver(hypertable.expectedHistory, hypertable)
      if (chunks > maxChunks) findings.push({ kind: 'unboundedTooLong', table, chunks, max: maxChunks })
    }
  }
  return findings
}

export function describeFinding(finding: ChunkCountFinding): string {
  switch (finding.kind) {
    case 'tooManyChunks':
      return `${finding.table}: retention keeps about ${finding.chunks} chunks, over the limit of ${finding.max}. Raise chunkTimeInterval or shorten retention.`
    case 'noRetention':
      return `${finding.table}: no retention. Declare retention.dropAfter, or retention: 'unbounded' to choose unbounded growth.`
    case 'unboundedTooLong':
      return `${finding.table}: unbounded retention over its expected history is about ${finding.chunks} chunks, over the limit of ${finding.max}. Raise chunkTimeInterval.`
    case 'unboundedUnknown':
      return `${finding.table}: unbounded retention grows without limit, so its chunk count is not checked. Declare expectedHistory to check it.`
  }
}

export function blocking(finding: ChunkCountFinding): boolean {
  return finding.kind !== 'unboundedUnknown'
}
