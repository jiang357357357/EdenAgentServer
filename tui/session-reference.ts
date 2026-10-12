export function reference<T extends { id: string }>(items: T[], value: string): T {
  const index = Number(value)
  const matches = /^\d+$/.test(value) ? [items[index - 1]].filter((item): item is T => Boolean(item))
    : items.filter(item => item.id === value || item.id.startsWith(value))
  if (matches.length !== 1) throw new Error('编号或 ID 不唯一；先查看列表')
  return matches[0]!
}
