import { existsSync } from 'node:fs'
import type { Browser, Page } from 'playwright-core'
import type { BlobService } from '../blobs/index.ts'

export interface BrowserInspection { url: string; selector?: string | undefined; screenshot: boolean; waitMs: number }

function executable(): string | undefined {
  const candidates = process.platform === 'win32'
    ? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
  return candidates.find(candidate => existsSync(candidate))
}

export class BrowserService {
  private readonly active = new Set<Browser>()
  private closed = false
  constructor(private readonly blobs: BlobService) {}

  async inspect(input: BrowserInspection, signal: AbortSignal) {
    if (this.closed) throw new Error('浏览器服务已关闭')
    signal.throwIfAborted()
    const url = new URL(input.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只允许不含凭据的 HTTP(S) 页面地址')
    const { chromium } = await import('playwright-core')
    const filename = executable() ?? chromium.executablePath()
    if (!existsSync(filename)) throw new Error('没有可用浏览器，请安装 Edge、Chrome 或 Chromium 后重试')
    const browser = await chromium.launch({ executablePath: filename, headless: true, chromiumSandbox: false, timeout: 15000 })
    this.active.add(browser)
    const deadline = AbortSignal.timeout(30000), combined = AbortSignal.any([signal, deadline])
    const cancel = () => { void browser.close().catch(() => {}) }
    combined.addEventListener('abort', cancel, { once: true })
    try {
      if (this.closed) throw new Error('浏览器服务已关闭')
      combined.throwIfAborted()
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: false, serviceWorkers: 'block' })
      await context.route('**/*', route => /^https?:/.test(route.request().url()) ? route.continue() : route.abort())
      const page = await context.newPage(), consoleMessages: string[] = [], errors: string[] = []
      page.on('console', message => { if (consoleMessages.length < 30) consoleMessages.push(`${message.type()}: ${message.text().slice(0, 1000)}`) })
      page.on('pageerror', error => { if (errors.length < 20) errors.push(error.message.slice(0, 1000)) })
      page.setDefaultTimeout(10000)
      const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 20000 })
      if (input.waitMs) await page.waitForTimeout(input.waitMs)
      if (input.selector) await page.locator(input.selector).first().waitFor({ state: 'attached' })
      const dom = await renderedDom(page, input.selector)
      const screenshot = input.screenshot ? await this.blobs.put(await page.screenshot({ type: 'png', animations: 'disabled', timeout: 10000 }), 'image/png') : undefined
      combined.throwIfAborted()
      return { url: page.url(), title: await page.title(), httpStatus: response?.status() ?? null,
        ...dom, console: consoleMessages, errors, ...(screenshot ? { screenshot: { blobId: screenshot.id, mime: screenshot.mime } } : {}) }
    } catch (error) {
      combined.throwIfAborted()
      throw error
    } finally {
      combined.removeEventListener('abort', cancel)
      this.active.delete(browser)
      await browser.close()
    }
  }

  async images(result: import('@eden/api').JsonValue) {
    const value = result as { screenshot?: { blobId: string } }
    if (!value?.screenshot) return []
    const { bytes } = await this.blobs.read(value.screenshot.blobId)
    return [{ type: 'image' as const, data: bytes.toString('base64'), mimeType: 'image/png' as const }]
  }

  async close() { this.closed = true; await Promise.all([...this.active].map(browser => browser.close())) }
}

async function renderedDom(page: Page, selector?: string) {
  return page.locator(selector ?? 'body').first().evaluate(element => {
    const clone = element.cloneNode(true) as HTMLElement
    if (clone.matches('input,textarea')) { clone.removeAttribute('value'); clone.textContent = '' }
    clone.querySelectorAll('script,style,noscript').forEach(node => node.remove())
    clone.querySelectorAll('input,textarea').forEach(node => { node.removeAttribute('value'); node.textContent = '' })
    const html = clone.outerHTML, text = (element as HTMLElement).innerText ?? element.textContent ?? ''
    return { text: text.slice(0, 16000), html: html.slice(0, 20000), truncated: text.length > 16000 || html.length > 20000,
      links: Array.from(element.querySelectorAll('a[href]')).slice(0, 50).map(node => ({ text: (node.textContent ?? '').slice(0, 120), href: (node as HTMLAnchorElement).href })) }
  })
}
