export function packet(type: number, payload = Buffer.alloc(0)) {
  const size = payload.length + 3
  if (size > 65535) throw new Error('OpenTTD packet exceeds size limit')
  const header = Buffer.alloc(3); header.writeUInt16LE(size); header[2] = type
  return Buffer.concat([header, payload])
}
export function cstring(text: string) {
  if (text.includes('\0')) throw new Error('OpenTTD strings cannot contain NUL')
  return Buffer.from(text + '\0')
}
export class PacketReader {
  private offset = 0
  constructor(private readonly bytes: Buffer) {}
  get remaining() { return this.bytes.length - this.offset }
  private take(size: number) { if (this.remaining < size) throw new Error('Truncated OpenTTD packet'); const offset = this.offset; this.offset += size; return offset }
  u8() { return this.bytes.readUInt8(this.take(1)) }
  u16() { return this.bytes.readUInt16LE(this.take(2)) }
  u32() { return this.bytes.readUInt32LE(this.take(4)) }
  i64() { return Number(this.bytes.readBigInt64LE(this.take(8))) }
  u64() { return Number(this.bytes.readBigUInt64LE(this.take(8))) }
  boolean() { const value = this.u8(); if (value > 1) throw new Error('Invalid OpenTTD boolean'); return value === 1 }
  string() { const end = this.bytes.indexOf(0, this.offset); if (end < 0) throw new Error('Unterminated OpenTTD string'); const text = this.bytes.subarray(this.offset, end).toString('utf8'); this.offset = end + 1; return text }
}
export class PacketFrames {
  private pending: Buffer = Buffer.alloc(0)
  push(bytes: Buffer, receive: (type: number, payload: Buffer) => void) {
    this.pending = Buffer.concat([this.pending, bytes])
    if (this.pending.length > 1024 * 1024) throw new Error('OpenTTD receive buffer exceeds limit')
    while (this.pending.length >= 2) {
      const size = this.pending.readUInt16LE()
      if (size < 3) throw new Error('Invalid OpenTTD frame size')
      if (this.pending.length < size) return
      const frame = this.pending.subarray(0, size); this.pending = this.pending.subarray(size)
      receive(frame[2]!, frame.subarray(3))
    }
  }
}
export function subscriptions(payload: Buffer) {
  const reader = new PacketReader(payload), version = reader.u8(), supported = new Map<number, number>()
  while (reader.remaining && reader.boolean()) supported.set(reader.u16(), reader.u16())
  const preferred = [[0, 2], [2, 64], [3, 16], [4, 16], [5, 64], [6, 64], [9, 64]] as const
  return { version, packets: preferred.filter(([update, frequency]) => ((supported.get(update) ?? 0) & frequency) !== 0).map(([update, frequency]) => {
    const body = Buffer.alloc(4); body.writeUInt16LE(update); body.writeUInt16LE(frequency, 2); return packet(2, body)
  }) }
}
export function pollPackets() {
  return [[0, 0], [2, 0xffffffff], [3, 0], [4, 0]].map(([update, target]) => {
    const body = Buffer.alloc(5); body[0] = update!; body.writeUInt32LE(target!, 1); return packet(3, body)
  })
}
