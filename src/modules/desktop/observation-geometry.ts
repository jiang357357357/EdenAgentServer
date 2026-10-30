import { toJson } from '@eden/api'
import type { Bounds, DesktopIdentity, NativeElement, NativeObservation } from './contracts.ts'

export function intersection(a: Bounds, b: Bounds): Bounds | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
  const width = Math.min(a.x + a.width, b.x + b.width) - x
  const height = Math.min(a.y + a.height, b.y + b.height) - y
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

export function screenshotUsable(observation: NativeObservation): boolean {
  return observation.screenshotIncluded !== false && observation.frameValid !== false && observation.width > 0 && observation.height > 0
}

export function treeComplete(observation: NativeObservation): boolean {
  return observation.elementsComplete === true && !observation.truncated && observation.degraded !== true
}

export function elementGeometry(element: NativeElement, observation: NativeObservation) {
  if (!element.frame) return { frame: null, windowIntersection: null, intersectsWindow: null }
  if (observation.elementCoordinateSpace === 'unknown') return { frame: { ...element.frame }, windowIntersection: null, intersectsWindow: null }
  const overlap = intersection(element.frame, observation.elementCoordinateSpace === 'window_screenshot_pixels'
    ? { x: 0, y: 0, width: observation.width || observation.window.bounds.width * (observation.scale ?? 1),
      height: observation.height || observation.window.bounds.height * (observation.scale ?? 1) } : observation.window.bounds)
  return { frame: { ...element.frame }, windowIntersection: overlap ? { ...overlap } : null, intersectsWindow: overlap !== null }
}

export function observationGeometry(observation: NativeObservation, identity: DesktopIdentity) {
  return toJson({
    observerBounds: identity.bounds, driverBounds: observation.window.bounds,
    observerCoordinateSpace: identity.coordinateSpace ?? 'unknown', driverCoordinateSpace: observation.captureBackend === 'cua_driver_native' ? 'physical_screen_pixels' : 'driver_desktop',
    elementFrameCoordinateSpace: observation.elementCoordinateSpace ?? 'driver_desktop',
    inputCoordinateSpace: 'window_screenshot_pixels', resizeCoordinateSpace: 'physical_screen_pixels',
    screenshotPixelsPerDriverUnit: { x: ratio(observation.width, observation.window.bounds.width), y: ratio(observation.height, observation.window.bounds.height) },
    screenshotPixelsPerObserverUnit: { x: ratio(observation.width, identity.bounds.width), y: ratio(observation.height, identity.bounds.height) },
    primaryScreen: identity.screen ?? null, virtualScreen: identity.virtualScreen ?? null, workArea: identity.workArea ?? null,
    windowDpi: identity.dpi || null, dpiMeaning: 'reported_for_window_awareness',
  })
}

function ratio(numerator: number, denominator: number) { return numerator > 0 && denominator > 0 ? numerator / denominator : null }

export function observationQuality(observation: NativeObservation) {
  return {
    screenshot: { width: observation.width, height: observation.height, scale: observation.scale ?? null,
      frameValid: observation.frameValid ?? null, included: observation.screenshotIncluded !== false, usableForCoordinates: screenshotUsable(observation) },
    accessibility: { complete: observation.elementsComplete ?? null, degraded: observation.degraded ?? null,
      degradedReason: observation.degradedReason ?? null, truncationReason: observation.truncationReason ?? null },
    capabilities: { ...backendCapabilities(observation), textRead: 'accessibility', captureBackend: observation.captureBackend ?? null,
      textRequested: observation.textRequested ?? null,
      minWindowSize: null, maxWindowSize: null, elementFrameCoordinateSpace: observation.elementCoordinateSpace ?? 'driver_desktop', visibility: 'geometric_intersection_only' },
  }
}

function backendCapabilities(observation: NativeObservation) {
  if (observation.captureBackend === 'cua_driver_native')
    return { delivery: { background: 'default_per_action', foreground: 'explicit_only' }, backend: 'cua_driver' }
  return { delivery: { background: 'per_action', foreground: 'explicit_only' }, backend: 'legacy' }
}
