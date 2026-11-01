import { withAccount } from '../modules/accounts/index.ts'
import type { OsTarget, State } from '../modules/os/index.ts'
import { memoCreateSchema } from '@eden/api'
import type { AccountRuntimes } from './account-runtimes.ts'

export function osWakeTarget(runtimes: AccountRuntimes): OsTarget {
  const bridge = async () => {
    const account = runtimes.serviceAccount()
    if (!account) throw new Error('后台服务账号未绑定')
    const runtime = await runtimes.get(account)
    if (!runtime.services.selfAwakeBridge) throw new Error('自醒服务不可用')
    return { account, service: runtime.services.selfAwakeBridge, control: runtime.services.selfAwake.repository.control }
  }
  return {
    ready: () => { const account = runtimes.serviceAccount(); return Boolean(account && runtimes.ready(account)) },
    async control() { const { account, control } = await bridge(); return withAccount(account, () => control.read()) },
    async run(input) { const { account, service } = await bridge(); return withAccount(account, () => service.submit(input)) as Promise<State> },
    async status(jobId, userId) { const { account, service } = await bridge(); return withAccount(account, () => service.readStatus({ job_id: jobId, user_id: userId })) as State },
    async admitReminder(input) {
      const account = runtimes.serviceAccount()
      if (!account) throw new Error('后台服务账号未绑定')
      const runtime = await runtimes.get(account)
      const memo = withAccount(account, () => runtime.services.memos.create(memoCreateSchema.parse({ title: input.title, content: input.content,
        kind: 'reminder', remindAt: input.at, priority: input.priority, metadata: { source: 'core', coreMemoId: input.sourceId } }), input.key))
      return { memoId: memo.id }
    },
    async reminderDelivery(memoId) {
      const account = runtimes.serviceAccount()
      if (!account) throw new Error('后台服务账号未绑定')
      const runtime = await runtimes.get(account)
      return withAccount(account, () => runtime.services.memos.read(memoId).lastTriggeredAt)
    },
  }
}
