import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeResults, normalizeResults } from '../../../src/modules/web/search-results.ts'
import { extractHtml, substantiveHtml } from '../../../src/modules/web/web-content.ts'

test('search results retain relevance, provider fields and URL filtering', () => {
  const results = normalizeResults('bing', 'alpha beta', [
    { title: '<b>Alpha &amp; beta</b>', url: 'https://example.com/article#part', description: '<p>Details&nbsp;here</p>', published_at: '2026-01-01' },
    { name: 'Scored result', link: 'https://other.example/a', content: 'Unrelated but provider-ranked', score: '0.5', provider: 'custom', date: '2026-02-01' },
    { title: 'Unrelated', url: 'https://unused.example/', snippet: 'No relevant text' },
    ...['http://localhost/a', 'https://x.local/', 'https://user:secret@example.com/', 'file:///tmp/a', 'invalid'].map(url => ({ title: 'Alpha', url })),
  ], 10)
  assert.deepEqual(results, [
    { title: 'Alpha & beta', url: 'https://example.com/article', snippet: 'Details here', hostname: 'example.com', provider: 'bing', publishedAt: '2026-01-01', score: null },
    { title: 'Scored result', url: 'https://other.example/a', snippet: 'Unrelated but provider-ranked', hostname: 'other.example', provider: 'custom', publishedAt: '2026-02-01', score: 0.5 },
  ])
})

test('search selection preserves duplicate and per-host limits across providers', () => {
  const group = normalizeResults('bing', 'alpha', [
    { title: 'Alpha one', url: 'https://a.example/one' },
    { title: 'Alpha one copy', url: 'https://a.example/one/' },
    { title: 'Alpha two', url: 'https://a.example/two' },
    { title: 'Alpha three', url: 'https://a.example/three' },
    { title: 'Alpha ONE', url: 'https://b.example/duplicate-title' },
    { title: 'Alpha other', url: 'https://b.example/other' },
  ], 10)
  assert.deepEqual(group.map(item => item.url), ['https://a.example/one', 'https://a.example/two', 'https://b.example/other'])
  const other = normalizeResults('brave', 'alpha', [
    { title: 'Alpha other', url: 'https://b.example/other' },
    { title: 'Alpha last', url: 'https://c.example/last' },
  ], 10)
  assert.deepEqual(mergeResults([group, other], 3).map(item => item.url), [
    'https://a.example/one', 'https://b.example/other', 'https://a.example/two',
  ])
})

test('web content extraction still removes active markup and rejects title-only evidence', () => {
  const page = extractHtml('<title>Alpha &amp; beta</title><script>secret()</script><style>hidden</style><p>Hello&nbsp;world</p><p>Next</p>')
  assert.deepEqual(page, { title: 'Alpha & beta', content: 'Alpha & beta Hello world\n\nNext' })
  assert.equal(substantiveHtml('Alpha', 'Alpha'), false)
  assert.equal(substantiveHtml('Alpha', `Alpha ${'Useful body. '.repeat(20)}`), true)
})
