import { readFile, writeFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const build = JSON.parse(await readFile(join(workspace, 'evidence/client-adapter-build.json'), 'utf8'))
const runtime = JSON.parse(await readFile(join(workspace, 'evidence/client-adapter-runtime.json'), 'utf8'))
const executable = await realpath(join(build.clientApp, 'ChatGPT.exe'))
const clientRoot = await realpath(join(workspace, '.theone/desktop-client'))
if (!executable.toLowerCase().startsWith(clientRoot.toLowerCase() + '\\')) throw new Error('Client is outside the local build directory')
if (runtime.executable !== executable || runtime.error || !runtime.nativeDraftVerified || !runtime.adjacentToNewChat || !runtime.nativeMcpTopicDirectoryVerified || !runtime.nativeSettingsVerified) {
  throw new Error('Verify this exact client build before installing its launcher')
}

const vbString = value => '"' + value.replaceAll('"', '""') + '"'
const psString = value => "'" + value.replaceAll("'", "''") + "'"
const launcher = join(workspace, '启动 TheOne Codex.vbs')
const originalExe = join(build.sourceApp, 'ChatGPT.exe')
// UTF-16 preserves Chinese strings in Windows Script Host without code-page changes.
const script = `Option Explicit
Dim sh, fs, clientExe, originalExe, clientRoot, processes, item, checkOnly
checkOnly = False
If WScript.Arguments.Count = 1 Then checkOnly = (WScript.Arguments(0) = "--check")
Set sh = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
clientExe = ${vbString(executable)}
originalExe = ${vbString(originalExe)}
clientRoot = ${vbString(clientRoot + '\\')}
If Not fs.FileExists(clientExe) Then
  If checkOnly Then
    WScript.Echo "missing-client"
    WScript.Quit 1
  End If
  MsgBox "找不到 TheOne 客户端副本。请保留 gpt-theone 项目目录，或重新构建客户端适配。", 48, "Codex TheOne"
  WScript.Quit 1
End If
Set processes = GetObject("winmgmts:\\\\.\\root\\cimv2").ExecQuery("SELECT ExecutablePath FROM Win32_Process WHERE Name='ChatGPT.exe'")
For Each item In processes
  If Not IsNull(item.ExecutablePath) Then
    If LCase(item.ExecutablePath) = LCase(originalExe) Or (InStr(1, LCase(item.ExecutablePath), LCase(clientRoot), vbTextCompare) = 1 And LCase(item.ExecutablePath) <> LCase(clientExe)) Then
      If checkOnly Then
        WScript.Echo "older-or-original-client-running"
        WScript.Quit 0
      End If
      MsgBox "请先从「文件」菜单完全退出当前 Codex（包括旧版 TheOne），再双击「Codex TheOne」。当前客户端仍在运行时，新的版本无法接管窗口。聊天记录会保留。", 64, "Codex TheOne"
      WScript.Quit 0
    End If
  End If
Next
If checkOnly Then
  WScript.Echo "ready"
  WScript.Quit 0
End If
sh.CurrentDirectory = fs.GetParentFolderName(clientExe)
sh.Run Chr(34) & clientExe & Chr(34), 1, False
`
await writeFile(launcher, Buffer.from('\ufeff' + script.replaceAll('\n', '\r\n'), 'utf16le'))

const powershell = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$launcherPath = ${psString(launcher)}
$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath 'Codex TheOne.lnk'
$shellObject = New-Object -ComObject WScript.Shell
$shortcut = $shellObject.CreateShortcut($shortcutPath)
$launcherHost = Join-Path $env:WINDIR 'System32\\wscript.exe'
$launcherArgs = '"' + $launcherPath + '"'
if ((Test-Path -LiteralPath $shortcutPath) -and ($shortcut.TargetPath -ne $launcherHost -or $shortcut.Arguments -ne $launcherArgs)) {
  throw 'An unrelated shortcut already exists; refusing to overwrite it'
}
$shortcut.TargetPath = $launcherHost
$shortcut.Arguments = $launcherArgs
$shortcut.WorkingDirectory = ${psString(workspace)}
$shortcut.IconLocation = ${psString(executable + ',0')}
$shortcut.Description = 'TheOne button beneath New chat; original Codex chat interface'
$shortcut.Save()
$verified = $shellObject.CreateShortcut($shortcutPath)
@{ shortcut=$shortcutPath; target=$verified.TargetPath; arguments=$verified.Arguments; originalClientPreserved=$true } | ConvertTo-Json -Compress
`
const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', powershell], { encoding: 'utf8', windowsHide: true })
const shortcut = JSON.parse(output.trim())
const report = { installedAt: new Date().toISOString(), adapterVersion: build.adapterVersion, launcher, executable, ...shortcut, launched: false }
await writeFile(join(workspace, 'evidence/client-adapter-install.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
