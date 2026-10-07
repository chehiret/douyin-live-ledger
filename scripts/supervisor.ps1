$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node.exe).Source
$dataDir = Join-Path $projectDir 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$mutex = New-Object System.Threading.Mutex($false, 'Local\DouyinLiveLedgerSupervisor')
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
    while ($true) {
        try {
            $listener = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($listener) {
                $health = Invoke-RestMethod 'http://127.0.0.1:4173/api/health' -TimeoutSec 5
                if ($health.app -ne 'live-ledger') { throw 'Port 4173 belongs to another service' }
                Wait-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
            } else {
                $process = Start-Process -FilePath $nodePath -ArgumentList @('--env-file-if-exists=.env', '--experimental-sqlite', 'server/index.js') -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'server-error.log') -PassThru
                $process.WaitForExit()
            }
        } catch {
            Add-Content -LiteralPath (Join-Path $dataDir 'supervisor.log') -Value "$(Get-Date -Format o) $($_.Exception.Message)"
        }
        Start-Sleep -Seconds 5
    }
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
