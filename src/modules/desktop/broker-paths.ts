import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

export function brokerPaths(root = path.join(process.env.LOCALAPPDATA ?? tmpdir(), 'EdenAgent', 'desktop-control')) {
  const absolute = path.resolve(root)
  const key = createHash('sha256').update(`${homedir()}\0${absolute}`).digest('hex').slice(0, 24)
  return { root: absolute, endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\eden-desktop-${key}` : path.join(absolute, 'broker.sock'),
    token: path.join(absolute, 'broker-token.json'), control: path.join(absolute, 'control.json') }
}
