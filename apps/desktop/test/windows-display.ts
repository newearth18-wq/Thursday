import { execFileSync } from 'node:child_process'

/**
 * TEST-ONLY helper for SET 8 AT8 on Windows: reads the display modes of the
 * primary screen and changes its resolution with ChangeDisplaySettings, so a
 * test can check that semantic interaction survives a resolution change.
 * Jupiter itself never changes display settings.
 */

const NATIVE = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class JupiterTestDisplay {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra;
    public int dmFields; public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation;
    public int dmDisplayFixedOutput; public short dmColor; public short dmDuplex; public short dmYResolution;
    public short dmTTOption; public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
    public int dmDisplayFlags; public int dmDisplayFrequency; public int dmICMMethod; public int dmICMIntent;
    public int dmMediaType; public int dmDitherType; public int dmReserved1; public int dmReserved2;
    public int dmPanningWidth; public int dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] static extern bool EnumDisplaySettings(string name, int mode, ref DEVMODE devMode);
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] static extern int ChangeDisplaySettings(ref DEVMODE devMode, int flags);
  static DEVMODE Fresh() { var m = new DEVMODE(); m.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE)); return m; }
  public static string Current() { var m = Fresh(); EnumDisplaySettings(null, -1, ref m); return m.dmPelsWidth + "x" + m.dmPelsHeight; }
  public static string Modes() {
    var seen = new List<string>();
    var m = Fresh();
    for (int i = 0; EnumDisplaySettings(null, i, ref m); i++) {
      var key = m.dmPelsWidth + "x" + m.dmPelsHeight;
      if (!seen.Contains(key)) seen.Add(key);
      m = Fresh();
    }
    return String.Join(",", seen.ToArray());
  }
  public static int Set(int width, int height) {
    var m = Fresh(); EnumDisplaySettings(null, -1, ref m);
    m.dmPelsWidth = width; m.dmPelsHeight = height; m.dmFields = 0x80000 | 0x100000;
    return ChangeDisplaySettings(ref m, 0);
  }
}
'@
`

function powershell(script: string): string {
  return execFileSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `${NATIVE}\n${script}`
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 }
  ).trim()
}

export interface DisplayMode {
  readonly width: number
  readonly height: number
}

function parse(text: string): DisplayMode {
  const [width, height] = text.trim().split('x').map(Number)
  return { width: width ?? 0, height: height ?? 0 }
}

export function currentMode(): DisplayMode {
  return parse(powershell('[JupiterTestDisplay]::Current()'))
}

export function availableModes(): DisplayMode[] {
  return powershell('[JupiterTestDisplay]::Modes()').split(',').filter(Boolean).map(parse)
}

/** ChangeDisplaySettings' result: 0 means the new resolution is in effect. */
export function setMode(mode: DisplayMode): number {
  return Number(
    powershell(`[JupiterTestDisplay]::Set(${String(mode.width)}, ${String(mode.height)})`)
  )
}

/** Common resolutions to try when the driver lists only the current one. */
export const COMMON_MODES: readonly DisplayMode[] = [
  { width: 1280, height: 1024 },
  { width: 1280, height: 800 },
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
  { width: 800, height: 600 }
]
