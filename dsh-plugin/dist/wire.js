// Wire helpers shared by the bridge and mirror (same shapes as the daemon bridge in bridge/src).

export function toWsUrl(serverUrl, name, token) {
  const u = new URL(serverUrl)
  u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol === 'http:' ? 'ws:' : u.protocol
  u.pathname = u.pathname.replace(/\/+$/, '') + '/bridge'
  u.search = ''
  u.searchParams.set('token', token)
  u.searchParams.set('name', name)
  return u.toString()
}

export function httpUrl(serverUrl, path) {
  const u = new URL(serverUrl)
  u.protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol
  u.pathname = u.pathname.replace(/\/+$/, '') + path
  u.search = ''
  return u.toString()
}

/** Short one-line JSON of tool arguments (<=120 chars), identical to the daemon mirror. */
export function shortArgs(args) {
  let s
  if (typeof args === 'string') {
    try {
      s = JSON.stringify(JSON.parse(args))
    } catch {
      s = args
    }
  } else {
    s = JSON.stringify(args ?? {})
  }
  return String(s).slice(0, 120)
}

export function toolCallMd(name, args) {
  return `\n\n> \u{1F527} ${name} ${shortArgs(args)}\n\n`
}

export function toolFailMd(name, text) {
  return `> ⚠️ ${name} failed: ${String(text).slice(0, 120)}\n\n`
}

/** Text of a dsh content array / string. */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
}

export function parseJson(s) {
  if (typeof s !== 'string') return s ?? {}
  try {
    return JSON.parse(s)
  } catch {
    return { arguments: s }
  }
}

export function parseModelRef(ref) {
  if (typeof ref !== 'string') return null
  const i = ref.indexOf('::')
  if (i <= 0 || i + 2 >= ref.length) return null
  return { provider: ref.slice(0, i), model: ref.slice(i + 2) }
}

export function normCwd(p) {
  if (typeof p !== 'string' || !p) return ''
  let r = p.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(r) || p.includes('\\')) r = r.toLowerCase()
  return r
}

/**
 * Is `p` a well-formed absolute working folder? Absolute POSIX, drive (`C:\x`, `C:/x`) or UNC path only; no NUL / control characters,
 * no `..` segment, at most 1000 characters. Shape only: whether a folder may be used is decided by OmniBridge.cwdAllowed.
 */
export function isSafeCwd(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1000) return false
  if (/[\u0000-\u001f\u007f]/.test(p)) return false
  if (!(/^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p))) return false
  return !p.split(/[\\/]+/).includes('..')
}
