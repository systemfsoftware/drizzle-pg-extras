import { is } from 'drizzle-orm'
import { isPgMaterializedView, isPgView, PgRole, PgSchema, PgTable } from 'drizzle-orm/pg-core'
import {
  brand,
  declaredFunctionId,
  extrasKind,
  functionTypeSql,
  KIND,
  type PgFunction,
  type PgViewLike,
  relationIdentity,
} from './defs.js'
import { PgExtrasError } from './errors.js'
import { assertIdentifier, qualify, quoteIdent, quoteLiteral } from './quote.js'

export type RelationPrivilege = 'select' | 'insert' | 'update' | 'delete' | 'truncate' | 'references' | 'trigger'
export type FunctionPrivilege = 'execute'
export type SchemaPrivilege = 'usage' | 'create'

const RELATION_PRIVILEGES: readonly RelationPrivilege[] = [
  'select',
  'insert',
  'update',
  'delete',
  'truncate',
  'references',
  'trigger',
]

type GrantOptions = {
  to: string | PgRole
  onlyIfRoleExists?: boolean
}

export type RelationGrantConfig = GrantOptions & {
  on: PgTable | PgViewLike
  privileges: readonly [RelationPrivilege, ...RelationPrivilege[]]
}

export type FunctionGrantConfig = GrantOptions & {
  on: PgFunction
  privileges: readonly [FunctionPrivilege]
}

export type SchemaGrantConfig = GrantOptions & {
  on: PgSchema
  privileges: readonly [SchemaPrivilege, ...SchemaPrivilege[]]
}

export type PgGrant = {
  readonly [KIND]: 'grant'
  readonly role: string
  readonly on: PgTable | PgViewLike | PgFunction | PgSchema
  readonly privileges: readonly (RelationPrivilege | FunctionPrivilege | SchemaPrivilege)[]
  readonly onlyIfRoleExists: boolean
}

export type GrantSnapshot = {
  id: string
  role: string
  target: 'relation' | 'function' | 'schema'
  schema: string
  name: string
  argTypes: string[]
  privileges: string[]
  onlyIfRoleExists: boolean
}

export function pgGrant(config: RelationGrantConfig): PgGrant
export function pgGrant(config: FunctionGrantConfig): PgGrant
export function pgGrant(config: SchemaGrantConfig): PgGrant
export function pgGrant(config: RelationGrantConfig | FunctionGrantConfig | SchemaGrantConfig): PgGrant {
  const role = is(config.to, PgRole) ? config.to.name : config.to
  if (typeof role !== 'string') throw new PgExtrasError('pgGrant(): to must be a role name or a Drizzle pgRole()')
  assertIdentifier('role', role)
  if (role.toLowerCase() === 'public') {
    throw new PgExtrasError('pgGrant(): granting to PUBLIC is not supported. Grant to a named role')
  }
  const where = `pgGrant(${role})`
  const privileges = [...new Set(config.privileges)]
  if (privileges.length === 0) throw new PgExtrasError(`${where}: privileges is empty`)
  const target = grantTarget(config.on)
  if (!target) {
    throw new PgExtrasError(`${where}: on must be a Drizzle table, view, or schema, or a pgFunction() declaration`)
  }
  for (const privilege of privileges) {
    if (!PRIVILEGES[target].includes(privilege)) {
      throw new PgExtrasError(`${where}: ${privilege} does not apply to a ${target}`)
    }
  }
  if (config.onlyIfRoleExists !== undefined && typeof config.onlyIfRoleExists !== 'boolean') {
    throw new PgExtrasError(`${where}: onlyIfRoleExists must be a boolean`)
  }
  return brand(
    {
      role,
      on: config.on,
      privileges,
      onlyIfRoleExists: config.onlyIfRoleExists ?? false,
    },
    'grant',
  )
}

const PRIVILEGES: Record<GrantSnapshot['target'], readonly string[]> = {
  relation: RELATION_PRIVILEGES,
  function: ['execute'],
  schema: ['usage', 'create'],
}

function grantTarget(on: unknown): GrantSnapshot['target'] | null {
  if (extrasKind(on) === 'function') return 'function'
  if (is(on, PgSchema)) return 'schema'
  if (is(on, PgTable) || isPgView(on) || isPgMaterializedView(on)) return 'relation'
  return null
}

export function snapshotGrant(grant: PgGrant): GrantSnapshot {
  const privileges = [...grant.privileges].sort()
  if (is(grant.on, PgSchema)) {
    return {
      id: JSON.stringify(['grant', grant.role, 'schema', grant.on.schemaName]),
      role: grant.role,
      target: 'schema',
      schema: grant.on.schemaName,
      name: grant.on.schemaName,
      argTypes: [],
      privileges,
      onlyIfRoleExists: grant.onlyIfRoleExists,
    }
  }
  if (extrasKind(grant.on) === 'function') {
    const fn = grant.on as PgFunction
    const argTypes = fn.args.filter((arg) => arg.mode !== 'out').map((arg) => functionTypeSql(arg.type))
    return {
      id: JSON.stringify(['grant', grant.role, 'function', declaredFunctionId(fn)]),
      role: grant.role,
      target: 'function',
      schema: fn.schema,
      name: fn.name,
      argTypes,
      privileges,
      onlyIfRoleExists: grant.onlyIfRoleExists,
    }
  }
  const identity = relationIdentity(grant.on as PgTable | PgViewLike)
  return {
    id: JSON.stringify(['grant', grant.role, 'relation', identity.schema, identity.name]),
    role: grant.role,
    target: 'relation',
    schema: identity.schema,
    name: identity.name,
    argTypes: [],
    privileges,
    onlyIfRoleExists: grant.onlyIfRoleExists,
  }
}

export function mergeGrants(grants: readonly GrantSnapshot[]): GrantSnapshot[] {
  const byId = new Map<string, GrantSnapshot>()
  for (const grant of grants) {
    const existing = byId.get(grant.id)
    if (!existing) {
      byId.set(grant.id, grant)
      continue
    }
    if (existing.onlyIfRoleExists !== grant.onlyIfRoleExists) {
      throw new PgExtrasError(
        `grants to ${grant.role} on ${grant.schema}.${grant.name} disagree on onlyIfRoleExists`,
      )
    }
    byId.set(grant.id, { ...existing, privileges: [...new Set([...existing.privileges, ...grant.privileges])].sort() })
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function objectSql(grant: GrantSnapshot): string {
  if (grant.target === 'function') return `FUNCTION ${qualify(grant.schema, grant.name)}(${grant.argTypes.join(', ')})`
  if (grant.target === 'schema') return `SCHEMA ${quoteIdent(grant.schema)}`
  return qualify(grant.schema, grant.name)
}

function guarded(grant: GrantSnapshot, statement: string): string {
  if (!grant.onlyIfRoleExists) return statement
  return [
    'DO $grant$',
    'BEGIN',
    `  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(grant.role)}) THEN`,
    `    ${statement}`,
    '  END IF;',
    'END',
    '$grant$;',
  ].join('\n')
}

export function grantSql(grant: GrantSnapshot, privileges: readonly string[] = grant.privileges): string {
  const list = privileges.map((privilege) => privilege.toUpperCase()).join(', ')
  return guarded(grant, `GRANT ${list} ON ${objectSql(grant)} TO ${quoteIdent(grant.role)};`)
}

export function revokeSql(grant: GrantSnapshot, privileges: readonly string[] = grant.privileges): string {
  const list = privileges.map((privilege) => privilege.toUpperCase()).join(', ')
  return guarded(grant, `REVOKE ${list} ON ${objectSql(grant)} FROM ${quoteIdent(grant.role)};`)
}

export type GrantTargets = {
  gone: (grant: GrantSnapshot) => boolean
  recreated: (grant: GrantSnapshot) => boolean
}

export function grantChanges(
  from: readonly GrantSnapshot[],
  to: readonly GrantSnapshot[],
  targets: GrantTargets,
): { revoke: string[]; grant: string[] } {
  const fromMap = new Map(from.map((grant) => [grant.id, grant]))
  const toMap = new Map(to.map((grant) => [grant.id, grant]))
  const revoke: string[] = []
  const grant: string[] = []
  for (const prev of from) {
    if (toMap.has(prev.id) || targets.gone(prev) || targets.recreated(prev)) continue
    revoke.push(revokeSql(prev))
  }
  for (const next of to) {
    const prev = fromMap.get(next.id)
    if (!prev || targets.recreated(next)) {
      grant.push(grantSql(next))
      continue
    }
    const removed = prev.privileges.filter((privilege) => !next.privileges.includes(privilege))
    const added = next.privileges.filter((privilege) => !prev.privileges.includes(privilege))
    if (removed.length > 0) revoke.push(revokeSql(next, removed))
    if (added.length > 0) grant.push(grantSql(next, added))
  }
  return { revoke, grant }
}

export function normalizeGrantSnapshot(value: unknown): GrantSnapshot {
  if (!value || typeof value !== 'object') throw new PgExtrasError('pg extras snapshot grant is not an object')
  const raw = value as Partial<GrantSnapshot>
  if (
    typeof raw.id !== 'string' || typeof raw.role !== 'string' || typeof raw.schema !== 'string' ||
    typeof raw.name !== 'string' || (raw.target !== 'relation' && raw.target !== 'function' && raw.target !== 'schema')
  ) {
    throw new PgExtrasError('pg extras snapshot grant is missing its role or object')
  }
  const strings = (items: unknown): string[] =>
    Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string') : []
  return {
    id: raw.id,
    role: raw.role,
    target: raw.target,
    schema: raw.schema,
    name: raw.name,
    argTypes: strings(raw.argTypes),
    privileges: strings(raw.privileges),
    onlyIfRoleExists: raw.onlyIfRoleExists === true,
  }
}
