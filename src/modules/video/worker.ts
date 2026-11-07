import { launchMcpProcess } from '@eden/execution'
import { McpClient, McpStdioChannel } from '@eden/integrations'
import type { JsonValue } from '@eden/api'
import { videoWorkerFailure } from './diagnostics.ts'

interface VideoWorkerCall {
  python: string; entry: string; runtime: string; scope: string
  name: string; input: JsonValue; signal: AbortSignal
}

/** Finish process cleanup before collecting the last diagnostics, retaining the original failure. */
export async function callVideoWorker({ python, entry, runtime, scope, name, input, signal }: VideoWorkerCall): Promise<JsonValue> {
  const worker = await launchMcpProcess(new Map(), { command: python,
    args: ['-I', '-u', '-X', 'utf8', entry, runtime, scope], cwd: '.' }, signal)
  const client = new McpClient(new McpStdioChannel(worker.input, worker.output, worker.terminate))
  let result: JsonValue = null, failed = false, failure: unknown, cleanupError: unknown
  try {
    await client.initialize(signal, 60000)
    result = await client.call(name, input, signal)
  } catch (error) { failed = true; failure = error }
  finally {
    client.close()
    try { await worker.close() }
    catch (error) { cleanupError = error; if (!failed) { failed = true; failure = error } }
  }
  signal.throwIfAborted()
  if (failed) throw videoWorkerFailure(name, failure, worker.diagnostics(), cleanupError)
  if (result && typeof result === 'object' && !Array.isArray(result) && result.isError === true)
    return { ...result, diagnostics: worker.diagnostics() }
  return result
}
