import { observeLog } from '@eden/plugin-sdk/connector'
import type { ConnectorDefinition, BridgeRecord, Observation } from '@eden/plugin-sdk/connector'
import { countryState } from './country-state.ts'

export function observation(record: BridgeRecord, observedAt: number): Observation | undefined {
  const fields = record.fields
  if (record.kind === 'HELLO') return { event: 'bridge_ready', externalId: `hello:${fields.bridge_version ?? 'unknown'}:protocol-1`,
    payload: { observedAt, fields }, state: { bridgeVersion: fields.bridge_version ?? null } }
  if (record.kind !== 'SNAPSHOT') return undefined
  const country = countryState(fields), snapshot = { observedAt, country, fields }
  return { event: 'snapshot', externalId: `snapshot:${country.countryTag ?? 'unknown'}:${country.date ?? observedAt}`,
    payload: snapshot, state: { latestSnapshot: snapshot } }
}
export const connector: ConnectorDefinition = {
  id: 'hoi4', version: '2.0.0', events: ['bridge_ready', 'snapshot'], queries: ['get_state'], actions: [],
  initialize: context => observeLog(context, 'EDENAGENT_HOI4|', observation).session
}
