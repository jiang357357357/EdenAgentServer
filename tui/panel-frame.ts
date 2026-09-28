import { clip, wrap } from './screen-text.ts'
import type { ColoredLine, ScreenPanel } from './terminal-frame.ts'

/** Shared menu/panel projection for the home page and conversation page. */
export function panelLines(panel: ScreenPanel, width: number, height: number): ColoredLine[] {
  const output: ColoredLine[] = [{ text: ` ${panel.title}`, kind: 'accent' }]
  if (panel.items) {
    if (panel.searchable) output.push({ text: ` / ${panel.query || '输入以搜索'}`, kind: panel.query ? 'accent' : 'muted' })
    const detailCount = Math.min(2, Math.max(0, height - panel.items.length - 2 - (panel.searchable ? 1 : 0)))
    for (const line of panel.lines.slice(0, detailCount)) output.push({ text: ` ${clip(line, width - 2)}`, kind: 'muted' })
    const capacity = Math.max(1, height - output.length - (height >= 3 ? 1 : 0))
    const first = Math.min(Math.max(0, panel.selected - capacity + 1), Math.max(0, panel.items.length - capacity))
    if (!panel.items.length) output.push({ text: ' 没有匹配的项目', kind: 'muted' })
    for (let index = first; index < Math.min(panel.items.length, first + capacity); index++) {
      const item = panel.items[index]!
      output.push({ text: `${index === panel.selected ? ' › ' : '   '}${item.label}${item.detail ? `  ${item.detail}` : ''}`,
        kind: index === panel.selected ? 'accent' : 'normal' })
    }
    if (height >= 3) output.push({ text: panel.searchable ? ' 输入筛选 · ↑↓ 选择 · Enter 确认 · Esc 关闭' : ' ↑↓ 选择 · Enter 确认 · Esc 关闭', kind: 'muted' })
  } else {
    const detail = panel.lines.flatMap(line => wrap(line, width - 3))
    const first = Math.min(panel.selected, Math.max(0, detail.length - Math.max(1, height - 2)))
    for (const line of detail.slice(first, first + Math.max(1, height - 2))) output.push({ text: ` ${line}`, kind: 'normal' })
    if (height >= 3 && detail.length > height - 1) output.push({ text: ` PgUp/PgDn 查看详情 · ${first + 1}-${Math.min(detail.length, first + height - 2)}/${detail.length}`, kind: 'muted' })
  }
  return output.slice(0, height)
}
