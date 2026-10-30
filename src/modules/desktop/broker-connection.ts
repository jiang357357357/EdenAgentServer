import { createConnection, type Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { DesktopError } from './contracts.ts'
import type { brokerPaths } from './broker-paths.ts'
import { brokerVersionMismatch } from '../../model-prompts/desktop-broker.ts'
import { desktopBrokerProtocol, readBrokerRegistration } from './broker-registration.ts'

export function brokerOffline(error: unknown): boolean {
  return ['ENOENT', 'ECONNREFUSED'].includes(String((error as NodeJS.ErrnoException | undefined)?.code))
}

/** Probe the endpoint before trusting persistent metadata, which can outlive any PID. */
export async function registeredBroker(paths: ReturnType<typeof brokerPaths>): Promise<{ socket: Socket; token: string }> {
  const socket = await connectEndpoint(paths.endpoint)
  try {
    // listen() becomes reachable just before the broker publishes its atomic registration.
    const deadline = Date.now() + 1200
    do {
      const result = await readBrokerRegistration(paths.token)
      if (result?.protocol === desktopBrokerProtocol) return { socket, token: result.token }
      if (Date.now() >= deadline) {
        if (result) throw new DesktopError(brokerVersionMismatch(result.protocol), 'BROKER_UPDATE_REQUIRED', 'failed',
          { endpointReachable: true, expectedProtocol: desktopBrokerProtocol, registeredProtocol: result.protocol,
            recovery: ['check_broker_registration', 'coordinate_broker_upgrade'] })
        throw new DesktopError('桌面服务端点可连接，但服务登记尚未就绪；请检查对应启动器', 'BROKER_REGISTRATION_PENDING')
      }
      await delay(30)
    } while (true)
  } catch (error) { socket.destroy(); throw error }
}

function connectEndpoint(endpoint: string): Promise<Socket> {
  const socket = createConnection(endpoint)
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => { clearTimeout(timeout); socket.destroy(); reject(error) }
    const timeout = setTimeout(() => failed(new DesktopError('桌面服务端点连接超时，未启动替代服务', 'BROKER_CONNECTION_TIMEOUT')), 1500)
    socket.once('error', failed)
    socket.once('connect', () => {
      clearTimeout(timeout); socket.removeListener('error', failed)
      // Registration may still be in flight; keep any disconnect contained until the client attaches.
      socket.on('error', () => socket.destroy())
      resolve(socket)
    })
  })
}
