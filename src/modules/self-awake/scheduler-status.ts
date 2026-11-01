import { readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { SelfAwakeSchedulerStatus } from '@eden/api'

const leaseSchema = z.object({ protocolVersion: z.literal(2), sessionScopes: z.literal(true), roleScopes: z.boolean().optional(),
  expiresAt: z.number().int().nonnegative(), accountKey: z.string().optional(),
  state: z.enum(['starting', 'ready', 'paused', 'failed']).optional(), enabled: z.boolean().nullable().optional(),
  controlUpdatedAt: z.number().int().nonnegative().nullable().optional(), error: z.string().max(4000).nullable().optional() })

export function schedulerStatus(stateFile: string | undefined, external: boolean, role = true, expectedAccount?: string): SelfAwakeSchedulerStatus {
  const base = { checkedAt: Date.now(), expiresAt: null, enabled: null, controlUpdatedAt: null }
  const result = (status: SelfAwakeSchedulerStatus['status'], message: string): SelfAwakeSchedulerStatus => ({ ...base, status, message })
  if (!external) return result('internal', '当前账号使用 Agent 内部作业调度')
  if (!stateFile) return result('unconfigured', '自醒调度未配置：请检查当前账号的 Agent 调度绑定')
  let value: unknown
  try { value = JSON.parse(readFileSync(path.join(path.dirname(stateFile), 'session-protocol.json'), 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result('unavailable', '当前账号的调度尚未启动：未发现有效心跳，请检查 Agent 本地调度状态')
    return error instanceof SyntaxError ? result('incompatible', '调度心跳格式无效，请更新匹配的 Agent 程序')
      : result('failed', '无法读取当前账号的调度心跳，请检查状态目录的访问权限')
  }
  const parsed = leaseSchema.safeParse(value)
  if (!parsed.success) return result('incompatible', '调度协议不兼容：需要支持会话调度的 Agent 程序')
  return leaseStatus(parsed.data, base.checkedAt, role, expectedAccount)
}

function leaseStatus(lease: z.infer<typeof leaseSchema>, checkedAt: number, role: boolean, expectedAccount?: string): SelfAwakeSchedulerStatus {
  const base = { checkedAt, expiresAt: null, enabled: null, controlUpdatedAt: null }
  const info = { ...base, expiresAt: lease.expiresAt, enabled: lease.enabled ?? null, controlUpdatedAt: lease.controlUpdatedAt ?? null }
  const current = (status: SelfAwakeSchedulerStatus['status'], message: string): SelfAwakeSchedulerStatus => ({ ...info, status, message })
  if (expectedAccount && lease.accountKey !== undefined && lease.accountKey !== expectedAccount)
    return current('wrong_account', '调度心跳属于其他账号，请核对 Agent 的账号绑定和调度目录')
  if (lease.expiresAt <= base.checkedAt) return current('expired', '当前账号的调度心跳已过期，请检查 Agent 调度是否仍在运行')
  if (role && lease.roleScopes !== true) return current('incompatible', '当前调度器不支持角色调度，请更新匹配的 Agent 程序')
  if (lease.state === 'failed') return current('failed', lease.error || '自醒调度发生异常，请查看 Agent 运行诊断')
  if (lease.state === 'starting') return current('starting', 'Agent 调度已启动，正在等待当前账号就绪')
  if (lease.state === 'paused' || lease.enabled === false) return current('paused', '当前账号的自醒已暂停，调度器仍在运行')
  return current('ready', '当前账号的自醒调度已就绪')
}
