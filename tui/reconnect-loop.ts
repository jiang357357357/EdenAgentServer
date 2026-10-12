export interface ReconnectActions {
  attempt(): Promise<boolean>
  progress(attempt: number, limit: number): void
  exhausted(): void
}

/** Only schedules after a disconnect. It never retries an RPC or a user message. */
export class ReconnectLoop {
  private timer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private running = false
  private attempts = 0

  constructor(private readonly actions: ReconnectActions,
    private readonly delays: readonly number[] = [500, 1000, 2000, 4000, 8000, 15000]) {}

  start(): void {
    if (this.running || !this.delays.length) return
    this.running = true; this.attempts = 0
    this.schedule(++this.generation)
  }

  stop(): void {
    this.generation++; this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(generation: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tryConnect(generation)
    }, this.delays[this.attempts] ?? 15000)
  }

  private async tryConnect(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation) return
    this.actions.progress(++this.attempts, this.delays.length)
    let retry = false
    try { retry = await this.actions.attempt() }
    catch { retry = true }
    if (!this.running || generation !== this.generation) return
    if (!retry) { this.stop(); return }
    if (this.attempts >= this.delays.length) {
      this.stop(); this.actions.exhausted(); return
    }
    this.schedule(generation)
  }
}
