import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const fixture = fileURLToPath(new URL('./event-backlog-load-fixture.mjs', import.meta.url))

test('real account refresh preserves multi-session durable backlogs beyond former memory limits', { concurrency: 2, timeout: 90_000 }, async t => {
  await Promise.all(['count', 'bytes'].map(scenario => t.test(scenario, async t => {
    const child = spawn(process.execPath, ['--import', 'tsx', fixture, scenario], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
      if (String(chunk).includes('BACKLOG_READY ')) process.stdout.write(String(chunk))
    })
    child.stderr.on('data', chunk => { stderr += chunk })
    t.after(() => { if (child.exitCode === null) child.kill() })
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    for (const line of stdout.split('\n')) if (line.startsWith('BACKLOG_RESULT ')) t.diagnostic(line)
    assert.equal(signal, null, stderr)
    assert.equal(code, 0, `${scenario} pressure regression failed\n${stdout}\n${stderr}`)
  })))
})
