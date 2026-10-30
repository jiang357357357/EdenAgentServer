export const DESKTOP_RESULT_MESSAGES = {
  read: '已读取结果。',
  dispatched: '动作已派发；效果以 verification 中的定向核验为准，不代表业务流程已经完成。',
  confirmed: '已核验返回证据所说明的界面状态；不代表远端接收或整个业务流程完成。',
  unconfirmed: '派发已结束，但效果尚未确认；使用返回的新观察继续核对，不要重放输入。',
  partial: '已观察到部分目标内容，仍不足以完整核对；请检查 evidence，不要重放输入。',
  unavailable: '动作后的观察未取得，原动作可能已发生；请重新观察，不要重放输入。',
  titleChanged: '窗口标题已更新；已按原定位条件重新读取目标，请结合目标上下文判断业务对象。',
  windowMatched: '已读回确认请求的窗口状态。',
  windowUnmatched: '窗口状态尚未符合请求；返回实际状态，不报告操作成功。',
} as const
