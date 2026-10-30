import { z } from 'zod'
import { expectationsSchema, locatorSchema } from './action-expectations.ts'

const windowRef = z.string().regex(/^window-[a-f0-9]{16}$/)
const element = z.string().regex(/^element-[a-f0-9]{16}$/).optional()
const coordinate = z.number().finite().min(0).max(32768)
const delivery = z.enum(['background', 'foreground']).default('background')
const locator = locatorSchema
const screenshotId = z.string().regex(/^screenshot-[a-f0-9]{16}$/).optional()
const target = { window: windowRef, element, x: coordinate.optional(), y: coordinate.optional(), screenshotId,
  expectedTitle: z.string().min(1).max(500).optional(), expect: expectationsSchema, delivery }
export const desktopSchemas = {
  desktop_list_windows: z.object({ query: z.string().max(200).default('') }).strict(),
  desktop_observe: z.object({ window: windowRef, include_screenshot: z.boolean().default(true), include_text: z.boolean().default(false),
    query: z.string().max(200).optional(), maxElements: z.number().int().min(1).max(400).optional() }).strict(),
  desktop_read_text: z.object({ window: windowRef, element, locator: locator.optional(), maxChars: z.number().int().min(1).max(16000).default(4000) })
    .strict().refine(v => Boolean(v.element) !== Boolean(v.locator), '指定 element 或 locator 中的一种'),
  desktop_click: z.object({ ...target, button: z.enum(['left', 'right', 'middle']).default('left'), count: z.number().int().min(1).max(3).default(1) }).strict(),
  desktop_type: z.object({ ...target, text: z.string().min(1).max(16000), mode: z.enum(['insert', 'replace']).default('insert') }).strict(),
  desktop_key: z.object({ ...target, keys: z.array(z.string().min(1).max(40)).min(1).max(6) }).strict(),
  desktop_scroll: z.object({ ...target, direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(30).default(3) }).strict(),
  desktop_drag: z.object({ window: windowRef, fromX: coordinate, fromY: coordinate, toX: coordinate, toY: coordinate,
    toWindow: windowRef.optional(), screenshotId, toScreenshotId: screenshotId, delivery, durationMs: z.number().int().min(100).max(3000).default(500) }).strict(),
  desktop_window: z.object({ window: windowRef, action: z.enum(['activate', 'minimize', 'maximize', 'restore', 'resize']),
    x: z.number().finite().min(-32768).max(32768).optional(), y: z.number().finite().min(-32768).max(32768).optional(),
    width: z.number().int().min(100).max(16384).optional(), height: z.number().int().min(100).max(16384).optional() }).strict(),
  desktop_launch: z.object({ application: z.string().min(1).max(4096), arguments: z.array(z.string().max(4096)).max(20).default([]) }).strict(),
} as const
export type DesktopToolName = keyof typeof desktopSchemas
export function desktopToolName(name: string): DesktopToolName {
  if (!Object.hasOwn(desktopSchemas, name)) throw new Error('未知桌面操作')
  return name as DesktopToolName
}
