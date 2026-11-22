import { Gherkin, Given, it, makeFeature, Then, When } from '@systemfsoftware/effect-gherkin-spec'
import {
  commentOn,
  defineExtras,
  generate,
  pgExtension,
  pgFunction,
  pgTrigger,
  renderIdempotent,
  withComment,
} from '@systemfsoftware/timescale-drizzle'
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgMaterializedView,
  pgTable,
  pgView,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core'
import { Effect } from 'effect'
import {
  Database,
  DatabaseFailed,
  freshDatabase,
  generated,
  migrated,
  postgresServer,
  query,
} from './__fixtures__/database.fixture.js'

const Feature = makeFeature({ it })

const shopTables = `CREATE TYPE public.account_role AS ENUM ('admin', 'member');
CREATE TABLE public.orgs (id integer PRIMARY KEY);
CREATE TABLE public.users (
  id integer PRIMARY KEY,
  email text NOT NULL,
  org_id integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_org_positive CHECK (org_id > 0),
  CONSTRAINT users_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs (id) ON DELETE CASCADE
);
CREATE INDEX users_email_idx ON public.users (email);
CREATE TABLE public.memberships (
  user_id integer NOT NULL,
  org_id integer NOT NULL,
  CONSTRAINT memberships_pk PRIMARY KEY (user_id, org_id)
);
CREATE VIEW public.active_users AS SELECT id, email FROM public.users;
CREATE MATERIALIZED VIEW public.user_stats AS SELECT id FROM public.users;`

const migrate = (extras: ReturnType<typeof defineExtras>, name: string) =>
  Effect.andThen(generated(extras, name), migrated)

const refusalOf = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.message)

const thrownBy = (run: () => unknown) =>
  Effect.match(Effect.try({ try: run, catch: (cause) => new DatabaseFailed({ step: 'declare', cause }) }), {
    onFailure: (error) => error.message,
    onSuccess: () => 'accepted',
  })

const columnComment = (table: string, column: string) =>
  `col_description('${table}'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = '${table}'::regclass AND attname = '${column}'))`
const constraintComment = (name: string) =>
  `obj_description((SELECT oid FROM pg_constraint WHERE conname = '${name}'), 'pg_constraint')`
const extensionComment = (name: string) =>
  `obj_description((SELECT oid FROM pg_extension WHERE extname = '${name}'), 'pg_extension')`

const commentsRead = (expressions: Readonly<Record<string, string>>) =>
  Effect.map(
    query(
      Object.entries(expressions).map(([key, expression]) => `${expression} AS "${key}"`).join(', ').replace(
        /^/,
        'SELECT ',
      ),
    ),
    (rows) => rows[0],
  )

const orgs = pgTable('orgs', { id: integer('id').primaryKey() })

function lifecycleSchema(stage: 'before' | 'after') {
  const accountRole = pgEnum('account_role', ['admin', 'member'])
  const touch = pgFunction('touch', { returns: 'trigger', body: 'BEGIN RETURN NEW; END;' })
  const users = pgTable('users', { email: text('email').notNull() }, (table) => [
    stage === 'before'
      ? withComment(index('users_email_idx').on(table.email), 'lookup')
      : index('users_email_idx').on(table.email),
  ])
  return defineExtras({
    enums: [withComment(accountRole, stage === 'before' ? 'old' : 'new')],
    functions: [stage === 'before' ? withComment(touch, 'touches') : touch],
    tables: [users],
  })
}

const lifecycleRead = commentsRead({
  role: "obj_description('public.account_role'::regtype, 'pg_type')",
  fn: "obj_description('public.touch()'::regprocedure, 'pg_proc')",
  idx: "obj_description('public.users_email_idx'::regclass, 'pg_class')",
})

Feature('Commenting database objects and declaring extensions', { timeout: 240_000 })
  .live('a real Postgres booted in a microVM')
  .withLayer(postgresServer)
  .withScenarioLayer(freshDatabase)
  .body(({ scenario }) => {
    scenario(
      'Tables, columns, enums, views and materialized views carry their declared comments',
      Gherkin.Do.pipe(
        Given('a shop with an account role, users, a view and a materialized view')('setup', () => query(shopTables)),
        When('their comments are declared and migrated')('seen', () => {
          const users = withComment(
            pgTable('users', {
              id: integer('id').primaryKey(),
              email: withComment(text('email').notNull(), 'Login email'),
            }),
            'Application users',
          )
          const activeUsers = withComment(
            pgView('active_users', { email: withComment(text('email'), 'Visible email') }).as(
              sql`select email from users`,
            ),
            'Visible users',
          )
          const userStats = withComment(
            pgMaterializedView('user_stats', { id: integer('id') }).as(sql`select id from users`),
            'One row per user',
          )
          return Effect.andThen(
            migrate(
              defineExtras({
                enums: [withComment(pgEnum('account_role', ['admin', 'member']), 'Account role')],
                tables: [users],
                views: [activeUsers, userStats],
              }),
              'relations',
            ),
            commentsRead({
              table: "obj_description('public.users'::regclass, 'pg_class')",
              column: columnComment('public.users', 'email'),
              role: "obj_description('public.account_role'::regtype, 'pg_type')",
              view: "obj_description('public.active_users'::regclass, 'pg_class')",
              viewColumn: columnComment('public.active_users', 'email'),
              matview: "obj_description('public.user_stats'::regclass, 'pg_class')",
            }),
          )
        }),
        Then('each object shows the comment declared for it')((s, expect) =>
          expect(s.seen).toEqual({
            table: 'Application users',
            column: 'Login email',
            role: 'Account role',
            view: 'Visible users',
            viewColumn: 'Visible email',
            matview: 'One row per user',
          })
        ),
      ),
    )

    scenario(
      'Functions, triggers and extensions carry their declared comments',
      Gherkin.Do.pipe(
        Given('a shop with a users table')('setup', () => query(shopTables)),
        When('a function, a trigger on users and an extension are declared with comments and migrated')('seen', () => {
          const users = pgTable('users', { id: integer('id').primaryKey() })
          const touch = withComment(
            pgFunction('set_updated_at', { returns: 'trigger', body: 'BEGIN RETURN NEW; END;' }),
            'Sets updated_at',
          )
          const addOne = withComment(
            pgFunction('add_one', {
              args: [{ name: 'n', type: 'integer' }],
              returns: 'integer',
              language: 'sql',
              body: sql`select n + 1`,
            }),
            'Adds one',
          )
          const usersTouch = withComment(
            pgTrigger('users_touch', { table: users, timing: 'before', events: ['update'], function: touch }),
            'Keeps updated_at current',
          )
          return Effect.andThen(
            migrate(
              defineExtras({
                tables: [users],
                functions: [touch, addOne],
                triggers: [usersTouch],
                extensions: [withComment(pgExtension('pgcrypto'), 'Cryptographic functions')],
              }),
              'code',
            ),
            commentsRead({
              touch: "obj_description('public.set_updated_at()'::regprocedure, 'pg_proc')",
              addOne: "obj_description('public.add_one(integer)'::regprocedure, 'pg_proc')",
              trigger: "obj_description((SELECT oid FROM pg_trigger WHERE tgname = 'users_touch'), 'pg_trigger')",
              extension: extensionComment('pgcrypto'),
            }),
          )
        }),
        Then('each function, the trigger and the extension show their comment')((s, expect) =>
          expect(s.seen).toEqual({
            touch: 'Sets updated_at',
            addOne: 'Adds one',
            trigger: 'Keeps updated_at current',
            extension: 'Cryptographic functions',
          })
        ),
      ),
    )

    scenario(
      'Indexes and constraints carry their declared comments',
      Gherkin.Do.pipe(
        Given(
          'a shop whose users have an email index, a unique, a check and a foreign key, and memberships have a key',
        )(
          'setup',
          () => query(shopTables),
        ),
        When('a comment is declared on each of them and migrated')('seen', () => {
          const users = pgTable('users', {
            id: integer('id').primaryKey(),
            email: text('email').notNull(),
            orgId: integer('org_id').notNull(),
          }, (table) => [
            withComment(index('users_email_idx').on(table.email), 'Lookup by email'),
            withComment(unique('users_email_key').on(table.email), 'One email'),
            withComment(check('users_org_positive', sql`${table.orgId} > 0`), 'Org id is positive'),
            withComment(
              foreignKey({ name: 'users_org_fk', columns: [table.orgId], foreignColumns: [orgs.id] }).onDelete(
                'cascade',
              ),
              'Employer',
            ),
          ])
          const memberships = pgTable('memberships', {
            userId: integer('user_id').notNull(),
            orgId: integer('org_id').notNull(),
          }, (table) => [
            withComment(primaryKey({ name: 'memberships_pk', columns: [table.userId, table.orgId] }), 'Membership key'),
          ])
          return Effect.andThen(
            migrate(defineExtras({ tables: [orgs, users, memberships] }), 'constraints'),
            commentsRead({
              idx: "obj_description('public.users_email_idx'::regclass, 'pg_class')",
              unique: constraintComment('users_email_key'),
              check: constraintComment('users_org_positive'),
              foreignKey: constraintComment('users_org_fk'),
              primaryKey: constraintComment('memberships_pk'),
            }),
          )
        }),
        Then('the index and every constraint show the comment declared for it')((s, expect) =>
          expect(s.seen).toEqual({
            idx: 'Lookup by email',
            unique: 'One email',
            check: 'Org id is positive',
            foreignKey: 'Employer',
            primaryKey: 'Membership key',
          })
        ),
      ),
    )

    scenario(
      'An unnamed index is commented under the name drizzle-kit gave it, with snake case column names',
      Gherkin.Do.pipe(
        Given('a posts table with an index named the way drizzle-kit names it')('setup', () =>
          query(
            'CREATE TABLE public.posts (updated_at timestamptz NOT NULL); CREATE INDEX posts_updated_at_index ON public.posts (updated_at);',
          )),
        When('a comment is declared on the unnamed index with the snake case option and migrated')('seen', () => {
          const posts = pgTable('posts', { updatedAt: timestamp().notNull() }, (table) => [
            withComment(index().on(table.updatedAt), 'By update time'),
          ])
          return Effect.andThen(
            Effect.flatMap(Database, ({ out }) =>
              Effect.try({
                try: () =>
                  generate({ extras: defineExtras({ tables: [posts] }), out, name: 'unnamed', casing: 'snake_case' }),
                catch: (cause) => new DatabaseFailed({ step: 'generate unnamed', cause }),
              })),
            Effect.andThen(
              migrated,
              commentsRead({ idx: "obj_description('public.posts_updated_at_index'::regclass, 'pg_class')" }),
            ),
          )
        }),
        Then('that index shows the comment')((s, expect) => expect(s.seen).toEqual({ idx: 'By update time' })),
      ),
    )

    scenario(
      'An index built on an expression needs a name before its comment is accepted',
      Gherkin.Do.pipe(
        Given('a shop with users')('setup', () => query(shopTables)),
        When('a comment is declared on an unnamed index over lower-cased email, and then on a named one')(
          'seen',
          () => {
            const unnamed = pgTable('users', { email: text('email').notNull() }, (table) => [
              withComment(index().on(sql`lower(${table.email})`), 'Case-insensitive email'),
            ])
            const named = pgTable('users', { email: text('email').notNull() }, (table) => [
              withComment(index('users_email_lower').on(sql`lower(${table.email})`), 'Case-insensitive email'),
            ])
            return Effect.all({
              refusal: refusalOf(generated(defineExtras({ tables: [unnamed] }), 'unnamed')),
              written: generated(defineExtras({ tables: [named] }), 'named'),
            })
          },
        ),
        Then('the unnamed one is refused for lacking an index name and the named one is accepted')((s, expect) =>
          expect({ refusal: /index name/.test(s.seen.refusal), written: s.seen.written.written }).toEqual({
            refusal: true,
            written: true,
          })
        ),
      ),
    )

    scenario(
      'Changing a comment updates it and removing a declared comment clears it',
      Gherkin.Do.pipe(
        Given('a shop whose role, function and index comments are already migrated')(
          'setup',
          () => Effect.andThen(query(shopTables), migrate(lifecycleSchema('before'), 'before')),
        ),
        When('the role comment is reworded and the function and index comments are removed')(
          'seen',
          () => Effect.andThen(migrate(lifecycleSchema('after'), 'after'), lifecycleRead),
        ),
        Then('the role shows the new wording and the function and the index show no comment')((s, expect) =>
          expect(s.seen).toEqual({ role: 'new', fn: null, idx: null })
        ),
      ),
    )

    scenario(
      'A function recreated because its return type changed keeps its comment',
      Gherkin.Do.pipe(
        Given('a shop with a commented trigger function that is already migrated')('setup', () =>
          Effect.andThen(
            query(shopTables),
            migrate(
              defineExtras({
                functions: [
                  withComment(pgFunction('touch', { returns: 'trigger', body: 'BEGIN RETURN NEW; END;' }), 'touches'),
                ],
              }),
              'first',
            ),
          )),
        When('the function is redeclared to return nothing, with the same comment')('seen', () =>
          Effect.andThen(
            migrate(
              defineExtras({
                functions: [
                  withComment(
                    pgFunction('touch', { returns: 'void', language: 'sql', body: sql`select 1` }),
                    'touches',
                  ),
                ],
              }),
              'second',
            ),
            Effect.all({
              comment: commentsRead({ fn: "obj_description('public.touch()'::regprocedure, 'pg_proc')" }),
              returns: query("SELECT pg_get_function_result('public.touch()'::regprocedure) AS result"),
            }),
          )),
        Then('the function returns nothing and still shows the comment')((s, expect) =>
          expect({ comment: s.seen.comment, returns: s.seen.returns }).toEqual({
            comment: { fn: 'touches' },
            returns: [{ result: 'void' }],
          })
        ),
      ),
    )

    scenario(
      'Removing a commented function from the declarations drops it without error',
      Gherkin.Do.pipe(
        Given('a shop with a commented function that is already migrated')('setup', () =>
          Effect.andThen(
            query(shopTables),
            migrate(
              defineExtras({
                functions: [
                  withComment(pgFunction('touch', { returns: 'trigger', body: 'BEGIN RETURN NEW; END;' }), 'touches'),
                ],
              }),
              'first',
            ),
          )),
        When('the function is no longer declared and the change is migrated')('seen', () =>
          Effect.andThen(
            migrate(defineExtras({}), 'second'),
            query("SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'touch'"),
          )),
        Then('the function is gone')((s, expect) => expect(s.seen).toEqual([{ n: 0 }])),
      ),
    )

    scenario(
      'Comments given with the comment helper escape quotes and leave function bodies intact',
      Gherkin.Do.pipe(
        Given('a shop with an account role, users and a view')('setup', () => query(shopTables)),
        When('comments are attached to an enum, a view, a function and a table and migrated')('seen', () => {
          const accountRole = pgEnum('account_role', ['admin', 'member'])
          const users = pgTable('users', { id: integer('id').primaryKey() })
          const activeUsers = pgView('active_users', { id: integer('id') }).as(sql`select id from users`)
          const odd = pgFunction('odd', { returns: 'text', language: 'sql', body: "SELECT '$function$'" })
          return Effect.andThen(
            migrate(
              defineExtras({
                enums: [accountRole],
                tables: [users],
                views: [activeUsers],
                functions: [odd],
                comments: [
                  commentOn(accountRole, 'Role'),
                  commentOn(activeUsers, 'Active'),
                  commentOn(odd, 'Odd'),
                  commentOn(users, "it's a table"),
                ],
              }),
              'helper',
            ),
            Effect.all({
              comments: commentsRead({
                role: "obj_description('public.account_role'::regtype, 'pg_type')",
                view: "obj_description('public.active_users'::regclass, 'pg_class')",
                fn: "obj_description('public.odd()'::regprocedure, 'pg_proc')",
                table: "obj_description('public.users'::regclass, 'pg_class')",
              }),
              body: query('SELECT public.odd() AS value'),
            }),
          )
        }),
        Then('the comments read back as written and the function still answers with its dollar text')((s, expect) =>
          expect(s.seen).toEqual({
            comments: { role: 'Role', view: 'Active', fn: 'Odd', table: "it's a table" },
            body: [{ value: '$function$' }],
          })
        ),
      ),
    )

    scenario(
      'Two different comments for one object and an unfinished builder are refused',
      Gherkin.Do.pipe(
        Given('a shop schema')('setup', () => query('CREATE SCHEMA shop')),
        When(
          'a role is commented twice with different texts, and a comment is attached to a view that has no query yet',
        )(
          'seen',
          () => {
            const role = withComment(pgEnum('account_role', ['admin']), 'one')
            return Effect.all({
              twice: refusalOf(
                generated(defineExtras({ enums: [role], comments: [commentOn(role, 'two')] }), 'twice'),
              ),
              unfinished: thrownBy(() => withComment(pgView('active_users') as never, 'too soon')),
            })
          },
        ),
        Then('the double comment is refused as declared twice and the view as lacking its query')((s, expect) =>
          expect({ twice: /declared twice/.test(s.seen.twice), unfinished: /\.as\(\)/.test(s.seen.unfinished) })
            .toEqual({ twice: true, unfinished: true })
        ),
      ),
    )

    scenario(
      'The idempotent script can be applied twice and leaves every comment in place',
      Gherkin.Do.pipe(
        Given('a shop with users')('setup', () => query(shopTables)),
        When('the idempotent script for a commented function and trigger is applied two times')('seen', () => {
          const users = pgTable('users', { id: integer('id').primaryKey() })
          const touch = withComment(
            pgFunction('touch', { returns: 'trigger', body: 'BEGIN RETURN NEW; END;' }),
            'touches',
          )
          const trigger = withComment(
            pgTrigger('users_touch', { table: users, timing: 'before', events: ['update'], function: touch }),
            'Keeps updated_at current',
          )
          const script = renderIdempotent(defineExtras({ functions: [touch], triggers: [trigger], tables: [users] }))
          return Effect.andThen(
            Effect.andThen(query(script), query(script)),
            commentsRead({
              fn: "obj_description('public.touch()'::regprocedure, 'pg_proc')",
              trigger: "obj_description((SELECT oid FROM pg_trigger WHERE tgname = 'users_touch'), 'pg_trigger')",
            }),
          )
        }),
        Then('the function and the trigger show their comments')((s, expect) =>
          expect(s.seen).toEqual({ fn: 'touches', trigger: 'Keeps updated_at current' })
        ),
      ),
    )

    scenario(
      'An extension is installed into the schema it names',
      Gherkin.Do.pipe(
        Given('a database with a tools schema')('setup', () => query('CREATE SCHEMA tools')),
        When('the case-insensitive text extension is declared in the tools schema and migrated')(
          'seen',
          () =>
            Effect.andThen(
              migrate(defineExtras({ extensions: [pgExtension('citext', { schema: 'tools' })] }), 'citext'),
              query(
                "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'citext'",
              ),
            ),
        ),
        Then('the extension lives in the tools schema')((s, expect) => expect(s.seen).toEqual([{ nspname: 'tools' }])),
      ),
    )

    scenario(
      'An extension that needs another installs it too when cascade is asked for',
      Gherkin.Do.pipe(
        Given('an empty database')('setup', () => query('SELECT 1')),
        When('the earth distance extension is declared with cascade and migrated')('seen', () =>
          Effect.andThen(
            migrate(defineExtras({ extensions: [pgExtension('earthdistance', { cascade: true })] }), 'earth'),
            query("SELECT extname FROM pg_extension WHERE extname IN ('cube', 'earthdistance') ORDER BY 1"),
          )),
        Then('both the earth distance and the cube extensions are installed')((s, expect) =>
          expect(s.seen).toEqual([{ extname: 'cube' }, { extname: 'earthdistance' }])
        ),
      ),
    )

    scenario(
      'An extension that needs another is refused by the database when cascade is not asked for',
      Gherkin.Do.pipe(
        Given('an empty database')('setup', () => query('SELECT 1')),
        When('the earth distance extension is declared without cascade and migrated')('seen', () =>
          Effect.all({
            refusal: refusalOf(migrate(defineExtras({ extensions: [pgExtension('earthdistance')] }), 'earth')),
            installed: query("SELECT extname FROM pg_extension WHERE extname IN ('cube', 'earthdistance')"),
          })),
        Then('the migration fails on the earth distance extension and neither extension is installed')((s, expect) =>
          expect({ refused: /earthdistance/.test(s.seen.refusal), installed: s.seen.installed }).toEqual({
            refused: true,
            installed: [],
          })
        ),
      ),
    )

    scenario(
      'Redeclaring an extension in another schema and version moves and updates it',
      Gherkin.Do.pipe(
        Given('a tools schema and the case-insensitive text extension at version 1.5 in public, already migrated')(
          'setup',
          () =>
            Effect.andThen(
              query('CREATE SCHEMA tools'),
              migrate(
                defineExtras({ extensions: [pgExtension('citext', { schema: 'public', version: '1.5' })] }),
                'one',
              ),
            ),
        ),
        When('the extension is redeclared in the tools schema at version 1.6 and migrated')(
          'seen',
          () =>
            Effect.andThen(
              migrate(
                defineExtras({ extensions: [pgExtension('citext', { schema: 'tools', version: '1.6' })] }),
                'two',
              ),
              query(
                "SELECT n.nspname, e.extversion FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'citext'",
              ),
            ),
        ),
        Then('the extension sits in the tools schema at version 1.6')((s, expect) =>
          expect(s.seen).toEqual([{ nspname: 'tools', extversion: '1.6' }])
        ),
      ),
    )

    scenario(
      'Removing an extension from the declarations drops it',
      Gherkin.Do.pipe(
        Given('a commented extension that is already migrated')(
          'setup',
          () => migrate(defineExtras({ extensions: [withComment(pgExtension('pgcrypto'), 'crypto')] }), 'one'),
        ),
        When('the extension is no longer declared and the change is migrated')('seen', () =>
          Effect.andThen(
            migrate(defineExtras({}), 'two'),
            query("SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pgcrypto'"),
          )),
        Then('the extension is gone')((s, expect) => expect(s.seen).toEqual([{ n: 0 }])),
      ),
    )

    scenario(
      'An extension installed by hand earlier is taken over and given its comment',
      Gherkin.Do.pipe(
        Given('a database where the cryptography extension was installed by hand')(
          'setup',
          () => query('CREATE EXTENSION pgcrypto'),
        ),
        When('the extension is declared with a comment and migrated')('seen', () =>
          Effect.andThen(
            migrate(
              defineExtras({ extensions: [withComment(pgExtension('pgcrypto'), 'Cryptographic functions')] }),
              'take',
            ),
            Effect.all({
              installed: query("SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pgcrypto'"),
              comment: commentsRead({ extension: extensionComment('pgcrypto') }),
            }),
          )),
        Then('it is still installed once and shows the comment')((s, expect) =>
          expect(s.seen).toEqual({ installed: [{ n: 1 }], comment: { extension: 'Cryptographic functions' } })
        ),
      ),
    )

    scenario(
      'Rolling back a migration removes a commented extension',
      Gherkin.Do.pipe(
        Given('a database with no extensions beyond the defaults')('setup', () => query('SELECT 1')),
        When('a commented extension is migrated and then its rollback statements are run')(
          'seen',
          () =>
            Effect.gen(function*() {
              const result = yield* generated(
                defineExtras({ extensions: [withComment(pgExtension('pgcrypto'), 'crypto')] }),
                'ext',
              )
              yield* migrated
              for (const statement of result.down) yield* query(statement)
              return yield* query("SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pgcrypto'")
            }),
        ),
        Then('the extension is gone')((s, expect) => expect(s.seen).toEqual([{ n: 0 }])),
      ),
    )
  })
