import { writeSync } from 'node:fs'
import path from 'node:path'
import { redactRecord } from './redaction.ts'
import { formatDiagnostic, logUsesColor, type DiagnosticRecord, type LogLevel, type LogOrigin } from './format-record.ts'
import { createJsonlSink } from './jsonl-sink.ts'

export interface LoggingOptions { origin: LogOrigin; dataRoot: string; env?: NodeJS.ProcessEnv }
export interface LoggerOptions {
  origin?: LogOrigin
  env?: NodeJS.ProcessEnv
  filename?: string
  tty?: boolean
  writeConsole?(line: string, stream: 'stdout' | 'stderr'): void
  now?(): Date
  maxBytes?: number
  backups?: number
}

export function loggingFile(options: LoggingOptions): string {
  const env = options.env ?? process.env
  const directory = env.EDEN_AGENT_LOG_DIR || (env.MON_LOG_START_DIR ? path.join(env.MON_LOG_START_DIR, 'Text', 'MonAgent') : path.join(options.dataRoot, 'logs'))
  return path.join(directory, `agent-${options.origin}-${process.pid}.jsonl`)
}

function levelOf(value: unknown): LogLevel {
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info'
}

function writeConsole(line: string, stream: 'stdout' | 'stderr'): void {
  try {
    const output = stream === 'stdout' ? process.stdout : process.stderr
    // Windows TTY streams use Unicode console writes; raw UTF-8 fd writes use the console code page.
    if (process.platform === 'win32' && output.isTTY) {
      output.write(line)
      return
    }
    const buffer = Buffer.from(line, 'utf8')
    let offset = 0
    while (offset < buffer.length) {
      const written = writeSync(stream === 'stdout' ? 1 : 2, buffer, offset, buffer.length - offset)
      if (!written) return
      offset += written
    }
  } catch { /* Closed console pipes cannot be recovered by the diagnostic logger. */ }
}

export function createDiagnosticLogger(options: LoggerOptions = {}) {
  const env = options.env ?? process.env
  const consoleWriter = options.writeConsole ?? writeConsole
  const color = logUsesColor(env, options.tty ?? Boolean(process.stdout.isTTY))
  let closed = false
  const normalize = (input: Record<string, unknown>, level?: LogLevel): DiagnosticRecord => {
    const record = redactRecord(input)
    const origin = record.origin === 'mon' || record.origin === 'local' ? record.origin : options.origin
    return { ...record, event: typeof record.event === 'string' ? record.event : 'server.diagnostic',
      level: level ?? levelOf(record.level), pid: process.pid, time: (options.now?.() ?? new Date()).toISOString(), ...(origin ? { origin } : {}) }
  }
  const consoleRecord = (record: DiagnosticRecord) => {
    try {
      const json = env.EDEN_AGENT_LOG_FORMAT === 'json'
      consoleWriter(json ? `${JSON.stringify(record)}\n` : formatDiagnostic(record, color),
        !['warn', 'error'].includes(record.level) ? 'stdout' : 'stderr')
    } catch { /* Formatting and output failures must not replace a business error. */ }
  }
  const sink = options.filename ? createJsonlSink({ filename: options.filename,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.backups === undefined ? {} : { backups: options.backups }),
    onFailure: error => consoleRecord(normalize({ event: 'logging.file_failed', path: options.filename, error }, 'warn')) }) : undefined
  return {
    log(record: Record<string, unknown>, level?: LogLevel) {
      if (closed) return
      try {
        const normalized = normalize(record, level)
        consoleRecord(normalized)
        sink?.write(`${JSON.stringify(normalized)}\n`)
      } catch {
        consoleRecord(normalize({ event: 'server.diagnostic', message: '诊断记录无法序列化，已省略内容' }, 'warn'))
      }
    },
    close() { closed = true; sink?.close() },
  }
}

function unconfiguredLogger() {
  return createDiagnosticLogger({ env: { ...process.env, EDEN_AGENT_LOG_FORMAT: 'text' } })
}

let current = unconfiguredLogger()

export function logDiagnostic(record: Record<string, unknown>, level?: LogLevel): void { current.log(record, level) }

export function configureLogging(options: LoggingOptions): { close(): void } {
  const logger = createDiagnosticLogger({ origin: options.origin, env: options.env ?? process.env, filename: loggingFile(options) })
  current.close()
  current = logger
  return { close() { logger.close(); if (current === logger) current = unconfiguredLogger() } }
}
