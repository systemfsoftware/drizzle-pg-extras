import { is, SQL } from 'drizzle-orm'
import { getViewConfig, isPgMaterializedView, isPgView, type PgView } from 'drizzle-orm/pg-core'
import {
  brand,
  declaredFunctionId,
  extrasKind,
  KIND,
  type PgFunction,
  type PgViewLike,
  relationIdentity,
} from './defs.js'
import { PgExtrasError } from './errors.js'
import { assertIdentifier, qualify } from './quote.js'
import { renderSql } from './render-sql.js'

export type ViewCheckOption = 'local' | 'cascaded'

export type PgViewDefinitionConfig = {
  query: string | SQL
  dependsOn?: readonly (PgFunction | PgViewLike)[]
  securityInvoker?: boolean
  securityBarrier?: boolean
  checkOption?: ViewCheckOption
}

export type PgViewDefinition = {
  readonly [KIND]: 'viewDefinition'
  readonly view: PgView
  readonly schema: string
  readonly name: string
  readonly query: string | SQL
  readonly dependsOn: readonly (PgFunction | PgViewLike)[]
  readonly securityInvoker: boolean
  readonly securityBarrier: boolean
  readonly checkOption: ViewCheckOption | null
}

export type ViewSnapshot = {
  id: string
  schema: string
  name: string
  query: string
  securityInvoker: boolean
  securityBarrier: boolean
  checkOption: ViewCheckOption | null
  functions: string[]
  relations: string[]
}

export type ViewChanges = {
  drop: string[]
  write: string[]
  /** `schema.name` of views dropped and created again, whose comments and grants must be written again. */
  rebuilt: Set<string>
  dropped: Set<string>
}

export function viewDefinition(view: PgView, config: PgViewDefinitionConfig): PgViewDefinition {
  if (!isPgView(view)) {
    throw new PgExtrasError(
      'viewDefinition() takes a Drizzle pgView(...).existing(). Materialized views are continuousAggregate() or drizzle-kit',
    )
  }
  const viewConfig = getViewConfig(view)
  const identity = relationIdentity(view)
  const where = `viewDefinition(${identity.schema}.${identity.name})`
  if (!viewConfig.isExisting) {
    throw new PgExtrasError(`${where}: declare the Drizzle view with .existing() so drizzle-kit does not create it too`)
  }
  assertIdentifier('view', identity.name)
  assertIdentifier('view schema', identity.schema)
  const query = typeof config.query === 'string' ? config.query.trim() : config.query
  if (typeof query === 'string' && query.length === 0) throw new PgExtrasError(`${where}: query is empty`)
  if (typeof query !== 'string' && !is(query, SQL)) {
    throw new PgExtrasError(`${where}: query must be a SELECT string or a sql fragment`)
  }
  for (const dependency of config.dependsOn ?? []) {
    if (extrasKind(dependency) !== 'function' && !isPgView(dependency) && !isPgMaterializedView(dependency)) {
      throw new PgExtrasError(`${where}: dependsOn takes pgFunction() declarations and Drizzle views`)
    }
  }
  if (config.checkOption !== undefined && config.checkOption !== 'local' && config.checkOption !== 'cascaded') {
    throw new PgExtrasError(`${where}: checkOption must be "local" or "cascaded"`)
  }
  return brand(
    {
      view,
      schema: identity.schema,
      name: identity.name,
      query,
      dependsOn: [...(config.dependsOn ?? [])],
      securityInvoker: config.securityInvoker ?? false,
      securityBarrier: config.securityBarrier ?? false,
      checkOption: config.checkOption ?? null,
    },
    'viewDefinition',
  )
}

export function viewKey(schema: string, name: string): string {
  return `${schema}.${name}`
}

export function snapshotViewDefinition(definition: PgViewDefinition): ViewSnapshot {
  const functions = new Set<string>()
  const relations = new Set<string>()
  const note = (value: unknown): void => {
    if (extrasKind(value) === 'function') {
      functions.add(declaredFunctionId(value as PgFunction))
      return
    }
    if (isPgView(value) || isPgMaterializedView(value)) {
      const identity = relationIdentity(value)
      relations.add(viewKey(identity.schema, identity.name))
    }
  }
  for (const dependency of definition.dependsOn) note(dependency)
  if (typeof definition.query !== 'string') walkChunks(definition.query, note, new Set())
  relations.delete(viewKey(definition.schema, definition.name))
  const text = typeof definition.query === 'string' ? definition.query : renderSql(definition.query)
  return {
    id: JSON.stringify(['view', definition.schema, definition.name]),
    schema: definition.schema,
    name: definition.name,
    query: text.trim().replace(/;\s*$/, '').trimEnd(),
    securityInvoker: definition.securityInvoker,
    securityBarrier: definition.securityBarrier,
    checkOption: definition.checkOption,
    functions: [...functions].sort(),
    relations: [...relations].sort(),
  }
}

function walkChunks(fragment: SQL, note: (value: unknown) => void, seen: Set<unknown>): void {
  if (seen.has(fragment)) return
  seen.add(fragment)
  for (const chunk of fragment.queryChunks) {
    if (is(chunk, SQL)) {
      walkChunks(chunk, note, seen)
      continue
    }
    if (is(chunk, SQL.Aliased)) {
      walkChunks(chunk.sql, note, seen)
      continue
    }
    note(chunk)
  }
}

export function createViewSql(view: ViewSnapshot): string {
  const options: string[] = []
  if (view.securityInvoker) options.push('security_invoker = true')
  if (view.securityBarrier) options.push('security_barrier = true')
  const withClause = options.length > 0 ? ` WITH (${options.join(', ')})` : ''
  const check = view.checkOption ? `\nWITH ${view.checkOption.toUpperCase()} CHECK OPTION` : ''
  return `CREATE OR REPLACE VIEW ${qualify(view.schema, view.name)}${withClause} AS\n${view.query}${check};`
}

export function dropViewSql(view: ViewSnapshot): string {
  return `DROP VIEW IF EXISTS ${qualify(view.schema, view.name)};`
}

export function sameView(a: ViewSnapshot, b: ViewSnapshot): boolean {
  return a.query === b.query &&
    a.securityInvoker === b.securityInvoker &&
    a.securityBarrier === b.securityBarrier &&
    a.checkOption === b.checkOption
}

export function orderedViews(views: readonly ViewSnapshot[]): ViewSnapshot[] {
  const byKey = new Map(views.map((view) => [viewKey(view.schema, view.name), view]))
  const ordered: ViewSnapshot[] = []
  const done = new Set<string>()
  const visiting = new Set<string>()
  const visit = (view: ViewSnapshot): void => {
    const key = viewKey(view.schema, view.name)
    if (done.has(key)) return
    if (visiting.has(key)) throw new PgExtrasError(`view ${key} reads itself through other views`)
    visiting.add(key)
    for (const relation of view.relations) {
      const parent = byKey.get(relation)
      if (parent) visit(parent)
    }
    visiting.delete(key)
    done.add(key)
    ordered.push(view)
  }
  for (const view of [...views].sort((a, b) => a.id.localeCompare(b.id))) visit(view)
  return ordered
}

export function viewChanges(
  from: readonly ViewSnapshot[],
  to: readonly ViewSnapshot[],
  droppedFunctionIds: ReadonlySet<string>,
  rebuiltRelations: ReadonlySet<string>,
): ViewChanges {
  const fromMap = new Map(from.map((view) => [view.id, view]))
  const toMap = new Map(to.map((view) => [view.id, view]))
  const removed = from.filter((view) => !toMap.has(view.id))
  const removedKeys = new Set(removed.map((view) => viewKey(view.schema, view.name)))

  for (const view of to) {
    for (const relation of view.relations) {
      if (removedKeys.has(relation)) {
        throw new PgExtrasError(
          `view ${
            viewKey(view.schema, view.name)
          } reads view ${relation}, which was removed. Remove or change the reader in the same change.`,
        )
      }
    }
  }

  const rebuild = new Set<string>()
  const touches = (view: ViewSnapshot, keys: ReadonlySet<string>): boolean =>
    view.relations.some((relation) => keys.has(relation))
  for (const next of to) {
    const prev = fromMap.get(next.id)
    if (!prev) continue
    if (
      !sameView(prev, next) ||
      prev.functions.some((id) => droppedFunctionIds.has(id)) ||
      touches(prev, rebuiltRelations) ||
      touches(next, rebuiltRelations)
    ) {
      rebuild.add(next.id)
    }
  }
  let grew = true
  while (grew) {
    grew = false
    const stale = new Set([
      ...removedKeys,
      ...[...rebuild].map((id) => {
        const view = toMap.get(id)!
        return viewKey(view.schema, view.name)
      }),
    ])
    for (const next of to) {
      const prev = fromMap.get(next.id)
      if (!prev || rebuild.has(next.id)) continue
      if (touches(prev, stale) || touches(next, stale)) {
        rebuild.add(next.id)
        grew = true
      }
    }
  }

  const dropped = [...removed, ...[...rebuild].map((id) => fromMap.get(id)!)]
  const written = [...to.filter((view) => !fromMap.has(view.id)), ...[...rebuild].map((id) => toMap.get(id)!)]
  return {
    drop: orderedViews(dropped).reverse().map((view) => dropViewSql(view)),
    write: orderedViews(written).map((view) => createViewSql(view)),
    rebuilt: new Set([...rebuild].map((id) => {
      const view = toMap.get(id)!
      return viewKey(view.schema, view.name)
    })),
    dropped: removedKeys,
  }
}

export function normalizeViewSnapshot(value: unknown): ViewSnapshot {
  if (!value || typeof value !== 'object') throw new PgExtrasError('pg extras snapshot view is not an object')
  const raw = value as Partial<ViewSnapshot>
  if (typeof raw.schema !== 'string' || typeof raw.name !== 'string' || typeof raw.query !== 'string') {
    throw new PgExtrasError('pg extras snapshot view is missing its schema, name, or query')
  }
  const strings = (items: unknown): string[] =>
    Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string') : []
  return {
    id: JSON.stringify(['view', raw.schema, raw.name]),
    schema: raw.schema,
    name: raw.name,
    query: raw.query,
    securityInvoker: raw.securityInvoker === true,
    securityBarrier: raw.securityBarrier === true,
    checkOption: raw.checkOption === 'local' || raw.checkOption === 'cascaded' ? raw.checkOption : null,
    functions: strings(raw.functions),
    relations: strings(raw.relations),
  }
}
