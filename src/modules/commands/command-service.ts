import { commandExecutionSetSchema, terminalSetSchema, terminalTargetSchema, type CommandExecutionConfig, type TerminalTarget } from '@eden/api'
import { hostCommandInfo, listWslDistributions, runHostCommand, runWslCommand } from '@eden/execution'
import type { configuredExternalCommandSandbox } from '@eden/execution'
import type { EdenDatabase } from '@eden/store'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const hostTarget: TerminalTarget = { kind: 'host' }
const sessionKey = (sessionId: string) => `command.terminal.session.${sessionId}`

export class CommandService {
  private active = 0
  private generation = 0
  constructor(private readonly database: EdenDatabase, _protectedRoots: readonly string[],
    _external?: ReturnType<typeof configuredExternalCommandSandbox>,
    private readonly terminalOptions: { deviceSettingsPath?: string | undefined; assertSession?: (sessionId: string) => void } = {}) { }

  private deviceSettingsPath() { return this.terminalOptions.deviceSettingsPath ?? path.resolve('Data', 'terminal-settings.json') }

  private deviceDefault(): TerminalTarget {
    let source: string
    try { source = readFileSync(this.deviceSettingsPath(), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return hostTarget
      throw error
    }
    return terminalTargetSchema.parse(JSON.parse(source))
  }

  private sessionOverride(sessionId?: string): TerminalTarget | null {
    if (!sessionId) return null
    this.terminalOptions.assertSession?.(sessionId)
    const row = this.database.connection.prepare('SELECT value_json FROM runtime_settings WHERE key=?').get(sessionKey(sessionId))
    return row ? terminalTargetSchema.parse(JSON.parse(String(row.value_json))) : null
  }

  async terminalInfo(sessionId?: string) {
    const host = hostCommandInfo()
    const deviceDefault = this.deviceDefault()
    const sessionOverride = this.sessionOverride(sessionId)
    return { platform: process.platform, hostShell: host.shell, hostAvailable: host.available,
      wslDistributions: await listWslDistributions(), deviceDefault, sessionOverride,
      effective: sessionOverride ?? deviceDefault }
  }

  async terminalSet(raw: unknown) {
    const input = terminalSetSchema.parse(raw)
    if (this.active) throw new Error('Wait for running commands before changing terminal environment')
    if (input.target?.kind === 'wsl' && !(await listWslDistributions()).includes(input.target.distribution))
      throw new Error(`WSL distribution is unavailable: ${input.target.distribution}`)
    if (input.target?.kind === 'host' && !hostCommandInfo().available) throw new Error('Host terminal is unavailable')
    if (input.scope === 'device') {
      const file = this.deviceSettingsPath()
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
      try { writeFileSync(temporary, JSON.stringify(input.target), { mode: 0o600, flag: 'wx' }); renameSync(temporary, file) }
      catch (error) { try { unlinkSync(temporary) } catch { /* no temporary file */ } throw error }
    } else {
      this.terminalOptions.assertSession?.(input.sessionId)
      this.database.transaction(() => {
        if (input.target) this.database.connection.prepare('INSERT OR REPLACE INTO runtime_settings VALUES (?, ?, ?)')
          .run(sessionKey(input.sessionId), JSON.stringify(input.target), Date.now())
        else this.database.connection.prepare('DELETE FROM runtime_settings WHERE key=?').run(sessionKey(input.sessionId))
      })
    }
    this.generation++
    return this.terminalInfo(input.scope === 'session' ? input.sessionId : undefined)
  }

  snapshot(sessionId?: string) {
    // Ignore saved sandbox settings while the developer-review suspension is in force.
    return { config: { mode: 'host' as const, networkAccess: true, writableRoots: [] as string[] },
      terminal: this.sessionOverride(sessionId) ?? this.deviceDefault(), sessionId, generation: this.generation }
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

  async execute(snapshot: ReturnType<CommandService['snapshot']>, root: string, command: string, signal: AbortSignal, timeoutMs = 30000) {
    signal.throwIfAborted()
    if (snapshot.generation !== this.generation || JSON.stringify(snapshot.terminal) !== JSON.stringify(this.snapshot(snapshot.sessionId).terminal))
      throw new Error('Terminal environment changed after approval; submit the command again')
    this.active++
    try {
      return snapshot.terminal.kind === 'wsl'
        ? await runWslCommand(root, command, snapshot.terminal.distribution, signal, timeoutMs)
        : await runHostCommand(root, command, signal, timeoutMs)
    } finally { this.active-- }
  }
}
