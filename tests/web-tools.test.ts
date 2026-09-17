import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { isPublicAddress, searchTextRelevant, webConfig, WebService } from '../src/modules/web/index.ts'

test('web configuration reads the search section while environment variables retain priority', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'eden-web-config-'))
  try {
    writeFileSync(path.join(root, '.monconfig'), '[search]\nPROVIDER=sogou,bing,duckduckgo\nTIMEOUT_MS=9000\nFETCH_MAX_BYTES=131072\n')
    const config = webConfig({ EDEN_AGENT_SEARCH_TIMEOUT_MS: '7000' }, path.join(root, 'nested'))
    assert.deepEqual(config.providers, ['sogou', 'bing', 'duckduckgo'])
    assert.equal(config.searchTimeoutMs, 7000)
    assert.equal(config.fetchMaxBytes, 131072)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('public web requests reject private, loopback and documentation networks', async () => {
  for (const address of ['127.0.0.1', '10.2.3.4', '169.254.10.2', '172.20.1.2', '192.168.1.2', '192.0.2.10', '198.51.100.10', '203.0.113.10', '::1', 'fc00::1', 'fe80::1', '2001:db8::1']) {
    assert.equal(isPublicAddress(address), false, address)
  }
  assert.equal(isPublicAddress('1.1.1.1'), true)
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true)

  const service = new WebService({ providers: ['bing'], searchTimeoutMs: 2_000, cacheTtlMs: 0, fetchTimeoutMs: 2_000, fetchMaxBytes: 64 * 1024 })
  await assert.rejects(service.fetch('private-test', { url: 'http://127.0.0.1/private', maxChars: 2_000 }, new AbortController().signal), /public|private|reserved/i)
})

test('web references cannot be read by another session', async () => {
  const service = new WebService({ providers: ['bing'], searchTimeoutMs: 2_000, cacheTtlMs: 0, fetchTimeoutMs: 2_000, fetchMaxBytes: 64 * 1024 })
  await assert.rejects(service.fetch('other-session', { refId: 'search_1', maxChars: 2_000 }, new AbortController().signal), /当前会话不存在网页引用/)
})

test('search relevance rejects generic pages that only share one snippet word', () => {
  const query = 'Phrenapates sensei alternate timeline identity revealed final chapter summary'
  assert.equal(searchTextRelevant(query, 'Lymphoid Cell Line - an overview', 'indicating the identity of several cell types'), false)
  assert.equal(searchTextRelevant(query, 'Phrenapates - Blue Archive Wiki', 'The alternate timeline Sensei appears in the final chapter.'), true)
  assert.equal(searchTextRelevant('普雷纳帕特斯 另一个世界的老师', '普雷纳帕特斯 - 萌娘百科', ''), true)
  assert.equal(searchTextRelevant('普雷纳帕特斯 另一个世界的老师', '漢字「普」の読み方', '普通選挙の意味を紹介'), false)
})

test('one turn rejects duplicate searches and enforces finite web research budgets', () => {
  const service = new WebService({ providers: ['bing'], searchTimeoutMs: 2_000, cacheTtlMs: 0, fetchTimeoutMs: 2_000, fetchMaxBytes: 64 * 1024 })
  const budget = service as unknown as {
    consumeSearch(sessionId: string, turnId: string, queries: string[]): unknown
    consumeFetch(sessionId: string, turnId: string): unknown
  }
  budget.consumeSearch('session', 'search-turn', ['alpha'])
  assert.throws(() => budget.consumeSearch('session', 'search-turn', ['alpha']), /相同查询/)
  budget.consumeSearch('session', 'search-turn', ['beta'])
  assert.throws(() => budget.consumeSearch('session', 'search-turn', ['gamma']), /两次上限/)
  for (let index = 0; index < 4; index += 1) budget.consumeFetch('session', 'fetch-turn')
  assert.throws(() => budget.consumeFetch('session', 'fetch-turn'), /四次上限/)
})
