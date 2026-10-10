# Works before Node/npm are installed. SHA256 values are pinned from:
# https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
$ErrorActionPreference = 'Stop'
$nodeVersion = '24.21.0'
$nodeHashes = @{
  x64 = @('158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541', 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32')
  arm64 = @('8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921', 'dff59da18b6ffe1bf1ca99e1d2af4906080c481740619f5b5098c0fca28bd9b7')
}
function Get-XtermHash([string]$File) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($File)
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}
function Test-XtermNode([string]$File) {
  if (!(Test-Path -LiteralPath $File -PathType Leaf)) { return $false }
  if (!(Test-Path -LiteralPath (Join-Path (Split-Path -Parent $File) 'node_modules\npm\bin\npm-cli.js'))) { return $false }
  try {
    $version = (& $File --version 2>$null | Out-String).Trim().TrimStart('v')
    $arch = (& $File -p 'process.arch' 2>$null | Out-String).Trim()
    return ($LASTEXITCODE -eq 0 -and [version]$version -ge [version]'22.12.0' -and $arch -in @('x64', 'arm64'))
  } catch { return $false }
}
function Save-XtermRuntime([string]$Url, [string]$File) {
  Add-Type -AssemblyName System.Net.Http
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $handler = New-Object Net.Http.HttpClientHandler
  $systemProxy = [Net.WebRequest]::DefaultWebProxy
  $proxy = if ($systemProxy) { $systemProxy.GetProxy([uri]$Url) } else { $null }
  if ($proxy -and $proxy.IsLoopback -and $proxy.AbsoluteUri -ne $Url) {
    $tcp = New-Object Net.Sockets.TcpClient
    try { if (!$tcp.ConnectAsync($proxy.Host, $proxy.Port).Wait(1000) -or !$tcp.Connected) { $handler.UseProxy = $false } }
    catch { $handler.UseProxy = $false } finally { $tcp.Dispose() }
  }
  $client = New-Object Net.Http.HttpClient($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(90)
  $response = $null; $output = $null
  try {
    $response = $client.GetAsync($Url).GetAwaiter().GetResult()
    $null = $response.EnsureSuccessStatusCode()
    $output = [IO.File]::Create($File)
    $null = $response.Content.CopyToAsync($output).GetAwaiter().GetResult()
  } finally {
    if ($output) { $output.Dispose() }; if ($response) { $response.Dispose() }; $client.Dispose()
  }
}
function Get-XtermNode([string]$ProjectRoot) {
  $portable = Join-Path $ProjectRoot 'runtime\node.exe'
  if (Test-Path -LiteralPath $portable) { return $portable }
  $native = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $arch = switch ($native.ToUpperInvariant()) { 'AMD64' { 'x64' }; 'ARM64' { 'arm64' }; default { throw 'xterm requires 64-bit Windows.' } }
  $cache = Join-Path $ProjectRoot '.runtime'
  $name = "node-v$nodeVersion-win-$arch"
  $node = Join-Path $cache "$name\node.exe"
  if ((Test-Path -LiteralPath $node) -and (Get-XtermHash $node) -eq $nodeHashes[$arch][1] -and (Test-XtermNode $node)) { return $node }
  if ($env:XTERM_NO_SYSTEM_NODE -ne '1') {
    $command = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command -and (Test-XtermNode $command.Source)) { return $command.Source }
    foreach ($candidate in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe", "$env:LOCALAPPDATA\hermes\node\node.exe")) {
      if (Test-XtermNode $candidate) { return $candidate }
    }
  }
  New-Item -ItemType Directory -Path $cache -Force | Out-Null
  $lock = $null; $deadline = [DateTime]::UtcNow.AddMinutes(5)
  while (!$lock -and [DateTime]::UtcNow -lt $deadline) {
    try { $lock = [IO.File]::Open((Join-Path $cache 'node-install.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch [IO.IOException] { Start-Sleep -Milliseconds 300 }
  }
  if (!$lock) { throw 'Another runtime preparation has not finished.' }
  $zip = Join-Path $cache "$name.zip"
  # Keep extraction paths short for Windows PowerShell 5.1's MAX_PATH limit.
  $stage = Join-Path ([IO.Path]::GetTempPath()) ('xtn-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  try {
    if (!((Test-Path -LiteralPath $node) -and (Get-XtermHash $node) -eq $nodeHashes[$arch][1] -and (Test-XtermNode $node))) {
      $downloaded = $false
      Write-Host "[1/3] Preparing Node.js $nodeVersion ($arch) automatically."
      foreach ($url in @("https://nodejs.org/dist/v$nodeVersion/$name.zip", "https://npmmirror.com/mirrors/node/v$nodeVersion/$name.zip")) {
        try {
          Write-Host "Downloading: $url"
          Save-XtermRuntime $url $zip | Out-Null
          if ((Get-XtermHash $zip) -ne $nodeHashes[$arch][0]) { throw 'Runtime checksum mismatch.' }
          $downloaded = $true; break
        } catch { Write-Host ("Download failed: " + $_.Exception.Message) }
      }
      if (!$downloaded) { throw 'Runtime download failed. Check Internet access and double-click again.' }
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      [IO.Compression.ZipFile]::ExtractToDirectory($zip, $stage)
      $extracted = Join-Path $stage $name
      if ((Get-XtermHash (Join-Path $extracted 'node.exe')) -ne $nodeHashes[$arch][1]) { throw 'Runtime executable checksum mismatch.' }
      $target = Join-Path $cache $name
      if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination ($target + '.old-' + [guid]::NewGuid().ToString('N')) }
      Move-Item -LiteralPath $extracted -Destination $target
      Write-Host 'Node.js is ready. No system installation was required.'
    }
  } finally {
    $lock.Dispose()
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    if ((Test-Path -LiteralPath $stage) -and !(Get-ChildItem -LiteralPath $stage -Force)) { [IO.Directory]::Delete($stage, $false) }
  }
  return $node
}
