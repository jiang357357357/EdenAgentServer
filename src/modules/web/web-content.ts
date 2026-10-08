export function extractHtml(html: string): { title: string; content: string } {
  const title = clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
  const safe = html.replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|section|article|header|footer|h[1-6]|li|tr|ul|ol)\s*>/gi, '\n')
  return { title, content: safe.replace(/<[^>]+>/g, ' ').split(/\r?\n/).map(clean).filter(Boolean).join('\n\n') }
}

export function substantiveHtml(title: string, content: string): boolean {
  const normalized = collapse(content)
  const withoutTitle = title ? normalized.replace(collapse(title), '').trim() : normalized
  return withoutTitle.length >= 160
}

export function decode(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|#39|nbsp);/gi, (_all, entity: string) => {
    if (entity[0] === '#') { const radix = entity[1]?.toLowerCase() === 'x' ? 16 : 10; return String.fromCodePoint(Number.parseInt(entity.slice(radix === 16 ? 2 : 1), radix)) }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[entity.toLowerCase()] ?? "'"
  })
}
export function clean(value: string) { return collapse(decode(value.replace(/<[^>]+>/g, ' '))) }
export function collapse(value: string) { return value.replace(/\s+/g, ' ').trim() }
export function truncate(value: string, length: number) { return value.length <= length ? value : `${value.slice(0, length)}…` }
