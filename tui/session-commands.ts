import type { SessionCommandHost } from './session-command-host.ts'
import { reference } from './session-reference.ts'
import { showCommandHelp, showCommandMenu } from './command-menu.ts'

export function sessionCommands(host: SessionCommandHost): Record<string, (argument: string) => void | Promise<unknown>> {
  return {
    '/help': (argument: string) => { showCommandHelp(host.terminal) },
    '/menu': (argument: string) => { showCommandMenu(host.terminal) },
    '/sessions': async (argument: string) => { await host.listSessions() },
    '/models': async (argument: string) => { await host.models.showMenu(host.current?.id, true) },
    '/model-preview': (argument: string) => { host.models.preview(argument) },
    '/model-confirm': async (argument: string) => { await host.models.select(argument) },
    '/home': (argument: string) => { host.showHome() },
    '/timeline': (argument: string) => { host.terminal.showTimeline() },
    '/jump': (argument: string) => { host.terminal.jumpTo(argument) },
    '/sidebar': (argument: string) => { host.terminal.toggleSidebar() },
    '/details': (argument: string) => { host.terminal.toggleDetails() },
    '/timestamps': (argument: string) => { host.terminal.toggleTimestamps() },
    '/status': async (argument: string) => { const current = await host.rpc.request('session.read', { sessionId: host.session().id })
        await host.refreshPending()
        host.current = current
        host.terminal.setSession(current.id, current.title, current.executionStatus === 'busy', current.contextTokens)
        host.terminal.showPanel('会话状态', [
          `标题：${current.title}`, `ID：${current.id}`, `世界：${current.runtimeOrigin}`,
          `执行：${current.executionStatus}`, `上下文：${current.contextTokens?.toLocaleString() ?? '未知'} tokens`,
          `待审批：${host.permissions.length} · 待回答：${host.questions.length}`,
        ]) },
    '/rename': async (argument: string) => { if (!argument) throw new Error('用法：/rename 新标题')
        const updated = await host.rpc.request('session.rename', { sessionId: host.session().id, title: argument })
        host.current = updated
        host.terminal.setSession(updated.id, updated.title, updated.executionStatus === 'busy', updated.contextTokens)
        await host.listSessions(false) },
    '/refresh': async () => {
      await host.listSessions(false); await host.refreshPending()
      if (host.current) host.terminal.setWorkspace(await host.rpc.request('workspace.info', { sessionId: host.current.id }))
      host.terminal.print('系统', '已刷新')
    },
    '/older': async (argument: string) => { await host.olderMessages() },
    '/use': async (argument: string) => { if (!argument) throw new Error('用法：/use 编号或 UUID')
        const id = /^\d+$/.test(argument) ? host.sessions[Number(argument) - 1]?.id : argument
        if (!id) throw new Error('会话编号无效；先输入 /sessions')
        await host.selectSession(id) },
    '/new': async (argument: string) => { if (argument) await host.createSession(argument); else host.showHome() },
    '/stop': async (argument: string) => { const result = await host.rpc.request('turn.cancel', { sessionId: host.session().id })
        host.terminal.print('系统', result.cancellationRequested ? '已请求停止' : '当前没有运行中的回合') },
    '/steer': async (argument: string) => { await host.followInput('/steer', argument) },
    '/followup': async (argument: string) => { await host.followInput('/followup', argument) },
    ...interactionCommands(host),
  }
}

function interactionCommands(host: SessionCommandHost): Record<string, (argument: string) => void | Promise<unknown>> {
  return {
    '/permissions': async (argument: string) => { await host.listPermissions() },
    '/permission-detail': async (argument: string) => { await host.listPermissions(false)
        const item = reference(host.permissions, argument)
        host.terminal.showPanel(`审批详情 · ${item.capability}`, [
          `资源：${item.resource}`, `详情：${JSON.stringify(item.details)}`, `请求：${JSON.stringify(item.request)}`,
          'Esc 关闭；输入 /permissions 返回审批选项',
        ]) },
    '/confirm-always': async (argument: string) => { await host.listPermissions(false)
        const item = reference(host.permissions, argument)
        host.terminal.showMenu('确认总是允许', [
          { label: '取消', command: `/permission ${item.id}` },
          { label: '确认总是允许', command: `/always ${item.id}` },
        ], [`能力：${item.capability}`, `资源：${item.resource}`]) },
    '/permission': async (argument: string) => { if (!argument) throw new Error('用法：/permission 编号或 ID')
        await host.listPermissions(false)
        host.showPermission(reference(host.permissions, argument)) },
    '/allow': async (argument: string) => { await host.resolvePermission('/allow', argument) },
    '/always': async (argument: string) => { await host.resolvePermission('/always', argument) },
    '/deny': async (argument: string) => { await host.resolvePermission('/deny', argument) },
    '/questions': async (argument: string) => { await host.listQuestions() },
    '/answer': async (argument: string) => { if (!argument) throw new Error('用法：/answer 编号或 ID')
        await host.listQuestions(false)
        host.beginAnswer(reference(host.questions, argument)) },
  }

}
