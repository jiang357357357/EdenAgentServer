import { rpcMethods } from '@eden/api'
import type { DesktopService } from '../../modules/desktop/index.ts'
import { contractHandler } from './contract-handler.ts'

export function desktopRoutes(service: DesktopService) {
  return {
    'desktop.status': contractHandler(rpcMethods['desktop.status'], () => service.status()),
    'desktop.control': contractHandler(rpcMethods['desktop.control'], input => service.control(input.action)),
  }
}
