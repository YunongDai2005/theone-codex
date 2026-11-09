import { validateHistoryModel, type HistoryModelChoice, type HistoryModelSettings } from './history-model-settings.ts'

export type RouterModelSettings = HistoryModelSettings
export type RouterModelChoice = HistoryModelChoice

export function recommendedRouterModel(models: RouterModelChoice[]): RouterModelSettings | null {
  for (const model of ['gpt-6-luna', 'gpt-5.6-luna']) {
    if (models.some(m => m.model === model && m.reasoningEfforts.includes('low')))
      return { model, effort: 'low', fast: false }
  }
  return null
}

export function validateRouterModel(settings: RouterModelSettings, models: RouterModelChoice[]) {
  const model = models.find(m => m.model === settings.model)
  if (!model) throw Error('ROUTER_MODEL_UNAVAILABLE')
  if (!model.reasoningEfforts.includes(settings.effort)) throw Error('ROUTER_EFFORT_UNAVAILABLE')
  if (settings.fast && !model.fastTier) throw Error('ROUTER_FAST_UNAVAILABLE')
  return validateHistoryModel(settings, models)
}
