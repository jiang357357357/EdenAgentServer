/** Keep 64-bit HWND values exact while native JSON crosses the JavaScript boundary. */
export function parseCuaJson(value: string): unknown {
  return JSON.parse(value, (_key: string, item: unknown, context?: { source: string }) =>
    typeof item === 'number' && Number.isInteger(item) && !Number.isSafeInteger(item) ? context?.source ?? String(item) : item)
}
export function stringifyCuaArgs(value: unknown): string {
  const json = JSON as typeof JSON & { rawJSON(source: string): unknown }
  return JSON.stringify(value, (key, item: unknown) =>
    ['window_id', 'windowId', 'hwnd'].includes(key) && typeof item === 'string' && /^\d+$/.test(item) ? json.rawJSON(item) : item)
}
