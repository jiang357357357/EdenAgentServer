import type { JsonValue } from '@eden/api'
import type { DesktopControlEvent } from '@eden/api'

export interface Bounds { x: number; y: number; width: number; height: number }
export interface NativeWindow { pid: number; windowId: string; app: string; title: string; bounds: Bounds; minimized: boolean }
export interface ElementLocator { role: string; label: string; ancestors?: { role: string; label: string }[] }
export interface NativeElement {
  token: string; role: string; label: string; value: string; enabled: boolean; actions: string[];
  index?: string; parent?: string; frame?: Bounds; valueAvailable?: boolean; valueTruncated?: boolean; labelTruncated?: boolean
  focused?: boolean
}
export interface NativeObservation {
  window: NativeWindow; elements: NativeElement[]; images: { mime: string; data: string }[];
  width: number; height: number; truncated: boolean;
  scale?: number; frameValid?: boolean; degraded?: boolean; degradedReason?: string;
  elementsComplete?: boolean; truncationReason?: string; screenshotIncluded?: boolean
  snapshot?: string
  elementCoordinateSpace?: 'window_screenshot_pixels' | 'physical_screen_pixels' | 'unknown'
  focusedElement?: NativeElement | null
  captureBackend?: string
  textRequested?: boolean
}
export interface DriverAction {
  status: 'delivered' | 'verified' | 'refused' | 'unknown'; message: string; code?: string;
  driverMessage?: string;
  effect?: 'confirmed' | 'partial' | 'unverifiable' | 'suspected_noop' | 'refused';
  route?: 'accessibility' | 'synthetic_events' | 'global_input' | 'system_api' | 'dom' | 'trusted_input';
  evidence?: ('value_readback' | 'window_change')[];
  diagnostics?: Record<string, JsonValue>;
}
export interface DesktopDriver {
  scoped?(scope: string): DesktopDriver
  native?(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CuaNativeResult>
  release?(): Promise<void>
  terminate?(): void
  /** Ensure an active native session; a changed generation invalidates every caller's snapshots. */
  prepare?(signal: AbortSignal): Promise<number>
  screenSize?(signal: AbortSignal): Promise<{ width: number; height: number }>
  windows(signal: AbortSignal): Promise<NativeWindow[]>
  observe(window: NativeWindow, signal: AbortSignal, options?: { screenshot?: boolean; text?: boolean }): Promise<NativeObservation>
  act(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<DriverAction>
  close(): Promise<void>
}
export interface CuaNativeResult extends DriverAction {
  structuredJson?: string
  text: string
  images: { mime: string; data: string }[]
}
export interface DesktopIdentity {
  started: string; bounds: Bounds; foreground: boolean; screen?: { width: number; height: number } | undefined;
  visibleBounds?: Bounds | undefined; minimized?: boolean | undefined; maximized?: boolean | undefined;
  dpi?: number | undefined; coordinateSpace?: 'physical_screen_pixels' | 'unknown' | undefined;
  workArea?: Bounds | undefined; virtualScreen?: Bounds | undefined
}
export interface InputObserver {
  readonly available: boolean
  windows?(): Promise<NativeWindow[]>
  identify(window: NativeWindow): Promise<DesktopIdentity>
  hit?(window: NativeWindow, x: number, y: number): Promise<boolean>
  window(window: NativeWindow, action: 'minimize' | 'maximize' | 'restore', started?: string): Promise<void>
  close(): Promise<void>
}
export type DesktopInputCallback = (stop: boolean, windowId?: string, source?: DesktopControlEvent['source']) => void
export interface DesktopResult {
  value: JsonValue; images?: { mime: string; data: string }[]
}
export class DesktopError extends Error {
  constructor(message: string, readonly code = 'DESKTOP_FAILED', readonly toolOutcome: 'failed' | 'cancelled' | 'unknown' = 'failed',
    readonly diagnostics?: Record<string, JsonValue>) { super(message) }
}
