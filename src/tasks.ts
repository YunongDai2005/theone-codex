import { join } from 'node:path'
import { PersistentWork } from './persistent-work.ts'
import type { TheOneService } from './service.ts'
import type { WorkNotice } from './work-store.ts'

export class TaskManager {
  readonly work: PersistentWork
  constructor(private service: TheOneService, dataDir: string, fetcher: typeof fetch = fetch) {
    this.work = new PersistentWork(join(dataDir, 'tasks.db'), {
      available: task => service.settings(task.gatewayId).enabled && (!task.contextId || service.listTopics().some(t => t.id === task.contextId)),
      analyze: async (_task, snapshot) => ({ summary: 'CI 检查失败。', nextStep: `查看 ${snapshot.url} 中的失败检查；尚未自动修改代码。` }),
      memory: async () => ({ waiting: 'UNSUPPORTED_TASK_KIND' }),
      notify: async notice => { service.runtime.put('notice', notice.id, notice); return true },
    }, fetcher)
    this.work.start()
  }
  create(input: { gatewayId: string; key: string; topicId?: string; url: string; objective: string; [key: string]: unknown }) {
    const settings = this.service.settings(input.gatewayId)
    if (!settings.enabled) throw new Error('GATEWAY_DISABLED')
    if (input.topicId) this.service.readTopic(input.topicId)
    return this.work.create(input, { key: JSON.stringify([input.gatewayId, input.key]), gatewayId: input.gatewayId, sessionId: `theone:${input.topicId ?? input.gatewayId}`, contextId: input.topicId })
  }
  list() { return { tasks: this.work.store.list(), notices: this.service.runtime.all<WorkNotice>('notice') } }
  control(id: string, action: 'pause' | 'resume' | 'cancel' | 'wake') { return { changed: this.work.scheduler.control(id, action), task: this.work.store.get(id) } }
  acknowledge(id: string) { this.service.runtime.remove('notice', id); return { acknowledged: id } }
  async close() { await this.work.close() }
}
