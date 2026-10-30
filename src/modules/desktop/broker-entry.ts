import { serveDesktopBroker } from './broker-server.ts'

const root = process.argv[2]
if (!root) throw new Error('缺少桌面控制服务目录')
try {
  const broker = await serveDesktopBroker(root)
  process.on('SIGTERM', () => { void broker.close() })
  process.on('SIGINT', () => { void broker.close() })
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') process.stderr.write('桌面控制服务启动失败\n')
  process.exitCode = (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 0 : 1
}
