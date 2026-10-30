import { randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { DesktopError } from './contracts.ts'

export const desktopBrokerProtocol = 'eden.desktop.3'
const registration = z.object({ token: z.string().length(64), protocol: z.string().regex(/^eden\.desktop\.\d{1,8}$/),
  pid: z.number().int().positive().optional() }).passthrough()

export async function readBrokerRegistration(filename: string) {
  try { return registration.parse(JSON.parse(await readFile(filename, 'utf8'))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new DesktopError('桌面服务端点可连接，但服务登记无效；未覆盖登记或重启服务，请检查对应启动器', 'BROKER_REGISTRATION_INVALID')
  }
}

/** Keep the old registration intact until the listener's replacement is fully written. */
export async function publishBrokerRegistration(filename: string, token: string) {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ token, protocol: desktopBrokerProtocol, pid: process.pid }), { mode: 0o600 })
    const deadline = Date.now() + 1000
    for (;;) {
      try { await rename(temporary, filename); return }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(String((error as NodeJS.ErrnoException).code)) || Date.now() >= deadline) throw error
        await delay(20)
      }
    }
  } finally { await rm(temporary, { force: true }) }
}
