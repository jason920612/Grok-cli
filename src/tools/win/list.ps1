# list.ps1 — enumerate open top-level windows (title + bounds) so the agent knows
# what it can target. Outputs one JSON array (UTF-8 to -Out, to keep non-ASCII titles).
param([string]$Out = "")
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
$list = @()
foreach ($w in $windows) {
  try {
    $name = $w.Current.Name
    if (-not $name -or $w.Current.IsOffscreen) { continue }
    $r = $w.Current.BoundingRectangle
    if ($r.Width -le 0 -or $r.Height -le 0) { continue }
    $list += [pscustomobject]@{
      title = $name
      bounds = @{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }
    }
  } catch {}
}
$json = ($list | ConvertTo-Json -Depth 4 -Compress)
if ($null -eq $json) { $json = "[]" }
if ($Out -ne "") { [System.IO.File]::WriteAllText($Out, $json, [System.Text.Encoding]::UTF8) } else { $json }
