import path from 'node:path'
import koffi from 'koffi'
import { DesktopError } from './contracts.ts'

/** Run only in the dedicated Cua worker, before the SDK creates threads or windows. */
export function initializeCuaWorkerDpi() {
  if (process.platform !== 'win32') return
  const system = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32')
  const user = koffi.load(path.join(system, 'user32.dll'))
  const kernel = koffi.load(path.join(system, 'kernel32.dll'))
  const currentProcess = kernel.func('intptr_t __stdcall GetCurrentProcess()')
  const processContext = user.func('intptr_t __stdcall GetDpiAwarenessContextForProcess(intptr_t process)')
  const threadContext = user.func('intptr_t __stdcall GetThreadDpiAwarenessContext()')
  const equal = user.func('int __stdcall AreDpiAwarenessContextsEqual(intptr_t first, intptr_t second)')
  const set = user.func('int __stdcall SetProcessDpiAwarenessContext(intptr_t context)')
  const pmv2 = -4
  if (!equal(processContext(currentProcess()), pmv2)) set(pmv2)
  if (!equal(processContext(currentProcess()), pmv2) || !equal(threadContext(), pmv2))
    throw new DesktopError('Cua 独立工作进程无法建立物理像素 DPI 上下文，已阻止桌面操作；请重新启动桌面服务', 'CUA_DPI_CONTEXT_UNAVAILABLE')
}
