import { spawn } from 'node:child_process'
import { readFile, mkdir, writeFile, unlink, mkdtemp, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { TheOneService } from '../dist/service.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { verifyHistoryUi } from './verify-history-ui.mjs'
const historyMode = process.env.THEONE_VERIFY_HISTORY === '1'

const build = JSON.parse(await readFile('evidence/client-adapter-build.json', 'utf8'))
const root = resolve('.theone/client-runtime-check'), profile = join(root, 'profile')
await mkdir(profile, { recursive: true })
const testData = await mkdtemp(join(root, 'topic-fixture-'))
const testEnv = { ...process.env, CODEX_ELECTRON_USER_DATA_PATH: profile }
const fixture = new TheOneService({ dataDir: testData })
if (!historyMode) {
  fixture.runtime.put('catalog-native-consent', 'main', 'declined')
  fixture.createTopic('写作计划', '整理章节结构，继续完成开头。')
  fixture.createTopic('旅行安排', '行程、住宿与随身物品。')
}
await fixture.close()
const fixtureClient = new Client({ name: 'desktop-fixture', version: '1' })
await fixtureClient.connect(new StdioClientTransport({ command: process.execPath, args: historyMode ? ['--import', 'tsx', resolve('tests/fixtures/history-mcp.ts')] : [resolve('release/theone/server/main.mjs')], env: { ...process.env, THEONE_DATA_DIR: testData }, stderr: 'pipe' }))
await unlink(join(profile, 'DevToolsActivePort')).catch(error => { if (error.code !== 'ENOENT') throw error })
const child = spawn(join(build.clientApp, 'ChatGPT.exe'), [
  `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
  '--enable-logging=stderr', `codex://threads/new?path=${encodeURIComponent(process.cwd())}`,
], { cwd: build.clientApp, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  env: testEnv,
})
let stderr = '', exited = false, browser, page
child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-200000) })
child.on('exit', code => { exited = true; console.log(JSON.stringify({ event: 'local-client-exit', code })) })
child.on('error', error => { exited = true; console.log(JSON.stringify({ event: 'local-client-error', code: error.code, message: error.message })) })
const report = { checkedAt: new Date().toISOString(), processId: child.pid, executable: join(build.clientApp, 'ChatGPT.exe'), isolatedProfile: profile,
  adapterVersion: build.adapterVersion, isolatedTopicData: testData, topicTransport: 'isolated real MCP server through test-only bridge; native navigation retained',
  runtimeLaunchVerified: false, buttonPresent: false, adjacentToNewChat: false, nativeDraftVerified: false, modelMessageSent: false }
try {
  let port
  for (let attempt = 0; attempt < 150 && !exited; attempt++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  if (!port) throw new Error(exited ? 'Adapted client exited before opening its test interface' : 'Adapted client did not expose a test interface within 30 seconds')
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  report.runtimeLaunchVerified = true
  let button
  for (let attempt = 0; attempt < 150 && !exited; attempt++) {
    const pages = browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed() && page.url().startsWith('app://-/'))
    for (const candidate of pages) {
      const entry = candidate.locator('[data-theone-native-entry]')
      if (await entry.isVisible().catch(() => false)) { page = candidate; button = entry; break }
    }
    if (page) break
    if (attempt % 10 === 0) console.log(JSON.stringify({ event: 'waiting-for-native-sidebar', poll: attempt, pages: pages.map(page => new URL(page.url()).pathname) }))
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  if (!page) {
    const pages = browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed() && page.url().startsWith('app://-/'))
    report.pages = await Promise.all(pages.map(async page => ({ path: new URL(page.url()).pathname, title: await page.title().catch(() => ''), buttonLabels: await page.getByRole('button').allTextContents().then(labels => labels.slice(0,25)).catch(() => []) })))
    if (pages[0]) await pages[0].screenshot({ path: join(root, 'startup.png') }).catch(() => {})
    throw new Error('The local client did not show the Codex sidebar button within 60 polls')
  }
  report.buttonPresent = true
  console.log(JSON.stringify({ event: 'native-button-found' }))
  // The startup renderer can be replaced after it first becomes visible. Let the
  // native window settle, then read the live DOM in a single renderer operation.
  page.setDefaultTimeout(60000)
  await page.waitForTimeout(2500)
  const state = await page.evaluate(() => {
    const element = document.querySelector('[data-theone-native-entry]')
    if (!element) throw new Error('The native entry disappeared during startup')
    const row = element.closest('button') ?? element
    const css = getComputedStyle(element)
    return { adjacent: /新聊天|New chat/i.test(row.previousElementSibling?.textContent ?? ''),
      appearance: { height: element.getBoundingClientRect().height, background: css.backgroundColor, border: css.borderColor,
      radius: css.borderRadius, shadow: css.boxShadow,
      wordmark: element.querySelector('.theone-wordmark')?.textContent,
      subtitle: element.querySelector('.theone-entry-sub')?.textContent,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches },
      membrane: element.querySelector('[data-part="membrane"]')?.getAttribute('d') }
  })
  report.adjacentToNewChat = state.adjacent
  report.brandAppearance = state.appearance
  console.log(JSON.stringify({ event: 'native-button-appearance', ...state.appearance }))
  const beforeAnimation = state.membrane
  await page.waitForTimeout(1200)
  const afterAnimation = await page.evaluate(() => document.querySelector('[data-theone-native-entry] [data-part="membrane"]')?.getAttribute('d'))
  report.originalCellAnimationVerified = !!beforeAnimation && beforeAnimation !== afterAnimation
  // A changed path alone does not prove visible motion: sample the nucleus for two seconds.
  report.cellMotion = await page.evaluate(async () => {
    const nucleus = () => document.querySelector('[data-theone-native-entry] [data-part="nucleus"]')
    const samples = []
    for (let i = 0; i < 40; i++) { const n = nucleus(); if (n) samples.push([+n.getAttribute('cx'), +n.getAttribute('cy'), +n.getAttribute('r')]); await new Promise(r => setTimeout(r, 50)) }
    const span = k => samples.length ? Math.max(...samples.map(s => s[k])) - Math.min(...samples.map(s => s[k])) : 0
    return { reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, samples: samples.length,
      distinct: new Set(samples.map(s => s.join())).size, cxSpan: span(0), cySpan: span(1), rSpan: span(2),
      renderedPx: document.querySelector('[data-theone-native-entry] .theone-symbol')?.getBoundingClientRect().width ?? 0 }
  })
  // The topic cells under the card should breathe and drift like DSH's, not sit still.
  report.foamMotion = await page.evaluate(async () => {
    const cells = () => [...document.querySelectorAll('.theone-foam [data-part="cells"] > g')]
    const shot = () => cells().map(g => (g.getAttribute('transform') ?? '') + '|' + (g.querySelector('path')?.getAttribute('d')?.slice(0, 60) ?? ''))
    const frames = []
    for (let i = 0; i < 20; i++) { frames.push(shot()); await new Promise(r => setTimeout(r, 100)) }
    return { cells: frames[0].length, distinctFrames: new Set(frames.map(f => f.join('#'))).size, firstFrame: frames[0].slice(0, 2) }
  })
  console.log(JSON.stringify({ event: 'foam-motion', ...report.foamMotion }))
  console.log(JSON.stringify({ event: 'cell-motion', ...report.cellMotion }))
  if (report.brandAppearance.height < 64 || report.brandAppearance.wordmark !== 'TheOne' || report.brandAppearance.radius !== '12px') throw new Error('DSH card dimensions or wordmark did not render')
  if (!report.brandAppearance.reducedMotion && !report.originalCellAnimationVerified) throw new Error('The copied DSH cell animation is not running')
  // Keep account credentials and user topics in their normal home. Only this
  // isolated window's TheOne controller is pointed at a throwaway MCP server.
  // Native navigation, draft handling, DOM and upstream foam all run unchanged.
  await page.exposeFunction('__theoneFixtureTool', async (name, args) => {
    if (!['theone_desktop_state','theone_desktop_bind','theone_select_topic','theone_create_topic','theone_manage_topic','theone_merge_topics','theone_unmerge_topic','theone_configure','theone_history_models','theone_history_sessions','theone_history_consent','theone_history_exclude','theone_history_refresh','theone_history_pause'].includes(name)) throw Error('Test operation not allowed')
    const result = await fixtureClient.callTool({ name, arguments: args })
    if (result.isError) throw Error(result.content.find(c => c.type === 'text')?.text)
    return result.structuredContent.result
  })
  await page.evaluate(async () => {
    const button = document.querySelector('[data-theone-native-entry]')
    let fiber = button[Object.keys(button).find(k => k.startsWith('__reactFiber$'))], controller
    for (; fiber && !controller; fiber = fiber.return) for (let hook = fiber.memoizedState; hook && !controller; hook = hook.next) {
      const value = Array.isArray(hook.memoizedState) ? hook.memoizedState[0] : null
      if (value?.host?.profileId && typeof value.getSnapshot === 'function') controller = value
    }
    if (!controller) throw Error('Test could not locate the adapter controller')
    controller.host.call = window.__theoneFixtureTool
    controller.save(null)
    await controller.refresh()
  })
  if (historyMode) { await verifyHistoryUi(page, button, report) } else {
  const navigation = button.locator('..')
  await navigation.screenshot({ path: join(root, 'navigation.png') })
  console.log(JSON.stringify({ event: 'native-button-screenshot-saved' }))
  await button.click()
  const editor = page.locator('[contenteditable="true"]').filter({ visible: true }).last()
  await editor.waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForFunction(() => [...document.querySelectorAll('[contenteditable="true"]')].some(e => e.textContent.includes('TheOne')), null, { timeout: 30000 })
  report.nativeDraftVerified = true
  report.nativeDraftText = await editor.innerText()
  report.brandActiveInDraft = await button.locator('.theone-nav').getAttribute('data-active')
  if (report.brandActiveInDraft !== 'true') throw Error('The main entry did not stay active in the native draft')
  await editor.press('End'); await editor.pressSequentially('TheOne draft retention check', { delay: 5 })
  await button.click(); await page.waitForTimeout(800)
  if (!(await editor.innerText()).includes('TheOne draft retention check')) throw Error('Repeated click cleared the unsent native draft')
  report.repeatedClickPreservesDraft = true
  const cells = page.locator('[data-theone-cells] .theone-cell:not(.more)')
  await cells.first().waitFor({ state: 'visible', timeout: 15000 })
  if (await cells.count() !== 2) throw Error('The upstream DSH cells did not render the isolated topic model')
  report.upstreamCellsVerified = true
  await page.getByRole('button', { name: '所有话题', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '所有话题' })
  await dialog.waitFor()
  await dialog.getByRole('button', { name: '写作计划', exact: false }).waitFor({ timeout: 30000 })
  report.nativeMcpTopicDirectoryVerified = true
  report.popupContrast = await dialog.evaluate(element => {
    const css = getComputedStyle(element), color = getComputedStyle(element.querySelector('button')).color
    const luminance = value => { const rgb = value.match(/[\d.]+/g).slice(0,3).map(n => Number(n)/255).map(n => n <= .04045 ? n/12.92 : ((n+.055)/1.055)**2.4); return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2] }
    const a = luminance(color), b = luminance(css.backgroundColor)
    return { text: color, background: css.backgroundColor, ratio: (Math.max(a,b)+.05)/(Math.min(a,b)+.05) }
  })
  if (report.popupContrast.ratio < 4.5) throw Error('The native topic popup text is not legible against its background')
  await dialog.screenshot({ path: join(root, 'topics.png') })
  await copyFile(join(root, 'topics.png'), 'evidence/client-topic-directory.png')
  await dialog.getByRole('searchbox', { name: '筛选话题' }).fill('旅行')
  if (await dialog.locator('.theone-foam-row').count() !== 1) throw Error('Topic search failed')
  await dialog.getByRole('button', { name: '旅行安排', exact: false }).click()
  const details = page.getByRole('dialog', { name: '旅行安排', exact: true })
  await details.getByRole('button', { name: '在主聊天接着聊', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.waitForFunction(() => [...document.querySelectorAll('.theone-foam-list button[aria-current="true"]')].some(e => e.textContent.includes('旅行安排')))
  if (!(await editor.innerText()).includes('TheOne draft retention check')) throw Error('Selecting a topic replaced the native draft')
  report.topicSelectionPreservesDraft = true
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '所有话题', exact: true }).click()
  await page.getByRole('dialog', { name: '所有话题' }).getByRole('button', { name: '写作计划', exact: false }).click()
  await page.getByRole('dialog', { name: '写作计划', exact: true }).getByRole('button', { name: '合并到…', exact: true }).click()
  await page.getByRole('dialog', { name: '并进哪个话题', exact: true }).getByRole('button', { name: '旅行安排', exact: false }).click()
  await page.waitForFunction(() => document.querySelectorAll('.theone-foam-list button').length === 1)
  report.idleMergeVerified = true
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '所有话题', exact: true }).click()
  await page.getByRole('dialog', { name: '所有话题' }).getByRole('button', { name: '旅行安排', exact: false }).click()
  await page.getByRole('dialog', { name: '旅行安排', exact: true }).getByRole('button', { name: '撤销合并「写作计划」', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.theone-foam-list button').length === 2)
  report.unmergeVerified = true
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'TheOne 设置', exact: true }).click()
  await page.getByRole('dialog', { name: 'TheOne 设置' }).waitFor()
  report.nativeSettingsVerified = true
  await page.getByRole('dialog', { name: 'TheOne 设置' }).getByRole('button', { name: '关闭', exact: true }).click()
  await button.click({ button: 'right' })
  await page.getByRole('dialog', { name: 'TheOne 设置' }).waitFor({ timeout: 3000 })
  report.rightClickSettingsVerified = true
  await page.getByRole('dialog', { name: 'TheOne 设置' }).getByRole('button', { name: '关闭', exact: true }).click()
  await page.waitForTimeout(800)
  await navigation.screenshot({ path: join(root, 'navigation.png') })
  await copyFile(join(root, 'navigation.png'), 'evidence/client-native-navigation.png')
  await page.screenshot({ path: join(root, 'native-draft.png') })
  }
} catch (error) {
  report.error = error.message
  if (page && !page.isClosed()) await page.screenshot({ path: join(root, 'failure.png'), timeout: 10000 }).catch(() => {})
} finally {
  await writeFile(join(root, 'runtime-stderr.log'), stderr)
  await writeFile(historyMode ? 'evidence/history-desktop-runtime.json' : 'evidence/client-adapter-runtime.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  if (browser) {
    try { const session = await browser.newBrowserCDPSession(); await session.send('Browser.close') } catch {}
  }
  if (!exited) child.kill()
  await fixtureClient.close()
}
if (report.error || !report.nativeDraftVerified || !report.adjacentToNewChat || (historyMode ? !report.historyManualRefreshVerified : !report.nativeMcpTopicDirectoryVerified || !report.nativeSettingsVerified)) process.exitCode = 1
