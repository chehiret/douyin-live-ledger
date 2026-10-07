# Internal Deployment

Keep Node.js listening on `127.0.0.1:4173` and place Caddy on the same Windows server. Choose an internal DNS name pointing to that server. Adapt `Caddyfile.example` to the real name and trust Caddy's local CA on employee devices. Do not transmit passwords or verification inputs over plain HTTP across the LAN.

Set these service environment variables before starting the backend (replace the example hostname):

```powershell
[Environment]::SetEnvironmentVariable('LIVE_ORIGIN', 'https://ledger.internal', 'User')
[Environment]::SetEnvironmentVariable('LIVE_TRUST_PROXY', '1', 'User')
```

Restart the supervisor after changing environment configuration. Only the loopback proxy is trusted. Keep port 4173 blocked from remote access; allow HTTPS to Caddy only. Existing local-only operation needs neither variable.

Install supervision with `powershell -File scripts/install-autostart.ps1`. The task runs under the existing Windows user at sign-in, preserving that user's Edge login profile access. It restarts the backend after process exit; it does not sign Windows in automatically or run the browser before Windows sign-in. This must also be installed on the eventual server. Stop the scheduled task before deliberately stopping the backend for maintenance.

Backups are SQLite snapshots in `data/backups/`, with SHA-256 manifests and integrity checks; the latest 30 are retained. A snapshot is made daily while the service runs and can also be created in the administrator's Data Backup page. Copy the snapshot AND its `.json` manifest when moving a backup. Database downloads do not include browser profiles. Back up `data/profiles/` separately while the collector is stopped; copying an Edge profile to another machine does not guarantee its login remains valid.

To recover without overwriting existing data:

```powershell
node --experimental-sqlite scripts/restore.mjs data/backups/backup-NAME.sqlite data/restored.sqlite
```

The script verifies checksum, SQLite integrity and foreign keys, clears system login sessions, cancels stale queued jobs, and writes a new database. Stop the supervisor and backend, retain the current `live.sqlite` and WAL/SHM files as a separate rollback set, then put the restored database in its place. Never combine restored data with old WAL files. Restart the service, log in again, and verify Douyin account logins before resuming collection. Database backups contain password hashes and private statistics; give them only to administrators.

In-app notifications only cover unmet monthly broadcast guarantees during the last seven calendar days of the month, once per anchor per day. Completed jobs, sync logs, login checks, audit events, notices and diagnostic files are retained for seven days. Application logs rotate by day in `data/runtime-logs/` with a 10MB daily cap. Broadcast sessions and collection coverage retain the current Shanghai calendar month plus the previous two; monthly guarantee settings and account profiles remain stored. Daily database compaction reclaims space. Older dates may be fetched manually if Douyin still offers them; results live in process memory for 30 minutes and are excluded from database backups. Existing backups retain their independent 30-file policy. No email, SMS or third-party messages are sent. For remote verification, the user operates the official page inside the protected verification dialog, including pointer drags and code entry. Challenges are completed manually; there is no automatic CAPTCHA solving.
