import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { LocalEmbedding } from './embedding.ts'
import { legacyPickle } from './legacy-pickle.ts'
import { saveState } from './state-store.ts'
import type { OsConfig } from './contracts.ts'

const record = z.object({ content: z.string(), metadata: z.unknown().default({}), embedding: z.array(z.number().finite()).default([]) })
const collectionSchema = z.object({ schema_version: z.literal(1), model_fingerprint: z.string(), dimension: z.number().int().nonnegative(), items: z.record(z.string(), record) })
type Collection = z.infer<typeof collectionSchema>

export class RecallService {
  readonly embedding: LocalEmbedding
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  constructor(private readonly config: OsConfig) { this.embedding = new LocalEmbedding(config.modelPath) }
  call(method: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('召回服务已停止'))
    const task = this.tail.then(() => this.execute(method, args))
    this.tail = task.catch(() => {})
    return task
  }
  private async execute(method: string, args: Record<string, unknown>): Promise<unknown> {
    const name = z.string().min(1).max(255).regex(/^[a-zA-Z0-9_.-]+$/).parse(args.collection_name)
    const collection = await this.read(name)
    if (method === 'recall_delete_memories') return this.remove(name, collection, args.where ?? {})
    await this.refresh(collection)
    if (method === 'recall_search') {
      if (!Object.keys(collection.items).length) return []
      const query = await this.embedding.embed(z.string().parse(args.query_text))
      this.save(name, collection)
      return Object.entries(collection.items).map(([id, item]) => ({ id, content: item.content, metadata: item.metadata,
        distance: query.reduce((sum, value, i) => sum + (value - item.embedding[i]!) ** 2, 0) }))
        .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id)).slice(0, z.number().int().min(1).max(10000).parse(args.top_k ?? 3))
    }
    return this.add(method, name, collection, args)
  }
  private async add(method: string, name: string, collection: Collection, args: Record<string, unknown>) {
    const items = method === 'recall_add_memory' ? [[args.doc_id, args.content, args.metadata ?? {}]] : z.array(z.array(z.unknown())).max(10000).parse(args.items)
    let count = 0
    for (const item of items) {
      if (typeof item[0] !== 'string' || !item[0].trim() || item.length < 2) continue
      const content = typeof item[1] === 'string' ? item[1] : JSON.stringify(item[1])
      const metadata = item[2] && typeof item[2] === 'object' && !Array.isArray(item[2]) ? item[2] : {}
      Object.defineProperty(collection.items, item[0].trim(), { value: { content, metadata, embedding: await this.embedding.embed(content) },
        configurable: true, writable: true, enumerable: true }); count++
    }
    if (count) { collection.model_fingerprint = this.embedding.fingerprint; collection.dimension = this.embedding.dimension; this.save(name, collection) }
    return { added: count > 0, ...(method === 'recall_add_memories' ? { count } : {}) }
  }
  private async read(name: string): Promise<Collection> {
    const filename = path.join(this.config.vectorDir, `${name}.json`)
    if (existsSync(filename)) return collectionSchema.parse(JSON.parse(readFileSync(filename, 'utf8')))
    const collection: Collection = { schema_version: 1, model_fingerprint: '', dimension: 0, items: {} }
    const legacy = path.join(this.config.legacyVectorDir, name, 'metadata.pkl')
    if (!existsSync(legacy)) return collection
    const value = z.object({ documents: z.record(z.string(), z.unknown()), metadata: z.record(z.string(), z.unknown()).default({}) }).parse(legacyPickle(readFileSync(legacy)))
    for (const [id, content] of Object.entries(value.documents)) Object.defineProperty(collection.items, id, {
      value: { content: typeof content === 'string' ? content : JSON.stringify(content), metadata: value.metadata[id] ?? {}, embedding: [] },
      configurable: true, writable: true, enumerable: true })
    await this.refresh(collection); this.save(name, collection)
    return collection
  }
  private async refresh(collection: Collection) {
    if (!Object.keys(collection.items).length) return
    await this.embedding.load()
    const all = collection.model_fingerprint !== this.embedding.fingerprint || collection.dimension !== this.embedding.dimension
    for (const item of Object.values(collection.items)) if (all || item.embedding.length !== this.embedding.dimension)
      item.embedding = await this.embedding.embed(item.content)
    collection.model_fingerprint = this.embedding.fingerprint; collection.dimension = this.embedding.dimension
  }
  private remove(name: string, collection: Collection, filters: unknown) {
    const conditions = z.record(z.string(), z.unknown()).parse(filters)
    let count = 0
    for (const [id, item] of Object.entries(collection.items)) {
      const metadata = item.metadata
      if (Object.entries(conditions).every(([key, value]) => metadata && typeof metadata === 'object'
        && Object.hasOwn(metadata, key) && isDeepStrictEqual((metadata as Record<string, unknown>)[key], value))) {
        delete collection.items[id]; count++
      }
    }
    if (count) this.save(name, collection)
    return { deleted: count > 0, count }
  }
  private save(name: string, collection: Collection) {
    mkdirSync(this.config.vectorDir, { recursive: true, mode: 0o700 })
    saveState(path.join(this.config.vectorDir, `${name}.json`), collection)
  }
  async close() { this.closed = true; await this.tail; await this.embedding.close() }
}
