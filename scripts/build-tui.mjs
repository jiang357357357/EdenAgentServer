import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
await build({
  absWorkingDir: root,
  entryPoints: ['Server/tui/main.ts'],
  outfile: 'dist/server/tui.mjs',
  bundle: true,
  platform: 'node', target: 'node22', format: 'esm', sourcemap: true,
  external: ['@earendil-works/*', 'ws', 'zod', 'typebox'],
})
process.stdout.write('Built dist/server/tui.mjs\n')
