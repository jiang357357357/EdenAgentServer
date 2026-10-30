import path from 'node:path'
import type { OsConfig } from '../../src/modules/os/index.ts'

export function osFixture(root: string): OsConfig {
  return { root, databasePath: path.join(root, 'memos.db'), vectorDir: path.join(root, 'vectors'), legacyVectorDir: path.join(root, 'legacy'),
    modelPath: path.join(root, 'models'), wakeDir: path.join(root, 'wakes'), memoDir: path.join(root, 'memo-scheduler'), port: 0, mcpPath: '/mcp',
    componentVersion: '1.11.7', identity: undefined, controlSeconds: 1, pollSeconds: 1, retryMinutes: 1, retryMaxMinutes: 10, memoReconcileSeconds: 30, memoBatchSize: 100,
    memoRetryMinutes: 5, selfAwakeEnabled: true, startupWakeEnabled: true, startupDelaySeconds: 1 }
}
