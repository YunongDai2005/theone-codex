// DSH a943701 RouteList layout and routes.* / feedback.* wording, using native controls.
export function RoutePanel({ React, routes, stats, topics, busy, move, report, error, retry }) {
  const h = React.createElement, titleOf = id => topics.find(t => t.id === id)?.title ?? '（已删除的话题）'
  return h('section', { className: 'theone-routes', 'data-theone-routes': true },
    h('p', { className: 'theone-muted' }, '分错了就在这里改，TheOne 会记住。在主聊天里说「分错了」也行。'),
    stats?.total ? h('p', { className: 'theone-muted' }, `最近 ${stats.total} 条，${Math.round(100 * (stats.total - stats.corrected) / stats.total)}% 分对`) : null,
    error ? h('p', { role: 'alert', className: 'theone-native-error' }, error, h('button', { type: 'button', onClick: retry }, '重试')) : null,
    routes === null ? h('p', { role: 'status' }, '正在读取分配记录…') : routes.length ? h('ol', null, ...routes.map(route => {
      const target = route.decision.contextId, receipt = route.receipt
      const details = [receipt?.mode === 'llm' ? receipt.model : receipt ? '规则判断' : undefined,
        receipt?.elapsedMs !== undefined ? `${(receipt.elapsedMs / 1000).toFixed(1)} s` : undefined,
        receipt?.errorCode ? `分类出错：${receipt.errorCode}` : undefined].filter(Boolean).join(' · ')
      return h('li', { key: route.inputId },
        h('time', null, new Date(route.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })),
        h('q', { title: route.excerpt }, route.excerpt || '…'),
        h('div', { className: 'theone-route-target' }, h('strong', null, route.decision.action === 'CLARIFY' ? '? 追问' : `→ ${titleOf(target)}`), h('small', null, details)),
        h('div', { className: 'theone-route-actions' },
          h('button', { type: 'button', onClick: () => report(route.inputId) }, '报告问题'),
          route.correctedTo ? h('span', null, `已改到 ${titleOf(route.correctedTo)} `,
            h('button', { type: 'button', disabled: busy, onClick: () => move(route.inputId, undefined, true) }, '撤销')) : h(React.Fragment, null,
            ...(route.decision.alternateIds ?? []).filter(id => id !== target && topics.some(t => t.id === id)).slice(0, 2).map(id =>
              h('button', { key: id, type: 'button', disabled: busy, onClick: () => move(route.inputId, id) }, `换到 ${titleOf(id)}`)),
            h('select', { 'aria-label': '改到…', value: '', disabled: busy, onChange: e => { if (e.target.value) move(route.inputId, e.target.value) } },
              h('option', { value: '' }, '改到…'), ...topics.filter(t => t.id !== target).map(t => h('option', { key: t.id, value: t.id }, t.title))))))
    })) : h('p', null, '还没有分配记录。'))
}

export function FeedbackPanel({ React, description, change, diagnostics, adapterVersion = 'unknown', loading, error, copy, copied, copying }) {
  const h = React.createElement
  const report = [description.trim(), '', '诊断信息', JSON.stringify({ ...(diagnostics ?? { version: 'unknown', codexVersion: 'unknown', routes: [] }), adapterVersion }, null, 2)].join('\n')
  return h('section', { className: 'theone-feedback', 'data-theone-feedback': true },
    h('p', null, '说说发生了什么。下面能看到将要复制的全部内容。'),
    h('label', null, '发生了什么？', h('textarea', { value: description, maxLength: 12000, rows: 5,
      placeholder: '比如：回复里出现乱码、分错了话题、某个按钮没反应', onChange: e => change(e.target.value) })),
    h('p', { className: 'theone-muted' }, '诊断信息仅含版本、路由来源、错误码和耗时，不含聊天正文、话题标题和本机路径。内容保留在本机；打开 GitHub 或邮件后，请自行粘贴并提交。'),
    loading ? h('p', { role: 'status' }, '正在整理诊断信息…') : null,
    error ? h('p', { role: 'alert', className: 'theone-native-error' }, '诊断信息没有整理出来，你仍然可以写下问题，复制后发邮件到 theone@yulid.org。') : null,
    h('h3', null, '要复制的内容'), h('pre', { tabIndex: 0 }, report),
    h('footer', { className: 'theone-history-actions' },
      h('button', { type: 'button', disabled: loading || copying || !description.trim(), onClick: () => copy(report) }, copied ? '已复制' : '复制内容'),
      h('a', { href: 'https://github.com/YunongDai2005/theone-codex/issues/new', target: '_blank', rel: 'noreferrer' }, '在 GitHub 提交'),
      h('a', { href: 'mailto:theone@yulid.org' }, '发邮件')))
}
