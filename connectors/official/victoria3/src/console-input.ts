import { spawn } from 'node:child_process'

export interface ConsoleInput { stem: string; virtualKey: number; focusDelay: number; keyDelay: number; signal: AbortSignal }
/** Windows-specific game integration belongs to this plugin, never the generic host. */
export async function injectConsole(input: ConsoleInput): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Victoria 3 console injection requires Windows')
  if (!/^edenagent_[a-f0-9]{32}$/.test(input.stem)) throw new Error('Invalid generated command stem')
  for (const [value, low, high] of [[input.virtualKey, 1, 255], [input.focusDelay, 100, 2000], [input.keyDelay, 1, 100]]) {
    if (!Number.isInteger(value) || value! < low! || value! > high!) throw new Error('Invalid console input settings')
  }
  const command = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${interop}\n'@; [EdenVictoriaConsole]::Run('${input.stem}',${input.virtualKey},${input.focusDelay},${input.keyDelay})`
  const child = spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { stdio: 'ignore', windowsHide: true, signal: AbortSignal.any([input.signal, AbortSignal.timeout(30000)]) })
  await new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error('Console input process failed')))
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Victoria 3 window focus or console input failed')))
  })
}

const interop = `using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class EdenVictoriaConsole {
  delegate bool EnumCallback(IntPtr window, IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr state);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] input, int size);
  [StructLayout(LayoutKind.Sequential)] struct Keyboard { public ushort key, scan; public uint flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct Mouse { public int x, y; public uint data, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct Payload { [FieldOffset(0)] public Keyboard keyboard; [FieldOffset(0)] public Mouse mouse; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public Payload payload; }
  static IntPtr Find() {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr window, IntPtr unused) {
      if (!IsWindowVisible(window)) return true;
      uint pid; GetWindowThreadProcessId(window, out pid);
      try { using (Process process = Process.GetProcessById((int)pid)) {
        if (String.Equals(System.IO.Path.GetFileName(process.MainModule.FileName), "victoria3.exe", StringComparison.OrdinalIgnoreCase)) { found = window; return false; }
      }} catch (System.ComponentModel.Win32Exception) {} catch (ArgumentException) {} catch (InvalidOperationException) {}
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) throw new Exception("No visible Victoria 3 window");
    return found;
  }
  static void Focus(IntPtr window) {
    if (IsIconic(window)) ShowWindow(window, 9);
    uint unused; uint current = GetCurrentThreadId();
    uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), out unused);
    uint target = GetWindowThreadProcessId(window, out unused);
    bool first = foreground != 0 && foreground != current && AttachThreadInput(current, foreground, true);
    bool second = target != 0 && target != current && target != foreground && AttachThreadInput(current, target, true);
    try { BringWindowToTop(window); SetForegroundWindow(window); }
    finally { if (second) AttachThreadInput(current, target, false); if (first) AttachThreadInput(current, foreground, false); }
  }
  static Input Key(ushort key, ushort scan, uint flags) {
    return new Input { type = 1, payload = new Payload { keyboard = new Keyboard { key = key, scan = scan, flags = flags } } };
  }
  static void Tap(ushort key, ushort scan, uint flags) {
    Input[] input = { Key(key, scan, flags), Key(key, scan, flags | 2) };
    if (SendInput(2, input, Marshal.SizeOf(typeof(Input))) != 2) throw new Exception("Keyboard input failed");
  }
  static void Check(IntPtr window) { if (GetForegroundWindow() != window) throw new Exception("Game lost focus"); }
  public static void Run(string stem, int key, int focusDelay, int keyDelay) {
    IntPtr window = Find(); Focus(window); Thread.Sleep(focusDelay); Check(window);
    Tap((ushort)key, 0, 0); Thread.Sleep(focusDelay);
    foreach (char character in "run " + stem) { Check(window); Tap(0, character, 4); Thread.Sleep(keyDelay); }
    Check(window); Tap(13, 0, 0); Thread.Sleep(focusDelay); Check(window); Tap((ushort)key, 0, 0);
  }
}`
