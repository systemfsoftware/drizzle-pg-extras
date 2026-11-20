import recommended from '@systemfsoftware/oxlint-config-recommended'
import { defineConfig } from 'oxlint'

// The house preset targets Effect / cell-architecture repositories. This package is a
// plain Node Postgres library with its own conventions, so rules that would force a
// rewrite of existing behavior or a foreign architecture are disabled here, each with
// its reason. Everything else the preset ships stays on. Three mechanisms need three
// treatments: preset `categories` are deleted, per-glob `overrides` lose the keys, and
// nested-extends rules are beaten by explicit top-level offs.
const disabledWithReasons: Record<string, string> = {
  // Effect idioms: rewriting them would churn src/ and tests/ without a behavior gain
  // for this package.
  'effecttsgo/strict-boolean-expressions': 'strict boolean conditions are intentional across src/ and tests/',
  'effecttsgo/missing-pipeable-signature': 'the public API is builder functions, not pipeable exports',
  'effecttsgo/extends-native-error': 'PgExtrasError extends Error as documented API',
  'effecttsgo/global-console': 'a Node CLI library prints to the console',
  'effecttsgo/global-date': 'a Node library uses Date',
  'effecttsgo/node-builtin-import': 'node: builtins are the runtime surface',
  'effecttsgo/process-env': 'a Node library reads process.env for its config',
  // Strictness rewrites over existing defensive code; this change keeps src/ behavior
  // unchanged.
  'typescript/strict-boolean-expressions': 'boolean style is intentional',
  'typescript/consistent-type-assertions': 'assertion style matches the codebase',
  'typescript/no-non-null-assertion': 'tests assert database rows after inserts; rewrites change how tests fail',
  'typescript/no-unnecessary-type-assertion': 'churn on existing defensive assertions',
  'typescript/no-unnecessary-condition': 'flags existing defensive checks',
  'typescript/no-unsafe-member-access': 'typed row generics over pg results are follow-up work',
  'typescript/no-unsafe-return': 'typed row generics over pg results are follow-up work',
  'typescript/no-unsafe-assignment': 'typed row generics over pg results are follow-up work',
  'typescript/no-unsafe-argument': 'typed row generics over pg results are follow-up work',
  // node: builtins are this package's runtime surface (Node CLI and library); the bare
  // key covers the effect-platform overrides, the prefixed key the preset map.
  'no-restricted-imports': 'node: builtins are the runtime surface',
  'eslint/no-restricted-imports': 'node: builtins are the runtime surface',
  // The two-argument expect(message) is stock Vitest API used for failure context, and
  // the conditional covers the installed drizzle-kit major.
  'valid-expect': 'stock Vitest two-argument expect for failure context',
  'vitest/valid-expect': 'stock Vitest two-argument expect for failure context',
  'no-conditional-in-test': 'the conditional covers the installed drizzle-kit major',
  'vitest/no-conditional-in-test': 'the conditional covers the installed drizzle-kit major',
  // Complexity budget flags the existing SQL builders; restructuring risks behavior.
  'complexity': 'the SQL builders are intentionally dense',
  'eslint/complexity': 'the SQL builders are intentionally dense',
  // House test-architecture rules for @systemfsoftware/vitest and spec lanes; this
  // repository runs stock Vitest from a tests/ tree (vitest 3.x kept by ruling).
  '@systemfsoftware/test-discipline/damp-test-naming': 'existing test names stay',
  '@systemfsoftware/test-discipline/tests-import-public-api': 'unit tests import src/ modules by design',
  '@systemfsoftware/test-discipline/test-suffix-outside-src': 'tests live in the tests/ tree',
  '@systemfsoftware/test-discipline/vitest-from-systemfsoftware-vitest': 'stock Vitest by ruling',
  '@systemfsoftware/test-discipline/no-behaviourless-assertion': 'house assertion shape',
  '@systemfsoftware/test-discipline/tests-dir-helpers-in-fixtures': 'house fixture layout',
  // House web/Effect conventions: asserts on spawned process .status, unknown is
  // expected to carry a domain type, the ColumnCasing class is intentional, and the
  // CLI prints String(error).
  '@systemfsoftware/cell-architecture/no-bodyless-status-assertion':
    'asserts on spawned process status, not HTTP responses',
  '@systemfsoftware/cell-architecture/ban-unknown':
    'unknown carries SQL strings and parsed snapshots, not a domain type',
  '@systemfsoftware/cell-architecture/ban-classes': 'the ColumnCasing helper class is intentional',
  '@systemfsoftware/cell-architecture/ban-error-string': 'the CLI prints String(error)',
}

const config = recommended

// The nested house configs key their rules bare, the tsgo presets prefix them, and
// every level of the extends chain can carry its own rules and overrides — strip the
// disabled keys everywhere in the config graph.
function stripDisabled(rules: unknown): void {
  if (!rules || typeof rules !== 'object') return
  const map = rules as Record<string, unknown>
  for (const key of Object.keys(map)) {
    const bare = key.includes('/') && !key.startsWith('@') ? key.slice(key.indexOf('/') + 1) : key
    if (disabledWithReasons[key] !== undefined || disabledWithReasons[bare] !== undefined) {
      delete map[key]
    }
  }
}

function sanitize(node: unknown, seen: Set<object>): void {
  if (Array.isArray(node)) {
    for (const entry of node) sanitize(entry, seen)
    return
  }
  if (node === null || typeof node !== 'object') return
  if (seen.has(node)) return
  seen.add(node)
  const object = node as Record<string, unknown>
  if (Array.isArray(object.extends)) sanitize(object.extends, seen)
  stripDisabled(object.rules)
  if (Array.isArray(object.overrides)) {
    for (const override of object.overrides) {
      if (override && typeof override === 'object') stripDisabled(override.rules)
    }
  }
}

sanitize(config, new Set())

const offs: Record<string, 'off'> = {}
for (const key of Object.keys(disabledWithReasons)) {
  offs[key] = 'off'
  const segments = key.split('/')
  if (!key.startsWith('@') && segments.length === 2) offs[segments[1]!] = 'off'
}

export default defineConfig({ extends: [config], rules: offs })
