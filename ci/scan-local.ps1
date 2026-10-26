# Runs the same secret and code scans as the Jenkins pipeline and saves reports in .\reports
# Usage (from the repo folder):  powershell -ExecutionPolicy Bypass -File ci\scan-local.ps1
$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force -Path reports | Out-Null
$repo = (Get-Location).Path
docker run --rm -v "${repo}:/repo" zricethezav/gitleaks:latest detect --source /repo --redact --report-format json --report-path /repo/reports/gitleaks.json
docker run --rm -v "${repo}:/src" semgrep/semgrep semgrep scan --config p/typescript --config p/javascript --config p/owasp-top-ten --json -o /src/reports/semgrep.json server/src app.js
Write-Host "Done. Reports are in the reports folder."
