import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import path from 'node:path'

const maxBytes = 8 * 1024 * 1024

/** Read only after approval, checking both the selected path and the opened file. */
export async function readQqWorkspaceFile(root: string, target: string): Promise<Buffer> {
  if (await realpath(target) !== target) throw new Error('QQ file path contains a symbolic link')
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (process.platform === 'linux') {
      const openedPath = await realpath(`/proc/self/fd/${handle.fd}`)
      if (!openedPath.startsWith(root + path.sep)) throw new Error('QQ file escaped the workspace')
    }
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('QQ file must be a regular file of at most 8 MiB')
    const bytes = await handle.readFile()
    if (bytes.length !== stat.size || bytes.length > maxBytes) throw new Error('QQ file changed while reading')
    return bytes
  } finally { await handle.close() }
}
