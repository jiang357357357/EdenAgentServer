import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Account-local identity is generated on first use; it contains no authentication credential. */
export function deviceIdentity(dataRoot: string): () => Promise<string> {
  let pending: Promise<string> | undefined
  return () => pending ??= loadDevice(dataRoot).catch(error => { pending = undefined; throw error })
}
async function loadDevice(dataRoot: string): Promise<string> {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  const filename = path.join(dataRoot, 'device-id')
  const candidate = randomUUID()
  try { await writeFile(filename, candidate, { flag: 'wx', mode: 0o600 }); return candidate }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const stat = await lstat(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64) throw new Error('共享资料库设备身份文件无效')
  const existing = (await readFile(filename, 'utf8')).trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing))
    throw new Error('共享资料库设备身份文件无效')
  return existing
}
