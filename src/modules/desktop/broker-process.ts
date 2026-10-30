import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DesktopError } from './contracts.ts'

declare const EDEN_BUNDLED_SERVER: boolean

export async function launchDesktopBroker(root: string): Promise<void> {
  const bundled = typeof EDEN_BUNDLED_SERVER !== 'undefined'
  const entry = fileURLToPath(new URL(bundled ? './desktop-broker.mjs' : './broker-entry.ts', import.meta.url))
  const child = spawn(process.execPath, [...(bundled ? [] : ['--import', 'tsx']), entry, root],
    { windowsHide: true, stdio: 'ignore', detached: false, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.on('error', () => reject(new DesktopError('桌面服务进程未能启动，请检查运行制品与启动器', 'BROKER_START_FAILED')))
  })
  child.unref()
}
