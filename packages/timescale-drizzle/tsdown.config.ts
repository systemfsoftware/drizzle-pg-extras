import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node20',
    deps: { onlyBundle: false },
    outExtensions: ({ format }) => ({
      js: format === 'es' ? '.js' : '.cjs',
      dts: format === 'es' ? '.d.ts' : '.d.cts',
    }),
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
    target: 'node20',
    deps: { onlyBundle: false },
    outExtensions: () => ({ js: '.js' }),
    banner: { js: '#!/usr/bin/env node' },
  },
])
