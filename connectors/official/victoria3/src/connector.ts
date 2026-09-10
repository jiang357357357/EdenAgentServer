import { observeLog } from '@eden/plugin-sdk/connector'
import type { ConnectorDefinition, BridgeRecord, Observation } from '@eden/plugin-sdk/connector'
import { probeControl } from './control-probe.ts'

export function observation(record: BridgeRecord, observedAt: number): Observation | undefined {
  const fields = record.fields
  if (record.kind === 'HELLO') return { event: 'bridge_ready', externalId: `hello:${fields.bridge_version ?? 'unknown'}:protocol-1`,
    payload: { observedAt, fields }, state: { bridgeVersion: fields.bridge_version ?? null } }
  if (record.kind === 'SNAPSHOT') {
    const snapshot = { observedAt, fields }
    return { event: 'snapshot', externalId: `snapshot:${fields.country_id ?? 'unknown'}:${fields.date ?? observedAt}`, payload: snapshot, state: { latestSnapshot: snapshot } }
  }
  if (record.kind !== 'ACK' || !fields.command_id) return undefined
  const ack = { observedAt, commandId: fields.command_id, status: fields.status ?? 'unknown', action: fields.action ?? null, fields }
  return { event: 'command_ack', externalId: `ack:${ack.commandId}`, payload: ack, state: { latestAck: ack } }
}
export const connector: ConnectorDefinition = {
  id: 'victoria3', version: '2.0.0', events: ['bridge_ready', 'snapshot', 'command_ack'], queries: ['get_state'], actions: ['probe_control'],
  initialize(context) {
    const observer = observeLog(context, '[EDENAGENT]|', observation)
    observer.state.latestAck = null
    return { ...observer.session, execute: () => probeControl(context, observer.state) }
  }
}
