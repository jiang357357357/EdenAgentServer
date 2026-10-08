import { RuntimePersistenceError } from '@eden/runtime-pi'

/** A synchronous repository operation must either commit its durable state or keep execution stopped. */
export function sessionStorage<T>(operation: string, work: () => T): T {
  try { return work() }
  catch (error) { throw new RuntimePersistenceError(operation, error) }
}
