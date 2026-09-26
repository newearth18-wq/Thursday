# Jupiter agent runtime (SET 8): Windows UI Automation behind a narrow RPC.
#
# Started by the Jupiter host as its own process. Reads one request per line
# from standard input and writes one reply per line to standard output; each
# line is the Base64 of a UTF-8 JSON object, so no console encoding can alter
# text. Request: {"id":n,"op":"...","params":{...}}. Reply:
# {"id":n,"ok":true,"result":{...}} or {"id":n,"ok":false,"error":{"code":"...","message":"..."}}.
#
# It acts only on what the host sends: window handles, element queries, an
# executable the host chose, a file path in a folder the host chose. It keeps
# no state between requests: windows and elements are found again every time.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class JupiterNative {
  public delegate bool EnumProc(IntPtr h, IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr state);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint processId);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, StringBuilder l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, string l);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetFocus();
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  // Gives keyboard focus to a control of another process's window (its window must be in front).
  public static bool FocusControl(IntPtr h) {
    uint processId;
    uint target = GetWindowThreadProcessId(h, out processId);
    uint self = GetCurrentThreadId();
    bool attached = target != self && AttachThreadInput(self, target, true);
    try { SetFocus(h); return GetFocus() == h; }
    finally { if (attached) AttachThreadInput(self, target, false); }
  }
  // Visible top-level windows, straight from the window manager.
  public static long[] TopLevelWindows() {
    var found = new List<long>();
    EnumWindows((h, state) => { if (IsWindowVisible(h)) found.Add(h.ToInt64()); return true; }, IntPtr.Zero);
    return found.ToArray();
  }
  public static string Title(IntPtr h) { var text = new StringBuilder(512); GetWindowText(h, text, text.Capacity); return text.ToString(); }
  public static string ClassOf(IntPtr h) { var text = new StringBuilder(256); GetClassName(h, text, text.Capacity); return text.ToString(); }
  // A standard Win32 edit control's own text (WM_GETTEXTLENGTH, WM_GETTEXT).
  public static string ControlText(IntPtr h) {
    int length = SendMessage(h, 0x000E, IntPtr.Zero, IntPtr.Zero).ToInt32();
    var text = new StringBuilder(length + 1);
    SendMessage(h, 0x000D, new IntPtr(length + 1), text);
    return text.ToString();
  }
  // Sets a standard Win32 edit control's text (WM_SETTEXT); true when the control accepted it.
  public static bool SetControlText(IntPtr h, string value) {
    return SendMessage(h, 0x000C, IntPtr.Zero, value).ToInt32() != 0;
  }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[void][JupiterNative]::SetProcessDPIAware()

# UI Automation describes classic Win32 controls (Edit, Button, ComboBox) through its
# client-side providers. Some Windows editions do not load them by themselves: register them
# explicitly, so a Win32 edit box is an Edit/Document with a Value pattern, not a bare Pane.
try {
  Add-Type -AssemblyName UIAutomationClientsideProviders
  [System.Windows.Automation.ClientSettings]::RegisterClientSideProviderAssembly(
    [UIAutomationClientsideProviders.UIAutomationClientSideProviders].Assembly.GetName())
} catch { }

$Automation = [System.Windows.Automation.AutomationElement]

function Fail([string]$code, [string]$message) {
  throw [System.InvalidOperationException]::new("JUPITER:$code|$message")
}

function To-Bounds($rect) {
  if ($rect.IsEmpty -or [double]::IsInfinity($rect.X) -or [double]::IsNaN($rect.X)) {
    return [ordered]@{ x = 0; y = 0; width = 0; height = 0 }
  }
  return [ordered]@{
    x = [int][Math]::Round($rect.X); y = [int][Math]::Round($rect.Y)
    width = [int][Math]::Round($rect.Width); height = [int][Math]::Round($rect.Height)
  }
}

function Get-WindowElement($handle) {
  $ptr = [IntPtr][long]$handle
  if (-not [JupiterNative]::IsWindow($ptr)) { Fail 'WINDOW_NOT_FOUND' "The window $handle no longer exists." }
  try { return $Automation::FromHandle($ptr) }
  catch { Fail 'WINDOW_NOT_FOUND' "The window $handle cannot be reached: $($_.Exception.Message)" }
}

function Window-Info($element) {
  return Handle-Info ([long]$element.Current.NativeWindowHandle)
}

# A top-level window as the window manager reports it (no UI Automation involved).
function Handle-Info([long]$handle) {
  $ptr = [IntPtr]$handle
  [uint32]$processId = 0
  [void][JupiterNative]::GetWindowThreadProcessId($ptr, [ref]$processId)
  $processName = ''
  try { $processName = (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { }
  $rect = New-Object JupiterNative+RECT
  [void][JupiterNative]::GetWindowRect($ptr, [ref]$rect)
  return [ordered]@{
    handle = $handle
    processId = [int]$processId
    processName = [string]$processName
    title = [JupiterNative]::Title($ptr)
    bounds = [ordered]@{ x = $rect.Left; y = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top }
    active = ([JupiterNative]::GetForegroundWindow() -eq $ptr)
    minimized = [JupiterNative]::IsIconic($ptr)
  }
}

# The native handle of a classic Win32 edit control, or 0.
function Win32-Edit($element) {
  $native = [long]$element.Current.NativeWindowHandle
  if ($native -eq 0) { return 0 }
  if ([JupiterNative]::ClassOf([IntPtr]$native) -ne 'Edit') { return 0 }
  return $native
}

function Element-Info($element) {
  $current = $element.Current
  $patterns = @()
  foreach ($pattern in $element.GetSupportedPatterns()) {
    $patterns += ($pattern.ProgrammaticName -replace 'PatternIdentifiers\.Pattern$', '')
  }
  return [ordered]@{
    automationId = [string]$current.AutomationId
    name = [string]$current.Name
    controlType = ($current.ControlType.ProgrammaticName -replace '^ControlType\.', '')
    className = [string]$current.ClassName
    bounds = To-Bounds $current.BoundingRectangle
    enabled = [bool]$current.IsEnabled
    patterns = @($patterns)
  }
}

function Describe-Query($query) {
  $parts = @()
  foreach ($key in 'automationId', 'name', 'controlType', 'className', 'index') {
    if ($null -ne $query.$key) { $parts += "$key=$($query.$key)" }
  }
  return ($parts -join ', ')
}

function Query-Condition($query) {
  $conditions = @()
  $P = [System.Windows.Automation.AutomationElementIdentifiers]
  if ($null -ne $query.automationId) {
    $conditions += [System.Windows.Automation.PropertyCondition]::new($P::AutomationIdProperty, [string]$query.automationId)
  }
  if ($null -ne $query.name) {
    $conditions += [System.Windows.Automation.PropertyCondition]::new($P::NameProperty, [string]$query.name)
  }
  if ($null -ne $query.controlType) {
    $field = [System.Windows.Automation.ControlType].GetField([string]$query.controlType)
    if ($null -eq $field) { Fail 'INVALID_QUERY' "Unknown control type $($query.controlType)." }
    $conditions += [System.Windows.Automation.PropertyCondition]::new($P::ControlTypeProperty, $field.GetValue($null))
  }
  if ($null -ne $query.className) {
    $conditions += [System.Windows.Automation.PropertyCondition]::new($P::ClassNameProperty, [string]$query.className)
  }
  if ($conditions.Count -eq 0) { Fail 'INVALID_QUERY' 'The query names nothing to look for.' }
  if ($conditions.Count -eq 1) { return $conditions[0] }
  return [System.Windows.Automation.AndCondition]::new([System.Windows.Automation.Condition[]]$conditions)
}

function Find-Element($handle, $query, $waitMs) {
  $window = Get-WindowElement $handle
  $condition = Query-Condition $query
  $index = 0
  if ($null -ne $query.index) { $index = [int]$query.index }
  $deadline = [DateTime]::UtcNow.AddMilliseconds([int]$waitMs)
  do {
    $found = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($found.Count -gt $index) { return $found[$index] }
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $deadline)
  Fail 'ELEMENT_NOT_FOUND' "No control matches ($(Describe-Query $query)) in window $handle."
}

function Get-Pattern($element, $pattern) {
  $value = $null
  if ($element.TryGetCurrentPattern($pattern, [ref]$value)) { return $value }
  return $null
}

function Focus-Window($handle) {
  $ptr = [IntPtr][long]$handle
  if ([JupiterNative]::IsIconic($ptr)) { [void][JupiterNative]::ShowWindow($ptr, 9) }
  if ([JupiterNative]::GetForegroundWindow() -eq $ptr) { return }
  try { (Get-WindowElement $handle).SetFocus() } catch { }
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    if ([JupiterNative]::GetForegroundWindow() -eq $ptr) { return }
    if ($attempt -eq 2) {
      # Windows lets a process take the foreground right after a key event it sent.
      [JupiterNative]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
      [JupiterNative]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    }
    [void][JupiterNative]::BringWindowToTop($ptr)
    [void][JupiterNative]::SetForegroundWindow($ptr)
    Start-Sleep -Milliseconds 100
  }
  if ([JupiterNative]::GetForegroundWindow() -ne $ptr) {
    Fail 'FOCUS_FAILED' "Windows did not bring window $handle to the front."
  }
}

function Escape-SendKeys([string]$text) {
  $builder = [System.Text.StringBuilder]::new()
  foreach ($char in $text.ToCharArray()) {
    switch ($char) {
      "`r" { }
      "`n" { [void]$builder.Append('{ENTER}') }
      "`t" { [void]$builder.Append('{TAB}') }
      default {
        if ('+^%~(){}[]'.IndexOf($char) -ge 0) { [void]$builder.Append('{').Append($char).Append('}') }
        else { [void]$builder.Append($char) }
      }
    }
  }
  return $builder.ToString()
}

$KeyNames = @{
  Enter = '{ENTER}'; Tab = '{TAB}'; Escape = '{ESC}'; Backspace = '{BACKSPACE}'; Delete = '{DELETE}'
  Home = '{HOME}'; End = '{END}'; PageUp = '{PGUP}'; PageDown = '{PGDN}'; Up = '{UP}'; Down = '{DOWN}'
  Left = '{LEFT}'; Right = '{RIGHT}'; Space = ' '
}

function Chord-SendKeys([string]$chord) {
  $prefix = ''
  $parts = $chord.Split('+')
  $key = $parts[$parts.Length - 1]
  for ($i = 0; $i -lt $parts.Length - 1; $i++) {
    switch ($parts[$i]) { 'Ctrl' { $prefix += '^' } 'Shift' { $prefix += '+' } 'Alt' { $prefix += '%' } }
  }
  if ($KeyNames.ContainsKey($key)) { return $prefix + $KeyNames[$key] }
  if ($key -match '^F([1-9]|1[0-2])$') { return $prefix + '{' + $key + '}' }
  if ($key -match '^[A-Z0-9]$') { return $prefix + $key.ToLowerInvariant() }
  Fail 'INVALID_KEYS' "Unknown key $chord."
}

function Read-Text($element) {
  $value = Get-Pattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
  if ($null -ne $value) { return [string]$value.Current.Value }
  $text = Get-Pattern $element ([System.Windows.Automation.TextPattern]::Pattern)
  if ($null -ne $text) { return [string]$text.DocumentRange.GetText(-1) }
  $edit = Win32-Edit $element
  if ($edit -ne 0) { return [JupiterNative]::ControlText([IntPtr]$edit) }
  return [string]$element.Current.Name
}

function Op-Ping($p) {
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  return [ordered]@{
    pid = $PID
    psVersion = $PSVersionTable.PSVersion.ToString()
    screen = [ordered]@{ width = $screen.Width; height = $screen.Height }
  }
}

function Op-ListWindows($p) {
  $windows = @()
  foreach ($handle in [JupiterNative]::TopLevelWindows()) {
    try {
      $info = Handle-Info $handle
      # Untitled, zero-size windows are helpers, not something a person works in.
      if ($info.title -eq '' -and ($info.bounds.width -le 0 -or $info.bounds.height -le 0)) { continue }
      $windows += $info
    } catch { }
    if ($windows.Count -ge 200) { break }
  }
  return [ordered]@{ windows = @($windows) }
}

function Op-Start($p) {
  $arguments = @($p.args)
  if ($arguments.Count -gt 0) { $process = Start-Process -FilePath $p.file -ArgumentList $arguments -PassThru }
  else { $process = Start-Process -FilePath $p.file -PassThru }
  return [ordered]@{ processId = [int]$process.Id }
}

function Op-WindowOp($p) {
  $window = Get-WindowElement $p.handle
  $pattern = Get-Pattern $window ([System.Windows.Automation.WindowPattern]::Pattern)
  $state = [System.Windows.Automation.WindowVisualState]
  if ($null -eq $pattern -and @('minimize', 'maximize', 'restore', 'close') -contains $p.operation) {
    Fail 'WINDOW_OP_UNSUPPORTED' "The window does not support $($p.operation) through UI Automation."
  }
  switch ($p.operation) {
    'focus' { Focus-Window $p.handle }
    'close' {
      $pattern.Close()
      $deadline = [DateTime]::UtcNow.AddSeconds(3)
      while ([JupiterNative]::IsWindow([IntPtr][long]$p.handle) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
      if ([JupiterNative]::IsWindow([IntPtr][long]$p.handle)) {
        Fail 'WINDOW_STILL_OPEN' 'The window did not close; it may be asking a question.'
      }
      return [ordered]@{ window = $null }
    }
    'minimize' { $pattern.SetWindowVisualState($state::Minimized) }
    'maximize' { $pattern.SetWindowVisualState($state::Maximized) }
    'restore' { $pattern.SetWindowVisualState($state::Normal) }
    { $_ -eq 'move' -or $_ -eq 'resize' } {
      $transform = Get-Pattern $window ([System.Windows.Automation.TransformPattern]::Pattern)
      if ($null -eq $transform) { Fail 'WINDOW_OP_UNSUPPORTED' 'The window cannot be moved or resized.' }
      if ($p.operation -eq 'move') { $transform.Move([double]$p.x, [double]$p.y) }
      else { $transform.Resize([double]$p.width, [double]$p.height) }
    }
  }
  Start-Sleep -Milliseconds 150
  return [ordered]@{ window = Window-Info (Get-WindowElement $p.handle) }
}

function Op-FindElement($p) {
  return [ordered]@{ element = Element-Info (Find-Element $p.handle $p.query $p.waitMs) }
}

function Op-Invoke($p) {
  $element = Find-Element $p.handle $p.query $p.waitMs
  if (-not $element.Current.IsEnabled) { Fail 'ELEMENT_DISABLED' "The control ($(Describe-Query $p.query)) is disabled." }
  $invoke = Get-Pattern $element ([System.Windows.Automation.InvokePattern]::Pattern)
  if ($null -ne $invoke) { $invoke.Invoke() }
  else {
    $toggle = Get-Pattern $element ([System.Windows.Automation.TogglePattern]::Pattern)
    if ($null -ne $toggle) { $toggle.Toggle() }
    else {
      $expand = Get-Pattern $element ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
      if ($null -ne $expand) { $expand.Expand() }
      else { Fail 'ELEMENT_NOT_INVOKABLE' "The control ($(Describe-Query $p.query)) cannot be clicked semantically." }
    }
  }
  $info = $null
  try { $info = Element-Info $element } catch { $info = $null }
  if ($null -eq $info) { $info = [ordered]@{ automationId = ''; name = ''; controlType = ''; className = ''; bounds = (To-Bounds ([System.Windows.Rect]::Empty)); enabled = $false; patterns = @() } }
  return [ordered]@{ element = $info }
}

function Op-SetValue($p) {
  $element = Find-Element $p.handle $p.query $p.waitMs
  $value = Get-Pattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
  if ($null -ne $value) {
    if ($value.Current.IsReadOnly) { Fail 'ELEMENT_READ_ONLY' "The control ($(Describe-Query $p.query)) is read-only." }
    $value.SetValue([string]$p.text)
    return [ordered]@{ element = Element-Info $element }
  }
  # A classic Win32 edit box without a Value pattern takes its text through its own message.
  $edit = Win32-Edit $element
  if ($edit -eq 0) { Fail 'ELEMENT_NOT_EDITABLE' "The control ($(Describe-Query $p.query)) has no editable value." }
  if (-not [JupiterNative]::SetControlText([IntPtr]$edit, [string]$p.text)) {
    Fail 'ELEMENT_NOT_EDITABLE' "The control ($(Describe-Query $p.query)) did not accept the text."
  }
  return [ordered]@{ element = Element-Info $element }
}

function Op-TypeText($p) {
  $element = Find-Element $p.handle $p.query $p.waitMs
  if (-not $element.Current.IsKeyboardFocusable -and (Win32-Edit $element) -eq 0) {
    Fail 'ELEMENT_NOT_EDITABLE' "The control ($(Describe-Query $p.query)) does not take keyboard input."
  }
  Focus-Window $p.handle
  $edit = Win32-Edit $element
  if ($edit -ne 0) {
    # A classic Win32 edit box that UI Automation cannot focus takes focus the Win32 way.
    $focused = $false
    try { $element.SetFocus(); $focused = $true } catch { }
    if (-not $focused -and -not [JupiterNative]::FocusControl([IntPtr]$edit)) {
      Fail 'FOCUS_FAILED' "The control ($(Describe-Query $p.query)) could not be given keyboard focus."
    }
  } else {
    $element.SetFocus()
  }
  [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeys ([string]$p.text)))
  return [ordered]@{ element = Element-Info $element }
}

function Op-SendKeys($p) {
  Focus-Window $p.handle
  foreach ($chord in @($p.keys)) {
    [System.Windows.Forms.SendKeys]::SendWait((Chord-SendKeys ([string]$chord)))
    Start-Sleep -Milliseconds 50
  }
  return [ordered]@{ window = Window-Info (Get-WindowElement $p.handle) }
}

function Op-ReadText($p) {
  return [ordered]@{ text = Read-Text (Find-Element $p.handle $p.query $p.waitMs) }
}

function Op-ReadTree($p) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $nodes = [System.Collections.ArrayList]::new()
  $script:truncated = $false
  function Visit($element, [int]$depth) {
    if ($nodes.Count -ge [int]$p.maxNodes) { $script:truncated = $true; return }
    $current = $element.Current
    [void]$nodes.Add([ordered]@{
      depth = $depth
      controlType = ($current.ControlType.ProgrammaticName -replace '^ControlType\.', '')
      name = [string]$current.Name
      automationId = [string]$current.AutomationId
      className = [string]$current.ClassName
      enabled = [bool]$current.IsEnabled
    })
    if ($depth -ge [int]$p.depth) { return }
    $child = $walker.GetFirstChild($element)
    while ($null -ne $child) {
      Visit $child ($depth + 1)
      if ($script:truncated) { return }
      $child = $walker.GetNextSibling($child)
    }
  }
  Visit (Get-WindowElement $p.handle) 0
  return [ordered]@{ nodes = @($nodes.ToArray()); truncated = [bool]$script:truncated }
}

function Op-Scroll($p) {
  $element = Find-Element $p.handle $p.query $p.waitMs
  $scroll = Get-Pattern $element ([System.Windows.Automation.ScrollPattern]::Pattern)
  if ($null -eq $scroll) { Fail 'ELEMENT_NOT_SCROLLABLE' "The control ($(Describe-Query $p.query)) cannot scroll." }
  $none = [System.Windows.Automation.ScrollAmount]::NoAmount
  for ($i = 0; $i -lt [int]$p.amount; $i++) {
    switch ($p.direction) {
      'up' { $scroll.Scroll($none, [System.Windows.Automation.ScrollAmount]::SmallDecrement) }
      'down' { $scroll.Scroll($none, [System.Windows.Automation.ScrollAmount]::SmallIncrement) }
      'left' { $scroll.Scroll([System.Windows.Automation.ScrollAmount]::SmallDecrement, $none) }
      'right' { $scroll.Scroll([System.Windows.Automation.ScrollAmount]::SmallIncrement, $none) }
    }
  }
  return [ordered]@{ element = Element-Info $element }
}

function Op-Select($p) {
  $element = Find-Element $p.handle $p.query $p.waitMs
  $item = Get-Pattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
  if ($null -eq $item) { Fail 'ELEMENT_NOT_SELECTABLE' "The control ($(Describe-Query $p.query)) cannot be selected." }
  $item.Select()
  if (-not $item.Current.IsSelected) { Fail 'SELECTION_NOT_APPLIED' 'The control did not become selected.' }
  return [ordered]@{ element = Element-Info $element }
}

function Op-Screenshot($p) {
  if ($null -eq $p.handle) {
    $area = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $x = $area.X; $y = $area.Y; $width = $area.Width; $height = $area.Height
  } else {
    $bounds = To-Bounds (Get-WindowElement $p.handle).Current.BoundingRectangle
    $x = $bounds.x; $y = $bounds.y; $width = $bounds.width; $height = $bounds.height
  }
  if ($width -le 0 -or $height -le 0) { Fail 'WINDOW_NOT_VISIBLE' 'The window has no visible area to capture.' }
  $bitmap = [System.Drawing.Bitmap]::new($width, $height)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try { $graphics.CopyFromScreen($x, $y, 0, 0, $bitmap.Size) } finally { $graphics.Dispose() }
    $bitmap.Save([string]$p.path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $bitmap.Dispose() }
  return [ordered]@{ width = $width; height = $height; bytes = (Get-Item -LiteralPath $p.path).Length }
}

function Op-ClickPoint($p) {
  $bounds = To-Bounds (Get-WindowElement $p.handle).Current.BoundingRectangle
  if ([int]$p.x -ge $bounds.width -or [int]$p.y -ge $bounds.height) {
    Fail 'POINT_OUTSIDE_WINDOW' "The point ($($p.x), $($p.y)) is outside the window ($($bounds.width)x$($bounds.height))."
  }
  Focus-Window $p.handle
  $screenX = $bounds.x + [int]$p.x
  $screenY = $bounds.y + [int]$p.y
  [void][JupiterNative]::SetCursorPos($screenX, $screenY)
  [JupiterNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [JupiterNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  return [ordered]@{ screenX = $screenX; screenY = $screenY }
}

$Operations = @{
  ping = { param($p) Op-Ping $p }
  listWindows = { param($p) Op-ListWindows $p }
  start = { param($p) Op-Start $p }
  windowOp = { param($p) Op-WindowOp $p }
  findElement = { param($p) Op-FindElement $p }
  invoke = { param($p) Op-Invoke $p }
  setValue = { param($p) Op-SetValue $p }
  typeText = { param($p) Op-TypeText $p }
  sendKeys = { param($p) Op-SendKeys $p }
  readText = { param($p) Op-ReadText $p }
  readTree = { param($p) Op-ReadTree $p }
  scroll = { param($p) Op-Scroll $p }
  select = { param($p) Op-Select $p }
  screenshot = { param($p) Op-Screenshot $p }
  clickPoint = { param($p) Op-ClickPoint $p }
}

function Write-Reply($reply) {
  $json = $reply | ConvertTo-Json -Compress -Depth 12
  [Console]::Out.WriteLine([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json)))
  [Console]::Out.Flush()
}

Write-Reply ([ordered]@{ id = 0; ok = $true; result = [ordered]@{ ready = $true; pid = $PID } })

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Length -eq 0) { continue }
  $id = 0
  try {
    $request = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
    $id = $request.id
    $operation = $Operations[[string]$request.op]
    if ($null -eq $operation) { Fail 'UNKNOWN_OPERATION' "The runtime has no operation $($request.op)." }
    $result = & $operation $request.params
    Write-Reply ([ordered]@{ id = $id; ok = $true; result = $result })
  } catch {
    $message = $_.Exception.Message
    $code = 'AUTOMATION_FAILED'
    if ($message.StartsWith('JUPITER:')) {
      $separator = $message.IndexOf('|')
      $code = $message.Substring(8, $separator - 8)
      $message = $message.Substring($separator + 1)
    } elseif ($_.Exception -is [System.Windows.Automation.ElementNotAvailableException]) {
      $code = 'ELEMENT_GONE'
    }
    Write-Reply ([ordered]@{ id = $id; ok = $false; error = [ordered]@{ code = $code; message = $message } })
  }
}
