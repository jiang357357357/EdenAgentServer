import path from 'node:path'

export interface WorkspaceMutationTarget { path: string; kind: 'file' | 'directory' }

/** Only overlapping host mutations wait; external editors and arbitrary shell side effects remain outside this contract. */
export class WorkspaceMutationQueue {
  private readonly pending = new Set<{ target: WorkspaceMutationTarget | undefined; done: Promise<void> }>()

  async run<T>(signal: AbortSignal, work: () => Promise<T>, target?: WorkspaceMutationTarget): Promise<T> {
    signal.throwIfAborted()
    const previous = Promise.all([...this.pending].filter(item => overlaps(item.target, target)).map(item => item.done)).then(() => undefined)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const entry = { target, done: previous.then(() => gate) }
    this.pending.add(entry)
    void entry.done.then(() => this.pending.delete(entry))
    try {
      await waitForPrevious(previous, signal)
      signal.throwIfAborted()
      return await work()
    } finally { release() }
  }
}

function overlaps(left?: WorkspaceMutationTarget, right?: WorkspaceMutationTarget): boolean {
  if (!left || !right) return true
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const first = normalize(left.path), second = normalize(right.path)
  if (first === second) return true
  const contains = (root: string, file: string) => {
    const relative = path.relative(root, file)
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
  }
  return (left.kind === 'directory' && contains(first, second)) || (right.kind === 'directory' && contains(second, first))
}

async function waitForPrevious(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('Workspace operation cancelled while queued'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try { await Promise.race([previous, cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}
