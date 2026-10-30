using System;
using System.IO;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Diagnostics;

// Private GUI fixture: independent app-owned state is the native-test oracle.
class PassiveForm : Form { protected override bool ShowWithoutActivation { get { return true; } } }
class DesktopFixture {
    [DllImport("user32.dll")] static extern int GetScrollPos(IntPtr window, int bar);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect value, int size);
    static object Frame(Form form) {
        Rect r; if(DwmGetWindowAttribute(form.Handle,9,out r,Marshal.SizeOf(typeof(Rect))) != 0)
            throw new Exception("Fixture could not read DWM visible bounds");
        return new { x=r.left, y=r.top, width=r.right-r.left, height=r.bottom-r.top };
    }
    static string directory;
    static readonly JavaScriptSerializer json = new JavaScriptSerializer();
    static readonly Dictionary<string, object> state = new Dictionary<string, object>();
    static Form first, second;
    static void Save() {
        if(first != null && second != null) state["windows"] = new { first=first.Visible, second=second.Visible,
            firstHandle=first.Handle.ToInt64().ToString(), secondHandle=second.Handle.ToInt64().ToString() };
        string target=Path.Combine(directory,"state.json"), temporary=Path.Combine(directory,"state.tmp");
        File.WriteAllText(temporary,json.Serialize(state));
        if(File.Exists(target)) File.Replace(temporary,target,null); else File.Move(temporary,target);
    }
    static Form Window(string key, string prefix, int x) {
        Form form = new PassiveForm { Text=prefix+" "+key, Width=500, Height=420, Left=x, Top=120,
            StartPosition=FormStartPosition.Manual };
        TextBox input = new TextBox { Name="EdenInput", AccessibleName="EdenInput", Multiline=true,
            Left=20, Top=20, Width=430, Height=160, ScrollBars=ScrollBars.Vertical };
        Button button = new Button { Name="EdenApply", AccessibleName="EdenApply", Text="Apply",
            Left=20, Top=195, Width=120, Height=35 };
        Label result = new Label { Text="Waiting", Left=20, Top=245, Width=430, Height=45 };
        CheckBox toggle = new CheckBox { Text="Enable", AccessibleName="EdenToggle", Left=180, Top=200 };
        state[key] = new { text="", applied="", enabled=false, clicks=0, drag=false };
        string applied="", dropped=""; int clicks=0; bool dragging=false;
        var transfer = new Label { Text=key=="A" ? "Drag to B" : "Drop here", AccessibleName="EdenTransfer", BorderStyle=BorderStyle.FixedSingle,
            Left=20, Top=310, Width=180, Height=40, AllowDrop=true };
        transfer.MouseDown += (s,e) => { if(key=="A" && e.Button==MouseButtons.Left) transfer.DoDragDrop("Eden cross-window proof",DragDropEffects.Copy); };
        transfer.DragEnter += (s,e) => { if(e.Data.GetDataPresent(DataFormats.Text)) e.Effect=DragDropEffects.Copy; };
        transfer.DragDrop += (s,e) => { dropped=(string)e.Data.GetData(DataFormats.Text); transfer.Text=dropped; };
        Action save = () => { state[key]=new { text=input.Text, applied=applied, enabled=toggle.Checked, clicks=clicks, drag=dragging,
            selection=input.SelectionStart, selectionLength=input.SelectionLength, dropped=dropped,
            scroll=GetScrollPos(input.Handle,1), windowState=form.WindowState.ToString(), width=form.Width, height=form.Height,
            visibleBounds=Frame(form) }; Save(); };
        button.Click += (s,e) => {
            applied=input.Text; clicks++; result.Text="Applied: "+applied;
            if(applied == "Eden model contract") { input.Text=""; form.Text=prefix+" updated "+key; button.AccessibleName="EdenApplied"; }
        };
        input.MouseMove += (s,e) => { if(e.Button == MouseButtons.Left) dragging=true; };
        var pulse = new Timer { Interval=100 };
        pulse.Tick += (s,e) => save(); form.Shown += (s,e) => pulse.Start();
        form.FormClosed += (s,e) => pulse.Dispose();
        form.Controls.Add(input); form.Controls.Add(button); form.Controls.Add(result); form.Controls.Add(toggle); form.Controls.Add(transfer);
        return form;
    }
    [STAThread] static void Main(string[] args) {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        directory=args[0]; Directory.CreateDirectory(directory);
        state["processId"]=Process.GetCurrentProcess().Id;
        Application.EnableVisualStyles();
        if(args.Length > 2) {
            first=Window("B",args[1],650);
            first.Shown += (s,e) => {
                var ready = new Timer { Interval=500 };
                ready.Tick += (s2,e2) => { ready.Stop(); Save(); File.WriteAllText(Path.Combine(directory,"ready"),"ready"); ready.Dispose(); };
                ready.Start();
            };
            Application.Run(first); return;
        }
        first=Window("A", args[1], 80); second=Window("B", args[1], 650);
        first.Shown += (s,e) => {
            second.Show();
            var ready = new Timer { Interval=500 };
            ready.Tick += (s2,e2) => { ready.Stop(); Save(); File.WriteAllText(Path.Combine(directory,"ready"),"ready"); ready.Dispose(); };
            ready.Start();
        };
        first.FormClosed += (s,e) => second.Close();
        Application.Run(first);
    }
}
