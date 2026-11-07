import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { containsPath, workspaceFile } from '@eden/execution'
import type { WorkspaceService } from '../workspace/index.ts'

declare const EDEN_BUNDLED_SERVER: boolean
function sdkEntry() {
  const bundled = typeof EDEN_BUNDLED_SERVER !== 'undefined' && EDEN_BUNDLED_SERVER
  return fileURLToPath(new URL(bundled ? './connector-sdk.mjs' : '../../../../packages/plugin-sdk/src/connector/index.ts', import.meta.url))
}
async function files(root: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name)
    if (entry.isDirectory()) result.push(...await files(filename))
    else if (entry.isFile()) result.push(filename)
    else throw new Error('插件包不能包含符号链接或特殊文件')
  }
  return result.sort()
}
export function connectorBuildPaths(workspace: WorkspaceService, source: string, output: string) {
  const root = workspace.root(), sourceRoot = workspaceFile(root, source), target = path.resolve(root, output)
  if (!containsPath(root, target) || target === root) throw new Error('构建目录必须位于工作区内')
  const parent = workspaceFile(root, path.dirname(target))
  if (path.resolve(parent, path.basename(target)) !== target) throw new Error('构建目录的父路径发生重定向')
  if (containsPath(sourceRoot, target)) throw new Error('构建目录不能位于源码目录内')
  return { root, sourceRoot, target }
}
/** The output is newly created; no pre-existing directory is replaced. */
export async function buildConnectorPackage(sourceRoot: string, target: string, signal: AbortSignal) {
  const metadata = path.join(sourceRoot, 'package'), manifest = JSON.parse(await readFile(path.join(metadata, 'connector.json'), 'utf8'))
  const plugin = JSON.parse(await readFile(path.join(metadata, 'plugin.json'), 'utf8'))
  if (manifest.runtime !== 'node' || manifest.entrypoints?.node?.path !== 'worker/main.mjs') throw new Error('连接器需要 Node worker/main.mjs 入口')
  if (!plugin.components?.runtimes?.some((item: { kind?: string; manifest?: string }) => item.kind === 'connector' && item.manifest === 'connector.json')) throw new Error('插件没有声明连接器组件')
  try { await lstat(target); throw new Error('构建目录已存在，请选择新的输出目录') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const staging = `${target}.staging-${randomUUID()}`
  try {
    await cp(metadata, staging, { recursive: true, errorOnExist: true, force: false, filter: async file => {
      if ((await lstat(file)).isSymbolicLink()) throw new Error('插件包不能包含符号链接')
      return !['checksums.json', 'signature.json', 'worker', 'workers'].includes(path.relative(metadata, file).split(path.sep)[0]!)
    } })
    signal.throwIfAborted()
    await mkdir(path.join(staging, 'worker'))
    await build({ entryPoints: [path.join(sourceRoot, 'src/main.ts')], outfile: path.join(staging, 'worker/main.mjs'), bundle: true,
      platform: 'node', target: 'node22', format: 'esm', sourcemap: false, packages: 'bundle', alias: { '@eden/plugin-sdk/connector': sdkEntry() }, logLevel: 'silent' })
    signal.throwIfAborted()
    const checksums: Record<string, string> = {}
    for (const file of await files(staging)) checksums[path.relative(staging, file).split(path.sep).join('/')] = createHash('sha256').update(await readFile(file)).digest('hex')
    await writeFile(path.join(staging, 'checksums.json'), JSON.stringify(checksums, null, 2) + '\n')
    signal.throwIfAborted()
    // Reserve the destination atomically; never replace a directory created by another actor.
    await mkdir(target)
    for (const name of await readdir(staging)) await rename(path.join(staging, name), path.join(target, name))
    await rm(staging, { recursive: true, force: true })
    return { id: String(plugin.id), connectorId: String(manifest.id), path: target }
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error }
}
