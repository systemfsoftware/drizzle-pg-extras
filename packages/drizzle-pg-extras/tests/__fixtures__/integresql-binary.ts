import { Data, Effect, Schedule, Schema } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { arch } from 'node:process'
import { gunzipSync } from 'node:zlib'

const REPOSITORY = 'allaboutapps/integresql'

const V1_1_0_LAYER_DIGESTS: Readonly<Record<string, string>> = {
  x64: 'sha256:8e4268615a42a8e45def4ecc7397241c9b598c3731e4c0a0c951c39e0c48093c',
  arm64: 'sha256:77ba01934c00eb411a42df97af551d904dcc02b8d3db1027101378923f32aab3',
}

const CACHE = path.join(homedir(), '.cache', 'drizzle-pg-extras', 'integresql-layers')

const BLOCK = 512

export class IntegresqlUnavailable extends Data.TaggedError('IntegresqlUnavailable')<{ readonly reason: string }> {
  override get message(): string {
    return `the pinned IntegreSQL binary is unavailable: ${this.reason}`
  }
}

const unavailable = (cause: unknown) =>
  new IntegresqlUnavailable({ reason: cause instanceof Error ? cause.message : String(cause) })

const digestOf = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

const entryOf = (archive: Uint8Array, name: string): Uint8Array | undefined => {
  let offset = 0
  while (offset + BLOCK <= archive.length) {
    const header = Buffer.from(archive.subarray(offset, offset + BLOCK))
    const nameEnd = header.indexOf(0)
    const entry = header.toString('latin1', 0, nameEnd === -1 || nameEnd > 100 ? 100 : nameEnd).replace(/^\.\//, '')
    if (entry === '') return undefined
    const size = Number.parseInt(header.toString('latin1', 124, 136).replace(/\0/g, '').trim(), 8)
    const data = offset + BLOCK
    if (entry === name) return archive.subarray(data, data + size)
    offset = data + Math.ceil(size / BLOCK) * BLOCK
  }
  return undefined
}

const TokenAnswer = Schema.Struct({ token: Schema.String })

const pulled = (digest: string) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const { token } = yield* client.get(`https://ghcr.io/token?scope=repository:${REPOSITORY}:pull`).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenAnswer)),
    )
    const response = yield* client.execute(
      HttpClientRequest.get(`https://ghcr.io/v2/${REPOSITORY}/blobs/${digest}`).pipe(
        HttpClientRequest.bearerToken(token),
      ),
    ).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk))
    return new Uint8Array(yield* response.arrayBuffer)
  }).pipe(
    // A registry blip on a cold cache would fail every scenario; the digest check below still rejects a bad blob.
    Effect.retry({ schedule: Schedule.exponential('1 second'), times: 4 }),
    Effect.mapError(unavailable),
  )

const cached = (file: string) =>
  Effect.promise(() => readFile(file).then((bytes) => new Uint8Array(bytes), () => undefined))

const kept = (file: string, blob: Uint8Array) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(CACHE, { recursive: true })
      const staged = `${file}.${process.pid}.partial`
      await writeFile(staged, blob)
      await rename(staged, file)
    },
    catch: unavailable,
  })

const layerOf = (digest: string) =>
  Effect.gen(function*() {
    const file = path.join(CACHE, digest.slice('sha256:'.length))
    const hit = yield* cached(file)
    if (hit && digestOf(hit) === digest) return hit
    const blob = yield* pulled(digest)
    if (digestOf(blob) !== digest) {
      return yield* new IntegresqlUnavailable({ reason: `the pulled layer is ${digestOf(blob)}, not ${digest}` })
    }
    yield* kept(file, blob)
    return blob
  })

export const integresqlBinary = Effect.gen(function*() {
  const digest = V1_1_0_LAYER_DIGESTS[arch]
  if (!digest) return yield* new IntegresqlUnavailable({ reason: `no pinned layer for ${arch}` })
  const blob = yield* layerOf(digest)
  const archive = yield* Effect.try({ try: () => gunzipSync(blob), catch: unavailable })
  const binary = entryOf(archive, 'integresql')
  if (!binary) return yield* new IntegresqlUnavailable({ reason: `layer ${digest} holds no /integresql` })
  return binary
})
