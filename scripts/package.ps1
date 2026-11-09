param([switch]$SkipBuild, [string]$NodeArchive, [string]$NodeShasums)
$ErrorActionPreference = 'Stop'
$PinnedNodeVersion = '24.21.0'

function Test-NodeChecksum {
  param([string]$Archive, [string]$Shasums, [string]$FileName)
  $checksumLines = @(Get-Content -LiteralPath $Shasums -Encoding UTF8 | Where-Object { $_ -match ('^[a-fA-F0-9]{64}\s+\*?' + [regex]::Escape($FileName) + '$') })
  if ($checksumLines.Count -ne 1) { throw "Expected exactly one official SHA256 entry for $FileName" }
  $expected = ($checksumLines[0] -split '\s+')[0]
  $actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash
  if ($actual -ne $expected) { throw "Node SHA256 mismatch for $FileName; remove the cached archive and download again." }
}
function Remove-PackageStage {
  param([string]$Path, [string]$Parent)
  $target = [IO.Path]::GetFullPath($Path)
  $boundary = [IO.Path]::GetFullPath($Parent).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
  if (-not $target.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe staging cleanup: $target" }
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}
function New-TheOneWindowsArchive {
  param([string]$ProjectRoot, [string]$RuntimeRoot, [string]$Version)
  if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version' }
  $releaseRoot = Join-Path $ProjectRoot 'release'
  $stageParent = Join-Path $ProjectRoot '.theone'
  $stage = Join-Path $stageParent ('package-' + [Guid]::NewGuid().ToString('N'))
  $null = New-Item -ItemType Directory -Path $stage -Force
  $archivePath = Join-Path $releaseRoot "TheOne-for-Codex-$Version-windows.zip"
  $temporaryZip = Join-Path $releaseRoot ('.package-' + [Guid]::NewGuid().ToString('N') + '.zip')
  try {
    Copy-Item -LiteralPath (Join-Path $releaseRoot 'theone') -Destination (Join-Path $stage 'theone') -Recurse
    $manifest = Get-Content -LiteralPath (Join-Path $stage 'theone/plugin.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.version -ne $Version -or $manifest.name -ne 'theone') { throw 'Built plugin version/name does not match package.json; rebuild first.' }
    $null = New-Item -ItemType Directory -Path (Join-Path $stage '.agents/plugins') -Force
    Copy-Item -LiteralPath (Join-Path $releaseRoot '.agents/plugins/marketplace.json') -Destination (Join-Path $stage '.agents/plugins/marketplace.json')
    Copy-Item -LiteralPath (Join-Path $releaseRoot 'client-adapter') -Destination (Join-Path $stage 'client-adapter') -Recurse
    $null = New-Item -ItemType Directory -Path (Join-Path $stage 'installer')
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'installer/install.mjs') -Destination (Join-Path $stage 'installer/install.mjs')
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'installer/install.cmd') -Destination (Join-Path $stage '安装 TheOne.cmd')
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'installer/uninstall.cmd') -Destination (Join-Path $stage '卸载 TheOne.cmd')
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'INSTALL.md') -Destination (Join-Path $stage 'INSTALL.md')
    foreach ($relative in @('theone/node')) {
      $destination = Join-Path $stage $relative
      $null = New-Item -ItemType Directory -Path $destination -Force
      foreach ($file in @('node.exe','LICENSE')) { Copy-Item -LiteralPath (Join-Path $RuntimeRoot $file) -Destination (Join-Path $destination $file) }
    }
    $config = Get-Content -LiteralPath (Join-Path $stage 'theone/mcp.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $config.mcpServers.theone.command = './node/node.exe'
    foreach ($file in @('mcp.json','.mcp.json')) { [IO.File]::WriteAllText((Join-Path $stage "theone/$file"), ($config | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false)) }
    $instructions = "先完整解压到一个文件夹，不要在压缩包里直接运行。`r`n双击「安装 TheOne.cmd」，无需另装 Node。`r`n安装后完全退出 Codex，再从「Codex TheOne」快捷方式启动；仅安装插件时重启 Codex 即可。`r`n卸载请双击「卸载 TheOne.cmd」，话题数据默认保留。`r`n出错时保留窗口中的原因和处理方法；详细说明见 INSTALL.md。`r`n"
    [IO.File]::WriteAllText((Join-Path $stage '安装说明.txt'), $instructions, [Text.UTF8Encoding]::new($true))
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    # Forward slashes and UTF-8 names, so Chinese file names survive on any system and in any unzip tool.
    Add-Type -AssemblyName System.IO.Compression
    $zipStream = [IO.File]::Open($temporaryZip, [IO.FileMode]::CreateNew)
    $writer = [IO.Compression.ZipArchive]::new($zipStream, [IO.Compression.ZipArchiveMode]::Create, $false, [Text.Encoding]::UTF8)
    try {
      $base = (Resolve-Path -LiteralPath $stage).Path.TrimEnd([char]92) + [char]92
      foreach ($file in Get-ChildItem -LiteralPath $stage -Recurse -File -Force) {
        $name = $file.FullName.Substring($base.Length).Replace([char]92, [char]47)
        $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($writer, $file.FullName, $name, [IO.Compression.CompressionLevel]::Optimal)
      }
    } finally { $writer.Dispose(); $zipStream.Dispose() }
    $archive = [IO.Compression.ZipFile]::OpenRead($temporaryZip)
    try {
      $entries = @($archive.Entries.FullName -replace '\\', '/')
      $required = @('安装 TheOne.cmd','卸载 TheOne.cmd','安装说明.txt','INSTALL.md','installer/install.mjs','.agents/plugins/marketplace.json','theone/plugin.json','theone/.codex-plugin/plugin.json','theone/mcp.json','theone/.mcp.json','theone/node/node.exe','theone/node/LICENSE','theone/server/main.mjs','theone/ui/theone.html','theone/skills/theone/SKILL.md','theone/LICENSE','theone/THIRD_PARTY_NOTICES.txt','client-adapter/patches.mjs','client-adapter/build.mjs','client-adapter/install-launcher.mjs','client-adapter/archive.mjs')
      foreach ($name in $required) { if ($entries -notcontains $name) { throw "Missing packaged file: $name" } }
    } finally { $archive.Dispose() }
    if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath }
    Move-Item -LiteralPath $temporaryZip -Destination $archivePath
    $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText(($archivePath + '.sha256'), "$hash  $([IO.Path]::GetFileName($archivePath))`n", [Text.UTF8Encoding]::new($false))
    return $archivePath
  } finally {
    Remove-PackageStage -Path $stage -Parent $stageParent
    if (Test-Path -LiteralPath $temporaryZip) { Remove-Item -LiteralPath $temporaryZip }
  }
}

# Dot-sourcing exposes local packaging/checksum functions for offline tests.
if ($MyInvocation.InvocationName -eq '.') { return }
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
  if (-not $SkipBuild) {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
    & npm.cmd run client:payload
    if ($LASTEXITCODE -ne 0) { throw 'Client payload compilation failed' }
  }
  $version = (Get-Content -LiteralPath 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json).version
  $fileName = "node-v$PinnedNodeVersion-win-x64.zip"
  $cache = Join-Path $projectRoot ".theone/downloads/node-v$PinnedNodeVersion"
  $null = New-Item -ItemType Directory -Path $cache -Force
  if ([bool]$NodeArchive -ne [bool]$NodeShasums) { throw 'Supply both -NodeArchive and -NodeShasums, or neither.' }
  if (-not $NodeArchive) {
    $NodeArchive = Join-Path $cache $fileName
    $NodeShasums = Join-Path $cache 'SHASUMS256.txt'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $base = "https://nodejs.org/dist/v$PinnedNodeVersion"
    if (-not (Test-Path -LiteralPath $NodeArchive)) { Invoke-WebRequest -UseBasicParsing -Uri "$base/$fileName" -OutFile $NodeArchive }
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt" -OutFile $NodeShasums
  }
  Test-NodeChecksum -Archive $NodeArchive -Shasums $NodeShasums -FileName $fileName
  $extract = Join-Path $cache ('extract-' + [Guid]::NewGuid().ToString('N'))
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory([IO.Path]::GetFullPath($NodeArchive), $extract)
    $runtimeRoot = Join-Path $extract "node-v$PinnedNodeVersion-win-x64"
    $nodeVersion = & (Join-Path $runtimeRoot 'node.exe') --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne "v$PinnedNodeVersion") { throw 'Portable Node version does not match the pinned release' }
    $archive = New-TheOneWindowsArchive -ProjectRoot $projectRoot -RuntimeRoot $runtimeRoot -Version $version
    Write-Output "Packaged: $archive"
    Write-Output "SHA256: $archive.sha256"
  } finally { Remove-PackageStage -Path $extract -Parent $cache }
} finally { Pop-Location }
