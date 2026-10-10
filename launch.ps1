param(
  [switch]$NoBrowser,
  [ValidateRange(1, 65535)][int]$Port = 8787,
  [switch]$Foreground,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$LauncherArguments
)

$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

try {
  . (Join-Path $scriptDir 'scripts\bootstrap-node.ps1')
  $nodeExe = Get-XtermNode $scriptDir
  $env:PATH = (Split-Path -Parent $nodeExe) + ';' + $env:PATH
  $launcherArgs = @((Join-Path $scriptDir 'scripts\launch.js'))
  if ($PSBoundParameters.ContainsKey('Port')) { $launcherArgs += @('--port', [string]$Port) }
  if ($NoBrowser) { $launcherArgs += '--no-open' }
  if ($Foreground) { $launcherArgs += '--fg' }
  if ($LauncherArguments) { $launcherArgs += $LauncherArguments }
  Write-Host '[2/3] Checking application components. First launch may take a few minutes.'
  & $nodeExe @launcherArgs
  $code = $LASTEXITCODE
  if ($null -eq $code) { $code = 1 }
  if ($code -eq 0) { Write-Host '[3/3] xterm started successfully.' }
  exit $code
} catch {
  $startupError = $_.Exception.Message
  try {
    $profileDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }
    $logDir = Join-Path $profileDir '.xterm\logs'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    Add-Content -LiteralPath (Join-Path $logDir 'launcher.log') -Encoding UTF8 -Value ("{0} Startup failed: {1}" -f (Get-Date -Format s), $startupError)
  } catch { }
  [Console]::Error.WriteLine("Startup failed: {0}", $startupError)
  exit 1
}
