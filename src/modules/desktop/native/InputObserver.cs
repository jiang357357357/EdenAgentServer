using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Collections.Generic;
using System.Text;

// Emits physical-input notifications and validates native window identities.
// It never records keys or text and never synthesizes keyboard/mouse input.
class InputObserver {
    delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
    delegate bool EnumWindow(IntPtr window, IntPtr data);
    static readonly Hook mouse = Mouse;
    static readonly Hook keyboard = Keyboard;
    static readonly JavaScriptSerializer json = new JavaScriptSerializer();
    static readonly object output = new object();
    static IntPtr mouseHook, keyboardHook;
    static int lastMove;
    static RawMouseWindow rawMouse;
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct MouseData { public Point point; public uint mouseData, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KeyData { public uint key, scan, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int size; public Rect monitor, work; public uint flags; }
    [StructLayout(LayoutKind.Sequential)] struct RawDevice { public ushort page, usage; public uint flags; public IntPtr target; }
    [StructLayout(LayoutKind.Sequential)] struct RawHeader { public uint type, size; public IntPtr device, parameter; }
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetWindowsHookEx(int id, Hook fn, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect value, int size);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr data);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect bounds);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll", SetLastError=true)] static extern bool RegisterRawInputDevices(RawDevice[] devices, uint count, uint size);
    [DllImport("user32.dll")] static extern uint GetRawInputData(IntPtr input, uint command, IntPtr data, ref uint size, uint headerSize);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("kernel32.dll", CharSet=CharSet.Auto)] static extern IntPtr GetModuleHandle(string name);

    static void Emit(object value) { lock(output) { Console.WriteLine(json.Serialize(value)); Console.Out.Flush(); } }
    static IntPtr Mouse(int code, IntPtr message, IntPtr data) {
        if(code >= 0) {
            MouseData record = (MouseData)Marshal.PtrToStructure(data, typeof(MouseData));
            // SetCursorPos can produce non-injected low-level move events.
            // Physical movement is classified only from Raw Input device records.
            if((record.flags & 1) == 0 && message.ToInt32() != 0x200)
                Emit(new { type="input", windowId=GetAncestor(WindowFromPoint(record.point),2).ToInt64().ToString() });
        }
        return CallNextHookEx(mouseHook, code, message, data);
    }
    class RawMouseWindow : NativeWindow {
        public bool Initialize() {
            CreateHandle(new CreateParams { Caption="EdenDesktopInputObserver", Parent=new IntPtr(-3) });
            return RegisterRawInputDevices(new[] { new RawDevice { page=1, usage=2, flags=0x100, target=Handle } },
                1, (uint)Marshal.SizeOf(typeof(RawDevice)));
        }
        protected override void WndProc(ref Message message) {
            if(message.Msg == 0xFF) Observe(message.LParam);
            base.WndProc(ref message);
        }
        static void Observe(IntPtr input) {
            uint size=0, header=(uint)Marshal.SizeOf(typeof(RawHeader));
            if(GetRawInputData(input,0x10000003,IntPtr.Zero,ref size,header) != 0 || size < header+24 || size > 4096) return;
            IntPtr buffer=Marshal.AllocHGlobal((int)size);
            try {
                if(GetRawInputData(input,0x10000003,buffer,ref size,header) != size) return;
                var raw=(RawHeader)Marshal.PtrToStructure(buffer,typeof(RawHeader));
                if(raw.type != 0 || raw.device == IntPtr.Zero) return;
                int x=Marshal.ReadInt32(buffer,(int)header+12), y=Marshal.ReadInt32(buffer,(int)header+16);
                if(x == 0 && y == 0) return;
                int now=Environment.TickCount;
                if(unchecked((uint)(now-lastMove)) < 100) return;
                lastMove=now; Point point;
                if(GetCursorPos(out point)) Emit(new { type="input", windowId=GetAncestor(WindowFromPoint(point),2).ToInt64().ToString() });
            } finally { Marshal.FreeHGlobal(buffer); }
        }
    }
    static IntPtr Keyboard(int code, IntPtr message, IntPtr data) {
        if(code >= 0 && (message.ToInt32() == 0x100 || message.ToInt32() == 0x104)) {
            KeyData record = (KeyData)Marshal.PtrToStructure(data, typeof(KeyData));
            if((record.flags & 0x10) == 0) {
                bool stop = record.key == 0x7B && GetAsyncKeyState(0x11) < 0 && GetAsyncKeyState(0x12) < 0;
                Emit(new { type = stop ? "stop" : "input", windowId=GetForegroundWindow().ToInt64().ToString() });
            }
        }
        return CallNextHookEx(keyboardHook, code, message, data);
    }
    static object Windows() {
        var windows = new List<object>();
        EnumWindows((window,data) => {
            if(windows.Count >= 512) return false;
            if(!IsWindowVisible(window) && !IsIconic(window)) return true;
            var title=new StringBuilder(1024); GetWindowText(window,title,title.Capacity);
            if(title.Length == 0) return true;
            uint pid; GetWindowThreadProcessId(window, out pid);
            Rect r; if(pid == 0 || !GetWindowRect(window,out r)) return true;
            try {
                using(var process=Process.GetProcessById((int)pid)) windows.Add(new { pid=(int)pid,
                    windowId=window.ToInt64().ToString(), app=process.ProcessName+".exe", title=title.ToString(),
                    bounds=new { x=r.left, y=r.top, width=r.right-r.left, height=r.bottom-r.top }, minimized=IsIconic(window) });
            } catch(ArgumentException) { } catch(System.ComponentModel.Win32Exception) { }
            return true;
        }, IntPtr.Zero);
        return windows;
    }
    static void Requests() {
        bool physical=false;
        try {
            SetThreadDpiAwarenessContext(new IntPtr(-4));
            physical=AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(),new IntPtr(-4));
        } catch(EntryPointNotFoundException) { }
        string line;
        while((line = Console.ReadLine()) != null) {
            string id = "";
            try {
                if(line.Length > 8192) throw new Exception("REQUEST_TOO_LARGE");
                var request = json.Deserialize<Dictionary<string, object>>(line);
                id = (string)request["id"];
                if((string)request["action"] == "list") { Emit(new { type="reply", id=id, result=Windows() }); continue; }
                int pid = Convert.ToInt32(request["pid"]);
                IntPtr window = new IntPtr(long.Parse((string)request["windowId"]));
                uint actual;
                GetWindowThreadProcessId(window, out actual);
                if(!IsWindow(window) || actual != pid) throw new Exception("WINDOW_CLOSED");
                using(var process = Process.GetProcessById(pid)) {
                    string started = process.StartTime.ToUniversalTime().Ticks.ToString();
                    string expected = request.ContainsKey("started") ? (string)request["started"] : null;
                    if(expected != null && expected != started) throw new Exception("WINDOW_REPLACED");
                    string action = (string)request["action"];
                    if(action != "identify" && action != "hit") {
                        int command = action == "minimize" ? 6 : action == "maximize" ? 3 : action == "restore" ? 9 : -1;
                        if(command < 0) throw new Exception("ACTION_UNSUPPORTED");
                        ShowWindowAsync(window, command);
                    }
                    Rect r;
                    if(!GetWindowRect(window, out r)) throw new Exception("WINDOW_UNAVAILABLE");
                    Rect visible;
                    if(DwmGetWindowAttribute(window,9,out visible,Marshal.SizeOf(typeof(Rect))) != 0) visible=r;
                    var monitor=new MonitorInfo { size=Marshal.SizeOf(typeof(MonitorInfo)) };
                    if(!GetMonitorInfo(MonitorFromWindow(window,2),ref monitor)) throw new Exception("MONITOR_UNAVAILABLE");
                    uint dpi=0; try { dpi=GetDpiForWindow(window); } catch(EntryPointNotFoundException) { }
                    bool hit=false;
                    if(action == "hit") {
                        var point=new Point { x=Convert.ToInt32(request["x"]), y=Convert.ToInt32(request["y"]) };
                        hit=GetAncestor(WindowFromPoint(point),2)==window;
                    }
                    Emit(new { type="reply", id=id, result=new { started=started, foreground=GetForegroundWindow()==window,
                        bounds=new { x=r.left, y=r.top, width=r.right-r.left, height=r.bottom-r.top }, hit=hit,
                        visibleBounds=new { x=visible.left, y=visible.top, width=visible.right-visible.left, height=visible.bottom-visible.top },
                        minimized=IsIconic(window), maximized=IsZoomed(window),
                        screen=new { width=GetSystemMetrics(0), height=GetSystemMetrics(1) }, dpi=dpi,
                        coordinateSpace=physical ? "physical_screen_pixels" : "unknown",
                        virtualScreen=new { x=GetSystemMetrics(76), y=GetSystemMetrics(77), width=GetSystemMetrics(78), height=GetSystemMetrics(79) },
                        workArea=new { x=monitor.work.left, y=monitor.work.top, width=monitor.work.right-monitor.work.left, height=monitor.work.bottom-monitor.work.top } } });
                }
            } catch(Exception error) { Emit(new { type="reply", id=id, error=error.Message }); }
        }
        Environment.Exit(0);
    }
    [STAThread] static int Main() {
        Console.OutputEncoding=new UTF8Encoding(false); Console.InputEncoding=new UTF8Encoding(false);
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch(EntryPointNotFoundException) { }
        mouseHook = SetWindowsHookEx(14, mouse, GetModuleHandle(null), 0);
        keyboardHook = SetWindowsHookEx(13, keyboard, GetModuleHandle(null), 0);
        if(mouseHook == IntPtr.Zero || keyboardHook == IntPtr.Zero) {
            Emit(new { type="error", error="INPUT_OBSERVER_UNAVAILABLE" }); return 1;
        }
        rawMouse=new RawMouseWindow();
        if(!rawMouse.Initialize()) { Emit(new { type="error", error="RAW_INPUT_OBSERVER_UNAVAILABLE" }); return 1; }
        Emit(new { type="ready" });
        var reader = new Thread(Requests); reader.IsBackground=true; reader.Start();
        try { Application.Run(); } finally { rawMouse.DestroyHandle(); UnhookWindowsHookEx(mouseHook); UnhookWindowsHookEx(keyboardHook); }
        return 0;
    }
}
