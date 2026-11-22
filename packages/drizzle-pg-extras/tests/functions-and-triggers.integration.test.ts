import {
  defineExtras,
  pgFunction,
  pgTrigger,
  renderIdempotent,
  updatedAtTrigger,
  withComment,
} from '@systemfsoftware/drizzle-pg-extras'
import { Gherkin, Given, it, makeFeature, Then, When } from '@systemfsoftware/effect-gherkin-spec'
import { sql } from 'drizzle-orm'
import { integer, pgMaterializedView, pgSchema, pgTable, pgView, serial, text, timestamp } from 'drizzle-orm/pg-core'
import { Effect } from 'effect'
import { freshDatabase, generated, migrated, postgresServer, query } from './__fixtures__/database.fixture.js'

const Feature = makeFeature({ it })

type Extras = ReturnType<typeof defineExtras>

const ACCEPTED = 'accepted'
const REFUSED = 'refused as expected'

const customers = pgTable('customers', { id: integer('id').primaryKey() })
const balances = pgTable('balances', {
  id: serial('id').primaryKey(),
  customerId: integer('customer_id').notNull(),
  amount: integer('amount').notNull(),
  note: text('note'),
})
const ledger = pgTable('ledger', { id: serial('id').primaryKey(), amount: integer('amount').notNull() })
const ledgerAudit = pgTable('ledger_audit', {
  id: serial('id').primaryKey(),
  kind: text('kind').notNull(),
  n: integer('n').notNull(),
})
const profiles = pgTable('profiles', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  note: text('note'),
  touches: integer('touches').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
const profileEmails = pgView('profile_emails', { id: integer('id'), email: text('email') }).as(
  sql`select id, email from profiles`,
)

const storeTables = `CREATE TABLE customers (id integer PRIMARY KEY);
INSERT INTO customers VALUES (1);
CREATE TABLE balances (id serial PRIMARY KEY, customer_id integer NOT NULL, amount integer NOT NULL, note text);
INSERT INTO balances (customer_id, amount) VALUES (1, 5);
CREATE TABLE ledger (id serial PRIMARY KEY, amount integer NOT NULL);
CREATE TABLE ledger_audit (id serial PRIMARY KEY, kind text NOT NULL, n integer NOT NULL);
CREATE TABLE profiles (
  id serial PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL,
  note text,
  touches integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO profiles (email, name, updated_at) VALUES ('a@example.com', 'ada', '2000-01-01');
CREATE VIEW profile_emails AS SELECT id, email FROM profiles;`

const migrate = (extras: Extras, name: string) => Effect.andThen(generated(extras, name), migrated)

const outcome = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.match(effect, { onFailure: (error) => error.message, onSuccess: () => ACCEPTED })

const declaring = (declare: () => unknown) =>
  Effect.try({ try: declare, catch: (cause) => ({ message: cause instanceof Error ? cause.message : String(cause) }) })

type Refusal = readonly [expected: RegExp, declare: () => unknown]

const refusals = (cases: readonly Refusal[]) =>
  Effect.forEach(
    cases,
    ([expected, declare]) =>
      Effect.map(outcome(declaring(declare)), (message) => expected.test(message) ? REFUSED : message),
  )

const allRefused = (cases: readonly Refusal[]) => cases.map(() => REFUSED)

const triggerState = (name: string) =>
  query(
    `SELECT t.tgenabled AS enabled, t.tgdeferrable AS deferrable, t.tginitdeferred AS deferred,
            NULLIF(t.tgconstrrelid, 0)::regclass::text AS "from", obj_description(t.oid, 'pg_trigger') AS comment
     FROM pg_trigger t WHERE t.tgname = '${name}' AND NOT t.tgisinternal`,
  )

const triggerCount = (table: string) =>
  query(
    `SELECT count(*)::int AS n FROM pg_trigger t WHERE t.tgrelid = '${table}'::regclass AND NOT t.tgisinternal`,
  )

const functionCount = (name: string) => query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = '${name}'`)

const triggerOid = (name: string) => query(`SELECT oid::int AS oid FROM pg_trigger WHERE tgname = '${name}'`)

const rejectNegative = pgFunction('reject_negative', {
  returns: 'trigger',
  language: 'plpgsql',
  body: "BEGIN\n  IF NEW.amount < 0 THEN\n    RAISE EXCEPTION 'negative balance';\n  END IF;\n  RETURN NEW;\nEND;",
})

const balanceCheck = (initially: 'deferred' | 'immediate') =>
  defineExtras({
    functions: [rejectNegative],
    triggers: [
      withComment(
        pgTrigger('balances_amount', {
          table: balances,
          timing: 'after',
          events: ['insert', 'update'],
          columns: [balances.amount],
          constraint: { deferrable: true, initially, from: customers },
          function: rejectNegative,
        }),
        'non-negative',
      ),
    ],
    tables: [balances, customers],
  })

const negativeRolledBack = 'BEGIN; INSERT INTO balances (customer_id, amount) VALUES (1, -1); ROLLBACK;'
const negativeCommitted = 'BEGIN; INSERT INTO balances (customer_id, amount) VALUES (1, -1); COMMIT;'

const touchEmail = pgFunction('touch_email', {
  returns: 'trigger',
  language: 'plpgsql',
  body: 'BEGIN\n  NEW.touches = NEW.touches + 1;\n  RETURN NEW;\nEND;',
})

const changedEmail = pgTrigger('profiles_email', {
  table: profiles,
  timing: 'before',
  events: ['update'],
  columns: [profiles.email],
  when: ({ OLD, NEW }) => sql`${OLD.email} IS DISTINCT FROM ${NEW.email}`,
  function: touchEmail,
})

const stampUpdated = pgFunction('set_updated_at', {
  returns: 'trigger',
  language: 'plpgsql',
  security: 'definer',
  searchPath: [],
  body: 'BEGIN\n  NEW.updated_at = now();\n  RETURN NEW;\nEND;',
})

const emailStamp = defineExtras({
  functions: [stampUpdated],
  triggers: [
    pgTrigger('profiles_set_updated_at', {
      table: profiles,
      timing: 'before',
      events: ['update'],
      when: ({ OLD, NEW }) => sql`${OLD.email} IS DISTINCT FROM ${NEW.email}`,
      function: stampUpdated,
    }),
  ],
  tables: [profiles],
})

const raiseAlways = pgFunction('raise_always', {
  returns: 'trigger',
  language: 'plpgsql',
  body: "BEGIN\n  RAISE EXCEPTION 'disabled trigger fired';\nEND;",
})

const deleteGuard = (options: { enabled: boolean; when: string }) =>
  defineExtras({
    functions: [raiseAlways],
    triggers: [
      pgTrigger('profiles_guard', {
        table: profiles,
        timing: 'before',
        events: ['delete'],
        when: sql.raw(options.when),
        function: raiseAlways,
        enabled: options.enabled,
      }),
    ],
    tables: [profiles],
  })

const stampNote = (version: string) =>
  pgFunction('stamp_note', {
    returns: 'trigger',
    language: 'plpgsql',
    body: `BEGIN\n  NEW.note = '${version}';\n  RETURN NEW;\nEND;`,
  })

const noteStamping = (version: string) => {
  const fn = stampNote(version)
  return defineExtras({
    functions: [fn],
    triggers: [pgTrigger('profiles_note', { table: profiles, timing: 'before', events: ['update'], function: fn })],
    tables: [profiles],
  })
}

const flagBalance = (name: string, label: string) =>
  pgFunction(name, {
    returns: 'trigger',
    language: 'plpgsql',
    body: `BEGIN\n  NEW.note = '${label}';\n  RETURN NEW;\nEND;`,
  })

const balanceFlagging = (fn: ReturnType<typeof flagBalance>) =>
  defineExtras({
    functions: [fn],
    triggers: [
      pgTrigger('balances_flag', {
        table: balances,
        timing: 'after',
        events: ['insert'],
        constraint: true,
        function: fn,
      }),
    ],
    tables: [balances],
  })

const anyFunction = { name: 'f' } as const
const baseTrigger = {
  table: profiles,
  timing: 'after' as const,
  events: ['update' as const],
  function: anyFunction,
}
const activeProfiles = pgView('active_profiles', { id: integer('id'), email: text('email') }).as(
  sql`select id, email from profiles`,
)
const otherView = pgView('other_view', { email: text('email') }).as(sql`select email from profiles`)
const profileStats = pgMaterializedView('profile_stats', { id: integer('id') }).as(sql`select id from profiles`)
const shopAccounts = pgSchema('shop').table('accounts', { id: integer('id').primaryKey() })

const constraintRefusals: readonly Refusal[] = [
  [/AFTER \.\.\. FOR EACH ROW/, () => pgTrigger('t', { ...baseTrigger, timing: 'before', constraint: true })],
  [/AFTER \.\.\. FOR EACH ROW/, () => pgTrigger('t', { ...baseTrigger, forEach: 'statement', constraint: true })],
  [
    /INITIALLY DEFERRED requires DEFERRABLE/,
    () => pgTrigger('t', { ...baseTrigger, constraint: { initially: 'deferred' } }),
  ],
  [
    /AFTER \.\.\. FOR EACH ROW/,
    () =>
      pgTrigger('t', {
        table: activeProfiles,
        timing: 'after',
        events: ['insert'],
        forEach: 'statement',
        constraint: true,
        function: anyFunction,
      }),
  ],
  [
    /FROM must reference a table/,
    () => pgTrigger('t', { ...baseTrigger, constraint: { from: activeProfiles as never } }),
  ],
]

const transitionRefusals: readonly Refusal[] = [
  [
    /only allowed on AFTER/,
    () => pgTrigger('t', { ...baseTrigger, timing: 'before', referencing: { oldTable: 'old_rows' } }),
  ],
  [
    /more than one event/,
    () => pgTrigger('t', { ...baseTrigger, events: ['insert', 'update'], referencing: { newTable: 'new_rows' } }),
  ],
  [
    /UPDATE OF/,
    () => pgTrigger('t', { ...baseTrigger, columns: [profiles.email], referencing: { newTable: 'new_rows' } }),
  ],
  [
    /constraint triggers cannot use transition tables/,
    () => pgTrigger('t', { ...baseTrigger, constraint: true, referencing: { newTable: 'new_rows' } }),
  ],
  [
    /OLD TABLE is only allowed for UPDATE or DELETE/,
    () => pgTrigger('t', { ...baseTrigger, events: ['insert'], referencing: { oldTable: 'old_rows' } }),
  ],
  [
    /NEW TABLE is only allowed for INSERT or UPDATE/,
    () => pgTrigger('t', { ...baseTrigger, events: ['delete'], referencing: { newTable: 'new_rows' } }),
  ],
  [/different names/, () => pgTrigger('t', { ...baseTrigger, referencing: { oldTable: 'rows', newTable: 'rows' } })],
  [
    /TRUNCATE/,
    () =>
      pgTrigger('t', {
        ...baseTrigger,
        events: ['truncate'],
        forEach: 'statement',
        referencing: { oldTable: 'old_rows' },
      }),
  ],
  [
    /only allowed on tables/,
    () =>
      pgTrigger('t', {
        table: activeProfiles,
        timing: 'after',
        events: ['insert'],
        forEach: 'statement',
        referencing: { newTable: 'inserted' },
        function: anyFunction,
      }),
  ],
]

const conditionRefusals: readonly Refusal[] = [
  [/cannot reference OLD/, () => pgTrigger('t', { ...baseTrigger, events: ['insert'], when: sql`OLD.email IS NULL` })],
  [/cannot reference NEW/, () => pgTrigger('t', { ...baseTrigger, events: ['delete'], when: sql`NEW.email IS NULL` })],
  [
    /cannot reference OLD/,
    () =>
      pgTrigger('t', {
        ...baseTrigger,
        events: ['insert', 'update'],
        when: ({ OLD }) => sql`${OLD.email} IS NULL`,
      }),
  ],
  [
    /statement trigger WHEN/,
    () => pgTrigger('t', { ...baseTrigger, forEach: 'statement', when: sql`OLD.email IS NULL` }),
  ],
  [/subquery/, () => pgTrigger('t', { ...baseTrigger, when: sql`EXISTS (SELECT 1)` })],
]

const viewRefusals: readonly Refusal[] = [
  [
    /do not support WHEN/,
    () =>
      pgTrigger('t', {
        table: activeProfiles,
        timing: 'instead of',
        events: ['update'],
        when: sql`true`,
        function: anyFunction,
      }),
  ],
  [
    /column lists/,
    () =>
      pgTrigger('t', {
        table: activeProfiles,
        timing: 'instead of',
        events: ['update'],
        columns: [activeProfiles.email],
        function: anyFunction,
      }),
  ],
  [
    /forEach: "statement"/,
    () => pgTrigger('t', { table: activeProfiles, timing: 'before', events: ['update'], function: anyFunction }),
  ],
  [
    /DISABLE TRIGGER on a view/,
    () =>
      pgTrigger('t', {
        table: activeProfiles,
        timing: 'instead of',
        events: ['insert'],
        function: anyFunction,
        enabled: false,
      }),
  ],
  [
    /materialized views/,
    () =>
      pgTrigger('t', {
        table: profileStats,
        timing: 'after',
        events: ['insert'],
        forEach: 'statement',
        function: anyFunction,
      }),
  ],
  [
    /does not belong to view/,
    () =>
      pgTrigger('t', {
        table: activeProfiles,
        timing: 'before',
        events: ['update'],
        forEach: 'statement',
        columns: [otherView.email] as never,
        function: anyFunction,
      }),
  ],
]

const definitionRefusals: readonly Refusal[] = [
  [
    /does not belong/,
    () =>
      pgTrigger('t', {
        table: profiles,
        timing: 'before',
        events: ['update'],
        columns: [customers.id] as never,
        function: anyFunction,
      }),
  ],
  [
    /statement/,
    () => pgTrigger('t', { table: profiles, timing: 'before', events: ['truncate'], function: anyFunction }),
  ],
  [
    /not trigger/,
    () =>
      pgTrigger('t', {
        table: profiles,
        timing: 'before',
        events: ['update'],
        function: pgFunction('not_trigger', { returns: 'integer', language: 'sql', body: 'SELECT 1' }),
      }),
  ],
  [/date, time, or timestamp/, () => updatedAtTrigger(profiles, profiles.email)],
  [
    /INSTEAD OF/,
    () =>
      pgTrigger('t', {
        table: profiles,
        timing: 'instead of' as 'before',
        events: ['update'],
        function: anyFunction,
      }),
  ],
]

const everyRefusal: readonly Refusal[] = [
  ...constraintRefusals,
  ...transitionRefusals,
  ...conditionRefusals,
  ...viewRefusals,
  ...definitionRefusals,
]

Feature('Declaring functions and triggers next to the tables', { timeout: 180_000 })
  .live('a real Postgres booted in a microVM')
  .withLayer(postgresServer)
  .withScenarioLayer(freshDatabase)
  .body(({ scenario }) => {
    scenario(
      'A trigger limited to one column and one condition only counts the changes it was declared for',
      Gherkin.Do.pipe(
        Given('a profile with an email, a name and an empty note')('setup', () => query(storeTables)),
        When(
          'the name changes, the email is rewritten unchanged, the email changes, and the note is set to two texts that mention SELECT and then to another',
        )(
          'touches',
          () => {
            const guarded = (name: string, when: ReturnType<typeof sql.raw>) =>
              pgTrigger(name, { table: profiles, timing: 'before', events: ['update'], when, function: touchEmail })
            const extras = defineExtras({
              functions: [touchEmail],
              triggers: [
                changedEmail,
                guarded('profiles_quoted', sql.raw("NEW.note = 'SELECT'")),
                guarded('profiles_dollar', sql.raw('NEW.note = $q$SELECT 1$q$')),
              ],
              tables: [profiles],
            })
            const touches = query('SELECT touches FROM profiles')
            return Effect.andThen(
              migrate(extras, 'guard'),
              Effect.gen(function*() {
                yield* query("UPDATE profiles SET name = 'ada l'")
                const named = yield* touches
                yield* query("UPDATE profiles SET email = 'a@example.com'")
                const rewritten = yield* touches
                yield* query("UPDATE profiles SET email = 'b@example.com'")
                const changed = yield* touches
                yield* query("UPDATE profiles SET note = 'SELECT'")
                const quoted = yield* touches
                yield* query("UPDATE profiles SET note = 'SELECT 1'")
                const dollar = yield* touches
                yield* query("UPDATE profiles SET note = 'other'")
                const other = yield* touches
                return { named, rewritten, changed, quoted, dollar, other }
              }),
            )
          },
        ),
        Then('the profile was touched once by each declared change and not by the others')((s, expect) =>
          expect(s.touches).toEqual({
            named: [{ touches: 0 }],
            rewritten: [{ touches: 0 }],
            changed: [{ touches: 1 }],
            quoted: [{ touches: 2 }],
            dollar: [{ touches: 3 }],
            other: [{ touches: 3 }],
          })
        ),
      ),
    )

    scenario(
      'A definer function stamps the update time of a changed row, and the down statements take it away again',
      Gherkin.Do.pipe(
        Given('a profile last updated in the year 2000')('setup', () => query(storeTables)),
        When(
          'the stamping trigger is migrated, the email is rewritten unchanged and then changed, and the down statements are run',
        )(
          'seen',
          () =>
            Effect.gen(function*() {
              const created = yield* generated(emailStamp, 'stamp')
              yield* migrated
              yield* query("UPDATE profiles SET email = 'a@example.com'")
              const same = yield* query('SELECT extract(year FROM updated_at)::int AS year FROM profiles')
              yield* query("UPDATE profiles SET email = 'b@example.com'")
              const changed = yield* query('SELECT extract(year FROM updated_at) > 2000 AS later FROM profiles')
              const definer = yield* query(
                "SELECT prosecdef AS definer, proconfig AS config FROM pg_proc WHERE proname = 'set_updated_at'",
              )
              yield* Effect.forEach(created.down, (statement) => query(statement))
              return {
                same,
                changed,
                definer,
                triggers: yield* triggerCount('profiles'),
                functions: yield* functionCount('set_updated_at'),
                profiles: yield* query('SELECT email FROM profiles'),
              }
            }),
        ),
        Then(
          'the unchanged email kept the year, the changed one moved it on, and after the down statements no trigger or function remains',
        )((
          s,
          expect,
        ) =>
          expect(s.seen).toEqual({
            same: [{ year: 2000 }],
            changed: [{ later: true }],
            definer: [{ definer: true, config: ['search_path=""'] }],
            triggers: [{ n: 0 }],
            functions: [{ n: 0 }],
            profiles: [{ email: 'b@example.com' }],
          })
        ),
      ),
    )

    scenario(
      'A deferred check objects only at commit, and tightening it to immediate replaces the trigger and keeps its comment',
      Gherkin.Do.pipe(
        Given('a customer with one balance of five')('setup', () => query(storeTables)),
        When('the deferred check is migrated and tried, then declared immediate, tried again and generated again')(
          'seen',
          () =>
            Effect.gen(function*() {
              yield* migrate(balanceCheck('deferred'), 'check')
              const deferred = {
                rolledBack: yield* outcome(query(negativeRolledBack)),
                committed: yield* outcome(query(negativeCommitted)),
                trigger: yield* triggerState('balances_amount'),
              }
              yield* migrate(balanceCheck('immediate'), 'tighten')
              const immediate = {
                rolledBack: yield* outcome(query(negativeRolledBack)),
                trigger: yield* triggerState('balances_amount'),
                triggers: yield* triggerCount('balances'),
              }
              const again = (yield* generated(balanceCheck('immediate'), 'again')).written
              return { deferred, immediate, again, kept: yield* query('SELECT amount FROM balances ORDER BY id') }
            }),
        ),
        Then(
          'the deferred check refused only the commit, the immediate one refuses at once, the comment stayed, nothing new was written and the five stayed',
        )((
          s,
          expect,
        ) =>
          expect({
            ...s.seen,
            deferred: { ...s.seen.deferred, committed: /negative balance/.test(s.seen.deferred.committed) },
            immediate: { ...s.seen.immediate, rolledBack: /negative balance/.test(s.seen.immediate.rolledBack) },
          }).toEqual({
            deferred: {
              rolledBack: ACCEPTED,
              committed: true,
              trigger: [{ enabled: 'O', deferrable: true, deferred: true, from: 'customers', comment: 'non-negative' }],
            },
            immediate: {
              rolledBack: true,
              trigger: [{
                enabled: 'O',
                deferrable: true,
                deferred: false,
                from: 'customers',
                comment: 'non-negative',
              }],
              triggers: [{ n: 1 }],
            },
            again: false,
            kept: [{ amount: 5 }],
          })
        ),
      ),
    )

    scenario(
      'Transition tables let a statement trigger and a row trigger count the rows they saw',
      Gherkin.Do.pipe(
        Given('an empty ledger with an audit table')('setup', () => query(storeTables)),
        When('three entries are inserted and then all three are updated')('audit', () => {
          const countInserted = pgFunction('count_inserted', {
            returns: 'trigger',
            language: 'plpgsql',
            body:
              "BEGIN\n  INSERT INTO ledger_audit (kind, n) SELECT 'insert', count(*)::integer FROM inserted;\n  RETURN NULL;\nEND;",
          })
          const countUpdated = pgFunction('count_updated', {
            returns: 'trigger',
            language: 'plpgsql',
            body:
              "BEGIN\n  INSERT INTO ledger_audit (kind, n) SELECT 'update', count(*)::integer FROM old_rows;\n  RETURN NULL;\nEND;",
          })
          return Effect.andThen(
            migrate(
              defineExtras({
                functions: [countInserted, countUpdated],
                triggers: [
                  pgTrigger('ledger_inserted', {
                    table: ledger,
                    timing: 'after',
                    events: ['insert'],
                    forEach: 'statement',
                    referencing: { newTable: 'inserted' },
                    function: countInserted,
                  }),
                  pgTrigger('ledger_updated', {
                    table: ledger,
                    timing: 'after',
                    events: ['update'],
                    forEach: 'row',
                    referencing: { oldTable: 'old_rows', newTable: 'new_rows' },
                    function: countUpdated,
                  }),
                ],
                tables: [ledger, ledgerAudit],
              }),
              'audit',
            ),
            Effect.andThen(
              query('INSERT INTO ledger (amount) VALUES (1), (2), (3)'),
              Effect.andThen(
                query('UPDATE ledger SET amount = amount + 1'),
                query('SELECT kind, n FROM ledger_audit ORDER BY id'),
              ),
            ),
          )
        }),
        Then('the insert was counted once as three and each updated row saw all three')((s, expect) =>
          expect(s.audit).toEqual([
            { kind: 'insert', n: 3 },
            { kind: 'update', n: 3 },
            { kind: 'update', n: 3 },
            { kind: 'update', n: 3 },
          ])
        ),
      ),
    )

    scenario(
      'An instead-of trigger turns an insert into a view into an insert into its table',
      Gherkin.Do.pipe(
        Given('a profile email view over the profiles table')('setup', () => query(storeTables)),
        When('an email is inserted through the view')('profiles', () => {
          const insertProfile = pgFunction('insert_profile', {
            returns: 'trigger',
            language: 'plpgsql',
            body: "BEGIN\n  INSERT INTO profiles (email, name) VALUES (NEW.email, 'from view');\n  RETURN NEW;\nEND;",
          })
          return Effect.andThen(
            migrate(
              defineExtras({
                functions: [insertProfile],
                triggers: [
                  pgTrigger('profile_emails_insert', {
                    table: profileEmails,
                    timing: 'instead of',
                    events: ['insert'],
                    function: insertProfile,
                  }),
                ],
                tables: [profiles],
                views: [profileEmails],
              }),
              'instead',
            ),
            Effect.andThen(
              query("INSERT INTO profile_emails (email) VALUES ('view@example.com')"),
              query("SELECT name FROM profiles WHERE email = 'view@example.com'"),
            ),
          )
        }),
        Then('the profiles table holds a profile named after the view')((s, expect) =>
          expect(s.profiles).toEqual([{ name: 'from view' }])
        ),
      ),
    )

    scenario(
      'A trigger declared disabled stays silent, even after its condition changes, until it is declared enabled',
      Gherkin.Do.pipe(
        Given('a profile that a guard would forbid deleting')('setup', () => query(storeTables)),
        When(
          'the guard is migrated disabled, its condition changes, the profile is deleted, and the guard is then enabled and the profile deleted again',
        )(
          'seen',
          () =>
            Effect.gen(function*() {
              yield* migrate(deleteGuard({ enabled: false, when: 'true' }), 'guard')
              yield* migrate(deleteGuard({ enabled: false, when: "OLD.name = 'ada'" }), 'condition')
              const disabled = {
                guard: yield* triggerState('profiles_guard'),
                condition: yield* query(
                  "SELECT pg_get_triggerdef(oid) LIKE '%ada%' AS changed FROM pg_trigger WHERE tgname = 'profiles_guard'",
                ),
                deleted: yield* outcome(query('DELETE FROM profiles')),
              }
              yield* query("INSERT INTO profiles (email, name) VALUES ('c@example.com', 'ada')")
              yield* migrate(deleteGuard({ enabled: true, when: "OLD.name = 'ada'" }), 'enable')
              const enabled = {
                guard: yield* triggerState('profiles_guard'),
                deleted: yield* outcome(query('DELETE FROM profiles')),
                profiles: yield* query('SELECT count(*)::int AS n FROM profiles'),
              }
              return { disabled, enabled }
            }),
        ),
        Then(
          'the disabled guard carries the new condition and lets the delete through, the enabled one refuses it and the profile stays',
        )((
          s,
          expect,
        ) =>
          expect({
            ...s.seen,
            enabled: { ...s.seen.enabled, deleted: /disabled trigger fired/.test(s.seen.enabled.deleted) },
          }).toEqual({
            disabled: {
              guard: [{ enabled: 'D', deferrable: false, deferred: false, from: null, comment: null }],
              condition: [{ changed: true }],
              deleted: ACCEPTED,
            },
            enabled: {
              guard: [{ enabled: 'O', deferrable: false, deferred: false, from: null, comment: null }],
              deleted: true,
              profiles: [{ n: 1 }],
            },
          })
        ),
      ),
    )

    scenario(
      'Changing only the body of a trigger function leaves the trigger itself in place',
      Gherkin.Do.pipe(
        Given('a profile whose note is stamped version one on update')('setup', () =>
          Effect.andThen(
            query(storeTables),
            Effect.andThen(migrate(noteStamping('v1'), 'v1'), triggerOid('profiles_note')),
          )),
        When('the function body is changed to stamp version two and the profile is updated')(
          'seen',
          () =>
            Effect.andThen(
              migrate(noteStamping('v2'), 'v2'),
              Effect.gen(function*() {
                yield* query("UPDATE profiles SET name = 'ada l'")
                return {
                  note: yield* query('SELECT note FROM profiles'),
                  trigger: yield* triggerOid('profiles_note'),
                }
              }),
            ),
        ),
        Then('the profile carries version two and the very same trigger is still attached')((s, expect) =>
          expect(s.seen).toEqual({ note: [{ note: 'v2' }], trigger: s.setup })
        ),
      ),
    )

    scenario(
      'Pointing a constraint trigger at a new function lets the old function be removed',
      Gherkin.Do.pipe(
        Given('a balance whose constraint trigger calls the first flagging function')('setup', () =>
          Effect.andThen(
            query(storeTables),
            migrate(balanceFlagging(flagBalance('flag_first', 'first')), 'first'),
          )),
        When('the trigger is declared on a second function and the first is no longer declared')(
          'seen',
          () =>
            Effect.andThen(
              migrate(balanceFlagging(flagBalance('flag_second', 'second')), 'second'),
              Effect.all({
                first: functionCount('flag_first'),
                second: functionCount('flag_second'),
                triggers: triggerCount('balances'),
              }),
            ),
        ),
        Then('only the second function remains, behind a single trigger')((s, expect) =>
          expect(s.seen).toEqual({ first: [{ n: 0 }], second: [{ n: 1 }], triggers: [{ n: 1 }] })
        ),
      ),
    )

    scenario(
      'A function whose return type changes is replaced and answers with the new type',
      Gherkin.Do.pipe(
        Given('a function that returns its argument plus one')('setup', () =>
          migrate(
            defineExtras({
              functions: [
                pgFunction('label_of', {
                  args: [{ name: 'n', type: 'integer' }],
                  returns: 'integer',
                  language: 'sql',
                  body: 'SELECT n + 1',
                }),
              ],
            }),
            'label',
          )),
        When('it is declared to return text labelling its argument and is called with four')(
          'answer',
          () =>
            Effect.andThen(
              migrate(
                defineExtras({
                  functions: [
                    pgFunction('label_of', {
                      args: [{ name: 'n', type: 'integer' }],
                      returns: 'text',
                      language: 'sql',
                      body: "SELECT 'n=' || n",
                    }),
                  ],
                }),
                'relabel',
              ),
              query('SELECT label_of(4) AS answer'),
            ),
        ),
        Then('the call answers with the text label')((s, expect) => expect(s.answer).toEqual([{ answer: 'n=4' }])),
      ),
    )

    scenario(
      'Dropping the trigger table by hand does not stop the next migration from removing its function',
      Gherkin.Do.pipe(
        Given('a profile table whose stamping trigger was migrated and then the table was dropped by hand')(
          'setup',
          () =>
            Effect.andThen(
              query(storeTables),
              Effect.andThen(migrate(emailStamp, 'stamp'), query('DROP VIEW profile_emails; DROP TABLE profiles')),
            ),
        ),
        When('the declaration is migrated again without the table, trigger and function')('seen', () =>
          Effect.andThen(
            migrate(defineExtras({ tables: [customers] }), 'removed'),
            functionCount('set_updated_at'),
          )),
        Then('the migration completes and the function is gone')((s, expect) => expect(s.seen).toEqual([{ n: 0 }])),
      ),
    )

    scenario(
      'Functions with defaults, column types, schema-qualified tables, forward calls and dollar quotes all answer',
      Gherkin.Do.pipe(
        Given('an accounts table in its own schema holding two rows')('setup', () =>
          query(
            'CREATE SCHEMA shop; CREATE TABLE shop.accounts (id integer PRIMARY KEY); INSERT INTO shop.accounts VALUES (1), (2);',
          )),
        When('four functions are migrated, the outer one listed before the inner one it calls, and each is called')(
          'seen',
          () => {
            const addOne = pgFunction('add_one', {
              args: [{ name: 'n', type: 'integer', default: '0' }],
              returns: customers.id,
              language: 'sql',
              volatility: 'immutable',
              body: sql`SELECT n + 1`,
            })
            const countAccounts = pgFunction('count_accounts', {
              schema: 'shop',
              returns: 'integer',
              language: 'sql',
              body: sql`SELECT count(*)::integer FROM ${shopAccounts}`,
            })
            const inner = pgFunction('inner_value', { returns: 'integer', language: 'sql', body: 'SELECT 41' })
            const outer = pgFunction('outer_value', {
              returns: 'integer',
              language: 'sql',
              body: sql`SELECT inner_value() + 1`,
            })
            const odd = pgFunction('odd_quote', { returns: 'text', language: 'sql', body: "SELECT '$function$'" })
            return Effect.andThen(
              migrate(defineExtras({ functions: [addOne, countAccounts, outer, inner, odd] }), 'functions'),
              query(
                'SELECT add_one() AS first, add_one(4) AS second, shop.count_accounts() AS accounts, outer_value() AS outer, odd_quote() AS quote',
              ),
            )
          },
        ),
        Then(
          'the defaulted call answers one, the explicit call five, two accounts are counted, the outer function answers forty-two and the quote tag comes back whole',
        )((s, expect) =>
          expect(s.seen).toEqual([{ first: 1, second: 5, accounts: 2, outer: 42, quote: '$function$' }])
        ),
      ),
    )

    scenario(
      'An updated-at trigger shares one function between tables and stamps every update',
      Gherkin.Do.pipe(
        Given('two tables that each hold a row last updated in the year 2000')('setup', () =>
          query(
            `CREATE TABLE posts (id integer PRIMARY KEY, title text, updated_at timestamptz NOT NULL);
             CREATE TABLE comments (id integer PRIMARY KEY, body text, updated_at timestamptz NOT NULL);
             INSERT INTO posts VALUES (1, 'a', '2000-01-01');
             INSERT INTO comments VALUES (1, 'b', '2000-01-01');`,
          )),
        When('an updated-at trigger on each table is migrated and a row of each is edited')('seen', () => {
          const posts = pgTable('posts', {
            id: integer('id').primaryKey(),
            title: text('title'),
            updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
          })
          const comments = pgTable('comments', {
            id: integer('id').primaryKey(),
            body: text('body'),
            updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
          })
          return Effect.andThen(
            migrate(
              defineExtras({
                tables: [posts, comments],
                triggers: [updatedAtTrigger(posts, posts.updatedAt), updatedAtTrigger(comments, comments.updatedAt)],
              }),
              'updated',
            ),
            Effect.gen(function*() {
              yield* query("UPDATE posts SET title = 'a2'")
              yield* query("UPDATE comments SET body = 'b2'")
              return {
                posts: yield* query('SELECT extract(year FROM updated_at) > 2000 AS later FROM posts'),
                comments: yield* query('SELECT extract(year FROM updated_at) > 2000 AS later FROM comments'),
                functions: yield* functionCount('set_updated_at'),
              }
            }),
          )
        }),
        Then('both rows moved on and there is a single shared function')((s, expect) =>
          expect(s.seen).toEqual({ posts: [{ later: true }], comments: [{ later: true }], functions: [{ n: 1 }] })
        ),
      ),
    )

    scenario(
      'The idempotent script can be run twice and leaves one trigger of each kind',
      Gherkin.Do.pipe(
        Given('a customer with one balance of five')('setup', () => query(storeTables)),
        When('the idempotent script for a disabled check trigger with a comment is run twice')('seen', () => {
          const extras = defineExtras({
            functions: [rejectNegative],
            triggers: [
              withComment(
                pgTrigger('balances_check', {
                  table: balances,
                  timing: 'after',
                  events: ['insert'],
                  constraint: true,
                  function: rejectNegative,
                  enabled: false,
                }),
                'check',
              ),
            ],
            tables: [balances],
          })
          return Effect.andThen(
            Effect.andThen(query(renderIdempotent(extras)), query(renderIdempotent(extras))),
            Effect.all({
              trigger: triggerState('balances_check'),
              triggers: triggerCount('balances'),
              functions: functionCount('reject_negative'),
            }),
          )
        }),
        Then('there is one disabled, commented trigger on one function')((s, expect) =>
          expect(s.seen).toEqual({
            trigger: [{ enabled: 'D', deferrable: false, deferred: false, from: null, comment: 'check' }],
            triggers: [{ n: 1 }],
            functions: [{ n: 1 }],
          })
        ),
      ),
    )

    scenario(
      'Invalid trigger declarations are refused with the rule they break',
      Gherkin.Do.pipe(
        Given('a profiles table')('setup', () => query(storeTables)),
        When('invalid constraint, transition table, condition, view and plain trigger declarations are attempted')(
          'seen',
          () => refusals(everyRefusal),
        ),
        Then('each is refused with the rule it breaks')((s, expect) =>
          expect(s.seen).toEqual(allRefused(everyRefusal))
        ),
      ),
    )
  })
