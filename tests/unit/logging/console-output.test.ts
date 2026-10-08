import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const loggerUrl = new URL('../../../src/modules/logging/logger.ts', import.meta.url).href
const message = '共享资料库 DLC 未安装或配置无效'
const bootstrap = `import { createDiagnosticLogger } from ${JSON.stringify(loggerUrl)};
const logger = createDiagnosticLogger({ origin: 'mon', env: {}, tty: false });`

function child(code: string) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `${bootstrap}\n${code}`],
    { encoding: 'utf8', timeout: 10000, windowsHide: true })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  return result
}

for (const [stream, reportStream, level] of [['stdout', 'stderr', 'info'], ['stderr', 'stdout', 'warn']] as const) {
  test(`${stream} TTY receives Chinese text through Node's Unicode terminal writer`, { skip: process.platform !== 'win32' }, () => {
    const result = child(`
      const lines = [];
      Object.defineProperty(process.${stream}, 'isTTY', { value: true });
      process.${stream}.write = text => { lines.push(text); return true; };
      logger.log({ event: 'shared_workspace.registry_restore_failed', error: ${JSON.stringify(message)} }, '${level}');
      process.${reportStream}.write(JSON.stringify(lines));
    `)
    const lines = JSON.parse(result[reportStream]) as string[]
    assert.equal(lines.length, 1, 'Raw fd writes bypass the Unicode terminal writer on Windows')
    assert.match(lines[0]!, /\[Agent\/伊甸园\]/)
    assert.ok(lines[0]!.endsWith(` | ${message}\n`))
    assert.equal(result[stream], '')
  })
}

test('redirected stdout and stderr retain UTF-8 text and level routing', () => {
  const result = child(`
    logger.log({ event: 'server.listening', message: '中文服务已就绪' });
    logger.log({ event: 'shared_workspace.registry_restore_failed', error: ${JSON.stringify(message)} }, 'warn');
  `)
  assert.match(result.stdout, /\[INFO\] \[Agent\/伊甸园\].*中文服务已就绪\n$/)
  assert.match(result.stderr, /\[WARN\] \[Agent\/伊甸园\].*共享资料库 DLC 未安装或配置无效\n$/)
  assert.doesNotMatch(result.stdout + result.stderr, /\ufffd|浼婄敻/)
})

test('a closed stderr pipe does not replace the business result with an output error', () => {
  const result = child(`
    const { closeSync } = await import('node:fs');
    closeSync(2);
    logger.log({ event: 'server.diagnostic', message: '管道已关闭' }, 'warn');
    process.stdout.write('business continued');
  `)
  assert.equal(result.stdout, 'business continued')
})
