import { Gherkin, Given, it, makeFeature, Then, When } from '@systemfsoftware/effect-gherkin-spec'
import { defineExtras, pgFunction, pgGrant, viewDefinition } from '@systemfsoftware/timescale-drizzle'
import { sql } from 'drizzle-orm'
import { integer, pgRole, pgSchema, text } from 'drizzle-orm/pg-core'
import { Effect } from 'effect'
import { freshDatabase, generated, migrated, postgresServer, query, queryAs } from './__fixtures__/database.fixture.js'

const Feature = makeFeature({ it })

const READER = 'shop_reader'
const ABSENT = 'shop_auditor'

const shop = pgSchema('shop')
const orders = shop.table('orders', {
  id: integer('id').primaryKey(),
  customer: text('customer').notNull(),
  total: integer('total').notNull(),
})
const positiveOrders = shop.view('positive_orders', { id: integer('id'), total: integer('total') }).existing()
const bigOrders = shop.view('big_orders', { id: integer('id') }).existing()

const ordersTable = `CREATE SCHEMA shop;
CREATE TABLE shop.orders (id integer PRIMARY KEY, customer text NOT NULL, total integer NOT NULL);
INSERT INTO shop.orders VALUES (1, 'ada', 5), (2, 'bo', 50), (3, 'cy', -1);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${READER}') THEN CREATE ROLE ${READER}; END IF;
END $$;
DROP ROLE IF EXISTS ${ABSENT};`

function shopSchema(options: { argument: string; bigOver: number }) {
  const ordersOver = pgFunction('orders_over', {
    schema: shop,
    args: [{ name: options.argument, type: 'integer', default: '0' }],
    returns: { kind: 'table', columns: [{ name: 'id', type: 'integer' }, { name: 'total', type: orders.total }] },
    language: 'sql',
    volatility: 'stable',
    body: sql`SELECT o.id, o.total FROM ${orders} o WHERE o.total > ${sql.raw(options.argument)}`,
  })
  const reader = pgRole(READER).existing()
  return defineExtras({
    functions: [ordersOver],
    viewDefinitions: [
      viewDefinition(bigOrders, {
        query: sql`SELECT id FROM ${positiveOrders} WHERE total > ${sql.raw(String(options.bigOver))}`,
      }),
      viewDefinition(positiveOrders, { query: sql`SELECT * FROM ${ordersOver}(0)` }),
    ],
    grants: [
      pgGrant({ to: reader, on: shop, privileges: ['usage'] }),
      pgGrant({ to: reader, on: orders, privileges: ['select'] }),
      pgGrant({ to: reader, on: positiveOrders, privileges: ['select'] }),
      pgGrant({ to: reader, on: bigOrders, privileges: ['select'] }),
      pgGrant({ to: reader, on: ordersOver, privileges: ['execute'] }),
      pgGrant({ to: ABSENT, on: bigOrders, privileges: ['select'], onlyIfRoleExists: true }),
    ],
  })
}

const handWrittenObjects = `CREATE FUNCTION shop.orders_over(p_min integer DEFAULT 0)
  RETURNS TABLE (id integer, total integer) LANGUAGE sql STABLE
  AS $$ SELECT o.id, o.total FROM shop.orders o WHERE o.total > p_min $$;
CREATE VIEW shop.positive_orders AS SELECT * FROM shop.orders_over(0);
CREATE VIEW shop.big_orders AS SELECT id FROM shop.positive_orders WHERE total > 10;
GRANT USAGE ON SCHEMA shop TO ${READER};
GRANT SELECT ON shop.big_orders TO ${READER};`

const migrate = (extras: ReturnType<typeof shopSchema>, name: string) =>
  Effect.andThen(generated(extras, name), migrated)

const refusalOf = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.message)

Feature('Declaring views, functions and grants next to the tables', { timeout: 180_000 })
  .live('a real Postgres booted in a microVM')
  .withLayer(postgresServer)
  .withScenarioLayer(freshDatabase)
  .body(({ scenario }) => {
    scenario(
      'A reporting role reads a view built on a function and on another view',
      Gherkin.Do.pipe(
        Given('a shop with three orders and a reporting role')('setup', () => query(ordersTable)),
        When('the views, the function and the reporting grants are migrated, and the reporting role reads them')(
          'seen',
          () =>
            Effect.andThen(
              migrate(shopSchema({ argument: 'p_min', bigOver: 10 }), 'objects'),
              Effect.all({
                big: queryAs(READER, 'SELECT id FROM shop.big_orders ORDER BY id'),
                positive: queryAs(READER, 'SELECT id, total FROM shop.positive_orders ORDER BY id'),
                insert: refusalOf(queryAs(READER, "INSERT INTO shop.orders VALUES (9, 'x', 1)")),
              }),
            ),
        ),
        Then('the reporting role sees the big order and the positive orders, and cannot add an order')((s, expect) =>
          expect({ ...s.seen, insert: /permission denied/.test(s.seen.insert) }).toEqual({
            big: [{ id: 2 }],
            positive: [{ id: 1, total: 5 }, { id: 2, total: 50 }],
            insert: true,
          })
        ),
      ),
    )

    scenario(
      'Renaming a function argument rebuilds the views that call it and keeps their grants',
      Gherkin.Do.pipe(
        Given('a shop whose reporting views are already migrated')(
          'setup',
          () => Effect.andThen(query(ordersTable), migrate(shopSchema({ argument: 'p_min', bigOver: 10 }), 'objects')),
        ),
        When('the function argument is renamed and the big order threshold drops to one')('seen', () =>
          Effect.andThen(
            migrate(shopSchema({ argument: 'p_floor', bigOver: 1 }), 'rename'),
            Effect.all({
              big: queryAs(READER, 'SELECT id FROM shop.big_orders ORDER BY id'),
              signature: query("SELECT pg_get_function_arguments('shop.orders_over(integer)'::regprocedure) AS args"),
              orders: query('SELECT count(*)::int AS n FROM shop.orders'),
            }),
          )),
        Then('the reporting role reads the new big orders through the renamed function, and no order is lost')((
          s,
          expect,
        ) =>
          expect(s.seen).toEqual({
            big: [{ id: 1 }, { id: 2 }],
            signature: [{ args: 'p_floor integer DEFAULT 0' }],
            orders: [{ n: 3 }],
          })
        ),
      ),
    )

    scenario(
      'Views and functions written by hand earlier are taken over in place',
      Gherkin.Do.pipe(
        Given('a shop whose function and views were created by hand with the same definitions')(
          'setup',
          () => Effect.andThen(query(ordersTable), query(handWrittenObjects)),
        ),
        When('the declared views, function and grants are migrated over them')('seen', () =>
          Effect.andThen(
            migrate(shopSchema({ argument: 'p_min', bigOver: 10 }), 'objects'),
            Effect.all({
              big: queryAs(READER, 'SELECT id FROM shop.big_orders'),
              views: query(
                "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'shop' AND c.relkind = 'v' ORDER BY 1",
              ),
            }),
          )),
        Then('the reporting role still reads the same big order from the same two views')((s, expect) =>
          expect(s.seen).toEqual({
            big: [{ id: 2 }],
            views: [{ relname: 'big_orders' }, { relname: 'positive_orders' }],
          })
        ),
      ),
    )

    scenario(
      'A grant to a role the environment never created is skipped',
      Gherkin.Do.pipe(
        Given('a shop with no auditor role')('setup', () => query(ordersTable)),
        When('a grant to the auditor that waits for the role is migrated')('grantees', () =>
          Effect.andThen(
            migrate(shopSchema({ argument: 'p_min', bigOver: 10 }), 'objects'),
            query(
              "SELECT DISTINCT grantee FROM information_schema.role_table_grants WHERE table_schema = 'shop' AND table_name = 'big_orders' AND grantee <> current_user ORDER BY 1",
            ),
          )),
        Then('the migration completes and only the reporting role can read the big orders')((s, expect) =>
          expect(s.grantees).toEqual([{ grantee: READER }])
        ),
      ),
    )

    scenario(
      'A function with in-out, out and variadic arguments answers with every output',
      Gherkin.Do.pipe(
        Given('a shop schema')('setup', () => query('CREATE SCHEMA shop')),
        When('a function that halves an amount and takes any number of tags is migrated and called with nine')(
          'answer',
          () =>
            Effect.andThen(
              Effect.andThen(
                generated(
                  defineExtras({
                    functions: [pgFunction('split_total', {
                      schema: shop,
                      args: [
                        { mode: 'inout', name: 'amount', type: 'integer' },
                        { mode: 'out', name: 'half', type: 'integer' },
                        { mode: 'variadic', name: 'tags', type: 'text[]' },
                      ],
                      returns: 'record',
                      language: 'plpgsql',
                      volatility: 'immutable',
                      body: 'BEGIN\n  half := amount / 2;\nEND;',
                    })],
                  }),
                  'split',
                ),
                migrated,
              ),
              query("SELECT * FROM shop.split_total(9, 'a', 'b')"),
            ),
        ),
        Then('it answers nine and its half')((s, expect) => expect(s.answer).toEqual([{ amount: 9, half: 4 }])),
      ),
    )

    scenario(
      'Removing a view that another view still reads is refused before anything is written',
      Gherkin.Do.pipe(
        Given('a shop whose reporting views are already migrated')(
          'setup',
          () => Effect.andThen(query(ordersTable), migrate(shopSchema({ argument: 'p_min', bigOver: 10 }), 'objects')),
        ),
        When('the positive orders view is removed while the big orders view still reads it')(
          'refusal',
          () =>
            refusalOf(generated(
              defineExtras({
                viewDefinitions: [viewDefinition(bigOrders, { query: sql`SELECT id FROM ${positiveOrders}` })],
              }),
              'orphan',
            )),
        ),
        Then('the change is refused and names the view still in use')((s, expect) =>
          expect(s.refusal).toMatch(/reads view shop\.positive_orders, which was removed/)
        ),
      ),
    )
  })
