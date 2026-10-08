import { graphemes } from './screen-text.ts'

export interface KeyPress { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }
export type InputMode = 'normal' | 'username' | 'password'

export function isEnter(key: KeyPress): boolean { return key.name === 'return' || key.name === 'enter' }
export function isVertical(key: KeyPress): boolean { return key.name === 'up' || key.name === 'down' }
export function isPage(key: KeyPress): boolean { return key.name === 'pageup' || key.name === 'pagedown' }
export function isText(text: string | undefined, key: KeyPress): text is string {
  return !key.ctrl && !key.meta && Boolean(text && text >= ' ')
}

/** Authentication and question input may edit text but cannot navigate away by global shortcuts. */
export function restrictedKey(key: KeyPress, mode: InputMode, answering: boolean): boolean {
  if (mode !== 'normal' && (key.ctrl || key.meta) && !['a', 'e', 'u'].includes(key.name ?? '')) return true
  return answering && Boolean(key.ctrl) && ['p', 's', 'n', 'x', 'b', 't'].includes(key.name ?? '')
}

export function commandKey(text: string | undefined, key: KeyPress, answering: boolean): string | undefined {
  if (key.meta && text && /^[1-9]$/.test(text)) return `/use ${text}`
  if (key.ctrl) {
    const commands: Record<string, string> = { p: '/menu', s: '/sessions', n: '/new', x: '/stop' }
    const command = commands[key.name ?? '']
    if (command) return command
  }
  if (key.name === 'f1' && !answering) return '/help'
  return undefined
}

export type EditResult = { input: string; cursor: number; changed: boolean }

/** Grapheme-aware cursor movement and destructive edits; insertion/history stay with their owners. */
export function editInput(input: string, cursor: number, key: KeyPress): EditResult | undefined {
  const points = graphemes(input)
  const movement: Record<string, number> = { left: Math.max(0, cursor - 1), right: Math.min(points.length, cursor + 1), home: 0, end: points.length }
  const controlMovement: Record<string, number> = { a: 0, e: points.length }
  const destination = movement[key.name ?? ''] ?? (key.ctrl ? controlMovement[key.name ?? ''] : undefined)
  if (destination !== undefined) return { input, cursor: destination, changed: false }
  if (key.name === 'backspace' && cursor) { points.splice(--cursor, 1); return { input: points.join(''), cursor, changed: true } }
  if (key.name === 'delete' && cursor < points.length) { points.splice(cursor, 1); return { input: points.join(''), cursor, changed: true } }
  if (key.ctrl && key.name === 'u') return { input: '', cursor: 0, changed: true }
  return undefined
}
