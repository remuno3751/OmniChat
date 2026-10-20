/**
 * Import OmniChat models into dsh (PROTOCOL-v7-dshmodels.md, sections 2.1-2.4).
 *
 * The OmniChat server answers request frames over the bridge socket (omni_models_request, omni_key_request,
 * omni_key_revoke). This class sends them, waits for the replies (routed in by bridge.js through onFrame), and
 * writes the result into dsh: the `llm-pi-ai` provider `omnichat` through the `settings` service, the API key
 * through the `credentials` service, and a record file (no secrets) in the dsh home directory.
 *
 * Services are looked up on every call (getServices). Errors thrown by the public methods are RemoteError
 * instances with codes `omnichatbridge/<code>`; state() never throws.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { RemoteError } from './remote.js'

export const PROVIDER_ID = 'omnichat'
export const KEY_REF = 'OMNICHAT_API_KEY'
export const NAME_PREFIX = '[OmniChat] '
export const RECORD_FILE = 'omnichat-imported-models.json'
export const LLM_NS = 'llm-pi-ai'

const MAX_MODELS = 500
const REVOKE_TIMEOUT_MS = 5000
const KNOWN_CODES = new Set([
  'omni-timeout',
  'omni-not-connected',
  'omni-server-error',
  'omni-bad-reply',
  'omni-bad-args',
  'omni-settings-unavailable',
  'omni-credentials-unavailable',
])

// ─── helpers ───────────────────────────────────────────────────────────────

/** An internal failure carrying one of the omni-* codes; converted to a RemoteError at the public boundary. */
function fault(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

function remoteErr(code, message, details = {}) {
  return new RemoteError(`omnichatbridge/${code}`, message, details)
}

function codeOf(e) {
  return KNOWN_CODES.has(e?.code) ? e.code : 'omni-failed'
}

function toRemote(e) {
  if (e && e.isDSHRemoteError) return e
  return remoteErr(codeOf(e), (e && e.message) || 'The OmniChat model import failed')
}

function omniArgs(args) {
  return args && typeof args === 'object' ? args : {}
}

const validCtx = (n) => Number.isInteger(n) && n > 0
const stripPrefix = (name) => (name.startsWith(NAME_PREFIX) ? name.slice(NAME_PREFIX.length) : name)

function emptyRecord() {
  return { version: 1, providerId: PROVIDER_ID, baseUrl: null, explicitBase: false, keyRef: KEY_REF, keyId: null, importedAt: null, syncedAt: null, models: [] }
}

/** Tolerant reader for the record file: anything unexpected is dropped, never thrown. */
function normalizeRecord(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return emptyRecord()
  const models = []
  const seen = new Set()
  for (const m of Array.isArray(j.models) ? j.models : []) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id || seen.has(m.id)) continue
    seen.add(m.id)
    const name = typeof m.name === 'string' && m.name ? m.name : `${NAME_PREFIX}${m.id}`
    const plain = typeof m.plain === 'string' && m.plain ? m.plain : stripPrefix(name)
    models.push({
      id: m.id,
      plain,
      name,
      ...(typeof m.providerName === 'string' && m.providerName ? { providerName: m.providerName } : {}),
      ...(validCtx(m.contextWindow) ? { contextWindow: m.contextWindow } : {}),
    })
  }
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null)
  return {
    version: 1,
    providerId: PROVIDER_ID,
    baseUrl: typeof j.baseUrl === 'string' && j.baseUrl ? j.baseUrl : null,
    explicitBase: j.explicitBase === true,
    keyRef: KEY_REF,
    keyId: typeof j.keyId === 'string' && j.keyId ? j.keyId : null,
    importedAt: num(j.importedAt),
    syncedAt: num(j.syncedAt),
    models,
  }
}

/** Server model list -> validated entries (plain name, optional providerName, contextWindow). */
function normalizeModels(list) {
  const out = []
  const seen = new Set()
  for (const m of list) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id || typeof m.name !== 'string' || !m.name) continue
    if (seen.has(m.id)) continue
    seen.add(m.id)
    out.push({
      id: m.id,
      name: m.name,
      providerName: typeof m.providerName === 'string' ? m.providerName.slice(0, 100) : '',
      ...(validCtx(m.contextWindow) ? { contextWindow: m.contextWindow } : {}),
    })
    if (out.length >= MAX_MODELS) break
  }
  return out
}

/** A server model as a record entry (`plain` is the server's plain name). */
function entryFrom(m) {
  return {
    id: m.id,
    plain: m.name,
    ...(m.providerName ? { providerName: m.providerName } : {}),
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
  }
}

/**
 * Adds the `name` of every entry: `[OmniChat] <plain>`, with ` (<providerName>)` appended to all entries whose
 * plain name is shared with another entry. Pure.
 */
export function nameModels(entries) {
  const count = new Map()
  for (const e of entries) count.set(e.plain, (count.get(e.plain) ?? 0) + 1)
  return entries.map((e) => {
    const suffix = count.get(e.plain) > 1 ? ` (${e.providerName || e.id})` : ''
    return { ...e, name: `${NAME_PREFIX}${e.plain}${suffix}` }
  })
}

function validIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === 'string' && x.trim())) {
    throw remoteErr('omni-bad-args', 'ids must be a non-empty list of model ids')
  }
  return [...new Set(ids.map((x) => x.trim()))]
}

function normalizeBaseUrl(v) {
  const bad = () => remoteErr('omni-bad-args', 'baseUrl must be an http(s) URL')
  if (typeof v !== 'string' || !v.trim()) throw bad()
  let u
  try {
    u = new URL(v.trim())
  } catch {
    throw bad()
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad()
  return u.href.replace(/\/+$/, '')
}

/** The `omnichat` provider as dsh's llm-pi-ai settings expect it. */
function providerDef(baseUrl, models) {
  return {
    displayName: 'OmniChat',
    api: 'openai-completions',
    baseURL: baseUrl,
    apiKeyEnv: KEY_REF,
    models: models.map((m) => ({ id: m.id, name: m.name, input: ['text'], ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}) })),
  }
}

/** YAML for cordis.patch.yml when the settings service is missing. Never contains the key. */
function snippetFor(baseUrl, models) {
  const lines = [
    '# OmniChat models for dsh (the API key is stored by dsh credentials as OMNICHAT_API_KEY, not here)',
    `${LLM_NS}:`,
    '  providers:',
    `    ${PROVIDER_ID}:`,
    '      displayName: "OmniChat"',
    '      api: "openai-completions"',
    `      baseURL: ${JSON.stringify(baseUrl ?? '')}`,
    `      apiKeyEnv: "${KEY_REF}"`,
  ]
  if (models.length === 0) lines.push('      models: []')
  else {
    lines.push('      models:')
    for (const m of models) {
      lines.push(`        - id: ${JSON.stringify(m.id)}`, `          name: ${JSON.stringify(m.name)}`, '          input: ["text"]')
      if (m.contextWindow) lines.push(`          contextWindow: ${m.contextWindow}`)
    }
  }
  return lines.join('\n') + '\n'
}

const SETTINGS_REMOVE_HINT = `# remove the providers.${PROVIDER_ID} block of ${LLM_NS} from cordis.patch.yml`

// ─── OmniModels ────────────────────────────────────────────────────────────

export class OmniModels {
  /**
   * @param {object} o
   * @param {(frame: object) => boolean} o.send - sends a frame to the OmniChat server; false when not connected
   * @param {() => object | Promise<object>} [o.getServices] - returns { settings, credentials } (either may be missing)
   * @param {string} o.dshHome - directory of the record file
   * @param {(msg: string) => void} [o.log] - plugin log; only fixed texts and counts are logged
   * @param {number} [o.timeoutMs=15000] - how long a request may wait for its reply
   * @param {() => number} [o.now=Date.now]
   * @param {() => string} [o.randomId] - request ids (default crypto.randomUUID)
   * @param {() => boolean} [o.linked] - whether the server link is live (default: always true)
   */
  constructor(o = {}) {
    this.send = o.send
    this.getServices = o.getServices ?? (() => ({}))
    this.dshHome = o.dshHome
    this.log = o.log ?? (() => {})
    this.timeoutMs = o.timeoutMs ?? 15000
    this.now = o.now ?? Date.now
    this.randomId = o.randomId ?? (() => crypto.randomUUID())
    this.linked = o.linked ?? (() => true)
    this.pending = new Map() // requestId -> { resolve, timer }
    this.lastKey = null // in memory only, for log scrubbing
  }

  /** Secrets the bridge must scrub from its logs (the last API key this process received). */
  secrets() {
    return this.lastKey ? [this.lastKey] : []
  }

  /** Routes an omni_models / omni_key / omni_key_revoked reply to the request waiting for it. Unknown ids are ignored. */
  onFrame(m) {
    const id = m && typeof m === 'object' ? m.requestId : undefined
    if (typeof id !== 'string') return
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    p.resolve(m)
  }

  /** One request frame and its reply. Throws an internal fault with an omni-* code. */
  async request(reqType, replyType, fields = {}, timeoutMs = this.timeoutMs) {
    const requestId = this.randomId()
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(fault('omni-timeout', 'OmniChat did not answer in time'))
      }, timeoutMs)
      this.pending.set(requestId, { resolve, timer })
      let sent = false
      try {
        sent = this.send({ type: reqType, requestId, ...fields }) === true
      } catch {
        sent = false
      }
      if (!sent) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(fault('omni-not-connected', 'OmniChat is not connected'))
      }
    })
    if (!reply || typeof reply !== 'object' || reply.type !== replyType) throw fault('omni-bad-reply', 'OmniChat sent an unexpected reply')
    if (reply.ok !== true) {
      const msg = typeof reply.error === 'string' && reply.error.trim() ? reply.error.trim().slice(0, 300) : 'OmniChat refused the request'
      throw fault('omni-server-error', msg)
    }
    return reply
  }

  /** The server's model list: { baseUrl: string|null, models: entries }. */
  async fetchAvailable() {
    const reply = await this.request('omni_models_request', 'omni_models')
    if (!Array.isArray(reply.models)) throw fault('omni-bad-reply', 'OmniChat sent an unexpected model list')
    const baseUrl = typeof reply.baseUrl === 'string' && reply.baseUrl ? reply.baseUrl : null
    return { baseUrl, models: normalizeModels(reply.models) }
  }

  // ─── record file ─────────────────────────────────────────────────────────

  recordPath() {
    return path.join(this.dshHome, RECORD_FILE)
  }

  readRecord() {
    if (!this.dshHome) return emptyRecord()
    let raw
    try {
      raw = fs.readFileSync(this.recordPath(), 'utf8')
    } catch (e) {
      if (e?.code !== 'ENOENT') this.log('omnichat record file is unreadable: ignored')
      return emptyRecord()
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.log('omnichat record file is corrupt: ignored')
      return emptyRecord()
    }
    return normalizeRecord(parsed)
  }

  /** Atomic write (temp file in the same directory, then rename). The body is built field by field: no secrets. */
  writeRecord(rec) {
    if (!this.dshHome) throw fault('omni-failed', 'the dsh home directory is unknown')
    const file = this.recordPath()
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
    const body = {
      version: 1,
      providerId: PROVIDER_ID,
      baseUrl: rec.baseUrl ?? null,
      explicitBase: rec.explicitBase === true,
      keyRef: KEY_REF,
      keyId: rec.keyId ?? null,
      importedAt: rec.importedAt ?? null,
      syncedAt: rec.syncedAt ?? null,
      models: rec.models.map((m) => ({
        id: m.id,
        plain: m.plain,
        name: m.name,
        ...(m.providerName ? { providerName: m.providerName } : {}),
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      })),
    }
    try {
      fs.mkdirSync(this.dshHome, { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 })
      try {
        fs.chmodSync(tmp, 0o600)
      } catch {
        /* best effort (no effect on Windows) */
      }
      fs.renameSync(tmp, file)
    } catch {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* ignore */
      }
      throw fault('omni-failed', 'could not write the OmniChat record file')
    }
  }

  deleteRecord() {
    if (!this.dshHome) return
    try {
      fs.rmSync(this.recordPath(), { force: true })
    } catch {
      throw fault('omni-failed', 'could not delete the OmniChat record file')
    }
  }

  /** Writes the record and, when a key was replaced, revokes the old one (best effort). */
  commit(next, oldKeyId) {
    this.writeRecord(next)
    if (oldKeyId && oldKeyId !== next.keyId) void this.revokeKey(oldKeyId)
  }

  // ─── key, settings, credentials ──────────────────────────────────────────

  async services() {
    try {
      const s = await this.getServices()
      return s && typeof s === 'object' ? s : {}
    } catch {
      this.log('dsh services are not available')
      return {}
    }
  }

  /** Whether the dsh credential OMNICHAT_API_KEY is set. Unknown answers count as set; a failing lookup as not set. */
  async keyConfigured(creds) {
    if (!creds || typeof creds.describe !== 'function') return !!creds
    try {
      const d = await creds.describe(KEY_REF)
      if (typeof d === 'boolean') return d
      if (d && typeof d === 'object') {
        for (const k of ['configured', 'set', 'exists', 'present']) if (typeof d[k] === 'boolean') return d[k]
      }
      return true
    } catch {
      return false
    }
  }

  /** Returns the key id to use: the recorded one when its credential is set, else a freshly minted key stored in dsh. */
  async ensureKey(rec, creds) {
    if (rec.keyId && (await this.keyConfigured(creds))) return rec.keyId
    if (!creds || typeof creds.set !== 'function') throw remoteErr('omni-credentials-unavailable', 'the dsh credentials service is not available')
    const reply = await this.request('omni_key_request', 'omni_key')
    if (typeof reply.keyId !== 'string' || !reply.keyId || typeof reply.apiKey !== 'string' || !reply.apiKey) {
      throw fault('omni-bad-reply', 'OmniChat sent an unexpected key reply')
    }
    this.lastKey = reply.apiKey
    try {
      await creds.set(KEY_REF, reply.apiKey)
    } catch {
      void this.revokeKey(reply.keyId)
      throw remoteErr('omni-credentials-unavailable', 'dsh did not accept the API key')
    }
    return reply.keyId
  }

  /** Best effort: never throws, at most REVOKE_TIMEOUT_MS. */
  async revokeKey(keyId) {
    try {
      await this.request('omni_key_revoke', 'omni_key_revoked', { keyId }, REVOKE_TIMEOUT_MS)
    } catch (e) {
      this.log(`key revoke skipped: ${codeOf(e)}`)
    }
  }

  async writeProvider(settings, baseUrl, models) {
    const settingsError = () =>
      remoteErr('omni-settings-unavailable', 'dsh settings are not available: paste the snippet into cordis.patch.yml', {
        snippet: snippetFor(baseUrl, models),
      })
    if (!settings || typeof settings.update !== 'function') throw settingsError()
    try {
      await settings.update(LLM_NS, { providers: { [PROVIDER_ID]: providerDef(baseUrl, models) } })
    } catch {
      this.log('dsh settings refused the OmniChat provider update')
      throw settingsError()
    }
  }

  /** Removes the provider, the credential, revokes the key (best effort) and deletes the record. */
  async removeAllWith(svcs, rec) {
    const settings = svcs.settings
    const settingsError = () =>
      remoteErr('omni-settings-unavailable', 'dsh settings are not available: remove the OmniChat provider by hand', {
        snippet: SETTINGS_REMOVE_HINT,
      })
    if (!settings || typeof settings.mutate !== 'function') throw settingsError()
    try {
      await settings.mutate(LLM_NS, [{ op: 'unset', path: ['providers', PROVIDER_ID] }])
    } catch {
      this.log('dsh settings refused the OmniChat provider removal')
      throw settingsError()
    }
    const creds = svcs.credentials
    if (creds && typeof creds.unset === 'function') {
      try {
        await creds.unset(KEY_REF)
      } catch {
        this.log('could not remove the OmniChat credential')
      }
    }
    if (rec.keyId) await this.revokeKey(rec.keyId)
    this.deleteRecord()
  }

  // ─── state ───────────────────────────────────────────────────────────────

  isLinked() {
    try {
      return this.linked() === true
    } catch {
      return false
    }
  }

  /**
   * The OmniState (PROTOCOL-v7 section 2.4). `list` is the server answer or undefined when it is not available.
   * `stale` is only known after a successful fetch (`list` given); otherwise false.
   */
  buildState({ ok, errorCode, error, list, rec }) {
    const recIds = new Set(rec.models.map((m) => m.id))
    const offered = list ? new Set(list.models.map((m) => m.id)) : null
    return {
      ok,
      ...(ok ? {} : { errorCode, error }),
      linked: this.isLinked(),
      providerId: PROVIDER_ID,
      baseUrl: rec.explicitBase ? rec.baseUrl : list?.baseUrl ?? rec.baseUrl ?? null, // an override typed by the user wins; otherwise the endpoint the server reports now
      available: list
        ? list.models.map((m) => ({
            id: m.id,
            name: m.name,
            providerName: m.providerName,
            ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
            imported: recIds.has(m.id),
          }))
        : [],
      imported: rec.models.map((m) => ({
        id: m.id,
        name: m.name,
        ...(m.providerName ? { providerName: m.providerName } : {}),
        stale: offered ? !offered.has(m.id) : false,
      })),
      syncedAt: rec.syncedAt ?? null,
    }
  }

  /** Current state. Never throws: a failed fetch is ok:false with errorCode, the imported list still comes from the record. */
  async state(opts) {
    const rec = this.readRecord()
    if (opts && opts.refresh === false) return this.buildState({ ok: true, rec })
    try {
      const list = await this.fetchAvailable()
      return this.buildState({ ok: true, list, rec })
    } catch (e) {
      return this.buildState({ ok: false, errorCode: codeOf(e), error: (e && e.message) || 'OmniChat is not available', rec })
    }
  }

  // ─── operations ──────────────────────────────────────────────────────────

  /** Imports `ids` (all must be offered by the server) additively. Returns the OmniState after the import. */
  async import(args) {
    try {
      const a = omniArgs(args)
      const ids = validIds(a.ids)
      const requestedBase = a.baseUrl === undefined || a.baseUrl === null ? undefined : normalizeBaseUrl(a.baseUrl)
      const rec = this.readRecord()
      const svcs = await this.services()
      const list = await this.fetchAvailable()
      const offered = new Map(list.models.map((m) => [m.id, m]))
      for (const id of ids) if (!offered.has(id)) throw remoteErr('omni-bad-args', 'a model is not offered by OmniChat')
      const explicitBase = requestedBase !== undefined || rec.explicitBase === true
      const baseUrl = requestedBase ?? (rec.explicitBase ? rec.baseUrl : list.baseUrl) ?? rec.baseUrl
      if (!baseUrl) throw fault('omni-bad-reply', 'OmniChat did not report an endpoint')

      const keyId = await this.ensureKey(rec, svcs.credentials)
      const merged = new Map(rec.models.map((m) => [m.id, { id: m.id, plain: m.plain, providerName: m.providerName, contextWindow: m.contextWindow }]))
      for (const id of ids) merged.set(id, entryFrom(offered.get(id)))
      const models = nameModels([...merged.values()])

      await this.writeProvider(svcs.settings, baseUrl, models)
      const now = this.now()
      const next = { baseUrl, explicitBase, keyId, importedAt: rec.importedAt ?? now, syncedAt: now, models }
      this.commit(next, rec.keyId)
      this.log(`imported ${ids.length} OmniChat model(s), ${models.length} in total`)
      return this.buildState({ ok: true, list, rec: next })
    } catch (e) {
      throw toRemote(e)
    }
  }

  /**
   * Brings the imported models in line with the server: names and context are refreshed, vanished models are
   * dropped, and (addNew, default true) models not imported yet are added. Empty result = remove all.
   */
  async sync(args) {
    try {
      const a = omniArgs(args)
      const addNew = a.addNew !== false
      const rec = this.readRecord()
      const svcs = await this.services()
      const list = await this.fetchAvailable()
      const offered = new Map(list.models.map((m) => [m.id, m]))
      const have = new Set(rec.models.map((m) => m.id))
      const diff = { added: 0, updated: 0, removed: 0 }
      const merged = []
      for (const m of rec.models) {
        const o = offered.get(m.id)
        if (!o) {
          diff.removed++
          continue
        }
        const e = entryFrom(o)
        if (e.plain !== m.plain || (e.providerName ?? '') !== (m.providerName ?? '') || e.contextWindow !== m.contextWindow) diff.updated++
        merged.push(e)
      }
      if (addNew) {
        for (const o of list.models) {
          if (have.has(o.id)) continue
          merged.push(entryFrom(o))
          diff.added++
        }
      }

      if (merged.length === 0) {
        await this.removeAllWith(svcs, rec)
        return { ...this.buildState({ ok: true, list, rec: emptyRecord() }), diff }
      }
      // an explicit override survives a sync; otherwise follow the endpoint the server reports now (it can change, e.g. localhost -> LAN address)
      const explicitBase = rec.explicitBase === true
      const baseUrl = (explicitBase ? rec.baseUrl : list.baseUrl) ?? rec.baseUrl
      if (!baseUrl) throw fault('omni-bad-reply', 'OmniChat did not report an endpoint')
      const keyId = await this.ensureKey(rec, svcs.credentials)
      const models = nameModels(merged)
      await this.writeProvider(svcs.settings, baseUrl, models)
      const now = this.now()
      const next = { baseUrl, explicitBase, keyId, importedAt: rec.importedAt ?? now, syncedAt: now, models }
      this.commit(next, rec.keyId)
      this.log(`synced OmniChat models: +${diff.added} ~${diff.updated} -${diff.removed}`)
      return { ...this.buildState({ ok: true, list, rec: next }), diff }
    } catch (e) {
      throw toRemote(e)
    }
  }

  /** `{all:true}` removes the provider entirely; `{ids}` removes some (all of them when none would remain). */
  async remove(args) {
    try {
      const a = omniArgs(args)
      const rec = this.readRecord()
      const svcs = await this.services()
      if (a.all === true) {
        await this.removeAllWith(svcs, rec)
      } else {
        const ids = validIds(a.ids)
        const have = new Set(rec.models.map((m) => m.id))
        for (const id of ids) if (!have.has(id)) throw remoteErr('omni-bad-args', 'a model is not imported')
        const remaining = rec.models.filter((m) => !ids.includes(m.id)).map((m) => ({
          id: m.id,
          plain: m.plain,
          ...(m.providerName ? { providerName: m.providerName } : {}),
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        }))
        if (remaining.length === 0) {
          await this.removeAllWith(svcs, rec)
        } else {
          const models = nameModels(remaining)
          await this.writeProvider(svcs.settings, rec.baseUrl, models)
          this.commit({ ...rec, models }, null)
        }
      }
      return await this.state()
    } catch (e) {
      throw toRemote(e)
    }
  }
}
