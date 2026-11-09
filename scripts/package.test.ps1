$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'package.ps1')
if (-not (Get-Command Test-NodeChecksum -ErrorAction SilentlyContinue)) { throw 'Missing Test-NodeChecksum implementation' }
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('theone-package-test-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $testRoot
try {
  $archive = Join-Path $testRoot 'node-v24.21.0-win-x64.zip'
  [IO.File]::WriteAllText($archive, 'fixture, not a real Node distribution')
  $hash = (Get-Sha256 -Path $archive)
  $checksums = Join-Path $testRoot 'SHASUMS256.txt'
  [IO.File]::WriteAllText($checksums, "$hash  node-v24.21.0-win-x64.zip`n")
  Test-NodeChecksum -Archive $archive -Shasums $checksums -FileName 'node-v24.21.0-win-x64.zip'
  [IO.File]::AppendAllText($archive, 'tampered')
  $rejected = $false
  try { Test-NodeChecksum -Archive $archive -Shasums $checksums -FileName 'node-v24.21.0-win-x64.zip' } catch { $rejected = $_.Exception.Message -match 'SHA256' }
  if (-not $rejected) { throw 'Checksum mismatch must be rejected' }
  $rejected = $false
  try { Test-NodeChecksum -Archive $archive -Shasums $checksums -FileName 'other.zip' } catch { $rejected = $true }
  if (-not $rejected) { throw 'Missing checksum must be rejected' }
  $project = Join-Path $testRoot 'project'
  $runtime = Join-Path $testRoot 'runtime'
  $files = @{
    'release/theone/plugin.json' = '{"name":"theone","version":"0.1.0"}'
    'release/theone/.codex-plugin/plugin.json' = '{"name":"theone","version":"0.1.0"}'
    'release/theone/mcp.json' = '{"mcpServers":{"theone":{"command":"node","args":["${PLUGIN_ROOT}/server/main.mjs","serve"],"cwd":"${PLUGIN_ROOT}"}}}'
    'release/theone/.mcp.json' = '{}'
    'release/theone/server/main.mjs' = '// fixture'
    'release/theone/skills/theone/SKILL.md' = 'fixture'
    'release/theone/ui/theone.html' = 'fixture'
    'release/theone/LICENSE' = 'fixture'
    'release/theone/THIRD_PARTY_NOTICES.txt' = 'fixture'
    'release/.agents/plugins/marketplace.json' = '{"name":"theone-codex"}'
    'release/client-adapter/patches.mjs' = '// fixture'
    'release/client-adapter/build.mjs' = '// fixture'
    'release/client-adapter/install-launcher.mjs' = '// fixture'
    'release/client-adapter/archive.mjs' = '// fixture'
    'installer/install.mjs' = '// fixture'
    'installer/install.cmd' = '@echo off'
    'installer/uninstall.cmd' = '@echo off'
    'INSTALL.md' = 'fixture'
  }
  foreach ($entry in $files.GetEnumerator()) {
    $path = Join-Path $project $entry.Key
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force
    [IO.File]::WriteAllText($path, $entry.Value)
  }
  $null = New-Item -ItemType Directory -Path $runtime
  [IO.File]::WriteAllText((Join-Path $runtime 'node.exe'), 'fixture executable')
  [IO.File]::WriteAllText((Join-Path $runtime 'LICENSE'), 'fixture license')
  $zip = New-TheOneWindowsArchive -ProjectRoot $project -RuntimeRoot $runtime -Version '0.1.0'
  if (-not (Test-Path -LiteralPath ($zip + '.sha256'))) { throw 'Missing release SHA256' }
  $reader = [IO.Compression.ZipFile]::OpenRead($zip)
  try {
    $entries = @($reader.Entries.FullName -replace '\\', '/')
    foreach ($name in @('theone/node/node.exe','theone/node/LICENSE','installer/install.mjs','client-adapter/patches.mjs','.agents/plugins/marketplace.json','安装 TheOne.cmd','卸载 TheOne.cmd','安装说明.txt')) {
      if ($entries -notcontains $name) { throw "Missing payload entry: $name" }
    }
    $entry = $reader.Entries | Where-Object { ($_.FullName -replace '\\', '/') -eq 'theone/.mcp.json' }
    $stream = [IO.StreamReader]::new($entry.Open())
    try { $config = $stream.ReadToEnd() | ConvertFrom-Json } finally { $stream.Dispose() }
    if ($config.mcpServers.theone.command -ne './node/node.exe') { throw 'Windows MCP does not use portable Node' }
    if ($config.mcpServers.theone.cwd -ne '${PLUGIN_ROOT}') { throw 'Plugin root was not preserved' }
  } finally { $reader.Dispose() }
  $source = Get-Content -LiteralPath (Join-Path $project 'release/theone/mcp.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($source.mcpServers.theone.command -ne 'node') { throw 'Cross-platform source was modified' }
  Write-Output 'PASS: checksum match, tamper rejection, missing hash rejection, offline archive contents, portable MCP, source preservation.'
} finally {
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $allowed = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\theone-package-test-'
  if (-not $resolved.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
