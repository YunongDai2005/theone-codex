export const PLUGIN_MENTION = '[@TheOne](plugin://gpt-theone@theone-local) '

export function createNativeHost({ scope, modules, preview, startDraft }) {
  const ids = modules('DBCl'), binding = modules('V3rO'), keys = modules('d6Ff'), sidebar = modules('RFDv')
  const account = modules('SPnB'), hostId = modules('kfGJ').fI
  const profileId = JSON.stringify([scope.get(account.chatGptAuthenticatedUserId$), scope.get(account.chatGptAuthenticatedAccountId$), hostId])
  const storageKey = 'theone-main-v1:' + profileId
  const current = (get = (...args) => scope.get(...args)) => {
    const location = get(modules('nlNF').x2)
    const clientThreadId = keys.OC(get(sidebar.oN)) ?? (location?.pathname === '/' ? get(binding.RH, modules('yWTM').w9({ entrypoint: 'home' })) : null)
    const threadId = clientThreadId ? ids.L$F(clientThreadId) ? get(binding.Tl, clientThreadId) : clientThreadId : null
    return { clientThreadId, threadId, workspace: get(modules('ndjw').pY), locationKey: location?.key ?? location?.pathname }
  }
  const host = {
    profileId, preview, current,
    load: () => { try { return JSON.parse(localStorage.getItem(storageKey) ?? 'null') } catch { return null } },
    save: record => localStorage.setItem(storageKey, JSON.stringify(record)),
    resolveThread: (id, get = (...args) => scope.get(...args)) => get(binding.Tl, id),
    watch: (callback, pendingId) => scope.watch(({ get }) => { const value = current(get); if (pendingId()) get(binding.Tl, pendingId()); callback(value) }),
    watchSend: callback => {
      const listener = event => {
        const value = event.detail
        if (value?.hostId !== hostId || typeof value.threadId !== 'string' || typeof value.text !== 'string') return
        try { Promise.resolve(callback(value)).catch(() => {}) } catch {}
      }
      window.addEventListener('theone-user-send', listener)
      return () => window.removeEventListener('theone-user-send', listener)
    },
    call: async (tool, args) => {
      const currentProfile = JSON.stringify([scope.get(account.chatGptAuthenticatedUserId$), scope.get(account.chatGptAuthenticatedAccountId$), hostId])
      if (currentProfile !== profileId) throw Error('账户已切换，请重新打开 TheOne。')
      const result = await modules('ILnd').W1(scope, hostId, 'theone', tool, args, { retryOnTransportClosed: false })
      if (result.isError) throw Object.assign(Error(result.content?.find(item => item.type === 'text')?.text ?? 'TheOne 请求未完成'), { statusCode: result.structuredContent?.statusCode })
      return result.structuredContent?.result ?? JSON.parse(result.content.find(item => item.type === 'text').text)
    },
    readThread: id => modules('Dgwo').V(scope, hostId).readThread(id, { includeTurns: false }),
    openThread: async id => {
      const path = ids._RT(id), navigation = scope.get(modules('E8Sp').gM)
      host.openingNative = true
      try {
        modules('hvSK').hI(scope, { kind: 'chat', clientThreadId: scope.get(binding.oB, id) ?? id,
          routePath: path, state: { ...host.preview, sidebarProductMode: 'codex' },
          navigate: state => navigation.navigate(path, { state }) })
      } finally { host.openingNative = false }
    },
    newDraft: async () => {
      const workspace = current().workspace
      if (!workspace) throw Error('先在 Codex 中选择一个项目，再打开 TheOne。')
      return new Promise((resolve, reject) => {
        host.openingNative = true
        try {
          startDraft({ ...host.preview, codexAppMode: 'codex', prefillComposerMode: 'work', selectChat: true,
            freshDraft: true, prefillPrompt: PLUGIN_MENTION, prefillPromptFormat: 'markdown', theoneGatewayDraft: true }, () => {
            const clientThreadId = scope.get(binding.RH, modules('yWTM').w9({ entrypoint: 'home' }))
            host.openingNative = false
            if (!clientThreadId) reject(Error('无法读取原生聊天草稿，请重试。'))
            else resolve({ clientThreadId, workspace })
          })
        } catch (error) { host.openingNative = false; reject(error) }
      })
    },
  }
  return host
}
