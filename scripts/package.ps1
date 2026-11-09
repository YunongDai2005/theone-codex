$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $projectRoot 'release'
$pluginRoot = Join-Path $releaseRoot 'gpt-theone'
$packageVersion = (Get-Content -Raw -LiteralPath (Join-Path $pluginRoot 'plugin.json') | ConvertFrom-Json).version
$archivePath = Join-Path $releaseRoot "gpt-theone-$packageVersion.zip"
if (-not (Test-Path -LiteralPath (Join-Path $pluginRoot 'server/main.mjs'))) { throw 'Run npm run build first.' }
if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($pluginRoot, $archivePath)
$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  $required = @('plugin.json', 'mcp.json', '.mcp.json', '.codex-plugin/plugin.json', 'skills/theone/SKILL.md', 'server/main.mjs', 'ui/theone.html', 'LICENSE', 'THIRD_PARTY_NOTICES.txt')
  $entries = $archive.Entries.FullName -replace '\\', '/'
  foreach ($name in $required) { if ($entries -notcontains $name) { throw "Missing packaged file: $name" } }
  [pscustomobject]@{ archive = $archivePath; entries = $archive.Entries.Count; bytes = (Get-Item -LiteralPath $archivePath).Length } | ConvertTo-Json
} finally { $archive.Dispose() }
