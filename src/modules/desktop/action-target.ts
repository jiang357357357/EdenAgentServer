import { elementLocator, elementText, refreshWindowLocator, uniqueElement } from './element-text.ts'
import type { ElementLocator, NativeElement, NativeObservation } from './contracts.ts'
import type { Target } from './window-targets.ts'

export interface ActionTarget {
  locator: ElementLocator
  windowTitle: string
  text: ReturnType<typeof elementText>
}
export function captureActionTarget(target: Target, input: Record<string, unknown>): ActionTarget | undefined {
  const observation = target.observation
  if (!observation) return
  const element = typeof input.element === 'string' ? target.elements.get(input.element) : pixelTextTarget(observation, input)
  if (!element || element.labelTruncated) return
  return { locator: elementLocator(element, observation.elements), windowTitle: observation.window.title, text: elementText(element, observation, 16000) }
}
function pixelTextTarget(observation: NativeObservation, input: Record<string, unknown>): NativeElement | undefined {
  if (typeof input.x !== 'number' || typeof input.y !== 'number' || observation.elementCoordinateSpace === 'unknown') return
  if (!observation.width || !observation.height) return
  const bounds = observation.window.bounds
  const x = bounds.x + input.x * bounds.width / observation.width, y = bounds.y + input.y * bounds.height / observation.height
  const candidates = observation.elements.filter(element => {
    const frame = element.frame
    return frame && element.enabled && ['Edit', 'Group', 'Document', 'Pane'].includes(element.role)
      && (element.actions.includes('set_value') || element.actions.includes('text'))
      && x >= frame.x && x < frame.x + frame.width && y >= frame.y && y < frame.y + frame.height
  }).sort((a, b) => a.frame!.width * a.frame!.height - b.frame!.width * b.frame!.height)
  if (candidates.length > 1 && candidates[0]!.frame!.width * candidates[0]!.frame!.height === candidates[1]!.frame!.width * candidates[1]!.frame!.height) return
  return candidates[0]
}
export function matchActionTarget(before: ActionTarget, observation: NativeObservation) {
  const element = uniqueElement(refreshWindowLocator(before.locator, before.windowTitle, observation), observation)
  return { element, text: elementText(element, observation, 16000) }
}
