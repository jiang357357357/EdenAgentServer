export function activate(api) {
  const React = api.React
  function Todos({ host }) {
    const [title, setTitle] = React.useState('')
    const [data, setData] = React.useState({ todos: [] })
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState('')
    async function invoke(action, input = {}) {
      setBusy(true); setError('')
      try {
        const result = await host.callTool('call_mcp_tool', { runtimeId: 'fullstack-todos:backend', name: 'todos', arguments: { action, ...input } })
        if (result.isError) throw new Error(result.content.map(item => item.text ?? '').join('\n'))
        if (!host.signal.aborted) { setData(result.structuredContent); if (action === 'add') setTitle('') }
      } catch (reason) { if (!host.signal.aborted) setError(reason.message) }
      finally { if (!host.signal.aborted) setBusy(false) }
    }
    return React.createElement('div', { className: 'fullstack-todos', 'data-todos-version': '__TODO_VERSION__' },
      React.createElement('h3', null, '持久化待办 v__TODO_VERSION__'),
      React.createElement('input', { 'aria-label': '待办标题', value: title, onChange: event => setTitle(event.target.value), placeholder: '输入新的待办' }),
      React.createElement('button', { 'data-action': 'add', disabled: busy || !title.trim(), onClick: () => invoke('add', { title }) }, '添加'),
      React.createElement('button', { 'data-action': 'reload', disabled: busy, onClick: () => invoke('list') }, '刷新'),
      React.createElement('button', { 'data-action': 'fail', disabled: busy, onClick: () => invoke('fail') }, '测试失败反馈'),
      React.createElement('button', { 'data-action': 'slow', disabled: busy, onClick: () => invoke('slow') }, '延迟读取'),
      React.createElement('p', { 'data-backend-version': true }, data.version ? '后端版本 ' + data.version : '请刷新读取后端数据'),
      error && React.createElement('p', { role: 'alert', 'data-todos-error': true }, error),
      React.createElement('ul', null, data.todos.map(todo => React.createElement('li', { key: todo.id, 'data-todo-id': todo.id },
        React.createElement('span', null, todo.title + (todo.done ? '（已完成）' : '')),
        React.createElement('button', { 'data-action': 'toggle', disabled: busy, onClick: () => invoke('update', { id: todo.id, done: !todo.done }) }, '切换完成'),
        React.createElement('button', { 'data-action': 'delete', disabled: busy, onClick: () => invoke('delete', { id: todo.id }) }, '删除')))))
  }
  api.addStyle('.fullstack-todos { padding:20px; overflow-wrap:anywhere } .fullstack-todos input { border:1px solid currentColor; padding:8px; border-radius:6px } .fullstack-todos button { margin:6px; padding:6px 10px; border:1px solid currentColor; border-radius:6px } .fullstack-todos button:disabled { opacity:.5 } .fullstack-todos li { margin:12px 0 }')
  api.registerView('todos', Todos)
}
