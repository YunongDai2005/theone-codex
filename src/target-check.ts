import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export interface TargetCheck {
  title: string
  alternateTitles: string[]
  uncertain: boolean
  answer?: 'confirmed' | 'declined'
}

// Resolve existing ancestors as well as the final path, so a new file under a
// symlink cannot appear to belong to this workspace just because of its spelling.
function canonical(path: string): string {
  const absolute = resolve(path)
  let ancestor = absolute
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor)
  try { return resolve(realpathSync.native(ancestor), relative(ancestor, absolute)) } catch { return absolute }
}
export function targetQuestion(check: TargetCheck, cwd: string, details: Record<string, any>): string | undefined {
  if (check.answer) return
  if (check.uncertain || check.alternateTitles.length) return check.alternateTitles.length
    ? `这条消息放在了「${check.title}」，但也可能是「${check.alternateTitles.join('」或「')}」的事。确定在当前话题里做这个改动吗？`
    : `暂时无法确认这条消息属于哪个话题，目前放在「${check.title}」。确定在当前话题里做这个改动吗？`
  const roots = ['cwd','workdir','path','file_path','notebook_path','grantRoot'].flatMap(key => typeof details[key] === 'string' ? [details[key]] : [])
  const permissions = details.additionalPermissions?.fileSystem
  for (const path of Array.isArray(permissions?.write) ? permissions.write : []) if (typeof path === 'string') roots.push(path)
  for (const entry of Array.isArray(permissions?.entries) ? permissions.entries : []) {
    if (entry.access !== 'write') continue
    if (entry.path?.type === 'path' && typeof entry.path.path === 'string') roots.push(entry.path.path)
    else return `「${check.title}」请求的写入范围无法限定到话题工作目录。确定由这个话题继续吗？`
  }
  for (const change of Array.isArray(details.changes) ? details.changes : []) {
    if (typeof change.path === 'string') roots.push(change.path)
    if (typeof change.kind?.move_path === 'string') roots.push(change.kind.move_path)
    if (typeof change.kind?.movePath === 'string') roots.push(change.kind.movePath)
  }
  const root = canonical(cwd)
  for (const raw of roots) {
    const target = canonical(resolve(cwd, raw)), rel = relative(root, target)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))
      return `「${check.title}」将操作工作目录之外的 ${raw}。确定由这个话题继续吗？`
  }
}
