import { commandExecutionSetSchema, type CommandExecutionConfig } from '@eden/api'
import { hostCommandInfo, runHostCommand } from '@eden/execution'
import type { configuredExternalCommandSandbox } from '@eden/execution'
import type { EdenDatabase } from '@eden/store'

export class CommandService {
  private active = 0
  private generation = 0
  constructor(private readonly database: EdenDatabase, _protectedRoots: readonly string[],
    _external?: ReturnType<typeof configuredExternalCommandSandbox>) { }

  snapshot() {
    // Ignore saved sandbox settings while the developer-review suspension is in force.
    return { config: { mode: 'host' as const, networkAccess: true, writableRoots: [] as string[] }, generation: this.generation }
  }

  async info() {
    const host = hostCommandInfo()
    return { ...this.snapshot().config, available: host.available, hostAvailable: host.available, hostShell: host.shell,
      sandboxAvailable: false, sandboxBackend: 'disabled', shell: host.shell,
      detail: '当前统一使用本机执行，文件和网络访问遵循当前系统账户权限。' }
  }

  async set(raw: unknown) {
    const input = commandExecutionSetSchema.parse(raw)
    if (this.active) throw new Error('Wait for running commands before changing execution boundaries')
    if (input.mode !== 'host') throw new Error('沙箱机制已暂停，需开发者审阅后才能重新加入。')
    if (input.mode === 'host' && !hostCommandInfo().available) throw new Error('Host command execution is unavailable on this platform')
    const config: CommandExecutionConfig = { mode: 'host', networkAccess: true, writableRoots: [] }
    this.database.transaction(() => {
      const previous = this.snapshot().config
      const now = Date.now()
      this.database.connection.prepare("UPDATE legacy_app_config SET state='reconfigured',resolution_json=?,resolved_at=? WHERE target_key='command.execution' AND state IN ('confirmation_required','review_required')")
        .run(JSON.stringify(config), now)
      this.database.connection.prepare('INSERT OR REPLACE INTO runtime_settings VALUES (?, ?, ?)').run('command.execution', JSON.stringify(config), now)
      this.database.connection.prepare('INSERT INTO runtime_setting_changes(key,previous_json,value_json,created_at) VALUES (?, ?, ?, ?)')
        .run('command.execution', JSON.stringify(previous), JSON.stringify(config), now)
    })
    this.generation++
    return this.info()
  }

  async execute(snapshot: ReturnType<CommandService['snapshot']>, root: string, command: string, signal: AbortSignal) {
    signal.throwIfAborted()
    if (snapshot.generation !== this.generation) throw new Error('Execution boundary changed after approval; submit the command again')
    this.active++
    try {
      return await runHostCommand(root, command, signal)
    } finally { this.active-- }
  }
}
