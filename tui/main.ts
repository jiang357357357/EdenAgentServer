import { capabilityToken, parseConfig, usage } from './config.ts'
import { TuiApp } from './app.ts'

async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2))
  if (!config) { process.stdout.write(`${usage}\n`); return }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('终端保底界面需要交互式终端')
  const capability = capabilityToken(config)
  await new TuiApp(config, capability).run()
}

await main().catch(error => {
  process.stderr.write(`Eden Agent TUI: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
