# click.ps1 — click a UI element. If -Name resolves to an element supporting the
# Invoke pattern and -Button is left, it is invoked via UI Automation (NO cursor
# movement, does not steal focus). Otherwise it falls back to a real SendInput
# click at the coordinates (this DOES move the cursor). Outputs one JSON object.
param(
  [string]$Window = "",
  [string]$Name = "",
  [int]$X = -1,
  [int]$Y = -1,
  [string]$Button = "left",
  [string]$Out = ""
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Emit($o) {
  $json = $o | ConvertTo-Json -Compress
  if ($Out -ne "") { [System.IO.File]::WriteAllText($Out, $json, [System.Text.Encoding]::UTF8) } else { $json }
  exit
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Mouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public const uint LD=0x02, LU=0x04, RD=0x08, RU=0x10;
}
"@

function Send-Click([int]$x, [int]$y, [string]$btn) {
  [Mouse]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 30
  if ($btn -eq "right") { [Mouse]::mouse_event([Mouse]::RD,0,0,0,[IntPtr]::Zero); [Mouse]::mouse_event([Mouse]::RU,0,0,0,[IntPtr]::Zero) }
  else { [Mouse]::mouse_event([Mouse]::LD,0,0,0,[IntPtr]::Zero); [Mouse]::mouse_event([Mouse]::LU,0,0,0,[IntPtr]::Zero) }
}

# Try the UI Automation Invoke path (no cursor movement) for a named element + left click.
if ($Name -ne "" -and $Button -eq "left") {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $scope = $root
  if ($Window -ne "") {
    $wc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
    foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $wc)) {
      if ($w.Current.Name -and $w.Current.Name.ToLower().Contains($Window.ToLower())) { $scope = $w; break }
    }
  }
  $nc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Name)
  $el = $scope.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nc)
  if ($el) {
    $obj = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$obj)) {
      $obj.Invoke()
      Emit ([pscustomobject]@{ method = "uia-invoke"; movedCursor = $false; clicked = $Name })
    }
    $r = $el.Current.BoundingRectangle
    if ($r.Width -gt 0) { $X = [int]($r.X + $r.Width / 2); $Y = [int]($r.Y + $r.Height / 2) }
  }
}

if ($X -lt 0 -or $Y -lt 0) {
  Emit ([pscustomobject]@{ error = "no invokable element and no coordinates provided" })
}
Send-Click $X $Y $Button
Emit ([pscustomobject]@{ method = "sendinput"; movedCursor = $true; clicked = @{ x = $X; y = $Y; button = $Button } })
