import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { officialConnectorFixture } from './official-connector-fixture.ts'
import { observation as hoi4 } from '../connectors/official/hoi4/src/connector.ts'
import { observation as victoria } from '../connectors/official/victoria3/src/connector.ts'

test('HOI4 snapshot preserves typed country metrics and raw fields; Victoria ACK preserves correlation', () => {
  const snapshot = hoi4({ kind: 'SNAPSHOT', fields: { country_tag: 'GER', stability: '72%', manpower_k: '1,250', at_war: 'yes' } }, 1)!
  assert.deepEqual((snapshot.payload as { country: { stability: number; manpowerThousands: number; atWar: boolean } }).country.stability, 0.72)
  assert.equal((snapshot.payload as { country: { manpowerThousands: number } }).country.manpowerThousands, 1250)
  assert.equal((snapshot.payload as { country: { atWar: boolean } }).country.atWar, true)
  assert.deepEqual(victoria({ kind: 'ACK', fields: { command_id: 'probe-1', status: 'success' } }, 2)?.payload,
    { observedAt: 2, commandId: 'probe-1', status: 'success', action: null, fields: { command_id: 'probe-1', status: 'success' } })
})

test('real isolated HOI4 worker follows partial lines and same-size log rewrite', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-observer-log-')), file = path.join(root, 'game.log')
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(file, 'startup\n')
  const f = await officialConnectorFixture(t, 'hoi4', { logPath: file })
  const snapshot = 'EDENAGENT_HOI4|1|SNAPSHOT|date=1936.1.1|country_tag=ENG\n'
  await writeFile(file, snapshot.slice(0, -1))
  await delay(600)
  let state = await f.launched.runtime.invoke('query', 'get_state', {}, 'partial', f.signal) as { latestSnapshot: unknown }
  assert.equal(state.latestSnapshot, null)
  await writeFile(file, snapshot)
  for (let attempt = 0; attempt < 30; attempt++) {
    state = await f.launched.runtime.invoke('query', 'get_state', {}, `read-${attempt}`, f.signal) as typeof state
    if (state.latestSnapshot) break
    await delay(100)
  }
  assert.equal((state.latestSnapshot as { country: { countryTag: string } }).country.countryTag, 'ENG')
  await writeFile(file, snapshot.replace('ENG', 'FRA'))
  for (let attempt = 0; attempt < 30; attempt++) {
    state = await f.launched.runtime.invoke('query', 'get_state', {}, `rotate-${attempt}`, f.signal) as typeof state
    if ((state.latestSnapshot as { country: { countryTag: string } }).country.countryTag === 'FRA') break
    await delay(100)
  }
  assert.equal((state.latestSnapshot as { country: { countryTag: string } }).country.countryTag, 'FRA')
})
