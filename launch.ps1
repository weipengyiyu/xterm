param(
  [switch]$NoBrowser,
  [ValidateRange(1, 65535)][int]$Port = 8787,
  [switch]$Foreground
)

$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

function Find-NodeExecutable {
  $command = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $command -and $command.Source) { return $command.Source }
  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'hermes\node\node.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  throw 'Node.js not found. Install from https://nodejs.org/'
}

try {
  $nodeExe = Find-NodeExecutable
  $launcherArgs = @((Join-Path $scriptDir 'scripts\launch.js'), '--port', [string]$Port)
  if ($NoBrowser) { $launcherArgs += '--no-open' }
  if ($Foreground) { $launcherArgs += '--fg' }
  & $nodeExe @launcherArgs
  $code = $LASTEXITCODE
  if ($null -eq $code) { $code = 1 }
  exit $code
} catch {
  $startupError = $_.Exception.Message
  try {
    $logDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.xterm\logs'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    Add-Content -LiteralPath (Join-Path $logDir 'launcher.log') -Encoding UTF8 -Value ("{0} Startup failed: {1}" -f (Get-Date -Format s), $startupError)
  } catch { }
  [Console]::Error.WriteLine("Startup failed: {0}", $startupError)
  exit 1
}
