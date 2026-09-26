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
  [DllImport("user32.dll")] public static extern bool EnumDisplaySettings(string name, int mode, ref DEVMODE devMode);
  [DllImport("user32.dll")] public static extern int ChangeDisplaySettings(ref DEVMODE devMode, int flags);
  public static DEVMODE Current() { var m = new DEVMODE(); m.dmSize = (short)Marshal.SizeOf(m); EnumDisplaySettings(null, -1, ref m); return m; }
}
'@
`

function powershell(script: string): string {
  return execFileSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 }
  ).trim()
}

export interface DisplayMode {
  readonly width: number
  readonly height: number
}

export function currentMode(): DisplayMode {
  const [width, height] = powershell(
    `${NATIVE}; $m = [JupiterTestDisplay]::Current(); "$($m.dmPelsWidth)x$($m.dmPelsHeight)"`
  )
    .split('x')
    .map(Number)
  return { width: width ?? 0, height: height ?? 0 }
}

export function availableModes(): DisplayMode[] {
  const out = powershell(`${NATIVE}
$m = New-Object JupiterTestDisplay+DEVMODE; $m.dmSize = [int16][Runtime.InteropServices.Marshal]::SizeOf($m)
$i = 0; $seen = @{}
while ([JupiterTestDisplay]::EnumDisplaySettings($null, $i, [ref]$m)) { $seen["$($m.dmPelsWidth)x$($m.dmPelsHeight)"] = 1; $i++ }
$seen.Keys -join ','`)
  return out
    .split(',')
    .filter(Boolean)
    .map((item) => {
      const [width, height] = item.split('x').map(Number)
      return { width: width ?? 0, height: height ?? 0 }
    })
}

/** Returns ChangeDisplaySettings' result: 0 means the new resolution is in effect. */
export function setMode(mode: DisplayMode): number {
  return Number(
    powershell(`${NATIVE}
$m = [JupiterTestDisplay]::Current(); $m.dmPelsWidth = ${String(mode.width)}; $m.dmPelsHeight = ${String(mode.height)}; $m.dmFields = 0x180000
[JupiterTestDisplay]::ChangeDisplaySettings([ref]$m, 0)`)
  )
}
