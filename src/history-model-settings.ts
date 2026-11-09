export interface HistoryModelSettings { model: string; effort: string; fast: boolean }
export interface HistoryModelChoice {
  model: string
  displayName: string
  description: string
  reasoningEfforts: string[]
  defaultEffort: string
  fastTier: string | null
}

// Economy preference reviewed 2026-11-09 against the official model catalog.
// Never infer price from list order or fall back to the user's expensive global default.
export function recommendedHistoryModel(models: HistoryModelChoice[]): HistoryModelSettings | null {
  for (const model of ['gpt-6-luna', 'gpt-5.6-luna']) {
    if (models.some(m => m.model === model && m.reasoningEfforts.includes('medium')))
      return { model, effort: 'medium', fast: false }
  }
  return null
}

export function validateHistoryModel(settings: HistoryModelSettings, models: HistoryModelChoice[]) {
  const model = models.find(m => m.model === settings.model)
  if (!model) throw Error('所选整理模型当前不可用，请重新选择模型。')
  if (!model.reasoningEfforts.includes(settings.effort)) throw Error('所选模型不支持这个思考强度，请重新选择。')
  if (settings.fast && !model.fastTier) throw Error('所选模型不支持快速模式，请关闭快速后重试。')
  return { settings: { model: model.model, effort: settings.effort, fast: settings.fast }, serviceTier: settings.fast ? model.fastTier! : 'default' }
}
