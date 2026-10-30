import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

export async function buildTui(root = fileURLToPath(new URL('../../', import.meta.url)), output = 'dist/server/tui.mjs') {
await build({
  absWorkingDir: root,
  entryPoints: ['Server/tui/main.ts'],
  outfile: path.resolve(root, output),
  bundle: true,
  platform: 'node', target: 'node22', format: 'esm', sourcemap: true,
  external: ['@earendil-works/*', 'ws', 'zod', 'typebox'],
})
process.stdout.write('Built TUI bundle\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await buildTui()
