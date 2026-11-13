param([string]$DoubaoPath = 'D:\doubao\app\Doubao.exe')
$ErrorActionPreference = 'Stop'
# Do not kill, restart, sign in, read cookies, or modify the client installation.
if (-not (Test-Path -LiteralPath $DoubaoPath -PathType Leaf)) { throw 'Doubao.exe was not found. Pass -DoubaoPath with its installed location.' }
try {
  $state = Invoke-RestMethod -Uri 'http://127.0.0.1:19226/json/version' -TimeoutSec 2 -NoProxy
  if ($state.Browser -and $state.webSocketDebuggerUrl -match '^ws://127\.0\.0\.1:19226/') {
    Write-Output 'A debugging channel is already open on 127.0.0.1:19226. Refresh Doubao Desktop Models in DSH.'
    exit 0
  }
} catch { }
$running = @(Get-Process -Name Doubao -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) { throw 'Doubao is already running without the expected channel. Finish current tasks, then choose Exit in its system-tray menu and run this script again. This script will not terminate it.' }
Start-Process -FilePath $DoubaoPath -ArgumentList @('--remote-debugging-address=127.0.0.1', '--remote-debugging-port=19226')
Write-Output 'Requested Doubao startup. Keep the debugging port local; do not forward or expose it. Open the Doubao chat window, sign in manually if needed, and refresh the DSH plugin settings.'
