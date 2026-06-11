# capture.ps1 — screenshot a window (or the full screen) and enumerate clickable
# UI Automation elements with their center coordinates. Outputs one JSON object.
#   -Window <substring>   match a top-level window whose title contains this
#   -FullScreen           capture the whole virtual screen instead
param([string]$Window = "", [switch]$FullScreen, [string]$Out = "")
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Fg { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }
"@

$root = [System.Windows.Automation.AutomationElement]::RootElement
$target = $null
$bounds = $null

if (-not $FullScreen -and $Window -ne "") {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  foreach ($w in $windows) {
    if ($w.Current.Name -and $w.Current.Name.ToLower().Contains($Window.ToLower())) { $target = $w; break }
  }
}
if (-not $target) { $target = $root }

# Bounds to screenshot.
if ($FullScreen -or $target -eq $root) {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bounds = New-Object System.Drawing.Rectangle($vs.X, $vs.Y, $vs.Width, $vs.Height)
} else {
  $r = $target.Current.BoundingRectangle
  $bounds = New-Object System.Drawing.Rectangle([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
  if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bounds = New-Object System.Drawing.Rectangle($vs.X, $vs.Y, $vs.Width, $vs.Height)
  }
}

$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$b64 = [Convert]::ToBase64String($ms.ToArray())
$g.Dispose(); $bmp.Dispose(); $ms.Dispose()

# Clickable elements within the target.
$types = @(
  [System.Windows.Automation.ControlType]::Button,
  [System.Windows.Automation.ControlType]::MenuItem,
  [System.Windows.Automation.ControlType]::CheckBox,
  [System.Windows.Automation.ControlType]::RadioButton,
  [System.Windows.Automation.ControlType]::Hyperlink,
  [System.Windows.Automation.ControlType]::TabItem,
  [System.Windows.Automation.ControlType]::ListItem,
  [System.Windows.Automation.ControlType]::SplitButton
)
$or = $null
foreach ($t in $types) {
  $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $t)
  if ($null -eq $or) { $or = $c } else { $or = New-Object System.Windows.Automation.OrCondition($or, $c) }
}
# Enumerate within a single window only — walking the whole desktop tree is slow
# and can hang. If no window matched, scope to the foreground window.
$scope = $target
if ($target -eq $root) {
  try {
    $hwnd = [Fg]::GetForegroundWindow()
    if ($hwnd -ne [IntPtr]::Zero) { $scope = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd) }
  } catch {}
}
$elements = @()
try {
  if ($scope -eq $root) { throw "no scoped window" }
  $found = $scope.FindAll([System.Windows.Automation.TreeScope]::Descendants, $or)
  foreach ($e in $found) {
    try {
      $r = $e.Current.BoundingRectangle
      if ($r.Width -le 0 -or $r.Height -le 0) { continue }
      if (-not $e.Current.IsEnabled -or $e.Current.IsOffscreen) { continue }
      $invokable = $false
      $obj = $null
      if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$obj)) { $invokable = $true }
      $elements += [pscustomobject]@{
        name = $e.Current.Name
        type = $e.Current.ControlType.ProgrammaticName -replace "ControlType\.", ""
        cx = [int]($r.X + $r.Width / 2)
        cy = [int]($r.Y + $r.Height / 2)
        invokable = $invokable
      }
    } catch {}
  }
} catch {}

$result = [pscustomobject]@{
  window = if ($target -eq $root) { "(full screen)" } else { $target.Current.Name }
  bounds = @{ x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height }
  image = $b64
  elements = $elements
}
$json = $result | ConvertTo-Json -Depth 6 -Compress
if ($Out -ne "") { [System.IO.File]::WriteAllText($Out, $json, [System.Text.Encoding]::UTF8) } else { $json }
