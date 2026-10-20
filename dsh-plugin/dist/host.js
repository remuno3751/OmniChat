// Thin, defensive adapter over dsh's internal `ctx.*` services. Every access is wrapped:
// dsh's plugin API is an internal (rc) surface, so a missing method must degrade, never crash dsh.

function safe(fn, dflt) {
  try {
    return fn()
  } catch {
    return dflt
  }
}

export function createHost(ctx, log) {
  const warned = new Set()
  const warnOnce = (key, msg) => {
    if (warned.has(key)) return
    warned.add(key)
    log(`warning: ${msg}`)
  }

  const sc = () => safe(() => ctx.sessionController, undefined)
  const svc = (name) => safe(() => ctx.get(name), undefined)

  const host = {
    warnOnce,

    /** Names of required capabilities that are missing (for a single startup warning). */
    missing() {
      const s = sc()
      const out = []
      if (!s) return ['sessionController']
      for (const m of ['list', 'create', 'prompt', 'cancel', 'modelCatalog']) if (typeof s[m] !== 'function') out.push(`sessionController.${m}`)
      return out
    },

    hasMirrorApi() {
      const s = sc()
      return !!(s && typeof s.list === 'function' && (typeof s.inspect === 'function' || svc('sessions')))
    },

    async list() {
      const r = await sc().list({})
      return Array.isArray(r?.items) ? r.items : []
    },

    /** Persisted/attached header + events of a session (cold-safe). */
    async inspect(sessionId) {
      const s = sc()
      if (s && typeof s.inspect === 'function') {
        const r = await s.inspect(sessionId)
        return { meta: r?.meta ?? {}, events: Array.isArray(r?.events) ? r.events : [] }
      }
      const live = svc('sessions')?.get?.(sessionId)
      if (live) return { meta: live.header ?? {}, events: safe(() => [...live.snapshotEvents()], []) }
      return { meta: {}, events: [] }
    },

    async create(cwd) {
      const r = await sc().create(cwd ? { cwd } : {})
      return r?.sessionId
    },

    async prompt(sessionId, requestId, text) {
      return sc().prompt({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal)
    },

    async cancel(sessionId) {
      return sc().cancel({ sessionId })
    },

    async modelCatalog() {
      return sc().modelCatalog()
    },

    canSelectModel() {
      return typeof sc()?.selectModel === 'function'
    },

    async selectModel(sessionId, provider, model) {
      return sc().selectModel({ sessionId, provider, model })
    },

    /** Current GUI default model selection (or undefined if the service is unavailable). */
    defaultSelection() {
      return safe(() => svc('agentDefaultModel')?.currentSelection?.(), undefined)
    },

    async saveDefault(selection) {
      const s = svc('agentDefaultModel')
      if (s && typeof s.saveSelection === 'function') await s.saveSelection(selection)
    },

    isRunning(sessionId) {
      return safe(() => svc('agents')?.get?.(sessionId)?.status === 'running', false)
    },

    /** Subscribe; returns a disposer. Failures are logged once and degrade to a no-op. */
    on(name, fn, options) {
      try {
        const d = ctx.on(name, fn, options)
        return typeof d === 'function' ? d : () => {}
      } catch (e) {
        warnOnce(`on:${name}`, `cannot subscribe to "${name}": ${e instanceof Error ? e.message : String(e)}`)
        return () => {}
      }
    },

    version() {
      return safe(() => {
        const v = svc('profileContext')?.version
        return typeof v === 'string' ? v : undefined
      }, undefined)
    },
  }
  return host
}
