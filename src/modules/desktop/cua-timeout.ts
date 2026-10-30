/** Driver operations can include downloads and recorded workflows, beyond a single input gesture. */
export function cuaOperationTimeout(name: string, input: Record<string, unknown>): number {
  const tool = name.startsWith('cua_') ? name.slice(4) : name
  if (['install_ffmpeg', 'replay_trajectory'].includes(tool)) return 300000
  if (tool === 'browser_download') return 120000
  if (tool === 'verify_state' && typeof input.timeout_ms === 'number') return Math.min(120000, Math.max(30000, input.timeout_ms + 5000))
  return 30000
}
