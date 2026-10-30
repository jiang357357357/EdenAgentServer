import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { LocalEmbedding } from '../../../src/modules/os/embedding.ts'

test('real local BGE safetensors run in the TypeScript host with normalized semantic vectors', {
  skip: !process.env.EDEN_TEST_BGE_MODEL, timeout: 120000,
}, async () => {
  const embedding = new LocalEmbedding(path.resolve(process.env.EDEN_TEST_BGE_MODEL!))
  try {
    const apple = await embedding.embed('苹果是一种常见的水果。')
    const fruit = await embedding.embed('我喜欢吃新鲜的苹果和水果。')
    const code = await embedding.embed('编译器将源代码转换为机器指令。')
    assert.equal(apple.length, 512)
    assert.ok(Math.abs(apple.reduce((n, v) => n + v * v, 0) - 1) < 0.0001)
    const similarity = (a: number[], b: number[]) => a.reduce((n, v, i) => n + v * b[i]!, 0)
    assert.ok(similarity(apple, fruit) > similarity(apple, code))
    assert.deepEqual(await embedding.embed('苹果是一种常见的水果。'), apple)
    assert.match(embedding.fingerprint, /^sha256:[0-9a-f]{64}$/)
  } finally { await embedding.close() }
})
