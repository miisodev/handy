import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseKeyChord, toWin32Vk, WIN32_VK_CODES, type ConcreteModifier } from "../keys.js";
import { decodePng } from "../png.js";
import type {
  DesktopBackend,
  DisplayInfo,
  DoctorCheck,
  MouseButton,
  Point,
  RawFrame,
  Region,
  WindowInfo,
} from "../types.js";
import { JsonlWorker, type JsonlWorkerOptions } from "./jsonl-worker.js";

/**
 * Persistent PowerShell + C# P/Invoke worker compatible with both Windows PowerShell 5.1 (.NET 4.x)
 * and PowerShell 7+ on x64 and ARM64 Windows 10/11 PCs.
 */
export const WIN32_POWERSHELL_SCRIPT = `
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$csharp = @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class HandyWin32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiFlag);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);

    [DllImport("shcore.dll")]
    private static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool OpenClipboard(IntPtr hWndNewOwner);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EmptyClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetClipboardData(uint uFormat);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalLock(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalUnlock(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalFree(IntPtr hMem);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    public class WinItem {
        public long id;
        public string title;
        public string app;
        public int pid;
        public int x;
        public int y;
        public int width;
        public int height;
        public bool focused;
    }

    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;

    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint MOUSEEVENTF_HWHEEL = 0x01000;
    public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;

    private const uint CF_UNICODETEXT = 13;
    private const uint GMEM_MOVEABLE = 0x0002;

    public static void InitDpi() {
        try {
            if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) {
                SetProcessDPIAware();
            }
        } catch {
            try { SetProcessDPIAware(); } catch { }
        }
    }

    public static double GetMonitorScale(int centerX, int centerY) {
        try {
            POINT pt = new POINT();
            pt.X = centerX;
            pt.Y = centerY;
            IntPtr hMon = MonitorFromPoint(pt, 2);
            if (hMon != IntPtr.Zero) {
                uint dpiX = 96;
                uint dpiY = 96;
                if (GetDpiForMonitor(hMon, 0, out dpiX, out dpiY) == 0 && dpiX > 0) {
                    return Math.Round((double)dpiX / 96.0, 2);
                }
            }
        } catch { }
        return 1.0;
    }

    public static void MoveMouseAbs(int x, int y) {
        SetCursorPos(x, y);
        Rectangle vs = SystemInformation.VirtualScreen;
        int vw = Math.Max(1, vs.Width - 1);
        int vh = Math.Max(1, vs.Height - 1);
        int normX = (int)Math.Round(((x - vs.Left) * 65535.0) / vw);
        int normY = (int)Math.Round(((y - vs.Top) * 65535.0) / vh);
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].U.mi.dx = normX;
        inputs[0].U.mi.dy = normY;
        inputs[0].U.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void MouseButton(uint flag) {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].U.mi.dwFlags = flag;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void ScrollWheel(int dx, int dy) {
        if (dy != 0) {
            INPUT[] v = new INPUT[1];
            v[0].type = INPUT_MOUSE;
            v[0].U.mi.dwFlags = MOUSEEVENTF_WHEEL;
            v[0].U.mi.mouseData = unchecked((uint)(-dy * 120));
            SendInput(1, v, Marshal.SizeOf(typeof(INPUT)));
        }
        if (dx != 0) {
            INPUT[] h = new INPUT[1];
            h[0].type = INPUT_MOUSE;
            h[0].U.mi.dwFlags = MOUSEEVENTF_HWHEEL;
            h[0].U.mi.mouseData = unchecked((uint)(dx * 120));
            SendInput(1, h, Marshal.SizeOf(typeof(INPUT)));
        }
    }

    public static void SendVk(ushort vk, bool down) {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].U.ki.wVk = vk;
        inputs[0].U.ki.dwFlags = down ? 0u : KEYEVENTF_KEYUP;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void SendUnicodeString(string text) {
        if (string.IsNullOrEmpty(text)) return;
        INPUT[] inputs = new INPUT[text.Length * 2];
        for (int i = 0; i < text.Length; i++) {
            ushort codeUnit = (ushort)text[i];
            inputs[i * 2].type = INPUT_KEYBOARD;
            inputs[i * 2].U.ki.wScan = codeUnit;
            inputs[i * 2].U.ki.dwFlags = KEYEVENTF_UNICODE;

            inputs[i * 2 + 1].type = INPUT_KEYBOARD;
            inputs[i * 2 + 1].U.ki.wScan = codeUnit;
            inputs[i * 2 + 1].U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        }
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static string CapturePngBase64(int x, int y, int width, int height) {
        using (Bitmap bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
            using (Graphics g = Graphics.FromImage(bmp)) {
                g.CopyFromScreen(x, y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
            }
            using (MemoryStream ms = new MemoryStream()) {
                bmp.Save(ms, ImageFormat.Png);
                return Convert.ToBase64String(ms.ToArray());
            }
        }
    }

    public static WinItem[] ListVisibleWindows() {
        IntPtr fg = GetForegroundWindow();
        List<WinItem> results = new List<WinItem>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            int len = GetWindowTextLength(hWnd);
            if (len <= 0) return true;
            StringBuilder sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            string title = sb.ToString().Trim();
            if (title.Length == 0) return true;
            RECT r;
            if (!GetWindowRect(hWnd, out r)) return true;
            int w = r.Right - r.Left;
            int h = r.Bottom - r.Top;
            if (w <= 0 || h <= 0) return true;
            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            string appName = "";
            if (pid > 0) {
                try { appName = Process.GetProcessById((int)pid).ProcessName; } catch { }
            }
            WinItem item = new WinItem();
            item.id = hWnd.ToInt64();
            item.title = title;
            item.app = appName;
            item.pid = (int)pid;
            item.x = r.Left;
            item.y = r.Top;
            item.width = w;
            item.height = h;
            item.focused = (hWnd == fg);
            results.Add(item);
            return true;
        }, IntPtr.Zero);
        return results.ToArray();
    }

    public static bool FocusWindowById(long hwndVal) {
        IntPtr hWnd = new IntPtr(hwndVal);
        if (IsIconic(hWnd)) {
            ShowWindow(hWnd, 9);
        }
        return SetForegroundWindow(hWnd);
    }

    private static bool TryOpenClipboard() {
        for (int i = 0; i < 6; i++) {
            if (OpenClipboard(IntPtr.Zero)) return true;
            Thread.Sleep(15);
        }
        return false;
    }

    public static string ReadClipboardUnicode() {
        if (!TryOpenClipboard()) return "";
        try {
            IntPtr hData = GetClipboardData(CF_UNICODETEXT);
            if (hData == IntPtr.Zero) return "";
            IntPtr ptr = GlobalLock(hData);
            if (ptr == IntPtr.Zero) return "";
            try {
                return Marshal.PtrToStringUni(ptr) ?? "";
            } finally {
                GlobalUnlock(hData);
            }
        } finally {
            CloseClipboard();
        }
    }

    public static void WriteClipboardUnicode(string text) {
        string safe = text ?? "";
        if (!TryOpenClipboard()) {
            throw new InvalidOperationException("Unable to open Win32 clipboard.");
        }
        try {
            EmptyClipboard();
            int byteLen = (safe.Length + 1) * 2;
            IntPtr hGlobal = GlobalAlloc(GMEM_MOVEABLE, new UIntPtr((uint)byteLen));
            if (hGlobal == IntPtr.Zero) {
                throw new InvalidOperationException("GlobalAlloc failed for clipboard.");
            }
            IntPtr target = GlobalLock(hGlobal);
            if (target == IntPtr.Zero) {
                GlobalFree(hGlobal);
                throw new InvalidOperationException("GlobalLock failed for clipboard.");
            }
            try {
                Marshal.Copy(safe.ToCharArray(), 0, target, safe.Length);
                Marshal.WriteInt16(target, safe.Length * 2, 0);
            } finally {
                GlobalUnlock(hGlobal);
            }
            if (SetClipboardData(CF_UNICODETEXT, hGlobal) == IntPtr.Zero) {
                GlobalFree(hGlobal);
                throw new InvalidOperationException("SetClipboardData failed.");
            }
        } finally {
            CloseClipboard();
        }
    }
}
"@

Add-Type -TypeDefinition $csharp -ReferencedAssemblies System, System.Windows.Forms, System.Drawing
[HandyWin32]::InitDpi()

while (($line = [Console]::In.ReadLine()) -ne $null) {
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0) { continue }
    $id = -1
    try {
        $cmd = $trimmed | ConvertFrom-Json
        $id = [int]$cmd.id
        $op = [string]$cmd.op
        if ($op -eq "doctor") {
            $resp = @{ id = $id; ok = $true; dpiAware = $true } | ConvertTo-Json -Compress
            [Console]::Out.WriteLine($resp)
        }
        elseif ($op -eq "displays") {
            $screens = [System.Windows.Forms.Screen]::AllScreens
            $list = @()
            for ($i = 0; $i -lt $screens.Length; $i++) {
                $s = $screens[$i]
                $b = $s.Bounds
                $cx = [int]($b.X + ($b.Width / 2))
                $cy = [int]($b.Y + ($b.Height / 2))
                $scale = [double]([HandyWin32]::GetMonitorScale($cx, $cy))
                $list += @{
                    id = $i
                    name = [string]$s.DeviceName
                    x = [int]$b.X
                    y = [int]$b.Y
                    width = [int]$b.Width
                    height = [int]$b.Height
                    scaleFactor = $scale
                    primary = [bool]$s.Primary
                }
            }
            $resp = @{ id = $id; ok = $true; displays = $list } | ConvertTo-Json -Compress -Depth 4
            [Console]::Out.WriteLine($resp)
        }
        elseif ($op -eq "windows") {
            $items = [HandyWin32]::ListVisibleWindows()
            $list = @()
            for ($i = 0; $i -lt $items.Length; $i++) {
                $w = $items[$i]
                $list += @{
                    id = [int64]$w.id
                    title = [string]$w.title
                    app = [string]$w.app
                    pid = [int]$w.pid
                    bounds = @{
                        x = [int]$w.x
                        y = [int]$w.y
                        width = [int]$w.width
                        height = [int]$w.height
                    }
                    focused = [bool]$w.focused
                }
            }
            $resp = @{ id = $id; ok = $true; windows = $list } | ConvertTo-Json -Compress -Depth 5
            [Console]::Out.WriteLine($resp)
        }
        elseif ($op -eq "focus_window") {
            $okFocus = [HandyWin32]::FocusWindowById([int64]$cmd.hwnd)
            $resp = @{ id = $id; ok = $true; focused = [bool]$okFocus } | ConvertTo-Json -Compress
            [Console]::Out.WriteLine($resp)
        }
        elseif ($op -eq "clipboard_get") {
            $txt = [HandyWin32]::ReadClipboardUnicode()
            $resp = @{ id = $id; ok = $true; text = [string]$txt } | ConvertTo-Json -Compress
            [Console]::Out.WriteLine($resp)
        }
        elseif ($op -eq "clipboard_set") {
            [HandyWin32]::WriteClipboardUnicode([string]$cmd.text)
            $resp = @{ id = $id; ok = $true } | ConvertTo-Json -Compress
            [Console]::Out.WriteLine($resp)
        }
        elseif ($op -eq "mouse_pos") {
            $pt = New-Object HandyWin32+POINT
            [void][HandyWin32]::GetCursorPos([ref]$pt)
            $resp = @{ id = $id; ok = $true; x = [int]$pt.X; y = [int]$pt.Y } | ConvertTo-Json -Compress
            [Console]::Out.WriteLine($resp)
        }
        elseif ($op -eq "move") {
            [HandyWin32]::MoveMouseAbs([int]$cmd.x, [int]$cmd.y)
            $resp = @{ id = $id; ok = $true } | ConvertTo-Json -Compress
            [Console]::Out.WriteLine($resp)
        }
        elseif ($op -eq "mouse_btn") {
            [HandyWin32]::MouseButton([uint32]$cmd.flag)
            $resp = @{ id = $id; ok = $true } | ConvertTo-Json -Compress
            [Console]::Out.WriteLine($resp)
        }
        elseif ($op -eq "scroll") {
            [HandyWin32]::ScrollWheel([int]$cmd.dx, [int]$cmd.dy)
            $resp = @{ id = $id; ok = $true } | ConvertTo-Json -Compress
            [Console]::Out.WriteLine($resp)
        }
        elseif ($op -eq "vk") {
            [HandyWin32]::SendVk([uint16]$cmd.vk, [bool]$cmd.down)
            $resp = @{ id = $id; ok = $true } | ConvertTo-Json -Compress
            [Console]::Out.WriteLine($resp)
        }
        elseif ($op -eq "unicode") {
            [HandyWin32]::SendUnicodeString([string]$cmd.text)
            $resp = @{ id = $id; ok = $true } | ConvertTo-Json -Compress
            [Console]::Out.WriteLine($resp)
        }
        elseif ($op -eq "capture") {
            $b64 = [HandyWin32]::CapturePngBase64([int]$cmd.x, [int]$cmd.y, [int]$cmd.width, [int]$cmd.height)
            $resp = @{ id = $id; ok = $true; pngBase64 = $b64 } | ConvertTo-Json -Compress
            [Console]::Out.WriteLine($resp)
        }
        else {
            $resp = @{ id = $id; ok = $false; error = "Unknown op: $op" } | ConvertTo-Json -Compress
            [Console]::Out.WriteLine($resp)
        }
    } catch {
        $errMsg = $_.Exception.Message
        $resp = @{ id = $id; ok = $false; error = [string]$errMsg } | ConvertTo-Json -Compress
        [Console]::Out.WriteLine($resp)
    }
}
`;

export interface Win32BackendOptions {
  workerOptions?: JsonlWorkerOptions;
}

export class Win32Backend implements DesktopBackend {
  readonly name = "win32-sendinput";
  readonly platform = "win32" as const;

  private readonly worker: JsonlWorker;
  private tempDir: string | null = null;

  constructor(options: Win32BackendOptions = {}) {
    if (options.workerOptions) {
      this.worker = new JsonlWorker(options.workerOptions);
    } else {
      // Write script to a temp .ps1 (with UTF-8 BOM for PowerShell 5.1) so we never hit
      // Win32 CreateProcessW's 32,767-character command-line limit on -EncodedCommand
      const dir = mkdtempSync(join(tmpdir(), "handy-win32-"));
      const scriptPath = join(dir, "worker.ps1");
      writeFileSync(scriptPath, `\uFEFF${WIN32_POWERSHELL_SCRIPT}`, "utf8");
      this.tempDir = dir;
      this.worker = new JsonlWorker({
        command: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        requestTimeoutMs: 15_000,
      });
    }
  }

  async init(): Promise<void> {
    await this.worker.start();
  }

  async close(): Promise<void> {
    await this.worker.stop();
    if (this.tempDir) {
      try {
        rmSync(this.tempDir, { recursive: true, force: true });
      } catch {
        // ignore temp cleanup errors
      }
      this.tempDir = null;
    }
  }

  async getDisplays(): Promise<DisplayInfo[]> {
    const res = await this.worker.request({ op: "displays" });
    const raw = res.displays;
    const list = Array.isArray(raw) ? (raw as DisplayInfo[]) : raw ? [raw as DisplayInfo] : [];
    if (list.length > 0) return list;
    return [
      {
        id: 0,
        name: "Windows Primary Display",
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        scaleFactor: 1,
        primary: true,
      },
    ];
  }

  async listWindows(): Promise<WindowInfo[]> {
    const res = await this.worker.request({ op: "windows" });
    const raw = res.windows;
    const list = Array.isArray(raw) ? (raw as WindowInfo[]) : raw ? [raw as WindowInfo] : [];
    return list.map((w) => ({
      ...w,
      app: w.app || undefined,
      pid: w.pid || undefined,
    }));
  }

  async getActiveWindow(): Promise<WindowInfo | null> {
    const wins = await this.listWindows();
    return wins.find((w) => w.focused) ?? wins[0] ?? null;
  }

  async focusWindow(query: { title?: string; app?: string; id?: string | number }): Promise<boolean> {
    const wins = await this.listWindows();
    const titleNeedle = query.title?.toLowerCase();
    const appNeedle = query.app?.toLowerCase();
    const match = wins.find((w) => {
      if (query.id !== undefined && String(w.id) === String(query.id)) return true;
      if (titleNeedle && w.title.toLowerCase().includes(titleNeedle)) return true;
      if (appNeedle && (w.app ?? "").toLowerCase().includes(appNeedle)) return true;
      return false;
    });
    if (!match) return false;
    const res = await this.worker.request({ op: "focus_window", hwnd: Number(match.id) });
    return Boolean(res.focused);
  }

  async getClipboardText(): Promise<string> {
    const res = await this.worker.request({ op: "clipboard_get" });
    return typeof res.text === "string" ? res.text : "";
  }

  async setClipboardText(text: string): Promise<void> {
    await this.worker.request({ op: "clipboard_set", text });
  }

  async getMousePosition(): Promise<Point> {
    const res = await this.worker.request({ op: "mouse_pos" });
    return { x: Number(res.x ?? 0), y: Number(res.y ?? 0) };
  }

  async moveMouse(x: number, y: number): Promise<void> {
    await this.worker.request({ op: "move", x: Math.round(x), y: Math.round(y) });
  }

  async mouseDown(button: MouseButton): Promise<void> {
    const flag = button === "left" ? 0x0002 : button === "right" ? 0x0008 : 0x0020;
    await this.worker.request({ op: "mouse_btn", flag });
  }

  async mouseUp(button: MouseButton): Promise<void> {
    const flag = button === "left" ? 0x0004 : button === "right" ? 0x0010 : 0x0040;
    await this.worker.request({ op: "mouse_btn", flag });
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    await this.worker.request({ op: "scroll", dx: Math.round(deltaX), dy: Math.round(deltaY) });
  }

  async keyDown(key: string): Promise<void> {
    const parsed = parseKeyChord(key, [], "win32");
    const mapped = toWin32Vk(parsed.key);
    if (!mapped) {
      throw new Error(`Unsupported Windows keyDown key "${key}".`);
    }
    if (mapped.shift) {
      await this.worker.request({ op: "vk", vk: WIN32_VK_CODES.shift!.vk, down: true });
    }
    await this.worker.request({ op: "vk", vk: mapped.vk, down: true });
  }

  async keyUp(key: string): Promise<void> {
    const parsed = parseKeyChord(key, [], "win32");
    const mapped = toWin32Vk(parsed.key);
    if (!mapped) {
      throw new Error(`Unsupported Windows keyUp key "${key}".`);
    }
    await this.worker.request({ op: "vk", vk: mapped.vk, down: false });
    if (mapped.shift) {
      await this.worker.request({ op: "vk", vk: WIN32_VK_CODES.shift!.vk, down: false });
    }
  }

  async keyTap(key: string, modifiers: ConcreteModifier[] = []): Promise<void> {
    const mapped = toWin32Vk(key);
    if (!mapped) {
      if (modifiers.length === 0) {
        await this.typeText(key);
        return;
      }
      throw new Error(`Unsupported Windows key "${key}".`);
    }

    const activeMods = [...modifiers];
    if (mapped.shift && !activeMods.includes("shift")) {
      activeMods.push("shift");
    }

    for (const m of activeMods) {
      await this.worker.request({ op: "vk", vk: WIN32_VK_CODES[m]!.vk, down: true });
    }
    await this.worker.request({ op: "vk", vk: mapped.vk, down: true });
    await this.worker.request({ op: "vk", vk: mapped.vk, down: false });
    for (const m of [...activeMods].reverse()) {
      await this.worker.request({ op: "vk", vk: WIN32_VK_CODES[m]!.vk, down: false });
    }
  }

  async typeText(text: string): Promise<void> {
    let chunk = "";
    const flush = async () => {
      if (chunk.length > 0) {
        await this.worker.request({ op: "unicode", text: chunk });
        chunk = "";
      }
    };

    for (const ch of text) {
      if (ch === "\r") continue;
      if (ch === "\n") {
        await flush();
        await this.keyTap("enter");
      } else if (ch === "\t") {
        await flush();
        await this.keyTap("tab");
      } else {
        chunk += ch;
      }
    }
    await flush();
  }

  async captureScreen(options: { display?: number; region?: Region } = {}): Promise<RawFrame> {
    const displays = await this.getDisplays();
    const disp = displays.find((d) => d.id === (options.display ?? 0)) ?? displays[0]!;

    const rx = options.region ? Math.round(options.region.x) : disp.x;
    const ry = options.region ? Math.round(options.region.y) : disp.y;
    const rw = options.region ? Math.max(1, Math.round(options.region.width)) : disp.width;
    const rh = options.region ? Math.max(1, Math.round(options.region.height)) : disp.height;

    const res = await this.worker.request({ op: "capture", x: rx, y: ry, width: rw, height: rh }, 15_000);
    const pngBase64 = String(res.pngBase64 ?? "");
    if (!pngBase64) {
      throw new Error("Windows screen capture returned empty PNG buffer.");
    }
    const decoded = decodePng(Buffer.from(pngBase64, "base64"));

    return {
      width: decoded.width,
      height: decoded.height,
      data: decoded.data,
      originX: rx,
      originY: ry,
      logicalWidth: decoded.width,
      logicalHeight: decoded.height,
      scaleFactor: disp.scaleFactor || 1,
      displayId: disp.id,
    };
  }

  async doctor(): Promise<DoctorCheck[]> {
    try {
      await this.worker.request({ op: "doctor" });
      const displays = await this.getDisplays();
      return [
        {
          name: "Win32 SendInput + GDI Bridge",
          ok: true,
          detail: `Ready (${displays.length} display${displays.length === 1 ? "" : "s"} detected, Per-Monitor V2 DPI aware)`,
        },
      ];
    } catch (err) {
      return [
        {
          name: "Win32 SendInput + GDI Bridge",
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        },
      ];
    }
  }
}
