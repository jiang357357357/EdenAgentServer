import type { SchemaRpcMethodMap, SessionSummary } from '@eden/api'
import type { Terminal } from './terminal.ts'
import type { TuiRpcClient } from './rpc-client.ts'
import type { ModelFlow } from './model-flow.ts'

type Permission = SchemaRpcMethodMap['permission.list']['result'][number]
type Question = SchemaRpcMethodMap['question.list']['result'][number]

export interface SessionCommandHost {
  rpc: TuiRpcClient
  terminal: Terminal
  models: ModelFlow
  current: SessionSummary | undefined
  sessions: SessionSummary[]
  permissions: Permission[]
  questions: Question[]
  session(): SessionSummary
  listSessions(show?: boolean): Promise<void>
  showHome(): void
  createSession(title: string): Promise<void>
  selectSession(id: string): Promise<void>
  olderMessages(): Promise<void>
  refreshPending(): Promise<void>
  listPermissions(show?: boolean): Promise<void>
  showPermission(item: Permission): void
  resolvePermission(command: string, argument: string): Promise<void>
  listQuestions(show?: boolean): Promise<void>
  followInput(command: string, argument: string): Promise<void>
  beginAnswer(request: Question): void
}
