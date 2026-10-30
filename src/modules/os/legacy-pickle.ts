/** Read data-only pickle protocols 2–5; never resolve Python globals or construct classes. */
export function legacyPickle(bytes: Buffer): unknown { return new DataPickle(bytes).read() }

class DataPickle {
  private readonly stack: unknown[] = []
  private readonly memo = new Map<number, unknown>()
  private readonly mark = Symbol('mark')
  private offset = 0
  private readonly handlers: Map<number, () => void>
  constructor(private readonly bytes: Buffer) {
    this.handlers = new Map([
      [0x80, () => { if (this.byte() > 5) throw new Error('旧元数据 pickle 版本不支持') }],
      [0x95, () => { this.u64() }], [0x28, () => { this.stack.push(this.mark) }],
      [0x4e, () => { this.stack.push(null) }], [0x88, () => { this.stack.push(true) }], [0x89, () => { this.stack.push(false) }],
      [0x7d, () => { this.stack.push({}) }], [0x5d, () => { this.stack.push([]) }], [0x29, () => { this.stack.push([]) }],
      [0x4b, () => { this.stack.push(this.byte()) }], [0x4d, () => { this.stack.push(this.take(2).readUInt16LE()) }],
      [0x4a, () => { this.stack.push(this.take(4).readInt32LE()) }], [0x47, () => { this.stack.push(this.take(8).readDoubleBE()) }],
      [0x8a, () => this.long(this.byte())], [0x8b, () => this.long(this.u32())],
      [0x94, () => { this.memo.set(this.memo.size, this.stack.at(-1)) }],
      [0x71, () => { this.memo.set(this.byte(), this.stack.at(-1)) }], [0x72, () => { this.memo.set(this.u32(), this.stack.at(-1)) }],
      [0x68, () => this.reference(this.byte())], [0x6a, () => this.reference(this.u32())],
      [0x75, () => { const items = this.group(); this.pairs(this.dictionary(), items) }],
      [0x73, () => { const value = this.stack.pop(), key = this.stack.pop(); this.pairs(this.dictionary(), [key, value]) }],
      [0x64, () => { const items = this.group(), target = {}; this.pairs(target, items); this.stack.push(target) }],
      [0x65, () => { const items = this.group(); this.array().push(...items) }],
      [0x61, () => { const value = this.stack.pop(); this.array().push(value) }],
      [0x74, () => { this.stack.push(this.group()) }], [0x6c, () => { this.stack.push(this.group()) }],
    ])
    for (const code of [0x58, 0x42]) this.handlers.set(code, () => { this.stack.push(this.take(this.u32()).toString('utf8')) })
    for (const code of [0x8c, 0x43]) this.handlers.set(code, () => { this.stack.push(this.take(this.byte()).toString('utf8')) })
    for (const code of [0x8d, 0x8e]) this.handlers.set(code, () => { this.stack.push(this.take(this.u64()).toString('utf8')) })
    for (const code of [0x85, 0x86, 0x87]) this.handlers.set(code, () => { this.stack.push(this.stack.splice(this.stack.length - (code - 0x84))) })
  }
  read(): unknown {
    while (this.offset < this.bytes.length) {
      const code = this.byte()
      if (code === 0x2e) {
        if (this.stack.length !== 1) throw new Error('旧向量元数据栈不完整')
        return this.stack[0]
      }
      const handler = this.handlers.get(code)
      if (!handler) throw new Error(`旧向量 pickle 操作码不支持：0x${code.toString(16)}；原文件已保留`)
      handler()
    }
    throw new Error('旧向量元数据不完整')
  }
  private take(n: number): Buffer {
    if (!Number.isSafeInteger(n) || n < 0 || this.offset + n > this.bytes.length) throw new Error('旧向量元数据长度无效')
    const value = this.bytes.subarray(this.offset, this.offset + n); this.offset += n; return value
  }
  private byte(): number { return this.take(1)[0]! }
  private u32(): number { return this.take(4).readUInt32LE() }
  private u64(): number { return Number(this.take(8).readBigUInt64LE()) }
  private group(): unknown[] {
    const index = this.stack.lastIndexOf(this.mark)
    if (index < 0) throw new Error('旧向量元数据栈无效')
    const values = this.stack.splice(index + 1); this.stack.pop(); return values
  }
  private array(): unknown[] {
    const value = this.stack.at(-1)
    if (!Array.isArray(value)) throw new Error('旧向量列表无效')
    return value
  }
  private dictionary(): Record<string, unknown> {
    const value = this.stack.at(-1)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('旧向量字典无效')
    return value as Record<string, unknown>
  }
  private pairs(target: Record<string, unknown>, items: unknown[]) {
    if (items.length % 2) throw new Error('旧向量元数据字典无效')
    for (let i = 0; i < items.length; i += 2) {
      const key = items[i]
      if (typeof key !== 'string' && typeof key !== 'number') throw new Error('旧向量元数据键无效')
      Object.defineProperty(target, String(key), { value: items[i + 1], enumerable: true, configurable: true, writable: true })
    }
  }
  private reference(key: number) {
    if (!this.memo.has(key)) throw new Error('旧向量引用无效')
    this.stack.push(this.memo.get(key))
  }
  private long(length: number) {
    const value = this.take(length)
    let n = 0n
    for (let i = value.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(value[i]!)
    if (value.length && (value.at(-1)! & 128)) n -= 1n << BigInt(8 * value.length)
    if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('旧向量整数超出安全范围')
    this.stack.push(Number(n))
  }
}
