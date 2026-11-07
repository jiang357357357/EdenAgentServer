import type { RuntimeProcessDiagnostic } from '@eden/runtime-pi'
import { logDiagnostic } from './logger.ts'

export function runtimeDiagnosticLogger(scope: Record<string, unknown> = {}) {
  return (record: RuntimeProcessDiagnostic) => logDiagnostic({ ...record, ...scope },
    record.event === 'runtime.process.failed' ? 'error'
      : record.event === 'runtime.process.started' || record.event === 'runtime.process.disposed' ? 'debug' : 'info')
}
