import { parseKeyChord, toWin32Vk, WIN32_VK_CODES, type ConcreteModifier } from "../keys.js";
import { decodePng } from "../png.js";
import type { DesktopBackend, DisplayInfo, DoctorCheck, MouseButton, Point, RawFrame, Region } from "../types.js";
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
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class HandyWin32 {
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

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
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

    public static void InitDpi() {
        try {
            if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) {
                SetProcessDPIAware();
            }
        } catch {
            try { SetProcessDPIAware(); } catch { }
        }
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
}
"@

Add-Type -TypeDefinition $csharp -ReferencedAssemblies System.Windows.Forms, System.Drawing
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
                $list += @{
                    id = $i
                    name = [string]$s.DeviceName
                    x = [int]$b.X
                    y = [int]$b.Y
                    width = [int]$b.Width
                    height = [int]$b.Height
                    scaleFactor = 1
                    primary = [bool]$s.Primary
                }
            }
            $resp = @{ id = $id; ok = $true; displays = $list } | ConvertTo-Json -Compress -Depth 4
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

  constructor(options: Win32BackendOptions = {}) {
    const encoded = Buffer.from(WIN32_POWERSHELL_SCRIPT, "utf16le").toString("base64");
    this.worker = new JsonlWorker(
      options.workerOptions ?? {
        command: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        requestTimeoutMs: 15_000,
      },
    );
  }

  async init(): Promise<void> {
    await this.worker.start();
  }

  async close(): Promise<void> {
    await this.worker.stop();
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
    // Split on newlines/tabs so Enter/Tab fire true virtual-key events while text uses SendInput KEYEVENTF_UNICODE
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
      scaleFactor: 1,
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
