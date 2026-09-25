import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { workspaceFile } from './workspace-path.ts'

/** Byte offsets keep paging stable even when a file contains multibyte text. */
export async function readWorkspacePage(root: string, requested: string, offset: number, limit: number) {
  const filename = workspaceFile(root, requested)
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('Workspace path is not a regular file')
    if (offset > stat.size) throw new Error('Read offset exceeds file size')
    const buffer = Buffer.alloc(Math.min(stat.size - offset, limit + 4))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
    const available = buffer.subarray(0, bytesRead)
    const binary = available.includes(0)
    if (binary) return { name: path.basename(filename), path: filename, size: stat.size,
      binary: true, truncated: stat.size > offset, content: '', offset, nextOffset: null, offsetUnit: 'bytes' }
    let length = Math.min(limit, bytesRead)
    let content = ''
    for (let trim = 0; trim <= 4; trim++) {
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(available.subarray(0, length)); break }
      catch {
        if (trim === 4 || length === 0) throw new Error('File page is not valid UTF-8 text')
        length--
      }
    }
    if (length === 0 && offset < stat.size) throw new Error('Read offset cuts through a UTF-8 character or the file contains invalid text')
    const nextOffset = offset + length < stat.size ? offset + length : null
    return { name: path.basename(filename), path: filename, size: stat.size,
      binary: false, truncated: nextOffset !== null, content, offset, nextOffset, offsetUnit: 'bytes' }
  } finally { await file.close() }
}
