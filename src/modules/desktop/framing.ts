import type { Socket } from 'node:net'

export function jsonLines(socket: Socket, limit: number, receive: (value: unknown) => void): void {
  let pending = Buffer.alloc(0)
  socket.on('data', chunk => {
    pending = Buffer.concat([pending, chunk])
    for (;;) {
      const end = pending.indexOf(10)
      if (end < 0) break
      if (end > limit) { socket.destroy(new Error('桌面通信消息超过长度限制')); return }
      const line = pending.subarray(0, end).toString('utf8')
      pending = pending.subarray(end + 1)
      try { receive(JSON.parse(line)) } catch { socket.destroy(new Error('桌面通信消息格式错误')); return }
    }
    if (pending.length > limit) socket.destroy(new Error('桌面通信消息超过长度限制'))
  })
}
export function send(socket: Socket, value: unknown): void {
  if (socket.destroyed) throw new Error('桌面控制连接已关闭')
  socket.write(JSON.stringify(value) + '\n')
}
