import { Gherkin, Given, it, makeFeature, Then, When } from '@systemfsoftware/effect-gherkin-spec'
import {
  collectExtras,
  defineExtras,
  generate,
  partitionedTable,
  pgAttachPartition,
  pgDetachPartition,
  pgPartition,
} from '@systemfsoftware/timescale-drizzle'
import { sql } from 'drizzle-orm'
import { integer, pgSchema, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
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

const events = pgTable('events', {
  id: serial('id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  region: text('region').notNull(),
  payload: text('payload').notNull(),
}, (t) => [primaryKey({ columns: [t.id, t.createdAt] })])
const archive = pgTable('events_archive', {
  id: integer('id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  region: text('region').notNull(),
  payload: text('payload').notNull(),
}, (t) => [primaryKey({ columns: [t.id, t.createdAt] })])
const labels = pgTable('labels', {
  id: integer('id').notNull(),
  locale: text('locale').notNull(),
}, (t) => [primaryKey({ columns: [t.id, t.locale] })])
const tickets = pgTable('tickets', {
  id: integer('id').notNull(),
  bucket: integer('bucket').notNull(),
}, (t) => [primaryKey({ columns: [t.bucket, t.id] })])

const eventsParent = partitionedTable(events, { method: 'range', columns: [events.createdAt] })
const labelsParent = partitionedTable(labels, { method: 'list', columns: [labels.locale] })
const ticketsParent = partitionedTable(tickets, { method: 'hash', columns: [tickets.bucket] })

const year2024 = (options: { detachOnRemove: boolean } = { detachOnRemove: false }) =>
  pgPartition('events_2024', {
    parent: events,
    from: ['2024-01-01'],
    to: ['2025-01-01'],
    ...(options.detachOnRemove ? { onRemove: 'detach' as const } : {}),
  })
const year2025 = pgPartition('events_2025', { parent: events, from: ['2025-01-01'], to: ['2026-01-01'] })
const earlyEvents = pgPartition('events_early', { parent: events, from: ['MINVALUE'], to: ['2020-01-01'] })
const otherEvents = pgPartition('events_default', { parent: events, default: true })
const attachedArchive = pgAttachPartition(archive, { parent: events, from: ['2020-01-01'], to: ['2024-01-01'] })
const englishLabels = pgPartition('labels_en', { parent: labels, in: ['en', "o'reilly"] })
const otherLabels = pgPartition('labels_other', { parent: labels, default: true })
const evenTickets = pgPartition('tickets_0', { parent: tickets, modulus: 2, remainder: 0 })
const oddTickets = pgPartition('tickets_1', { parent: tickets, modulus: 2, remainder: 1 })

const yearlyEvents = defineExtras({ partitionedTables: [eventsParent], partitions: [year2024(), year2025] })
const shopEvents = defineExtras({
  partitionedTables: [eventsParent],
  partitions: [year2024(), earlyEvents, otherEvents, attachedArchive],
})
const everything = defineExtras({
  partitionedTables: [eventsParent, labelsParent, ticketsParent],
  partitions: [year2024(), otherEvents, attachedArchive, englishLabels, otherLabels, evenTickets, oddTickets],
})

const regions = `CREATE TABLE regions (code text PRIMARY KEY);
INSERT INTO regions VALUES ('eu');`
const eventsTable = `${regions}
CREATE TABLE events (
  id serial NOT NULL,
  created_at timestamptz NOT NULL,
  region text NOT NULL REFERENCES regions (code),
  payload text NOT NULL,
  PRIMARY KEY (id, created_at)
);`
const archiveTable = `CREATE TABLE events_archive (
  id integer NOT NULL,
  created_at timestamptz NOT NULL,
  region text NOT NULL REFERENCES regions (code),
  payload text NOT NULL,
  PRIMARY KEY (id, created_at)
);`
const oldArchivedEvent = "INSERT INTO events_archive VALUES (100, '2022-05-01', 'eu', 'old');"
const labelsAndTickets = `CREATE TABLE labels (id integer NOT NULL, locale text NOT NULL, PRIMARY KEY (id, locale));
CREATE TABLE tickets (id integer NOT NULL, bucket integer NOT NULL, PRIMARY KEY (bucket, id));`

const record = (rows: ReadonlyArray<readonly [created: string, payload: string]>) =>
  query(
    `INSERT INTO events (created_at, region, payload) VALUES ${
      rows.map(([created, payload]) => `('${created}', 'eu', '${payload}')`).join(', ')
    }`,
  )
const homes = query('SELECT payload, tableoid::regclass::text AS home FROM events ORDER BY payload')
const relationKinds = (names: readonly string[]) =>
  query(
    "SELECT relname, relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND relname = ANY($1) ORDER BY 1",
    [names],
  )
const childrenOf = (parent: string) =>
  query('SELECT inhrelid::regclass::text AS child FROM pg_inherits WHERE inhparent = $1::regclass ORDER BY 1', [parent])

const migrate = (extras: Parameters<typeof generated>[0], name: string) =>
  Effect.tap(generated(extras, name), () => migrated)

const deepest = (error: unknown): string => {
  let current: unknown = error
  while (current instanceof Error && current.cause instanceof Error) current = current.cause
  return current instanceof Error ? current.message : String(current)
}
const refusalOf = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.map(Effect.flip(effect), deepest)
const refusing = (declare: () => unknown) =>
  Effect.sync(() => {
    try {
      declare()
      return 'accepted'
    } catch (error) {
      return deepest(error)
    }
  })
const matches = (pattern: RegExp, message: string) => pattern.test(message)

const rollBack = (down: readonly string[]) => Effect.forEach(down, (statement) => query(statement), { discard: true })

const generatedWithCasing = (extras: Parameters<typeof generated>[0], name: string) =>
  Effect.flatMap(Database, ({ out }) =>
    Effect.try({
      try: () => generate({ extras, out, name, casing: 'snake_case' }),
      catch: (cause) => new DatabaseFailed({ step: `generate ${name}`, cause }),
    }))

const accountSchema = pgSchema('account')
const accountEvents = accountSchema.table('events', {
  id: integer('id').notNull(),
  createdAt: timestamp().notNull(),
}, (t) => [primaryKey({ columns: [t.id, t.createdAt] })])
const accountEventsExtras = defineExtras({
  partitionedTables: [partitionedTable(accountEvents, { method: 'range', columns: [accountEvents.createdAt] })],
  partitions: [
    pgPartition('events_2024', { parent: accountEvents, schema: 'history', from: ['2024-01-01'], to: ['2025-01-01'] }),
  ],
})

const richEventsTable = `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partition_reader') THEN CREATE ROLE partition_reader; END IF;
END $$;
CREATE TABLE regions (code text PRIMARY KEY);
INSERT INTO regions VALUES ('eu');
CREATE TABLE events (
  id serial NOT NULL,
  created_at timestamptz NOT NULL,
  region text NOT NULL,
  note text,
  CONSTRAINT events_pk PRIMARY KEY (id, created_at),
  CONSTRAINT events_note_len CHECK (length(note) < 100)
);
CREATE UNIQUE INDEX events_note_uidx ON events (note, created_at);
ALTER TABLE events ADD CONSTRAINT events_region_fk FOREIGN KEY (region) REFERENCES regions (code);
CREATE TABLE event_refs (
  id serial PRIMARY KEY,
  event_id integer NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT event_refs_event_fk FOREIGN KEY (event_id, created_at) REFERENCES events (id, created_at)
);
COMMENT ON TABLE events IS 'event log';
COMMENT ON COLUMN events.region IS 'region code';
GRANT SELECT ON events TO partition_reader;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
CREATE POLICY events_read ON events FOR SELECT TO partition_reader USING (true);
CREATE FUNCTION events_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.note = coalesce(NEW.note, 'touched');
  RETURN NEW;
END $$;
CREATE TRIGGER events_touch BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION events_touch();`

const richEvents = pgTable('events', {
  id: serial('id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  region: text('region').notNull(),
  note: text('note'),
}, (t) => [primaryKey({ columns: [t.id, t.createdAt] }), uniqueIndex('events_note_uidx').on(t.note, t.createdAt)])
const richEventsExtras = defineExtras({
  partitionedTables: [partitionedTable(richEvents, { method: 'range', columns: [richEvents.createdAt] })],
  partitions: [pgPartition('events_2024', { parent: richEvents, from: ['2024-01-01'], to: ['2025-01-01'] })],
})

const handPartitionedEvents = `${eventsTable.replace(/\);$/, ') PARTITION BY RANGE (created_at);')}
${archiveTable}
${oldArchivedEvent}
ALTER TABLE events ATTACH PARTITION events_archive FOR VALUES FROM ('2020-01-01') TO ('2024-01-01');`

Feature('Declaring partitioned tables next to the tables they partition', { timeout: 180_000 })
  .live('a real Postgres booted in a microVM')
  .withLayer(postgresServer)
  .withScenarioLayer(freshDatabase)
  .body(({ scenario }) => {
    scenario(
      'Events land in the year, early, default and archive partitions they belong to',
      Gherkin.Do.pipe(
        Given('an empty events table and an archive table that already holds one old event')(
          'setup',
          () => query(`${eventsTable}\n${archiveTable}\n${oldArchivedEvent}`),
        ),
        When(
          'yearly, early, default and attached archive partitions are migrated and events from five eras are recorded',
        )(
          'seen',
          () =>
            Effect.andThen(
              migrate(shopEvents, 'partitions'),
              Effect.andThen(
                record([['2024-06-01', 'a'], ['2023-06-01', 'b'], ['2026-06-01', 'c'], ['2019-06-01', 'e']]),
                homes,
              ),
            ),
        ),
        Then('every event sits in its own partition and the old archived event is visible through the parent')((
          s,
          expect,
        ) =>
          expect(s.seen).toEqual([
            { payload: 'a', home: 'events_2024' },
            { payload: 'b', home: 'events_archive' },
            { payload: 'c', home: 'events_default' },
            { payload: 'e', home: 'events_early' },
            { payload: 'old', home: 'events_archive' },
          ])
        ),
      ),
    )

    scenario(
      'Labels split by locale and tickets spread over hash buckets',
      Gherkin.Do.pipe(
        Given('empty label and ticket tables')('setup', () => query(labelsAndTickets)),
        When('list partitions with a fallback and two hash partitions are migrated and rows are recorded')(
          'seen',
          () =>
            Effect.andThen(
              migrate(
                defineExtras({
                  partitionedTables: [labelsParent, ticketsParent],
                  partitions: [englishLabels, otherLabels, evenTickets, oddTickets],
                }),
                'partitions',
              ),
              Effect.andThen(
                query(
                  "INSERT INTO labels VALUES (1, 'en'), (2, 'o''reilly'), (3, 'fr'); INSERT INTO tickets SELECT g, g FROM generate_series(1, 16) AS g",
                ),
                Effect.all({
                  labels: query('SELECT id, tableoid::regclass::text AS home FROM labels ORDER BY id'),
                  buckets: query('SELECT DISTINCT tableoid::regclass::text AS home FROM tickets ORDER BY 1'),
                  tickets: query('SELECT count(*)::int AS n FROM tickets'),
                }),
              ),
            ),
        ),
        Then('the listed locales go to their partition, the rest to the fallback, and the tickets use both buckets')((
          s,
          expect,
        ) =>
          expect(s.seen).toEqual({
            labels: [
              { id: 1, home: 'labels_en' },
              { id: 2, home: 'labels_en' },
              { id: 3, home: 'labels_other' },
            ],
            buckets: [{ home: 'tickets_0' }, { home: 'tickets_1' }],
            tickets: [{ n: 16 }],
          })
        ),
      ),
    )

    scenario(
      'Converting an empty events table keeps its constraints, trigger, policy, comments, grants and serial',
      Gherkin.Do.pipe(
        Given(
          'an empty events table with keys, a check, a trigger, a policy, comments, a grant and a referencing table',
        )(
          'setup',
          () => query(richEventsTable),
        ),
        When('it is migrated into a range partitioned table with a yearly partition and an event is recorded')(
          'seen',
          () =>
            Effect.andThen(
              migrate(richEventsExtras, 'partitions'),
              Effect.all({
                parent: query(
                  "SELECT c.relkind, pg_get_partkeydef(c.oid) AS key, c.relrowsecurity AS rls FROM pg_class c WHERE c.oid = 'public.events'::regclass",
                ),
                indexes: query(
                  "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'events' ORDER BY 1",
                ),
                constraints: query(
                  "SELECT conname FROM pg_constraint WHERE conrelid = 'public.events'::regclass OR confrelid = 'public.events'::regclass ORDER BY 1",
                ),
                comments: query(
                  "SELECT obj_description('public.events'::regclass) AS table_comment, col_description('public.events'::regclass, 3) AS column_comment",
                ),
                policy: query("SELECT polname FROM pg_policy WHERE polrelid = 'public.events'::regclass"),
                trigger: query(
                  "SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.events'::regclass AND NOT tgisinternal",
                ),
                grants: query(
                  "SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'events' AND grantee = 'partition_reader'",
                ),
                inserted: query(
                  "INSERT INTO events (created_at, region) VALUES ('2024-06-01', 'eu') RETURNING tableoid::regclass::text AS home, id > 0 AS positive, note",
                ),
                unknownRegion: refusalOf(
                  query("INSERT INTO events (created_at, region) VALUES ('2024-07-01', 'missing')"),
                ),
              }),
            ),
        ),
        Then('the table is partitioned and everything it had before still works')((s, expect) =>
          expect({ ...s.seen, unknownRegion: matches(/foreign key/, s.seen.unknownRegion) }).toEqual({
            parent: [{ relkind: 'p', key: 'RANGE (created_at)', rls: true }],
            indexes: [{ indexname: 'events_note_uidx' }, { indexname: 'events_pk' }],
            constraints: [
              { conname: 'event_refs_event_fk' },
              { conname: 'events_note_len' },
              { conname: 'events_pk' },
              { conname: 'events_region_fk' },
            ],
            comments: [{ table_comment: 'event log', column_comment: 'region code' }],
            policy: [{ polname: 'events_read' }],
            trigger: [{ tgname: 'events_touch' }],
            grants: [{ privilege_type: 'SELECT' }],
            inserted: [{ home: 'events_2024', positive: true, note: 'touched' }],
            unknownRegion: true,
          })
        ),
      ),
    )

    scenario(
      'A table that already has events is refused and left as it was',
      Gherkin.Do.pipe(
        Given('an events table that already holds one event')(
          'setup',
          () => Effect.andThen(query(eventsTable), record([['2024-06-01', 'a']])),
        ),
        When('it is migrated into a partitioned table')('seen', () =>
          Effect.all({
            refusal: refusalOf(migrate(yearlyEvents, 'partitions')),
            kinds: relationKinds(['events']),
            rows: query('SELECT payload FROM events'),
          })),
        Then('the migration fails because the table has rows, and the table stays an ordinary table with its event')((
          s,
          expect,
        ) =>
          expect({ ...s.seen, refusal: matches(/has rows, so it cannot be converted/, s.seen.refusal) }).toEqual({
            refusal: true,
            kinds: [{ relname: 'events', relkind: 'r' }],
            rows: [{ payload: 'a' }],
          })
        ),
      ),
    )

    scenario(
      'Declaring the same partitions again writes nothing',
      Gherkin.Do.pipe(
        Given('an events table whose yearly partitions are already migrated')(
          'setup',
          () => Effect.andThen(query(eventsTable), migrate(yearlyEvents, 'partitions')),
        ),
        When('the same partitions are generated again')('again', () => generated(yearlyEvents, 'noop')),
        Then('no migration is written')((s, expect) => expect(s.again).toEqual({ written: false, up: [], down: [] })),
      ),
    )

    scenario(
      'Removing an empty partition drops it',
      Gherkin.Do.pipe(
        Given('an events table partitioned by year with both years migrated')(
          'setup',
          () => Effect.andThen(query(eventsTable), migrate(yearlyEvents, 'partitions')),
        ),
        When('the first year is removed from the declarations and migrated')('seen', () =>
          Effect.andThen(
            migrate(defineExtras({ partitionedTables: [eventsParent], partitions: [year2025] }), 'drop'),
            Effect.all({
              kinds: relationKinds(['events_2024', 'events_2025']),
              children: childrenOf('events'),
            }),
          )),
        Then('only the second year remains, attached to the events table')((s, expect) =>
          expect(s.seen).toEqual({
            kinds: [{ relname: 'events_2025', relkind: 'r' }],
            children: [{ child: 'events_2025' }],
          })
        ),
      ),
    )

    scenario(
      'Removing a partition that holds events is refused and keeps the events',
      Gherkin.Do.pipe(
        Given('an events table partitioned by year with an event recorded in the first year')(
          'setup',
          () =>
            Effect.andThen(
              Effect.andThen(query(eventsTable), migrate(yearlyEvents, 'partitions')),
              record([['2024-06-01', 'a']]),
            ),
        ),
        When('the first year is removed from the declarations and migrated')('seen', () =>
          Effect.all({
            refusal: refusalOf(
              migrate(defineExtras({ partitionedTables: [eventsParent], partitions: [year2025] }), 'drop'),
            ),
            homes,
          })),
        Then('the migration fails because the partition has rows, and the event is still in the first year')((
          s,
          expect,
        ) =>
          expect({ ...s.seen, refusal: matches(/has rows\. Refusing to drop it/, s.seen.refusal) }).toEqual({
            refusal: true,
            homes: [{ payload: 'a', home: 'events_2024' }],
          })
        ),
      ),
    )

    scenario(
      'A partition removed with detach is kept as an ordinary table with its events',
      Gherkin.Do.pipe(
        Given('an events table partitioned by year, the first year set to detach, with an event recorded in it')(
          'setup',
          () =>
            Effect.andThen(
              Effect.andThen(
                query(eventsTable),
                migrate(
                  defineExtras({
                    partitionedTables: [eventsParent],
                    partitions: [year2024({ detachOnRemove: true }), year2025],
                  }),
                  'partitions',
                ),
              ),
              record([['2024-06-01', 'a']]),
            ),
        ),
        When('the first year is removed from the declarations and migrated')('seen', () =>
          Effect.andThen(
            migrate(defineExtras({ partitionedTables: [eventsParent], partitions: [year2025] }), 'detach'),
            Effect.all({
              kinds: relationKinds(['events_2024']),
              kept: query('SELECT payload FROM events_2024'),
              parent: query('SELECT count(*)::int AS n FROM events'),
            }),
          )),
        Then('the first year still holds its event as an ordinary table, and the events table no longer shows it')((
          s,
          expect,
        ) =>
          expect(s.seen).toEqual({
            kinds: [{ relname: 'events_2024', relkind: 'r' }],
            kept: [{ payload: 'a' }],
            parent: [{ n: 0 }],
          })
        ),
      ),
    )

    scenario(
      'A table attached by hand earlier is detached when it is declared as detached',
      Gherkin.Do.pipe(
        Given('an events table partitioned by hand with an archive table attached and holding one old event')(
          'setup',
          () => query(handPartitionedEvents),
        ),
        When('the events table is declared partitioned with the archive detached and migrated')(
          'seen',
          () =>
            Effect.andThen(
              migrate(
                defineExtras({
                  partitionedTables: [eventsParent],
                  detaches: [pgDetachPartition(archive, { parent: events })],
                }),
                'detach',
              ),
              Effect.all({
                kinds: relationKinds(['events', 'events_archive']),
                archived: query('SELECT payload FROM events_archive'),
                parent: query('SELECT count(*)::int AS n FROM events'),
              }),
            ),
        ),
        Then('the archive is an ordinary table that kept its event and the events table is empty')((s, expect) =>
          expect(s.seen).toEqual({
            kinds: [{ relname: 'events', relkind: 'p' }, { relname: 'events_archive', relkind: 'r' }],
            archived: [{ payload: 'old' }],
            parent: [{ n: 0 }],
          })
        ),
      ),
    )

    scenario(
      'Rolling back restores ordinary tables that accept events and numbering again',
      Gherkin.Do.pipe(
        Given('events, labels and tickets tables with their partitions migrated and then emptied')(
          'setup',
          () =>
            Effect.andThen(
              query(`${eventsTable}\n${archiveTable}\n${labelsAndTickets}`),
              Effect.tap(
                migrate(everything, 'partitions'),
                () => query('DELETE FROM events; DELETE FROM labels; DELETE FROM tickets'),
              ),
            ),
        ),
        When('the rollback written with the migration is run and an event is recorded')('seen', (s) =>
          Effect.andThen(
            rollBack(s.setup.down),
            Effect.all({
              kinds: relationKinds(['events', 'events_archive', 'events_2024', 'labels', 'tickets']),
              inserted: query(
                "INSERT INTO events (created_at, region, payload) VALUES ('2024-06-01', 'eu', 'after') RETURNING id > 0 AS positive",
              ),
            }),
          )),
        Then('every table is an ordinary table again, the partitions are gone and the new event gets a number')((
          s,
          expect,
        ) =>
          expect(s.seen).toEqual({
            kinds: [
              { relname: 'events', relkind: 'r' },
              { relname: 'events_archive', relkind: 'r' },
              { relname: 'labels', relkind: 'r' },
              { relname: 'tickets', relkind: 'r' },
            ],
            inserted: [{ positive: true }],
          })
        ),
      ),
    )

    scenario(
      'Rolling back is refused while a created partition still holds events',
      Gherkin.Do.pipe(
        Given('an events table partitioned by year with an event recorded in the first year')(
          'setup',
          () =>
            Effect.andThen(
              query(eventsTable),
              Effect.tap(migrate(yearlyEvents, 'partitions'), () => record([['2024-06-01', 'a']])),
            ),
        ),
        When('the rollback written with the migration is run')('seen', (s) =>
          Effect.all({
            refusal: refusalOf(rollBack(s.setup.down)),
            kinds: relationKinds(['events', 'events_2024']),
          })),
        Then('the rollback fails because the partition has rows, and the events table is still partitioned')((
          s,
          expect,
        ) =>
          expect({ ...s.seen, refusal: matches(/has rows\. Refusing to drop it/, s.seen.refusal) }).toEqual({
            refusal: true,
            kinds: [{ relname: 'events', relkind: 'p' }, { relname: 'events_2024', relkind: 'r' }],
          })
        ),
      ),
    )

    scenario(
      'Snake case column names and a partition in another schema are honoured',
      Gherkin.Do.pipe(
        Given('an empty events table in an account schema and an empty archive schema')(
          'setup',
          () =>
            query(`CREATE SCHEMA account; CREATE SCHEMA history;
CREATE TABLE account.events (id integer NOT NULL, created_at timestamp NOT NULL, PRIMARY KEY (id, created_at));`),
        ),
        When(
          'a yearly partition placed in the archive schema is migrated with snake case names and an event is recorded',
        )(
          'seen',
          () =>
            Effect.andThen(
              Effect.tap(generatedWithCasing(accountEventsExtras, 'partitions'), () => migrated),
              Effect.andThen(
                query("INSERT INTO account.events VALUES (1, '2024-06-01')"),
                Effect.all({
                  key: query("SELECT pg_get_partkeydef('account.events'::regclass) AS key"),
                  home: query('SELECT tableoid::regclass::text AS home FROM account.events'),
                }),
              ),
            ),
        ),
        Then('the table is partitioned by the snake case column and the event sits in the archive schema')((
          s,
          expect,
        ) =>
          expect(s.seen).toEqual({
            key: [{ key: 'RANGE (created_at)' }],
            home: [{ home: 'history.events_2024' }],
          })
        ),
      ),
    )

    scenario(
      'Partitioned tables and partitions exported beside the table are collected',
      Gherkin.Do.pipe(
        Given('an empty events table')('setup', () => query(eventsTable)),
        When('everything exported from the schema module is collected and migrated')('children', () =>
          Effect.andThen(
            migrate(collectExtras({ events, eventsParent, child: year2024() }), 'partitions'),
            childrenOf('events'),
          )),
        Then('the yearly partition is attached to the events table')((s, expect) =>
          expect(s.children).toEqual([{ child: 'events_2024' }])
        ),
      ),
    )

    scenario(
      'A partition key that the keys of the table do not cover is refused',
      Gherkin.Do.pipe(
        Given('an events table')('setup', () => query(eventsTable)),
        When(
          'a table with a primary key on its number only, a repeated key column, and a unique email index and a unique lower-case email expression index are declared as partitioned',
        )(
          'refusals',
          () => {
            const users = pgTable('users', {
              id: serial('id').primaryKey(),
              createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
            })
            const logged = pgTable('logged', {
              id: integer('id').notNull(),
              createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
              email: text('email').notNull(),
            }, (t) => [
              primaryKey({ columns: [t.id, t.createdAt] }),
              uniqueIndex('logged_email_uidx').on(t.email),
            ])
            const lowered = pgTable('lowered', {
              id: integer('id').notNull(),
              createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
              email: text('email').notNull(),
            }, (t) => [
              primaryKey({ columns: [t.id, t.createdAt] }),
              uniqueIndex('lowered_email_uidx').on(sql`lower(${t.email})`),
            ])
            return Effect.all({
              primaryKey: refusing(() => partitionedTable(users, { method: 'range', columns: [users.createdAt] })),
              repeated: refusing(() =>
                partitionedTable(events, { method: 'range', columns: [events.createdAt, events.createdAt] })
              ),
              unique: refusing(() => partitionedTable(logged, { method: 'range', columns: [logged.createdAt] })),
              expression: refusing(() => partitionedTable(lowered, { method: 'range', columns: [lowered.createdAt] })),
            })
          },
        ),
        Then('each declaration is refused with a message naming what is wrong')((s, expect) =>
          expect({
            primaryKey: matches(/partition key/, s.refusals.primaryKey),
            repeated: matches(/duplicate/, s.refusals.repeated),
            unique: matches(/logged_email_uidx.*must include partition key/, s.refusals.unique),
            expression: matches(/includes an expression/, s.refusals.expression),
          }).toEqual({ primaryKey: true, repeated: true, unique: true, expression: true })
        ),
      ),
    )

    scenario(
      'Bounds that do not fit the partitioning method are refused',
      Gherkin.Do.pipe(
        Given('an events table and a tickets table')('setup', () => query(`${eventsTable}\n${labelsAndTickets}`)),
        When(
          'a list bound on a range table, a fallback on a hash table, a bad remainder, a lopsided range and a partition without its table are declared',
        )(
          'refusals',
          () =>
            Effect.all({
              listOnRange: refusalOf(
                generated(
                  defineExtras({
                    partitionedTables: [eventsParent],
                    partitions: [pgPartition('events_eu', { parent: events, in: ['eu'] })],
                  }),
                  'bad',
                ),
              ),
              fallbackOnHash: refusalOf(
                generated(
                  defineExtras({
                    partitionedTables: [ticketsParent],
                    partitions: [pgPartition('tickets_default', { parent: tickets, default: true })],
                  }),
                  'bad',
                ),
              ),
              remainder: refusing(() => pgPartition('events_bad', { parent: events, modulus: 4, remainder: 4 })),
              lopsided: refusing(() =>
                pgPartition('events_orphan', { parent: events, from: ['2024-01-01'], to: ['2025-01-01', 'extra'] })
              ),
              orphan: refusalOf(generated(defineExtras({ partitions: [year2024()] }), 'bad')),
            }),
        ),
        Then('each declaration is refused with a message naming what is wrong')((s, expect) =>
          expect({
            listOnRange: matches(/range/, s.refusals.listOnRange),
            fallbackOnHash: matches(/DEFAULT/, s.refusals.fallbackOnHash),
            remainder: matches(/remainder/, s.refusals.remainder),
            lopsided: matches(/one bound per partition column/, s.refusals.lopsided),
            orphan: matches(/no partitionedTable/, s.refusals.orphan),
          }).toEqual({ listOnRange: true, fallbackOnHash: true, remainder: true, lopsided: true, orphan: true })
        ),
      ),
    )

    scenario(
      'Changing a partition key or bounds after they were migrated is refused',
      Gherkin.Do.pipe(
        Given('an events table partitioned by creation time with a yearly partition already migrated')(
          'setup',
          () =>
            Effect.andThen(
              query(eventsTable),
              migrate(defineExtras({ partitionedTables: [eventsParent], partitions: [year2024()] }), 'partitions'),
            ),
        ),
        When('the key is changed to the event number and, separately, the yearly bounds are moved back a year')(
          'refusals',
          () =>
            Effect.all({
              key: refusalOf(
                generated(
                  defineExtras({
                    partitionedTables: [partitionedTable(events, { method: 'range', columns: [events.id] })],
                    partitions: [pgPartition('events_2024', { parent: events, from: [0], to: [100] })],
                  }),
                  'key',
                ),
              ),
              bounds: refusalOf(
                generated(
                  defineExtras({
                    partitionedTables: [eventsParent],
                    partitions: [
                      pgPartition('events_2024', { parent: events, from: ['2023-01-01'], to: ['2024-01-01'] }),
                    ],
                  }),
                  'bounds',
                ),
              ),
            }),
        ),
        Then('both changes are refused before anything is written')((s, expect) =>
          expect({
            key: matches(/cannot change a partition key/, s.refusals.key),
            bounds: matches(/cannot alter partition bounds/, s.refusals.bounds),
          }).toEqual({ key: true, bounds: true })
        ),
      ),
    )
  })
