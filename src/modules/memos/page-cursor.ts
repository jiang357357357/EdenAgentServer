import { createHash } from 'node:crypto'
import { z } from 'zod'
import { currentAccount } from '../accounts/index.ts'

const cursorSchema = z.tuple([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().length(64)])
const scope = (query: string) => createHash('sha256').update(JSON.stringify([currentAccount()?.key ?? 'local', query])).digest('hex')
export function readMemoCursor(cursor: string | undefined, query: string) {
  if (!cursor) return undefined
  try {
    const [updatedAt, id, filter] = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
    if (filter !== scope(query)) throw new Error('Cursor scope changed')
    return { updatedAt, id }
  } catch { throw new Error('备忘分页游标无效或查询条件已变化，请刷新列表。') }
}
export function writeMemoCursor(updatedAt: number, id: number, query: string): string {
  return Buffer.from(JSON.stringify([updatedAt, id, scope(query)])).toString('base64url')
}
