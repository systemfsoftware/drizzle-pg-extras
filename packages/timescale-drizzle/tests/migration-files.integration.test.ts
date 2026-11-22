import { Gherkin, Given, it, makeFeature, Then, When } from '@systemfsoftware/effect-gherkin-spec'
import {
  defineExtras,
  generate,
  type GenerateOptions,
  type GenerateResult,
  pendingStatements,
  pgExtension,
  type PgExtras,
  pgFunction,
  pgTrigger,
  renderIdempotent,
  splitMigrationSql,
  updatedAtTrigger,
  withComment,
} from '@systemfsoftware/timescale-drizzle'
import { sql } from 'drizzle-orm'
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { Effect } from 'effect'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  Database,
  DatabaseFailed,
  freshDatabase,
  migrated,
  postgresServer,
  query,
} from './__fixtures__/database.fixture.js'

const Feature = makeFeature({ it })

const ZERO_ID = '00000000-0000-0000-0000-000000000000'
const KIT_SNAPSHOT_ID = 'kit-snapshot-id'

const accounts = withComment(
  pgTable('accounts', {
    id: integer('id').primaryKey(),
    email: text('email').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  }),
  'Customer accounts',
)

const profiles = pgTable('profiles', {
  id: integer().primaryKey(),
  email: text().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull(),
})

const accountsTable =
  'CREATE TABLE accounts (id integer PRIMARY KEY NOT NULL, email text NOT NULL, updated_at timestamp with time zone NOT NULL);'
const profilesTable =
  'CREATE TABLE profiles (id integer PRIMARY KEY NOT NULL, email text NOT NULL, updated_at timestamp with time zone NOT NULL);'

function accountExtras(extensions: readonly string[] = ['pgcrypto']) {
  const touch = pgFunction('touch_updated_at', {
    returns: 'trigger',
    language: 'plpgsql',
    body: 'BEGIN\n  NEW.updated_at = now();\n  RETURN NEW;\nEND;',
  })
  const accountsTouch = pgTrigger('accounts_touch', {
    table: accounts,
    timing: 'before',
    events: ['update'],
    when: ({ OLD, NEW }) => sql`${OLD.email} IS DISTINCT FROM ${NEW.email}`,
    function: touch,
  })
  return defineExtras({
    extensions: extensions.map((name) => pgExtension(name)),
    functions: [touch],
    triggers: [accountsTouch],
    tables: [accounts],
  })
}

const generatedWith = (
  extras: PgExtras,
  name: string,
  options: Omit<GenerateOptions, 'extras' | 'out' | 'name'> = {},
) =>
  Effect.flatMap(Database, ({ out }) =>
    Effect.try({
      try: (): GenerateResult => generate({ extras, out, name, ...options }),
      catch: (cause) => new DatabaseFailed({ step: `generate ${name}`, cause }),
    }))

type WrittenResult = Extract<GenerateResult, { written: true }>

const stringify = (value: unknown) => JSON.stringify(value)

const written = (extras: PgExtras, name: string, options: Omit<GenerateOptions, 'extras' | 'out' | 'name'> = {}) =>
  Effect.filterOrElse(
    generatedWith(extras, name, options),
    (result): result is WrittenResult => result.written,
    () => Effect.die(new Error(`nothing to migrate for ${name}`)),
  )

const migrate = (extras: PgExtras, name: string) => Effect.tap(written(extras, name), () => migrated)

const refusalOf = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.message)

const runStatements = (text: string) =>
  Effect.forEach(splitMigrationSql(text), (statement) => query(statement), { discard: true })

const runFile = (file: string) => runStatements(readFileSync(file, 'utf8'))

const files = Effect.map(Database, ({ out }) => readdirSync(out, { recursive: true }).map(String).sort())

const storedText = (text: string) =>
  Effect.flatMap(Database, ({ out }) =>
    Effect.sync(() => {
      mkdirSync(out, { recursive: true })
      writeFileSync(path.join(out, '_pg-extras.json'), text)
    }))

const storedSnapshot = (content: unknown) => storedText(stringify(content))

const catalog = Effect.map(
  query<{ extension: number; function: number; trigger: number; comment: string | null }>(
    `SELECT
       (SELECT count(*)::int FROM pg_extension WHERE extname = 'pgcrypto') AS extension,
       (SELECT count(*)::int FROM pg_proc WHERE proname = 'touch_updated_at') AS function,
       (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'accounts_touch') AS trigger,
       obj_description('public.accounts'::regclass) AS comment`,
  ),
  (rows) => rows[0],
)

const installed = (extension: string) =>
  Effect.map(
    query<{ n: number }>('SELECT count(*)::int AS n FROM pg_extension WHERE extname = $1', [extension]),
    (rows) => rows[0]?.n,
  )

const bumped = (table: string, email: string) =>
  Effect.map(
    query<{ bumped: boolean }>(
      `UPDATE ${table} SET email = $1, updated_at = '2000-01-01' WHERE id = 1 RETURNING updated_at > now() - interval '1 day' AS bumped`,
      [email],
    ),
    (rows) => rows[0]?.bumped,
  )

const triggerBehaviour = Effect.andThen(
  query("INSERT INTO accounts VALUES (1, 'ada@example.com', '2000-01-01')"),
  Effect.all({
    sameEmailBumped: bumped('accounts', 'ada@example.com'),
    newEmailBumped: bumped('accounts', 'ada@lovelace.example'),
  }),
)

const applied = (name: string, extensions?: readonly string[]) => migrate(accountExtras(extensions), name)

function writeKitFolder(out: string): void {
  const table =
    'CREATE TABLE "accounts" (\n\t"id" integer PRIMARY KEY NOT NULL,\n\t"email" text NOT NULL,\n\t"updated_at" timestamp with time zone NOT NULL\n);\n'
  const folder = path.join(out, `${currentStamp()}_accounts`)
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'migration.sql'), table)
  writeFileSync(
    path.join(folder, 'snapshot.json'),
    JSON.stringify({
      type: 'base',
      version: '10',
      dialect: 'postgres',
      id: KIT_SNAPSHOT_ID,
      prevIds: [ZERO_ID],
      footprints: [],
      ddl: [{ entityType: 'tables', schema: 'public', name: 'accounts' }],
    }),
  )
}

const kitFolder = Effect.flatMap(Database, ({ out }) => Effect.sync(() => writeKitFolder(out)))

function currentStamp(): string {
  return new Date().toISOString().replace(/[-T:]/g, '').slice(0, 14)
}

const kitSnapshotFolder = (snapshot: Record<string, unknown>) =>
  Effect.flatMap(Database, ({ out }) =>
    Effect.sync(() => {
      const folder = path.join(out, `${currentStamp()}_users`)
      mkdirSync(folder, { recursive: true })
      writeFileSync(path.join(folder, 'migration.sql'), '-- table\n')
      writeFileSync(path.join(folder, 'snapshot.json'), stringify(snapshot))
      return path.basename(folder)
    }))

type KitSnapshot = {
  id?: string
  prevIds?: string[]
  type?: string
  version?: string
  dialect?: string
  ddl?: unknown
}

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as KitSnapshot

Feature('Migration files and drift detection', { timeout: 180_000 })
  .live('a real Postgres booted in a microVM')
  .withLayer(postgresServer)
  .withScenarioLayer(freshDatabase)
  .body(({ scenario, scenarioOutline }) => {
    scenario(
      'A first migration is written as an up file, a down file and a stored snapshot, and applies',
      Gherkin.Do.pipe(
        Given('an empty database with a customer accounts table')('setup', () => query(accountsTable)),
        When('the extras are generated under a spoken migration name and migrated, and an account email changes')(
          'seen',
          () =>
            Effect.gen(function*() {
              const result = yield* migrate(accountExtras(), 'Add Accounts!')
              const { out } = yield* Database
              return {
                files: {
                  up: existsSync(result.sqlPath),
                  down: existsSync(result.downPath),
                  snapshot: existsSync(path.join(out, '_pg-extras.json')),
                  named: result.tag.endsWith('_add_accounts'),
                },
                catalog: yield* catalog,
                trigger: yield* triggerBehaviour,
              }
            }),
        ),
        Then('all three files exist, the objects are in place, and only a changed email fires the trigger')((
          s,
          expect,
        ) =>
          expect(s.seen).toEqual({
            files: { up: true, down: true, snapshot: true, named: true },
            catalog: { extension: 1, function: 1, trigger: 1, comment: 'Customer accounts' },
            trigger: { sameEmailBumped: false, newEmailBumped: true },
          })
        ),
      ),
    )

    scenario(
      'Running the down file removes what the migration added and keeps the rows',
      Gherkin.Do.pipe(
        Given('a database with the extras migrated and one account')(
          'setup',
          () =>
            Effect.andThen(query(accountsTable), applied('extras')).pipe(
              Effect.tap(() => query("INSERT INTO accounts VALUES (7, 'bo@example.com', now())")),
            ),
        ),
        When('the down file of that migration is run')('seen', (s) =>
          Effect.andThen(
            runFile(s.setup.downPath),
            Effect.all({ catalog, rows: query('SELECT id, email FROM accounts') }),
          )),
        Then('the extension, function, trigger and comment are gone and the account is still there')((s, expect) =>
          expect(s.seen).toEqual({
            catalog: { extension: 0, function: 0, trigger: 0, comment: null },
            rows: [{ id: 7, email: 'bo@example.com' }],
          })
        ),
      ),
    )

    scenario(
      'A second generate writes nothing until a declaration changes',
      Gherkin.Do.pipe(
        Given('a database with the extras already generated and migrated')(
          'setup',
          () => Effect.andThen(query(accountsTable), applied('extras')),
        ),
        When('the same extras are generated again, and then a second extension is declared and generated')(
          'seen',
          () =>
            Effect.gen(function*() {
              const before = yield* files
              const again = yield* generatedWith(accountExtras(), 'again')
              const after = yield* files
              const changed = yield* generatedWith(accountExtras(['pgcrypto', 'citext']), 'citext')
              return {
                againWritten: again.written,
                filesUntouched: before.join() === after.join(),
                changed: changed.written,
              }
            }),
        ),
        Then('the repeat writes nothing and the declared change writes a migration')((s, expect) =>
          expect(s.seen).toEqual({ againWritten: false, filesUntouched: true, changed: true })
        ),
      ),
    )

    scenario(
      'A changed declaration is written as a second migration that holds only the change and undoes only the change',
      Gherkin.Do.pipe(
        Given('a database with the extras migrated')(
          'setup',
          () => Effect.andThen(query(accountsTable), applied('extras')),
        ),
        When('a second extension is declared, generated and migrated, and then its down file is run')(
          'seen',
          () =>
            Effect.gen(function*() {
              const result = yield* migrate(accountExtras(['pgcrypto', 'citext']), 'citext')
              const upText = readFileSync(result.sqlPath, 'utf8')
              const afterUp = { citext: yield* installed('citext'), pgcrypto: yield* installed('pgcrypto') }
              yield* runFile(result.downPath)
              return {
                up: { addsNew: upText.includes('citext'), repeatsOld: upText.includes('pgcrypto') },
                afterUp,
                afterDown: {
                  citext: yield* installed('citext'),
                  pgcrypto: yield* installed('pgcrypto'),
                  trigger: (yield* catalog)?.trigger,
                },
              }
            }),
        ),
        Then('the second migration only adds the new extension, and its down file removes only that extension')((
          s,
          expect,
        ) =>
          expect(s.seen).toEqual({
            up: { addsNew: true, repeatsOld: false },
            afterUp: { citext: 1, pgcrypto: 1 },
            afterDown: { citext: 0, pgcrypto: 1, trigger: 1 },
          })
        ),
      ),
    )

    scenario(
      'The drift check lists exactly the declarations that no migration holds yet, and writes nothing',
      Gherkin.Do.pipe(
        Given('an empty database with a customer accounts table')('setup', () => query(accountsTable)),
        When('the drift check runs before the first migration, after it, and after a new extension is declared')(
          'seen',
          () =>
            Effect.gen(function*() {
              const { out } = yield* Database
              const unmigrated = pendingStatements(accountExtras(), out)
              const filesAfterCheck = yield* files
              yield* migrate(accountExtras(), 'extras')
              const clean = pendingStatements(accountExtras(), out)
              const drifted = pendingStatements(accountExtras(['pgcrypto', 'citext']), out)
              return {
                unmigrated: unmigrated.length > 0,
                checkWroteNothing: filesAfterCheck.length === 0,
                clean: clean.length,
                drifted: drifted.length > 0 && drifted.every((statement) => statement.includes('citext')),
              }
            }),
        ),
        Then(
          'the first check finds work, the clean check finds none, and the changed check finds only the new extension',
        )((
          s,
          expect,
        ) => expect(s.seen).toEqual({ unmigrated: true, checkWroteNothing: true, clean: 0, drifted: true })),
      ),
    )

    scenario(
      'Applying the idempotent rendering again restores every object a database lost',
      Gherkin.Do.pipe(
        Given('a database whose migrated extras were then dropped')('setup', () =>
          Effect.andThen(
            Effect.andThen(query(accountsTable), applied('extras')),
            Effect.andThen(
              query('DROP TRIGGER accounts_touch ON accounts'),
              Effect.andThen(
                query('DROP FUNCTION touch_updated_at()'),
                Effect.andThen(query('DROP EXTENSION pgcrypto'), query('COMMENT ON TABLE accounts IS NULL')),
              ),
            ),
          )),
        When('the idempotent rendering is run twice and an account email changes')('seen', () =>
          Effect.andThen(
            Effect.andThen(
              runStatements(renderIdempotent(accountExtras())),
              runStatements(renderIdempotent(accountExtras())),
            ),
            Effect.all({ catalog, trigger: triggerBehaviour }),
          )),
        Then('the extension, function, trigger and comment are back and the trigger fires on a changed email')((
          s,
          expect,
        ) =>
          expect(s.seen).toEqual({
            catalog: { extension: 1, function: 1, trigger: 1, comment: 'Customer accounts' },
            trigger: { sameEmailBumped: false, newEmailBumped: true },
          })
        ),
      ),
    )

    scenario(
      'The extras migration runs after the table migration drizzle-kit already wrote',
      Gherkin.Do.pipe(
        Given('a migrations folder that drizzle-kit wrote for the accounts table')('setup', () => kitFolder),
        When('the extras are generated into that folder and the folder is migrated')('seen', () =>
          Effect.andThen(
            migrate(accountExtras(), 'extras'),
            Effect.all({ catalog, trigger: triggerBehaviour }),
          )),
        Then('the table exists, the extras are applied, and the trigger fires on a changed email')((s, expect) =>
          expect(s.seen).toEqual({
            catalog: { extension: 1, function: 1, trigger: 1, comment: 'Customer accounts' },
            trigger: { sameEmailBumped: false, newEmailBumped: true },
          })
        ),
      ),
    )

    scenario(
      'The extras migration chains after the drizzle-kit snapshot, even in the same second, and keeps its content',
      Gherkin.Do.pipe(
        Given('a migrations folder that drizzle-kit wrote for the accounts table a moment ago')(
          'setup',
          () => kitFolder,
        ),
        When('the extras are generated into that folder')('seen', () =>
          Effect.gen(function*() {
            const result = yield* written(accountExtras(), 'extras')
            const { out } = yield* Database
            const snapshot = readJson(path.join(out, result.tag, 'snapshot.json'))
            return {
              previous: (snapshot.prevIds as string[])[0],
              migrations: readdirSync(out).filter((entry) => /^\d{14}_/.test(entry)).sort().map((entry) =>
                entry.replace(/^\d+_/, '')
              ),
              kitContentKept: snapshot.type === 'diff' && !('ddl' in snapshot),
            }
          })),
        Then('the new snapshot points at the kit snapshot, the migrations are in order, and the kit content is kept')((
          s,
          expect,
        ) =>
          expect(s.seen).toEqual({
            previous: KIT_SNAPSHOT_ID,
            migrations: ['accounts', 'extras'],
            kitContentKept: true,
          })
        ),
      ),
    )

    scenarioOutline(
      'A migrations folder written by drizzle-kit 0.x is refused until drizzle-kit up converts it: <layout>',
      [
        {
          layout: 'a journal',
          folder: { 'meta/_journal.json': stringify({ version: '7', dialect: 'postgresql', entries: [] }) },
        },
        {
          layout: 'a 0.x snapshot inside a migration folder',
          folder: {
            '20240101000000_users/migration.sql': '-- table\n',
            '20240101000000_users/snapshot.json': stringify({ id: 'prev-id', prevId: ZERO_ID, version: '7' }),
          },
        },
      ] as const,
      (row) =>
        Gherkin.Do.pipe(
          Given('a migrations folder that drizzle-kit 0.x wrote')('before', () =>
            Effect.flatMap(Database, ({ out }) =>
              Effect.andThen(
                Effect.sync(() => {
                  for (const [file, text] of Object.entries(row.folder)) {
                    mkdirSync(path.dirname(path.join(out, file)), { recursive: true })
                    writeFileSync(path.join(out, file), text)
                  }
                }),
                files,
              ))),
          When('an extension is generated into that folder')('seen', () =>
            Effect.all({
              refusal: refusalOf(generatedWith(defineExtras({ extensions: [pgExtension('pgcrypto')] }), 'ext')),
              files,
            })),
          Then('the generate is refused with the drizzle-kit up advice and the folder is left as it was')((s, expect) =>
            expect({ advice: s.seen.refusal.includes('drizzle-kit up'), files: s.seen.files })
              .toEqual({ advice: true, files: s.before })
          ),
        ),
    )

    scenario(
      'A drizzle-kit 1.0 base snapshot is followed by a diff snapshot that sorts after it, even in the same second',
      Gherkin.Do.pipe(
        Given('a migrations folder holding a drizzle-kit 1.0 base snapshot written this second')(
          'folder',
          () =>
            kitSnapshotFolder({
              type: 'base',
              version: '10',
              dialect: 'postgres',
              id: 'base-id',
              prevIds: [ZERO_ID],
              footprints: [],
              ddl: [{ kind: 'table' }],
            }),
        ),
        When('an extension is generated into that folder')('seen', (s) =>
          Effect.gen(function*() {
            const result = yield* written(defineExtras({ extensions: [pgExtension('pgcrypto')] }), 'ext')
            const next = readJson(path.join(path.dirname(result.sqlPath), 'snapshot.json'))
            return {
              sortsAfter: result.tag > s.folder,
              snapshot: { type: next.type, version: next.version, dialect: next.dialect, prevIds: next.prevIds },
              ownsNoDdl: !('ddl' in next),
              newId: next.id !== 'base-id',
            }
          })),
        Then('the new migration sorts after the base and its snapshot is a diff that points at the base')((s, expect) =>
          expect(s.seen).toEqual({
            sortsAfter: true,
            snapshot: { type: 'diff', version: '10', dialect: 'postgres', prevIds: ['base-id'] },
            ownsNoDdl: true,
            newId: true,
          })
        ),
      ),
    )

    scenario(
      'A snapshot stored by an older version, without the newer sections, is read and only new declarations are written',
      Gherkin.Do.pipe(
        Given(
          'a database with an extension and the snapshot an older version stored for it, which lacks newer sections',
        )(
          'setup',
          () =>
            Effect.andThen(
              query('CREATE EXTENSION pgcrypto'),
              storedSnapshot({
                version: 1,
                functions: [],
                triggers: [],
                extensions: [{ id: 'pgcrypto', name: 'pgcrypto', schema: null, version: null, cascade: false }],
                comments: [],
              }),
            ),
        ),
        When('a second extension is declared next to it, generated and migrated')('seen', () =>
          Effect.gen(function*() {
            const result = yield* migrate(
              defineExtras({ extensions: [pgExtension('pgcrypto'), pgExtension('citext')] }),
              'citext',
            )
            const upText = readFileSync(result.sqlPath, 'utf8')
            return {
              up: { addsNew: upText.includes('citext'), repeatsOld: upText.includes('pgcrypto') },
              citext: yield* installed('citext'),
            }
          })),
        Then('only the new extension is written and installed')((s, expect) =>
          expect(s.seen).toEqual({ up: { addsNew: true, repeatsOld: false }, citext: 1 })
        ),
      ),
    )

    scenarioOutline(
      'A stored snapshot that is <problem> is refused, naming the file',
      [
        {
          problem: 'of a version this library does not know',
          stored: stringify({ version: 99 }),
          reason: 'pg extras snapshot version 99 is not supported',
        },
        { problem: 'not valid JSON', stored: '{"version": 1,', reason: 'JSON' },
      ] as const,
      (row) =>
        Gherkin.Do.pipe(
          Given('a migrations folder whose stored snapshot was damaged')('setup', () => storedText(row.stored)),
          When('the extras are generated')('seen', () =>
            Effect.all({
              refusal: refusalOf(generatedWith(accountExtras(), 'extras')),
              files,
            })),
          Then('the generate is refused with the file and the reason, and nothing else is written')((s, expect) =>
            expect({
              refusal: s.seen.refusal.includes('_pg-extras.json: ') && s.seen.refusal.includes(row.reason),
              files: s.seen.files,
            })
              .toEqual({ refusal: true, files: ['_pg-extras.json'] })
          ),
        ),
    )

    scenario(
      'The up and down files also run whole, as one script, the way psql runs them',
      Gherkin.Do.pipe(
        Given('an accounts table and a sql function that reads it, generated into a migration')(
          'setup',
          () =>
            Effect.andThen(
              query(accountsTable),
              written(
                defineExtras({
                  functions: [pgFunction('account_count', {
                    returns: 'bigint',
                    language: 'sql',
                    body: sql`SELECT count(*) FROM ${accounts}`,
                  })],
                }),
                'count',
              ),
            ),
        ),
        When('the up file runs as one script, the function is called, and the down file runs as one script')(
          'seen',
          (s) =>
            Effect.gen(function*() {
              yield* query(readFileSync(s.setup.sqlPath, 'utf8'))
              const counted = yield* query('SELECT account_count()::int AS n')
              yield* query(readFileSync(s.setup.downPath, 'utf8'))
              const left = yield* query("SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'account_count'")
              return { counted, left }
            }),
        ),
        Then('the function answers after the up file and is gone after the down file')((s, expect) =>
          expect(s.seen).toEqual({ counted: [{ n: 0 }], left: [{ n: 0 }] })
        ),
      ),
    )

    scenario(
      'A migration name with no letters or digits is refused before anything is written',
      Gherkin.Do.pipe(
        Given('an empty migrations folder')('setup', () => files),
        When('the extras are generated under the name of three exclamation marks')('seen', () =>
          Effect.all({
            refusal: refusalOf(generatedWith(accountExtras(), '!!!')),
            files,
          })),
        Then('the generate is refused as an empty name and the folder stays empty')((s, expect) =>
          expect({ refusal: /empty after sanitizing/.test(s.seen.refusal), files: s.seen.files })
            .toEqual({ refusal: true, files: [] })
        ),
      ),
    )

    scenario(
      'Column names follow the configured casing when the generated function writes them',
      Gherkin.Do.pipe(
        Given('a profiles table whose declared column has no explicit name but is called updated_at in the database')(
          'setup',
          () => query(profilesTable),
        ),
        When('an updated-at trigger is generated with snake_case casing, migrated, and a profile email changes')(
          'seen',
          () =>
            Effect.andThen(
              Effect.andThen(
                written(
                  defineExtras({ tables: [profiles], triggers: [updatedAtTrigger(profiles, profiles.updatedAt)] }),
                  'touch',
                  { casing: 'snake_case' },
                ),
                migrated,
              ),
              Effect.andThen(
                query("INSERT INTO profiles VALUES (1, 'ada@example.com', '2000-01-01')"),
                bumped('profiles', 'ada@lovelace.example'),
              ),
            ),
        ),
        Then('the trigger stamps the updated_at column')((s, expect) =>
          expect({ stamped: s.seen }).toEqual({ stamped: true })
        ),
      ),
    )
  })
