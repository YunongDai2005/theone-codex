const effortText = { none: '不思考', minimal: '最低', low: '轻度', medium: '中度', high: '深度', xhigh: '更深', max: '最高', ultra: '超高' }
export function modelSelectionValid(options, selection) {
  const model = options?.models.find(m => m.model === selection?.model)
  return !!model && model.reasoningEfforts.includes(selection.effort) && (!selection.fast || !!model.fastTier)
}

/** Shared history/routing controls, using the established history layout and classes. */
export function ModelPicker({ React, label, options, selection, select, disabled = false, busyHint, saveHint, error, retry }) {
  const h = React.createElement, selected = options?.models.find(m => m.model === selection?.model)
  return h('div', { className: 'theone-history-models' }, options ? h(React.Fragment, null,
    h('label', { className: 'theone-history-model-label' }, label, h('select', { 'aria-label': label, value: selection?.model ?? '', disabled,
      onChange: e => select({ model: e.target.value }) },
      !selected && h('option', { value: selection?.model ?? '', disabled: true }, selection?.model ? `${selection.model}（当前不可用）` : '请选择模型'),
      ...options.models.map(m => h('option', { key: m.model, value: m.model }, m.displayName + (m.model === options.recommendedModel ? ' · 经济推荐' : ''))))),
    h('div', { className: 'theone-history-model-detail' },
      h('label', null, '思考强度', h('select', { 'aria-label': '思考强度', value: selection?.effort ?? '', disabled: disabled || !selected,
        onChange: e => select({ effort: e.target.value }) },
        selected && !selected.reasoningEfforts.includes(selection?.effort) && h('option', { value: selection?.effort ?? '', disabled: true }, '请选择思考强度'),
        ...(selected?.reasoningEfforts ?? []).map(e => h('option', { key: e, value: e }, effortText[e] ?? e)))),
      h('button', { type: 'button', className: 'theone-history-fast', 'aria-label': '快速模式', 'aria-pressed': !!selection?.fast,
        disabled: disabled || !selected?.fastTier, onClick: () => select({ fast: !selection?.fast }),
        title: selected?.fastTier ? '更快返回，消耗更多额度' : '此模型不支持快速模式' }, '⚡ 快速')),
    h('p', { className: 'theone-muted' }, busyHint || (!selected ? '请选择一个当前可用的模型。' : !selected.fastTier ? '当前模型不支持快速模式。'
      : selection.fast ? '⚡ 已开启快速：更快返回，会增加额度消耗。' : '标准速度 · 更省额度；可点亮闪电开启快速。')),
    saveHint && h('p', { className: 'theone-muted' }, saveHint))
    : error ? h('div', { role: 'alert', className: 'theone-native-error' }, '读取模型失败：', error, h('button', { type: 'button', disabled, onClick: retry }, '重新读取模型'))
    : h('p', { role: 'status' }, '正在读取可用模型…'))
}
