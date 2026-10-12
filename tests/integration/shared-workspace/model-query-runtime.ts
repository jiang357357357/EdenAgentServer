import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRuntime } from '@eden/runtime-pi'
import { callbacks, recordedModel } from '@eden/runtime-pi/testing'
import type { createServices } from '../../../src/bootstrap/services.ts'
import { sharedWorkspaceTool, sharedLibraryFileTools } from '../../../src/modules/shared-workspace/index.ts'
import { builtinSkillSnapshots } from '../../../src/modules/skills/index.ts'

/** Actual model HTTP/tool execution against the paired LAN services; model replies alone are recorded. */
export async function exerciseSharedModelQueries(services: ReturnType<typeof createServices>, sessionId: string) {
  const name = 'query_shared_workspace'
  const retired = ['get_shared_workspace_status', 'list_shared_workspaces', 'list_shared_workspace_files']
  const catalog = services.sessions.toolCatalog()
  assert.equal(catalog.filter(tool => tool.name === name).length, 1)
  assert.ok(catalog.every(tool => !retired.includes(tool.name)))
  const model = await recordedModel([{ tool: name, input: { action: 'status' } }, { tool: name, input: { action: 'spaces' } },
    { tool: name, input: { action: 'files' } }, { tool: 'read_shared_file', input: { path: 'lan.txt' } },
    { tool: 'write_shared_file', input: { path: 'skill-written.txt', content: 'created by shared skill' } },
    { tool: 'edit_shared_file', input: { path: 'skill-written.txt', oldText: 'created', newText: 'edited' } },
    { tool: 'read_shared_file', input: { path: 'skill-written.txt' } }, { text: '已读取并编辑共享资料。' }])
  try {
    services.permissions.setMode('takeover')
    assert.ok(builtinSkillSnapshots().some(skill => skill.name === 'eden-shared-library'))
    const audit = callbacks(), operations: string[] = []
    const runtime = createRuntime({ sessionId, systemPrompt: '', model: model.config,
      tools: [sharedWorkspaceTool(services.sharedWorkspace, sessionId),
        ...sharedLibraryFileTools(services.sharedWorkspace, services.permissions, sessionId, randomUUID())],
      callbacks: { ...audit.handlers, async beforeTool(name) { operations.push(name) } } })
    await runtime.prompt('检查共享资料库的状态、可见资料库和文件，并读取同步的 lan.txt。')
    assert.deepEqual(operations, [name, name, name, 'read_shared_file', 'write_shared_file', 'edit_shared_file', 'read_shared_file'])
    const exposed = (model.requests[0]!.tools as { function: { name: string } }[]).map(tool => tool.function.name)
    assert.ok(exposed.includes(name)); assert.ok(exposed.includes('read_shared_file')); assert.ok(!exposed.includes('read_file'))
    assert.ok(exposed.every(tool => !retired.includes(tool)))
    assert.doesNotMatch(JSON.stringify(model.requests[0]!.messages), /共享资料库(?:\/共享库)?内置于伊甸园/)
    const replies = (model.requests.at(-1)!.messages as { role: string; content: string }[])
      .filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
    assert.equal(replies.length, 7)
    for (const result of replies.slice(0, 3)) assert.equal('guidance' in result, false)
    assert.equal(replies[0].shared.bound, true)
    assert.equal(replies[0].directory.path, services.sharedWorkspace.directory(sessionId).path)
    assert.notEqual(replies[0].directory.path, services.workspace.forSession(sessionId).root())
    assert.ok(replies[1].spaces.some((space: { name: string }) => space.name === 'LAN RPC资料'))
    assert.ok(replies[2].files.some((file: { path: string; deleted: boolean }) => file.path === 'lan.txt' && !file.deleted))
    assert.equal(replies[2].source, 'synchronized-file-index')
    assert.match(JSON.stringify(replies[3]), /peer edit/)
    assert.match(JSON.stringify(replies[6]), /edited by shared skill/)
    assert.ok(services.permissions.list(sessionId).filter(request => request.capability === 'shared_workspace.write').length >= 2)
  } finally { await model.close() }
}
