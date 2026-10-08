import { WebSocket } from 'ws'

/** At most one event write is pending per delivery, so catch-up does not flood ws.bufferedAmount. */
export function sendWebsocketEvent(client: WebSocket, serialized: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (client.readyState !== WebSocket.OPEN) { reject(new Error('Event connection is closed')); return }
    const finished = (error?: Error) => {
      clearTimeout(timer)
      client.off('close', closed)
      client.off('error', finished)
      if (error) reject(error)
      else resolve()
    }
    const closed = () => finished(new Error('Event connection closed during send'))
    const timer = setTimeout(() => {
      client.close(1013, 'Event consumer did not drain the connection')
      finished(new Error('Event send timed out'))
    }, 10000)
    client.once('close', closed)
    client.once('error', finished)
    try { client.send(serialized, finished) }
    catch (error) { finished(error instanceof Error ? error : new Error('Event send failed')) }
  })
}
