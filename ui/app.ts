import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps'

type Topic = { id: string; title: string; summary?: string; private?: boolean; done?: boolean }
type Snapshot = { mode?: 'launcher' | 'topics'; topics: Topic[] }
const app = new App({ name: 'TheOne', version: '0.1.0-alpha.2' }, { availableDisplayModes: ['inline', 'fullscreen'] }, { autoResize: false })
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
let snapshot: Snapshot | undefined, connected = false, launchRequested = false, busy = false
let createdTopic: string | undefined
function status(text: string, failed = false) { $('status').textContent = text; $('status').classList.toggle('error', failed) }
function setTheme(context: ReturnType<App['getHostContext']>) {
  if (context?.theme) applyDocumentTheme(context.theme)
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables)
}
function nativeMessagesSupported() {
  const capabilities = app.getHostCapabilities()
  const extensions = (capabilities?.experimental ?? (capabilities as any)?.extensions) as Record<string, unknown> | undefined
  return !!capabilities?.message?.text && extensions?.['openai/message'] != null
}
async function call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await app.callServerTool({ name, arguments: args })
  if (result.isError) throw new Error(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n') || '操作失败')
  return (result.structuredContent as { result: T }).result
}
async function draft(target: 'new' | 'active', topicId?: string) {
  if (!nativeMessagesSupported()) throw new Error('当前宿主未提供打开原生聊天的接口')
  const content: Parameters<App['sendMessage']>[0]['content'] = topicId ? [
    { type: 'text', text: '用 TheOne 继续所选话题。接下来我想：' },
    { type: 'text', text: JSON.stringify({ theoneTopicId: topicId }), _meta: { 'openai/title': 'TheOne 话题' } },
  ] : [{ type: 'text', text: '用 TheOne 管理这个项目的话题，保留 Codex 原有聊天界面。请先按 theone 技能配置本聊天入口，然后处理下面的内容：\n\n' }]
  const result = await app.sendMessage({ role: 'user', content, _meta: { 'openai/message': { target, send: false } } })
  if (result.isError) throw new Error('Codex 没有接受打开聊天的请求。')
  status(target === 'new' ? '已打开原生聊天' : '已放入当前聊天输入框')
}
async function launch() {
  if (busy) return
  busy = true; $<HTMLButtonElement>('launch').disabled = true
  try { await draft('new') }
  catch (e) { status(e instanceof Error ? e.message : String(e), true) }
  finally { busy = false; $<HTMLButtonElement>('launch').disabled = !nativeMessagesSupported() }
}
function renderTopics() {
  const list = $('topics'); list.replaceChildren()
  const query = $<HTMLInputElement>('filter').value.toLocaleLowerCase()
  for (const topic of snapshot?.topics.filter(t => t.title.toLocaleLowerCase().includes(query)) ?? []) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'topic'
    row.setAttribute('aria-label', `切换到${topic.title}`)
    const title = document.createElement('span'); title.textContent = topic.title; title.className = 'topic-title'
    const badge = document.createElement('small'); badge.textContent = topic.private ? '私密' : topic.done ? '已完成' : '继续'
    row.append(title, badge); row.disabled = !nativeMessagesSupported()
    row.onclick = async () => {
      if (busy) return
      busy = true; row.disabled = true
      try { await draft('active', topic.id) }
      catch (e) { status(e instanceof Error ? e.message : String(e), true) }
      finally { busy = false; row.disabled = !nativeMessagesSupported() }
    }
    list.append(row)
  }
  if (!list.children.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = query ? '没有匹配的话题' : '还没有话题。可以从上方开始一件新事情。'; list.append(empty) }
}
function render() {
  if (!snapshot || !connected) return
  const isLauncher = snapshot.mode === 'launcher'
  $('launcher').hidden = !isLauncher; $('panel').hidden = isLauncher
  if (!nativeMessagesSupported()) status('当前宿主未提供打开原生聊天的接口', true)
  $<HTMLButtonElement>('launch').disabled = !nativeMessagesSupported()
  $<HTMLButtonElement>('new-topic').disabled = !nativeMessagesSupported()
  if (isLauncher && !launchRequested) { launchRequested = true; void launch() }
  else if (!isLauncher) { renderTopics(); if (nativeMessagesSupported() && $('status').textContent === '正在连接…') status('选择一个话题即可继续') }
}
$('launch').onclick = () => void launch()
$('filter').oninput = renderTopics
$('refresh').onclick = async () => {
  try { snapshot = { ...await call<Snapshot>('theone_ui_snapshot'), mode: 'topics' }; renderTopics() }
  catch (e) { status(e instanceof Error ? e.message : String(e), true) }
}
$('new-topic').onclick = () => { createdTopic = undefined; $<HTMLInputElement>('topic-name').value = ''; $<HTMLInputElement>('topic-name').disabled = false; $('topic-error').textContent = ''; $<HTMLDialogElement>('topic-dialog').showModal() }
$('topic-close').onclick = () => $<HTMLDialogElement>('topic-dialog').close()
$('topic-form').onsubmit = async e => {
  e.preventDefault(); const save = $<HTMLButtonElement>('topic-save'); if (save.disabled) return
  save.disabled = true
  try {
    if (!createdTopic) createdTopic = (await call<{ topicId: string }>('theone_create_topic', { title: $<HTMLInputElement>('topic-name').value.trim() })).topicId
    $<HTMLInputElement>('topic-name').disabled = true
    await draft('active', createdTopic)
    $<HTMLDialogElement>('topic-dialog').close()
    snapshot = { ...await call<Snapshot>('theone_ui_snapshot'), mode: 'topics' }; renderTopics()
  } catch (e) { $('topic-error').textContent = e instanceof Error ? e.message : String(e) }
  finally { save.disabled = false }
}
app.ontoolresult = result => {
  const data = (result.structuredContent as { result?: Snapshot } | undefined)?.result
  if (data?.mode && data.topics) { snapshot = data; render() }
}
app.onhostcontextchanged = setTheme
try { await app.connect(); connected = true; setTheme(app.getHostContext()); render() }
catch (e) { status(e instanceof Error ? e.message : String(e), true) }
