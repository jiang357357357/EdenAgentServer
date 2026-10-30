import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { z } from 'zod'

const assetSchema = z.object({ file: z.string().regex(/^(node|monpm|libstdcpp|libgcc)-linux-(x64|arm64)\.gz$/),
  size: z.number().int().min(1).max(128 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  rawSize: z.number().int().min(1).max(256 * 1024 * 1024), rawSha256: z.string().regex(/^[a-f0-9]{64}$/) })
const targetSchema = z.object({ node: assetSchema, monpm: assetSchema, libstdcpp: assetSchema, libgcc: assetSchema })
const manifestSchema = z.object({ schemaVersion: z.literal(2), nodeVersion: z.literal('22.23.1'),
  targets: z.object({ 'linux-x64': targetSchema, 'linux-arm64': targetSchema }) })
export type HostRuntimeAsset = z.infer<typeof assetSchema>
export type HostRuntimeBundle = z.infer<typeof targetSchema> & { root: string; id: string; notices: { node: string; monpm: string; cpp: string } }
export const hostRuntimeFiles = { node: 'node', monpm: 'monpm', libstdcpp: 'libstdc++.so.6', libgcc: 'libgcc_s.so.1' } as const

async function notice(root: string, name: string) {
  const filename = path.join(root, name), info = await lstat(filename)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) throw new Error('Invalid runtime notice')
  return readFile(filename, 'utf8')
}

export async function hostRuntimeBundle(root: string | undefined, architecture: 'x64' | 'arm64'): Promise<HostRuntimeBundle> {
  if (!root) throw new Error('共享资料库 DLC 缺少远端运行包，请安装包含运行环境的配套 DLC')
  try {
    const directory = await lstat(root)
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid runtime directory')
    const manifestPath = path.join(root, 'manifest.json'), info = await lstat(manifestPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024) throw new Error('Invalid runtime manifest')
    const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
    const target = manifest.targets[`linux-${architecture}`]
    const names = ['node', 'monpm', 'libstdcpp', 'libgcc'] as const
    for (const name of names) if (target[name].file !== `${name}-linux-${architecture}.gz`) throw new Error('Wrong runtime architecture')
    const id = createHash('sha256').update(names.map(name => target[name].rawSha256).join('')).digest('hex').slice(0, 24)
    const [node, monpm, cpp] = await Promise.all([notice(root, 'LICENSE.node.txt'), notice(root, 'NOTICE.monpm.txt'), notice(root, 'NOTICE.cpp.txt')])
    return { root, id, ...target, notices: { node, monpm, cpp } }
  } catch { throw new Error('共享资料库 DLC 远端运行包缺失或清单无效，请更新完整 DLC') }
}

/** Validate compressed bytes first, then enforce decompressed size/digest before allowing execution. */
export async function unpackHostRuntime(bundle: HostRuntimeBundle, asset: HostRuntimeAsset, output: string, signal: AbortSignal): Promise<void> {
  const source = path.join(bundle.root, asset.file), info = await lstat(source)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.size) throw new Error('远端运行包文件大小或类型不符')
  const compressed = createHash('sha256')
  for await (const bytes of createReadStream(source)) { signal.throwIfAborted(); compressed.update(bytes) }
  if (compressed.digest('hex') !== asset.sha256) throw new Error('远端运行包压缩文件 SHA-256 校验失败')
  const raw = createHash('sha256'); let size = 0
  const inspect = new Transform({ transform(bytes: Buffer, _encoding, callback) {
    size += bytes.length
    if (size > asset.rawSize) { callback(new Error('远端运行包解压大小超限')); return }
    raw.update(bytes); callback(null, bytes)
  } })
  await pipeline(createReadStream(source), createGunzip(), inspect, createWriteStream(output, { flags: 'wx', mode: 0o700 }), { signal })
  if (size !== asset.rawSize || raw.digest('hex') !== asset.rawSha256) throw new Error('远端运行包内容 SHA-256 校验失败')
}
