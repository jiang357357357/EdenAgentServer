import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'

export interface PublicResponse {
  url: URL
  status: number
  contentType: string
  body: Buffer
  truncated: boolean
}

interface PublicRequest {
  method?: 'GET' | 'POST' | undefined
  headers?: Record<string, string> | undefined
  body?: Buffer | undefined
  signal: AbortSignal
  timeoutMs: number
  maxBytes: number
}

export async function requestPublic(input: URL, options: PublicRequest): Promise<PublicResponse> {
  const deadline = Date.now() + options.timeoutMs
  let url = new URL(input)
  let method = options.method ?? 'GET'
  let body = options.body
  let headers = { ...options.headers }
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    options.signal.throwIfAborted()
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Public HTTP request timed out')
    const response = await requestOnce(url, { ...options, method, body, headers, timeoutMs: remaining })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    if (redirects === 5) throw new Error('Too many public HTTP redirects')
    const location = response.headers.location
    if (!location) throw new Error('Redirect response has no Location header')
    const next = new URL(location, url)
    if (next.origin !== url.origin) {
      const sensitive = new Set(['authorization', 'x-api-key', 'x-subscription-token'])
      headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !sensitive.has(name.toLowerCase())))
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET'; body = undefined
    }
    url = next
  }
  throw new Error('Unreachable redirect state')
}

async function requestOnce(url: URL, options: PublicRequest & { method: 'GET' | 'POST' }): Promise<PublicResponse & { headers: http.IncomingHttpHeaders }> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP and HTTPS URLs are allowed')
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Only public HTTP and HTTPS URLs are allowed')
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('URL resolves to a private or reserved network address')
  const selected = addresses[0]!
  const transport = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, value?: PublicResponse & { headers: http.IncomingHttpHeaders }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(value!)
    }
    const request = transport.request(url, {
      method: options.method,
      headers: { 'user-agent': 'Eden Agent/2.0', accept: 'application/json, text/html;q=0.9, text/plain;q=0.8', 'accept-encoding': 'identity', ...options.headers },
      agent: false,
      lookup: (_hostname, lookupOptions, callback) => {
        if (typeof lookupOptions === 'object' && lookupOptions.all) {
          ;(callback as unknown as (error: null, addresses: Array<{ address: string; family: number }>) => void)(null, [selected])
        } else {
          ;(callback as unknown as (error: null, address: string, family: number) => void)(null, selected.address, selected.family)
        }
      },
      ...(url.protocol === 'https:' ? { servername: host } : {}),
    }, response => {
      const chunks: Buffer[] = []
      let size = 0
      let truncated = false
      response.on('data', (raw: Buffer) => {
        if (truncated) return
        const chunk = Buffer.from(raw)
        const remaining = options.maxBytes - size
        if (chunk.length > remaining) { chunks.push(chunk.subarray(0, remaining)); size += remaining; truncated = true; response.destroy(); return }
        chunks.push(chunk); size += chunk.length
        if (size >= options.maxBytes) { truncated = true; response.destroy() }
      })
      response.on('end', () => finish(undefined, {
        url, status: response.statusCode ?? 0,
        contentType: String(response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase(),
        body: Buffer.concat(chunks), truncated, headers: response.headers,
      }))
      response.on('close', () => {
        if (truncated) finish(undefined, {
          url, status: response.statusCode ?? 0,
          contentType: String(response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase(),
          body: Buffer.concat(chunks), truncated, headers: response.headers,
        })
      })
      response.on('error', error => finish(error))
    })
    const abort = () => request.destroy(Object.assign(new Error('Web request cancelled'), { name: 'AbortError' }))
    const timer = setTimeout(() => request.destroy(new Error('Public HTTP request timed out')), options.timeoutMs)
    options.signal.addEventListener('abort', abort, { once: true })
    request.on('error', error => finish(error))
    if (options.body) request.write(options.body)
    request.end()
  })
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b! >= 64 && b! <= 127)
      || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 0)
      || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && c === 2)
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a! >= 224)
  }
  if (isIP(address) !== 6) return false
  const value = address.toLowerCase()
  // IPv4-mapped IPv6 may encode private IPv4 addresses in hexadecimal form.
  if (value.includes(':ffff:')) return false
  return !(value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd')
    || /^fe[89ab]/.test(value) || value.startsWith('ff') || value.startsWith('2001:db8:')
    || value.startsWith('2001:0:') || value.startsWith('2001:2:') || value.startsWith('2002:'))
}
