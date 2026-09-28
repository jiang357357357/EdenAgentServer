import type { ScreenMenuItem } from './terminal-frame.ts'

function score(value: string, query: string): number {
  const haystack = value.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase().trim()
  if (!needle) return 0
  const exact = haystack.indexOf(needle)
  if (exact >= 0) return 1000 - exact * 2 - haystack.length / 10
  let cursor = -1, gaps = 0
  for (const letter of needle) {
    const next = haystack.indexOf(letter, cursor + 1)
    if (next < 0) return -Infinity
    gaps += next - cursor - 1
    cursor = next
  }
  return 500 - gaps * 3 - haystack.length / 10
}

export function searchMenu<T extends ScreenMenuItem>(items: T[], query: string): T[] {
  if (!query.trim()) return items
  return items.map((item, index) => ({ item, index,
    score: Math.max(score(item.label, query), score(item.detail ?? '', query) - 30, score(item.command, query) - 60),
  })).filter(result => Number.isFinite(result.score))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(result => result.item)
}
