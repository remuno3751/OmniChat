import os from 'node:os'

const TRUE = new Set(['1', 'true', 'yes', 'on'])
const FALSE = new Set(['0', 'false', 'no', 'off'])
const DEFAULT_LOCAL_PORT = 19401
const LOCAL_ONLY_KEYS = ['serverUrl', 'token', 'username', 'password', 'previewFs']

/**
 * Read-only file access for Code preview (BRIDGE-v2.md, section C). Default off. Remote mode only.
 * Config key `previewFs`, or env OMNICHAT_BRIDGE_PREVIEW_FS when the key is not set.
 */
function previewFsField(c, env, errors) {
  const raw = given(c.previewFs) ? c.previewFs : env.OMNICHAT_BRIDGE_PREVIEW_FS
  return bool(raw, false, 'previewFs', errors)
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function given(v) {
  return v !== undefined && v !== null && v !== ''
}

function bool(v, dflt, key, errors) {
  if (v === undefined || v === null || v === '') return dflt
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (TRUE.has(s)) return true
    if (FALSE.has(s)) return false
  }
  errors.push(`${key} must be true or false`)
  return dflt
}

/** Shared validation of the settings that mean the same in both modes. */
function commonFields(c, env, errors) {
  const name = str(c.name) ?? str(env.OMNICHAT_NAME) ?? os.hostname()
  const cwd = str(c.cwd) ?? str(env.OMNICHAT_CWD)

  const mirror = bool(c.mirror, true, 'mirror', errors)
  const mirrorScope = c.mirrorScope === undefined || c.mirrorScope === null || c.mirrorScope === '' ? 'all' : c.mirrorScope
  if (mirrorScope !== 'all' && mirrorScope !== 'cwd') errors.push('mirrorScope must be "all" or "cwd"')
  const approvals = c.approvals === undefined || c.approvals === null || c.approvals === '' ? 'remote' : c.approvals
  if (approvals !== 'remote' && approvals !== 'gui' && approvals !== 'deny') errors.push('approvals must be "remote", "gui" or "deny"')
  let approvalTimeoutMs = 600000
  const rawTimeout = c.approvalTimeoutMs
  if (given(rawTimeout)) {
    const n = typeof rawTimeout === 'string' && /^\d+$/.test(rawTimeout.trim()) ? Number(rawTimeout.trim()) : rawTimeout
    if (Number.isSafeInteger(n) && n > 0) approvalTimeoutMs = n
    else errors.push('approvalTimeoutMs must be a positive integer')
  }
  // Off by default: OmniChat may only start sessions in folders this bridge already knows (config cwd, mirrored sessions).
  const allowAnyCwd = bool(c.allowAnyCwd, false, 'allowAnyCwd', errors)
  return { name, cwd, mirror, mirrorScope, approvals, approvalTimeoutMs, allowAnyCwd }
}

/** Remote-mode server settings (unchanged behaviour). */
function remoteFields(c, env, errors) {
  const serverUrl = str(c.serverUrl) ?? str(env.OMNICHAT_SERVER_URL)
  let url
  if (!serverUrl) errors.push('serverUrl is required (e.g. http://192.168.1.10:8787 or https://chat.example.com)')
  else {
    try {
      url = new URL(serverUrl)
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('bad protocol')
    } catch {
      errors.push('serverUrl must be an http(s):// or ws(s):// URL')
      url = undefined
    }
  }

  const token = str(c.token) ?? str(env.OMNICHAT_TOKEN)
  const username = str(c.username) ?? str(env.OMNICHAT_USERNAME)
  const password = (typeof c.password === 'string' && c.password) || (typeof env.OMNICHAT_PASSWORD === 'string' && env.OMNICHAT_PASSWORD) || undefined
  if (!token && !(username && password)) errors.push('credentials missing: set token, or username and password (env OMNICHAT_TOKEN / OMNICHAT_USERNAME / OMNICHAT_PASSWORD)')
  return { url, token, username, password }
}

/** Local-mode listen port: integer 1..65535, digit strings accepted. */
function listenPortField(c, env, errors) {
  let raw = c.listenPort
  if (!given(raw)) raw = env.OMNICHAT_LOCAL_PORT
  if (!given(raw)) return DEFAULT_LOCAL_PORT
  const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n
  errors.push('listenPort must be an integer between 1 and 65535')
  return DEFAULT_LOCAL_PORT
}

/** Normalises one allowedOrigins entry to its origin, or undefined when it is not an origin. */
function normaliseOrigin(x) {
  if (x === 'tauri://localhost') return x
  let u
  try {
    u = new URL(x)
  } catch {
    return undefined
  }
  if (u.protocol === 'tauri:') return u.hostname === 'localhost' ? 'tauri://localhost' : undefined
  if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin
  return undefined
}

function allowedOriginsField(c, errors) {
  const raw = c.allowedOrigins
  if (!given(raw)) return []
  let entries
  if (Array.isArray(raw)) entries = raw
  else if (typeof raw === 'string') entries = raw.split(',')
  else {
    errors.push('allowedOrigins must be an array of strings or a comma separated string')
    return []
  }
  const out = []
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      errors.push('allowedOrigins entries must be strings')
      continue
    }
    const x = entry.trim()
    if (!x) continue
    const origin = normaliseOrigin(x)
    if (origin === undefined) errors.push(`allowedOrigins entry "${x}" is not an origin (e.g. https://chat.example.com)`)
    else if (!out.includes(origin)) out.push(origin)
  }
  return out
}

/**
 * Validates the raw plugin config (a patch-yml `config:` object, with env fallbacks).
 * Never throws. Returns { config, errors, warnings }; `config` is null when errors exist.
 * Error texts never contain secret values.
 *
 * mode 'remote': connects out to an OmniChat server (serverUrl + credentials).
 * mode 'local' (default): listens locally for OmniChat; no server settings are needed.
 */
export function validateConfig(raw, env = process.env) {
  const errors = []
  const warnings = []
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const known = new Set([
    'mode', 'serverUrl', 'name', 'token', 'username', 'password', 'cwd', 'mirror', 'mirrorScope', 'approvals', 'approvalTimeoutMs',
    'allowAnyCwd', 'listenPort', 'allowedOrigins', 'pairingFile', 'updateToken', 'previewFs',
  ])
  for (const k of Object.keys(c)) if (!known.has(k)) warnings.push(`unknown config key "${k}" ignored`)

  // Optional GitHub token for plugin update checks (updater.js falls back to env OMNICHAT_UPDATE_TOKEN).
  // Added to the config only when set, so the documented key set stays the same otherwise.
  const updateToken = str(c.updateToken)
  const tokenField = updateToken ? { updateToken } : {}

  const rawMode = given(c.mode) ? c.mode : env.OMNICHAT_MODE
  const modeText = typeof rawMode === 'string' ? rawMode.trim() : rawMode
  let mode = 'local'
  if (given(modeText) && modeText !== '') {
    if (modeText === 'local' || modeText === 'remote') mode = modeText
    else errors.push('mode must be "local" or "remote"')
  }

  if (mode === 'remote') {
    const remote = remoteFields(c, env, errors)
    const common = commonFields(c, env, errors)
    const previewFs = previewFsField(c, env, errors)
    if (errors.length) return { config: null, errors, warnings }
    return {
      config: {
        mode: 'remote',
        // Added only when on, so the remote config keeps its documented key set by default.
        ...(previewFs ? { previewFs: true } : {}),
        serverUrl: remote.url.toString(),
        name: common.name,
        token: remote.token,
        username: remote.username,
        password: remote.password,
        cwd: common.cwd,
        mirror: common.mirror,
        mirrorScope: common.mirrorScope,
        approvals: common.approvals,
        approvalTimeoutMs: common.approvalTimeoutMs,
      allowAnyCwd: common.allowAnyCwd,
        ...tokenField,
      },
      errors,
      warnings,
    }
  }

  // local mode
  for (const k of LOCAL_ONLY_KEYS) if (given(c[k])) warnings.push(`"${k}" is ignored in local mode`)
  const listenPort = listenPortField(c, env, errors)
  const allowedOrigins = allowedOriginsField(c, errors)
  if (given(c.pairingFile) && typeof c.pairingFile !== 'string') errors.push('pairingFile must be a string path')
  const pairingFile = typeof c.pairingFile === 'string' ? c.pairingFile.trim() || undefined : undefined
  const common = commonFields(c, env, errors)
  if (errors.length) return { config: null, errors, warnings }
  return {
    config: {
      mode: 'local',
      listenPort,
      allowedOrigins,
      pairingFile,
      name: common.name,
      cwd: common.cwd,
      mirror: common.mirror,
      mirrorScope: common.mirrorScope,
      approvals: common.approvals,
      approvalTimeoutMs: common.approvalTimeoutMs,
      allowAnyCwd: common.allowAnyCwd,
      ...tokenField,
    },
    errors,
    warnings,
  }
}
