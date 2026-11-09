export interface AvailableRelease { version: string; url: string; command: string }
const parseVersion = (value: string) => {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value)
  return match && { numbers: match.slice(1, 4).map(Number), pre: match[4]?.split('.') }
}
export function newerRelease(candidate: string, current: string) {
  const a = parseVersion(candidate), b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i]
  if (!a.pre || !b.pre) return !a.pre && !!b.pre
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i]
    if (x === y) continue
    if (x === undefined || y === undefined) return y === undefined
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
    return nx && ny ? Number(x) > Number(y) : nx !== ny ? !nx : x > y
  }
  return false
}

/** Public metadata only. Never reads auth, downloads an asset or runs the displayed command. */
export class ReleaseChecker {
  private checkedAt?: number
  private result: AvailableRelease | null = null
  private pending?: Promise<AvailableRelease | null>
  constructor(private current = '0.1.0', private fetcher: typeof fetch = fetch) {}
  check(force = false): Promise<AvailableRelease | null> {
    if (this.pending) return this.pending
    if (!force && this.checkedAt !== undefined && Date.now() - this.checkedAt < 6 * 3600000) return Promise.resolve(this.result)
    return this.pending = this.read().finally(() => { this.checkedAt = Date.now(); this.pending = undefined })
  }
  private async read() {
    try {
      const response = await this.fetcher('https://api.github.com/repos/YunongDai2005/theone-codex/releases/latest', {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'theone-codex' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) return this.result = null
      const release = await response.json() as { tag_name?: unknown; draft?: boolean }
      if (release.draft || typeof release.tag_name !== 'string' || release.tag_name.length > 100 || !newerRelease(release.tag_name, this.current)) return this.result = null
      return this.result = { version: release.tag_name.replace(/^v/, ''),
        url: 'https://github.com/YunongDai2005/theone-codex/releases/tag/' + encodeURIComponent(release.tag_name),
        command: '下载最新 Windows 安装包并重新运行安装程序；macOS/Linux 请按 INSTALL.md 重新构建并安装。' }
    } catch { return this.result = null }
  }
}
