import type { JsonValue } from '@eden/api/connector'
import { PacketReader } from './packets.ts'

export class GameState {
  server: Record<string, JsonValue> = {}
  companies = new Map<number, Record<string, JsonValue>>()
  date: number | null = null
  authenticated = false
  bridgeReady = false
  bridgeVersion: number | null = null
  constructor(readonly instance: Record<string, JsonValue>) {}
  snapshot(): Record<string, JsonValue> {
    return { instance: this.instance, date: this.date, year: this.date === null ? null : Math.floor(this.date / 365), server: this.server,
      companies: [...this.companies].sort(([a], [b]) => a - b).map(([, value]) => value),
      capabilities: { observe_admin_state: true, server_management: true, company_gameplay: this.bridgeReady, gameplay_bridge_ready: this.bridgeReady, bridge_version: this.bridgeVersion } }
  }
  company(id: number) {
    let company = this.companies.get(id)
    if (!company) { company = { company_id: id }; this.companies.set(id, company) }
    return company
  }
}
type Event = { type: string; payload: JsonValue } | undefined
export function decodeState(type: number, payload: Buffer, state: GameState): Event {
  const reader = new PacketReader(payload)
  if (type === 104) { welcome(reader, state); return }
  if (type === 107) { state.date = reader.u32(); return }
  if (type === 113) { state.company(reader.u8()); return }
  if (type >= 114 && type <= 118) return companyPacket(type, reader, state)
  if (type === 119) return { type: 'chat', payload: { action: reader.u8(), destination_type: reader.u8(), client_id: reader.u32(), message: reader.string(), data: reader.u64() } }
  if (type === 105) { state.companies.clear(); state.date = null; state.bridgeReady = false; return { type: 'new_game', payload: state.snapshot() } }
  if (type === 106) return { type: 'shutdown', payload: state.snapshot() }
  return undefined
}
function welcome(reader: PacketReader, state: GameState) {
  state.server = { name: reader.string(), revision: reader.string(), dedicated: reader.boolean(), map_name: reader.string(), generation_seed: reader.u32(), landscape: reader.u8() }
  const date = reader.u32()
  Object.assign(state.server, { start_date: date, start_year: Math.floor(date / 365), map_width: reader.u16(), map_height: reader.u16() })
}
function companyPacket(type: number, reader: PacketReader, state: GameState): Event {
  const id = reader.u8(), company = state.company(id)
  if (type === 116) { const reason = reader.u8(); state.companies.delete(id); return { type: 'company_removed', payload: { company, reason, state: state.snapshot() } } }
  if (type === 114 || type === 115) {
    Object.assign(company, { name: reader.string(), president: reader.string(), colour: reader.u8(), passworded: reader.boolean() })
    if (type === 114) Object.assign(company, { inaugurated_year: reader.u32(), is_ai: reader.boolean() })
    company.quarters_bankrupt = reader.u8()
  }
  if (type === 117) company.economy = { money: reader.i64(), loan: reader.i64(), income: reader.i64(), delivered_cargo: reader.u16(), quarters: [quarter(reader), quarter(reader)] }
  if (type === 118) company.statistics = { vehicles: counts(reader), stations: counts(reader) }
  return undefined
}
const quarter = (reader: PacketReader) => ({ company_value: reader.i64(), performance: reader.u16(), delivered_cargo: reader.u16() })
const counts = (reader: PacketReader) => ({ train: reader.u16(), lorry: reader.u16(), bus: reader.u16(), aircraft: reader.u16(), ship: reader.u16() })
