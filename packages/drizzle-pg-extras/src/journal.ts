import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PgExtrasError } from './errors.js'
import type { Snapshot } from './snapshot.js'

export const BREAKPOINT = '--> statement-breakpoint'
export const EXTRAS_SNAPSHOT = '_pg-extras.json'

export type WriteMigrationInput = {
  out: string
  name: string
  up: string
  down: string
  snapshot: Snapshot
}

export type WrittenMigration = {
  tag: string
  sqlPath: string
  downPath: string
}

export function joinStatements(statements: readonly string[], breakpoints: boolean, header: string): string {
  const body = statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0)
  if (body.length === 0) return ''
  const separator = breakpoints ? `\n${BREAKPOINT}\n` : '\n'
  return `${header}\n${body.join(separator)}\n`
}

export function splitMigrationSql(sql: string): string[] {
  return sql
    .split(BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}

export function extrasSnapshotPath(out: string): string {
  return path.join(out, EXTRAS_SNAPSHOT)
}

export function readExtrasSnapshotFile(out: string): unknown {
  const file = extrasSnapshotPath(out)
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8')) as unknown
}

export function sanitizeMigrationName(name: string): string {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
    .replace(/_+$/g, '')
  if (!clean) throw new PgExtrasError(`migration name "${name}" is empty after sanitizing`)
  return clean
}

export function writeMigration(input: WriteMigrationInput): WrittenMigration {
  const out = path.resolve(input.out)
  mkdirSync(out, { recursive: true })
  if (existsSync(path.join(out, 'meta', '_journal.json'))) {
    throw new PgExtrasError(
      `migrations folder ${out} uses the drizzle-kit 0.x journal layout. Run \`drizzle-kit up\` with drizzle-kit 1.0 to convert it first.`,
    )
  }
  const written = writeFolder(out, input)
  writeFileSync(extrasSnapshotPath(out), `${JSON.stringify(input.snapshot, null, 2)}\n`)
  return written
}

/**
 * The snapshot that chains a new migration after the last one: what `drizzle-kit generate --custom`
 * writes for a migration with no schema change. drizzle-kit 1.0 stores one base snapshot, then diffs
 * chained through prevIds. A first migration in an empty folder has none; kit writes its base later.
 * Read before anything is written, so a folder kit 1.0 cannot read is refused untouched.
 */
function nextSnapshot(previous: string | null): Record<string, unknown> | null {
  if (!previous || !existsSync(previous)) return null
  const parsed = JSON.parse(readFileSync(previous, 'utf8')) as Record<string, unknown>
  if (typeof parsed.id !== 'string' || (parsed.type !== 'base' && parsed.type !== 'diff')) {
    throw new PgExtrasError(
      `${previous} is not a drizzle-kit 1.0 snapshot. Run \`drizzle-kit up\` with drizzle-kit 1.0 to convert it first.`,
    )
  }
  return {
    type: 'diff',
    version: parsed.version,
    dialect: parsed.dialect,
    id: randomUUID(),
    prevIds: [parsed.id],
    footprints: [],
    deltas: [],
  }
}

function writeFolder(out: string, input: WriteMigrationInput): WrittenMigration {
  const folders = readdirSync(out, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{14}_/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  const suffix = sanitizeMigrationName(input.name)
  let stamp = utcStamp(new Date())
  // drizzle-kit orders migration folders by name, so this one must sort after the last one,
  // even when both were written in the same second.
  const last = folders.at(-1)
  const lastStamp = last ? last.slice(0, 14) : null
  if (lastStamp && stamp <= lastStamp) stamp = bumpStamp(lastStamp)
  let folder = `${stamp}_${suffix}`
  while (existsSync(path.join(out, folder))) {
    stamp = bumpStamp(stamp)
    folder = `${stamp}_${suffix}`
  }
  const next = nextSnapshot(last ? path.join(out, last, 'snapshot.json') : null)
  const dir = path.join(out, folder)
  mkdirSync(dir, { recursive: true })
  const sqlPath = path.join(dir, 'migration.sql')
  const downPath = path.join(dir, 'down.sql')
  writeFileSync(sqlPath, input.up)
  writeFileSync(downPath, input.down)
  if (next) writeFileSync(path.join(dir, 'snapshot.json'), `${JSON.stringify(next, null, 2)}\n`)
  return { tag: folder, sqlPath, downPath }
}

function utcStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${
    pad(date.getUTCMinutes())
  }${pad(date.getUTCSeconds())}`
}

/** The next YYYYMMDDHHMMSS stamp after this one, as a real UTC time (no "…60" seconds). */
function bumpStamp(stamp: string): string {
  const at = Date.UTC(
    Number(stamp.slice(0, 4)),
    Number(stamp.slice(4, 6)) - 1,
    Number(stamp.slice(6, 8)),
    Number(stamp.slice(8, 10)),
    Number(stamp.slice(10, 12)),
    Number(stamp.slice(12, 14)),
  )
  return utcStamp(new Date(at + 1000))
}
