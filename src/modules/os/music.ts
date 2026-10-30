const base = 'https://www.jbsou.cn/'
const sources = ['netease', 'qq', 'kugou', 'kuwo', 'migu', 'baidu']
export const musicPlatforms = [
  { label: '网易云音乐', value: 'netease' }, { label: 'QQ音乐', value: 'qq' }, { label: '酷狗音乐', value: 'kugou' },
  { label: '酷我音乐', value: 'kuwo' }, { label: '咪咕音乐', value: 'migu' }, { label: '百度音乐', value: 'baidu' }, { label: 'WebSocket', value: 'websocket' },
]
export class OsMusic {
  private readonly abort = new AbortController()
  async search(query: string, page: number, platform: string): Promise<unknown[]> {
    if (platform !== 'all' && !sources.includes(platform)) throw new Error('音乐平台不支持')
    const groups = await Promise.all((platform === 'all' ? sources : [platform]).map(source => this.platform(query, page, source)))
    const seen = new Set<string>()
    return groups.flat().filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true })
  }
  private async platform(query: string, page: number, source: string) {
    const response = await fetch(base, { method: 'POST', body: new URLSearchParams({ input: query, filter: 'name', type: source, page: String(Math.max(1, page)) }),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10000)]), headers: { 'X-Requested-With': 'XMLHttpRequest',
        Origin: 'https://www.jbsou.cn', Referer: base, 'User-Agent': 'Mozilla/5.0 Chrome/120 Safari/537.36' } })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`音乐服务返回 HTTP ${response.status}`) }
    const value = await response.json() as { data?: Record<string, unknown>[] }
    return (Array.isArray(value.data) ? value.data : []).map((item, index) => {
      const text = (...keys: string[]) => String(keys.map(key => item[key]).find(v => typeof v === 'string' || typeof v === 'number') ?? '')
      return { id: text('songid', 'id') || `${source}_${index}`, source: `native_${source}`, name: text('name', 'title') || '未知歌曲',
        artist: text('artist', 'author', 'singer') || '未知歌手', album: text('album'), duration: Number(text('duration')) || 0,
        img: proxy(text('pic', 'cover')), url: proxy(text('url', 'link')), lrc: proxy(text('lrc')) }
    })
  }
  close() { this.abort.abort() }
}
function proxy(raw: string): string { return raw ? `/api/external/music/proxy/?url=${encodeURIComponent(new URL(raw, base).href)}` : '' }
