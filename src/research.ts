export interface PullSnapshot {
  url: string; title: string; sha: string; state: 'open' | 'closed'; merged: boolean
  checks: { name: string; state: string; summary: string }[]; partial: boolean
  status: 'pending' | 'passed' | 'failed'; fingerprint: string
}
export function workError(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }) }
export function pullSource(url: string): { owner: string; repo: string; number: string; url: string } {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/.exec(url)
  if (!match || ['.', '..'].includes(match[2])) throw workError('PUBLIC_GITHUB_PR_REQUIRED')
  return { owner: match[1], repo: match[2], number: match[3], url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}` }
}

/** Deliberately no credentials, arbitrary URL transport, write methods, or agent tools. */
export async function readPullRequest(url: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<PullSnapshot> {
  const source = pullSource(url)
  const base = `https://api.github.com/repos/${source.owner}/${source.repo}`
  const read = async (path: string): Promise<Record<string, any>> => {
    signal.throwIfAborted()
    const response = await fetcher(base + path, { method: 'GET', redirect: 'error', signal,
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-theone' } })
    if (!response.ok) throw workError(response.status === 403 || response.status === 429 ? 'GITHUB_RATE_LIMIT_OR_ACCESS' : response.status === 404 ? 'PUBLIC_PR_UNAVAILABLE' : 'GITHUB_READ_FAILED')
    const reader = response.body?.getReader()
    if (!reader) throw workError('GITHUB_INVALID_RESPONSE')
    const chunks: Uint8Array[] = []; let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > 512000) throw workError('GITHUB_RESPONSE_TOO_LARGE')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw workError('GITHUB_INVALID_RESPONSE')
    return data
  }
  const pr = await read(`/pulls/${source.number}`)
  if (!/^[a-f0-9]{40}$/i.test(pr.head?.sha ?? '') || !['open', 'closed'].includes(pr.state)) throw workError('GITHUB_INVALID_RESPONSE')
  if (pr.state === 'closed') return { url: source.url, title: typeof pr.title === 'string' ? pr.title.slice(0, 200) : '',
    sha: pr.head.sha, state: 'closed', merged: pr.merged === true, checks: [], partial: false, status: 'pending',
    fingerprint: createHash('sha256').update(JSON.stringify({ sha: pr.head.sha, state: 'closed', merged: pr.merged === true })).digest('hex') }
  const [runs, statuses] = await Promise.all([read(`/commits/${pr.head.sha}/check-runs?per_page=100`), read(`/commits/${pr.head.sha}/status`)])
  if (!Array.isArray(runs.check_runs) || !Array.isArray(statuses.statuses) || !Number.isInteger(runs.total_count) || !Number.isInteger(statuses.total_count)) throw workError('GITHUB_INVALID_RESPONSE')
  const text = (value: unknown, limit: number) => typeof value === 'string' ? value.slice(0, limit) : ''
  const checks = [
    ...runs.check_runs.map(run => ({ name: text(run.name, 200), state: run.status === 'completed' ? text(run.conclusion, 40) : 'pending', summary: text(run.output?.summary, 1500) })),
    ...statuses.statuses.map(item => ({ name: text(item.context, 200), state: text(item.state, 40), summary: text(item.description, 1500) })),
  ].sort((a, b) => a.name.localeCompare(b.name) || a.state.localeCompare(b.state))
  const partial = runs.total_count > runs.check_runs.length || statuses.total_count > statuses.statuses.length
  const failed = checks.some(check => ['failure', 'error', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(check.state))
  const status = failed ? 'failed' : !partial && checks.length && checks.every(check => ['success', 'neutral', 'skipped'].includes(check.state)) ? 'passed' : 'pending'
  const state = pr.state as PullSnapshot['state'], merged = pr.merged === true
  const fingerprint = createHash('sha256').update(JSON.stringify({ sha: pr.head.sha, state, merged, partial, checks: checks.map(({ name, state }) => ({ name, state })) })).digest('hex')
  return { url: source.url, title: text(pr.title, 200), sha: pr.head.sha, state, merged, checks: checks.slice(0, 20), partial: partial || checks.length > 20, status, fingerprint }
}
import { createHash } from 'node:crypto'
