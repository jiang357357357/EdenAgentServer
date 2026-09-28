const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' })

/** Keep server and model text from writing terminal controls or changing text direction. */
export function displayText(value: unknown): string {
  const plain = String(value ?? '').replace(/\t/g, '  ').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
  return plain.length > 20_000 ? `${plain.slice(0, 20_000)}\n[显示已截断，完整内容保存在 Server]` : plain
}

export function graphemes(value: string): string[] {
  return Array.from(segmenter.segment(value), item => item.segment)
}

function cellWidth(cluster: string): number {
  if (!cluster) return 0
  const point = cluster.codePointAt(0) ?? 0
  if (/^\p{Mark}/u.test(cluster)) return 0
  if (/\p{Extended_Pictographic}/u.test(cluster) || /\p{Regional_Indicator}/u.test(cluster)) return 2
  if (point >= 0x1100 && (point <= 0x115f || point >= 0x2329 && point <= 0x232a ||
    point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xd7a3 ||
    point >= 0xf900 && point <= 0xfaff || point >= 0xfe10 && point <= 0xfe6f ||
    point >= 0xff00 && point <= 0xff60 || point >= 0xffe0 && point <= 0xffe6)) return 2
  return 1
}

export function cells(value: string): number {
  return graphemes(value).reduce((total, cluster) => total + cellWidth(cluster), 0)
}

export function clip(value: string, width: number): string {
  if (width <= 0) return ''
  let result = '', used = 0
  for (const cluster of graphemes(value)) {
    const size = cellWidth(cluster)
    if (used + size > width) break
    result += cluster
    used += size
  }
  return result
}

export function fit(value: string, width: number): string {
  const result = clip(value, width)
  return result + ' '.repeat(Math.max(0, width - cells(result)))
}

export function wrap(value: string, width: number): string[] {
  const limit = Math.max(1, width)
  const lines: string[] = []
  for (const source of value.split('\n')) {
    let line = '', used = 0
    for (const cluster of graphemes(source)) {
      const size = cellWidth(cluster)
      if (used + size > limit && line) { lines.push(line); line = ''; used = 0 }
      if (size > limit) continue
      line += cluster
      used += size
    }
    lines.push(line)
  }
  return lines
}
