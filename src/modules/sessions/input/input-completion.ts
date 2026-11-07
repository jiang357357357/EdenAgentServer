/** Explicit cancellation must not conceal an unrelated execution or storage failure. */
export function inputCompletion(error: string | undefined, alreadyCancelled: boolean, cancelledByUser: boolean) {
  const cancelled = cancelledByUser || alreadyCancelled && !error
  return {
    state: alreadyCancelled || cancelled ? 'cancelled' : error ? 'interrupted' : 'completed',
    error: cancelled ? null : error ?? null,
    reason: cancelled ? '本轮执行已取消；已完成工具结果已保留，未确认的操作不会自动重试' : error,
    event: cancelled ? 'input.cancelled' : error ? 'input.interrupted' : 'turn.completed',
    completed: !cancelled && !error,
  }
}
