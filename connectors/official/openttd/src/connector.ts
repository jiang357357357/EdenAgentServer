import type { ConnectorDefinition } from '@eden/plugin-sdk/connector'
import { AdminSession } from './session.ts'
export const connector: ConnectorDefinition = {
  id: 'openttd', version: '2.0.0', events: ['chat', 'new_game', 'company_removed', 'gamescript', 'shutdown'],
  queries: ['get_state', 'inspect_tile', 'find_towns', 'find_industries', 'get_company_assets', 'list_road_engines', 'find_road_route_site'],
  actions: ['refresh_state', 'pause_game', 'resume_game', 'save_game', 'send_chat', 'gameplay_command', 'gameplay_plan'],
  initialize: context => new AdminSession(context)
}
