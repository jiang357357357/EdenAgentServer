export const COMPUTER_INPUT_DELIVERED = '前台操作已请求执行；请核对新观察中的目标、焦点和内容，不能仅凭界面变化认定任务成功。'
export const COMPUTER_TARGET_MISMATCH = '操作后的会话或窗口标题与预期目标不符，禁止报告成功或继续输入发送。'
const errors: Record<string, string> = {
  CAPTURE_REQUIRES_FOREGROUND: '当前截图后端要求目标窗口在前台；请先显式激活目标，再重新观察。',
  WINDOW_OCCLUDED: '目标窗口被其他窗口遮挡，未采集截图；请显式激活并重新观察。',
  WINDOW_NOT_FOREGROUND: '目标窗口未能获得前台焦点，未继续输入；请重新选择并激活目标。',
  WINDOW_MINIMIZED: '窗口已最小化，请恢复并激活窗口后重新观察。',
  WINDOW_CLOSED: '目标窗口已关闭，请重新发现窗口。', WINDOW_REPLACED: '窗口进程已变化，请重新发现目标。',
  WINDOW_CHANGED: '窗口位置或尺寸已变化，请重新观察后操作。',
  OBSERVATION_REQUIRED: '当前观察已失效或被其他操作使用，请重新观察目标窗口。',
  ELEMENT_REFERENCE_EXPIRED: '控件引用不属于当前观察，请重新观察。', ELEMENT_MOVED: '控件位置已变化，请重新观察后操作。',
  ELEMENT_CHANGED: '目标控件或其子项文字已变化，请重新观察并核对目标后操作。',
  ELEMENT_NOT_VISIBLE: '目标控件不在当前窗口范围内，请重新观察可见目标。',
  POINT_NOT_TARGET_WINDOW: '输入位置被非目标窗口占用，未继续输入；请激活目标并重新观察。',
  FOCUS_REQUIRED: '尚未确认可输入焦点，请点击目标编辑区域并重新观察。',
  FOCUS_NOT_TARGET_WINDOW: '当前焦点不属于目标窗口，未输入文字；请点击目标编辑区域并重新观察。',
  FOCUS_NOT_TARGET_ELEMENT: '当前焦点与指定编辑控件不一致，未输入文字；请先点击该控件并重新观察。',
  FOCUS_CHANGED: '输入期间焦点发生变化，文字可能仅部分输入；请重新观察，禁止直接重复完整输入。',
  INPUT_PARTIAL: '系统只接受了部分输入，结果未知；请先观察，不得直接重放。',
  SET_VALUE_UNSUPPORTED: '该控件不支持直接替换值，请核对焦点后使用普通文字输入。',
  KEY_UNSUPPORTED: '组合键不受支持，请使用明确的字母、数字、控制键或功能键。',
  APPLICATION_INVALID: '请提供应用名称或 .exe 路径；启动后重新发现实际窗口。',
  COORDINATE_OUTSIDE_WINDOW: '坐标不属于当前有效截图，请重新观察并使用窗口内坐标。',
  COMPUTER_USE_CANCELLED: 'Computer Use 操作已取消；已开始的输入结果可能未知，请先观察。',
}
export function computerUseError(code: string): string { return errors[code] ?? 'Computer Use 后端未能完成操作，请按错误码重新检查目标和当前状态。' }
