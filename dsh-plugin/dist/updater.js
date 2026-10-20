/**
 * Plugin update check and staging (dsh side). Dependency free: Node built-ins only.
 *
 * The plugin never replaces itself while dsh runs. `check()` asks GitHub for the newest stable
 * `omnichat-dsh-bridge-<ver>.tgz` release asset. `stage()` downloads it, verifies its SHA-256 against the
 * release's `SHA256SUMS` (or `<asset>.sha256`) and keeps it under `<dshHome>/omnichat-update/`. The
 * settings page then shows the one-line command that installs it (run with dsh closed).
 *
 * Errors are returned as `{ code, message, at }` by check() and thrown as UpdateFailure by stage().
 * Messages never include the GitHub token.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_REPO = 'remuno3751/omnichat'
export const DEFAULT_API_BASE = 'https://api.github.com'
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // automatic checks at most once per 6 hours
export const MAX_DOWNLOAD_BYTES = 60 * 1024 * 1024
const MAX_JSON_BYTES = 5 * 1024 * 1024
const MAX_SUMS_BYTES = 1024 * 1024
const MAX_REDIRECTS = 5
const API_TIMEOUT_MS = 15000
const DOWNLOAD_TIMEOUT_MS = 300000
const USER_AGENT = 'omnichat-dsh-bridge-updater'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const PLUGIN_ASSET_RE = /^omnichat-dsh-bridge-(\d+\.\d+\.\d+[^/]*)\.tgz$/
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const SHA256_HEX = /^[0-9a-fA-F]{64}$/

/** A failure with a stable code (see the codes used below). */
export class UpdateFailure extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'UpdateFailure'
    this.code = code
  }
}

const fail = (code, message) => new UpdateFailure(code, message)

// ---------------------------------------------------------------- semver (SemVer 2.0 precedence)

/** `{ core: [major, minor, patch], pre: [identifiers] }` or null. A leading "v" and +build are accepted. */
export function parseSemver(s) {
  const m = SEMVER_RE.exec(typeof s === 'string' ? s.trim().replace(/^v/, '') : '')
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/** -1 | 0 | 1 for valid versions, null when either one does not parse. */
export function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1
  }
  // A release (no prerelease) is greater than any prerelease of the same core version.
  if (!pa.pre.length || !pb.pre.length) {
    if (pa.pre.length === pb.pre.length) return 0
    return pa.pre.length ? -1 : 1
  }
  const n = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1 // fewer identifiers sort first
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d < 0 ? -1 : 1
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1 // numeric identifiers sort before alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

// ---------------------------------------------------------------- small helpers

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function isLoopbackHost(hostname) {
  return LOOPBACK.has(hostname)
}

/** https always; http only towards a loopback host (tests). */
function protocolAllowed(url, apiUrl) {
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && isLoopbackHost(apiUrl.hostname) && isLoopbackHost(url.hostname)
}

/** Parses `<hex>  <name>` lines (sha256sum output; `*name` binary marker tolerated). */
export function parseSums(text) {
  const out = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})[ \t]+\*?(.+?)\s*$/.exec(line)
    if (m) out.set(m[2], m[1].toLowerCase())
  }
  return out
}

/** Parses a `<asset>.sha256` file: `<hex>` or `<hex>  <name>`. Returns the hex or null. */
export function parsePerAsset(text, assetName) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})(?:[ \t]+\*?(.+?))?\s*$/.exec(line.trim())
    if (!m) continue
    if (m[2] !== undefined && m[2] !== assetName) return null
    return m[1].toLowerCase()
  }
  return null
}

/** The command the user runs with dsh closed. Double-quoted PowerShell string, so the path is escaped. */
export function installCommand(profile, file) {
  const quoted = '"' + String(file).replace(/[`"$]/g, (c) => '`' + c) + '"'
  return `dsh plugin --profile ${profile} remove @omnichat/dsh-bridge; dsh plugin --profile ${profile} add ${quoted}`
}

function normalizeRelease(r) {
  if (!r || typeof r !== 'object' || r.draft === true) return null // drafts are ignored
  const assets = Array.isArray(r.assets)
    ? r.assets
        .filter((a) => a && typeof a.name === 'string')
        .map((a) => ({
          id: a.id,
          name: a.name,
          size: Number(a.size) || 0,
          url: typeof a.url === 'string' ? a.url : null,
          downloadUrl: typeof a.browser_download_url === 'string' ? a.browser_download_url : null,
        }))
    : []
  return {
    tag: String(r.tag_name ?? ''),
    prerelease: r.prerelease === true,
    publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
    assets,
  }
}

/** Newest stable plugin asset over all non-draft, non-prerelease releases; the version comes from the asset name. */
export function pickPlugin(releases) {
  let best = null
  for (const rel of releases) {
    if (rel.prerelease) continue
    for (const asset of rel.assets) {
      const m = PLUGIN_ASSET_RE.exec(asset.name)
      if (!m) continue
      const version = m[1]
      const parsed = parseSemver(version)
      if (!parsed || parsed.pre.length) continue // stable plugin versions only
      if (!best || compareSemver(version, best.version) > 0) best = { version, asset, release: rel }
    }
  }
  return best
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- factory

/**
 * @param {object} opts
 * @param {string} opts.currentVersion  the installed plugin version
 * @param {string} [opts.dshHome]       default: $DSH_HOME or ~/.dsh (tests always pass a temp dir)
 * @param {object} [opts.env]           default process.env (OMNICHAT_UPDATE_TOKEN / _REPO / _API_BASE, DSH_PROFILE)
 * @param {Function} [opts.fetchImpl]   default globalThis.fetch
 * @param {string} [opts.token]         GitHub token (config `updateToken`); wins over the env variable
 * @param {string} [opts.repo]          default remuno3751/omnichat
 * @param {string} [opts.apiBase]       default https://api.github.com (loopback http allowed for tests)
 * @param {string} [opts.profile]       dsh profile used in the command, default env DSH_PROFILE or "desktop"
 * @param {Function} [opts.log]
 * @param {Function} [opts.now]         clock, default Date.now
 * @param {number} [opts.maxBytes]      download cap, default 60 MiB
 * @returns {{ state(): object, check(opts?: {maxAgeMs?: number}): Promise<object>, stage(): Promise<object> }}
 */
export function createUpdater(opts = {}) {
  const env = opts.env ?? process.env
  const currentVersion = typeof opts.currentVersion === 'string' ? opts.currentVersion : '0.0.0'
  const dshHome = str(opts.dshHome) ?? (str(env.DSH_HOME) || path.join(os.homedir(), '.dsh'))
  const dir = path.join(dshHome, 'omnichat-update')
  const stateFile = path.join(dir, 'state.json')
  const token = str(opts.token) ?? str(env.OMNICHAT_UPDATE_TOKEN)
  const repo = str(opts.repo) ?? str(env.OMNICHAT_UPDATE_REPO) ?? DEFAULT_REPO
  const apiBase = (str(opts.apiBase) ?? str(env.OMNICHAT_UPDATE_API_BASE) ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const rawProfile = str(opts.profile) ?? str(env.DSH_PROFILE)
  const profile = rawProfile && /^[A-Za-z0-9_-]+$/.test(rawProfile) ? rawProfile : 'desktop'
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : MAX_DOWNLOAD_BYTES

  // Persisted (survives a dsh restart): last check time and result, and the staged file.
  let persisted = readPersisted()
  // In memory only: the release list and its ETag (conditional GET).
  let cache = { etag: null, releases: null }
  // In memory only: the plugin asset chosen by the last successful check, with its checksum assets.
  let picked = null
  let checking = null
  let staging = null

  function readPersisted() {
    const o = readJsonFile(stateFile)
    const out = { checkedAt: null, latest: null, error: null, staged: null }
    if (!o || typeof o !== 'object') return out
    if (Number.isFinite(o.checkedAt)) out.checkedAt = o.checkedAt
    if (o.latest && typeof o.latest.version === 'string') out.latest = o.latest
    if (o.error && typeof o.error.code === 'string') out.error = o.error
    if (o.staged && typeof o.staged.version === 'string' && typeof o.staged.file === 'string' && typeof o.staged.sha256 === 'string') {
      out.staged = o.staged
    }
    return out
  }

  function writePersisted() {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const tmp = stateFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2))
      fs.renameSync(tmp, stateFile)
    } catch (e) {
      log(`update state not saved: ${scrub(e && e.message)}`)
    }
  }

  /** Removes the token from any text before it reaches a message or the log. */
  function scrub(text) {
    let out = String(text ?? '')
    if (token) out = out.split(token).join('[redacted]')
    return out
  }

  function snapshot() {
    const latest = persisted.latest
    const updateAvailable = !!latest && compareSemver(latest.version, currentVersion) === 1
    const staged = persisted.staged && fs.existsSync(persisted.staged.file) ? persisted.staged : null
    const command = staged && compareSemver(staged.version, currentVersion) === 1 ? installCommand(profile, staged.file) : null
    return {
      current: currentVersion,
      latest: latest ? { ...latest } : null,
      updateAvailable,
      checkedAt: persisted.checkedAt,
      error: persisted.error ? { ...persisted.error } : null,
      staged: staged ? { ...staged } : null,
      command,
      profile,
    }
  }

  /** Protocol and API base rules, checked before any request leaves the process. */
  function apiUrl() {
    let u
    try {
      u = new URL(apiBase)
    } catch {
      throw fail('unsupported', 'The update API base URL is not valid')
    }
    if (!protocolAllowed(u, u)) throw fail('unsupported', 'The update API base must be https (plain http is only allowed for localhost)')
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw fail('unsupported', 'The update repository must look like owner/name')
    return u
  }

  /**
   * GET with manual redirects (max 5). Authorization is sent on the first hop only, and only when that hop is
   * the API base host. Every later hop is sent without it. Returns the final, non-redirect response.
   */
  async function follow(url, { headers = {}, timeoutMs }) {
    const base = apiUrl()
    let current = url
    for (let hop = 0; ; hop++) {
      let u
      try {
        u = new URL(current)
      } catch {
        throw fail('bad-response', 'GitHub returned an invalid download address')
      }
      if (!protocolAllowed(u, base)) throw fail('unsupported', `Refusing to fetch from ${u.protocol}//${u.host}`)
      const h = { 'User-Agent': USER_AGENT, ...headers }
      if (token && hop === 0 && u.host === base.host) h.Authorization = `Bearer ${token}`
      let res
      try {
        res = await fetchImpl(current, { headers: h, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
      } catch {
        throw fail('network', `Could not reach ${u.host}`)
      }
      const location = res.headers.get('location')
      if (REDIRECTS.has(res.status) && location) {
        if (hop >= MAX_REDIRECTS) throw fail('download', 'Too many redirects while downloading the update')
        try {
          await res.body?.cancel()
        } catch {
          /* ignore */
        }
        current = new URL(location, current).toString()
        continue
      }
      return res
    }
  }

  /** Reads a body with a byte cap. Over the cap throws `download`. */
  async function readBody(res, cap) {
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > cap) {
      try {
        await res.body?.cancel()
      } catch {
        /* ignore */
      }
      throw fail('download', 'The download is larger than the size limit')
    }
    const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null
    if (!reader) {
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > cap) throw fail('download', 'The download is larger than the size limit')
      return buf
    }
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > cap) {
        try {
          await reader.cancel()
        } catch {
          /* ignore */
        }
        throw fail('download', 'The download is larger than the size limit')
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
    return Buffer.concat(chunks, total)
  }

  /** Releases from the API, with the ETag cache. A 304 reuses the cached list. */
  async function fetchReleases() {
    apiUrl() // validates the base and the repository name before anything is sent
    const url = `${apiBase}/repos/${repo}/releases?per_page=20`
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    if (cache.etag && cache.releases) headers['If-None-Match'] = cache.etag
    const res = await follow(url, { headers, timeoutMs: API_TIMEOUT_MS })
    if (res.status === 304 && cache.releases) return cache.releases
    if (res.status === 401) throw fail('unauthorized', 'GitHub rejected the update token (HTTP 401)')
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining')
      if (res.status === 429 || remaining === '0' || res.headers.get('retry-after')) {
        const reset = Number(res.headers.get('x-ratelimit-reset'))
        const when = Number.isFinite(reset) && reset > 0 ? ` Try again after ${new Date(reset * 1000).toISOString()}.` : ' Try again later.'
        throw fail('rate-limited', `GitHub API rate limit reached.${when} Set an update token to raise the limit.`)
      }
      throw fail('forbidden', 'GitHub refused the request (HTTP 403)')
    }
    if (res.status === 404) {
      throw fail('not-found', 'Release repository not found: check OMNICHAT_UPDATE_REPO, or set an update token if the repository is private')
    }
    if (!res.ok) throw fail('bad-response', `GitHub answered HTTP ${res.status}`)
    let json
    try {
      json = JSON.parse((await readBody(res, MAX_JSON_BYTES)).toString('utf8'))
    } catch (e) {
      if (e instanceof UpdateFailure) throw e
      throw fail('bad-response', 'GitHub sent a response that is not JSON')
    }
    if (!Array.isArray(json)) throw fail('bad-response', 'GitHub sent an unexpected release list')
    const releases = json.map(normalizeRelease).filter(Boolean)
    cache = { etag: res.headers.get('etag'), releases }
    return releases
  }

  /** Downloads one release asset: the API URL with the token when one is set, else the browser URL. */
  async function fetchAsset(asset, timeoutMs, cap) {
    const useApi = !!token && !!asset.url
    const url = useApi ? asset.url : asset.downloadUrl
    if (!url) throw fail('bad-response', `No download address for ${asset.name}`)
    const headers = useApi ? { Accept: 'application/octet-stream' } : {}
    const res = await follow(url, { headers, timeoutMs })
    if (!res.ok) throw fail('download', `HTTP ${res.status} while downloading ${asset.name}`)
    return readBody(res, cap)
  }

  /** The expected SHA-256 for the picked asset, from SHA256SUMS or `<asset>.sha256`. Throws checksum-missing. */
  async function expectedSha(p) {
    const name = p.asset.name
    if (p.sums) {
      const text = (await fetchAsset(p.sums, API_TIMEOUT_MS, MAX_SUMS_BYTES)).toString('utf8')
      const hex = parseSums(text).get(name)
      if (hex && SHA256_HEX.test(hex)) return hex.toLowerCase()
    }
    if (p.per) {
      const text = (await fetchAsset(p.per, API_TIMEOUT_MS, 4096)).toString('utf8')
      const hex = parsePerAsset(text, name)
      if (hex && SHA256_HEX.test(hex)) return hex
    }
    throw fail('checksum-missing', `No SHA-256 checksum is published for ${name}: refusing to stage`)
  }

  async function doCheck() {
    const at = now()
    try {
      const releases = await fetchReleases()
      const best = pickPlugin(releases)
      if (!best) {
        picked = null
        persisted.latest = null
        persisted.error = { code: 'no-plugin', message: 'No omnichat-dsh-bridge release asset was found', at }
      } else {
        const names = best.release.assets
        picked = {
          version: best.version,
          asset: best.asset,
          sums: names.find((a) => a.name === 'SHA256SUMS') ?? null,
          per: names.find((a) => a.name === `${best.asset.name}.sha256`) ?? null,
        }
        persisted.latest = {
          version: best.version,
          name: best.asset.name,
          size: best.asset.size,
          tag: best.release.tag,
          publishedAt: best.release.publishedAt,
        }
        persisted.error = null
      }
      persisted.checkedAt = at
      writePersisted()
      log(`update check: latest plugin ${persisted.latest ? persisted.latest.version : 'none'}`)
    } catch (e) {
      const failure = e instanceof UpdateFailure ? e : fail('other', 'The update check failed')
      persisted.checkedAt = at
      persisted.error = { code: failure.code, message: scrub(failure.message), at }
      writePersisted()
      log(`update check failed: ${persisted.error.code}`)
    }
    return snapshot()
  }

  /**
   * Looks up the newest plugin release. Never throws: a failure is stored and shown in the returned state.
   * With `maxAgeMs`, a check newer than that returns the cached result without any request.
   */
  function check(options = {}) {
    if (checking) return checking
    const age = persisted.checkedAt == null ? null : now() - persisted.checkedAt
    if (options.maxAgeMs !== undefined && age !== null && age >= 0 && age < options.maxAgeMs) {
      return Promise.resolve(snapshot())
    }
    checking = doCheck().finally(() => {
      checking = null
    })
    return checking
  }

  async function doStage() {
    if (!picked) {
      const after = await check()
      if (!picked) {
        const err = after.error ?? { code: 'no-plugin', message: 'No omnichat-dsh-bridge release asset was found' }
        throw fail(err.code, err.message)
      }
    }
    const p = picked
    if (compareSemver(p.version, currentVersion) !== 1) return snapshot() // nothing newer to stage
    const expected = await expectedSha(p)
    const buf = await fetchAsset(p.asset, DOWNLOAD_TIMEOUT_MS, maxBytes)
    if (p.asset.size > 0 && buf.length !== p.asset.size) {
      throw fail('download', `The download of ${p.asset.name} is ${buf.length} bytes, the release says ${p.asset.size}`)
    }
    const sha = crypto.createHash('sha256').update(buf).digest('hex')
    if (sha !== expected) throw fail('checksum-mismatch', `SHA-256 mismatch for ${p.asset.name}: refusing to stage`)

    const name = `omnichat-dsh-bridge-${p.version}.tgz`
    const file = path.join(dir, name)
    const part = file + '.part'
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(part, buf)
      fs.renameSync(part, file)
    } catch (e) {
      try {
        fs.rmSync(part, { force: true })
      } catch {
        /* ignore */
      }
      throw fail('other', `Could not store the update: ${scrub(e && e.message)}`)
    }
    // Older staged packages are no longer needed.
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (/^omnichat-dsh-bridge-.*\.tgz$/.test(entry) && entry !== name) fs.rmSync(path.join(dir, entry), { force: true })
      }
    } catch {
      /* ignore */
    }
    persisted.staged = { version: p.version, file, sha256: sha }
    writePersisted()
    log(`update staged: omnichat-dsh-bridge ${p.version}`)
    return snapshot()
  }

  /**
   * Downloads, verifies and stages the picked plugin version. Throws UpdateFailure on any problem; nothing is
   * left in the staging folder when verification fails.
   */
  function stage() {
    if (staging) return staging
    staging = doStage()
      .catch((e) => {
        if (e instanceof UpdateFailure) throw e
        throw fail('other', scrub(e && e.message) || 'The update could not be staged')
      })
      .finally(() => {
        staging = null
      })
    return staging
  }

  return {
    state: snapshot,
    check,
    stage,
  }
}
