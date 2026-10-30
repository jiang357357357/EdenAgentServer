import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { osConfig } from '../../../src/bootstrap/os-config.ts'

test('integrated source layout resolves persistent OS storage without a BaseOs checkout', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'eden-integrated-os-layout-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const configRoot = path.join(root, 'Config/Os')
  mkdirSync(configRoot, { recursive: true })
  writeFileSync(path.join(configRoot, '.monconfig'), [
    '[database]', 'NAME=../../Data/Os/DB/SQLite/monos_db.sqlite3', 'VECTOR_DIR=../../Data/Os/DB/Vector',
    '[model]', 'MODEL_PATH=../../Data/Os/Models/bge-small-zh-v1.5',
    '[self_awake]', 'DATA_DIR=../../Data/Os/SelfAwake', '[memo]', 'DATA_DIR=../../Data/Os/MemoScheduler',
  ].join('\n'))
  writeFileSync(path.join(root, '.monworkspace'), JSON.stringify({ modules: [{ id: 'agent', root: 'Agent' }] }))
  const config = osConfig(root, path.join(root, 'Agent/Data/realms/mon'), undefined, {})!
  assert.equal(config.root, configRoot)
  assert.equal(config.databasePath, path.join(root, 'Data/Os/DB/SQLite/monos_db.sqlite3'))
  assert.equal(config.modelPath, path.join(root, 'Data/Os/Models/bge-small-zh-v1.5'))
  assert.equal(config.vectorDir, path.join(root, 'Data/Os/DB/Vector'))
  assert.equal(config.wakeDir, path.join(root, 'Data/Os/SelfAwake'))
  assert.equal(config.memoDir, path.join(root, 'Data/Os/MemoScheduler'))
  assert.equal(config.port, 40072)
  assert.equal(existsSync(path.join(root, 'BaseOs')), false)
})
