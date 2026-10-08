import { createSharedWorkspaceClient, createSharedLanRuntime } from '@eden/shared-workspace'
import type { SharedClientFactory } from './contracts.ts'

/** Receiving is part of Agent; the optional DLC gates publication at the library service. */
export async function loadSharedWorkspace(): Promise<SharedClientFactory> {
  return Object.assign(createSharedWorkspaceClient, { createLanRuntime: createSharedLanRuntime })
}
