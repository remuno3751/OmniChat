import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MIN_PAIRING_LENGTH = 32

/** The dsh home directory: $DSH_HOME, else ~/.dsh. */
export function dshHome(env = process.env) {
  return env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** The pairing file used when the config does not name one: <dshHome>/omnichat-bridge.json. */
export function defaultPairingFile(env = process.env) {
  return path.join(dshHome(env), 'omnichat-bridge.json')
}

/** Constant-time string comparison. False when the lengths differ or either value is not a string. */
export function safeEqual(a, b) {
  try {
    if (typeof a !== 'string' || typeof b !== 'string') return false
    const ba = Buffer.from(a, 'utf8')
    const bb = Buffer.from(b, 'utf8')
    if (ba.length !== bb.length) return false
    return crypto.timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}

/** Turns parsed JSON into a valid pairing record, or null when the pairing secret is unusable. */
function normalise(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.pairing !== 'string' || raw.pairing.length < MIN_PAIRING_LENGTH) return null
  const data = {
    version: 1,
    pairing: raw.pairing,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(now()).toISOString(),
  }
  if (typeof raw.pairedAt === 'string') data.pairedAt = raw.pairedAt
  data.allowedOrigins = Array.isArray(raw.allowedOrigins) ? raw.allowedOrigins.filter((x) => typeof x === 'string') : []
  if (Number.isInteger(raw.listenPort) && raw.listenPort >= 1 && raw.listenPort <= 65535) data.listenPort = raw.listenPort
  return data
}

/** Reads the pairing record fresh from disk. Returns null when missing, unreadable, or invalid. Never throws. */
export function readPairing(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return normalise(raw, Date.now)
  } catch {
    return null
  }
}

/** Atomic JSON write: temp file in the same directory, then rename over the target. */
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    try {
      fs.chmodSync(tmp, 0o600)
    } catch {
      /* not supported on every platform */
    }
    fs.renameSync(tmp, file)
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    throw e
  }
}

/**
 * Replaces the pairing secret with a fresh one. Clears pairedAt and allowedOrigins (the paired app must pair again);
 * keeps the saved listen port. Written atomically. Throws when the file cannot be written. Never logs the secret.
 */
export function regeneratePairing({ file, randomBytes = crypto.randomBytes, now = Date.now } = {}) {
  const previous = readPairing(file)
  const data = {
    version: 1,
    pairing: randomBytes(32).toString('base64url'),
    createdAt: new Date(now()).toISOString(),
    allowedOrigins: [],
  }
  if (previous?.listenPort !== undefined) data.listenPort = previous.listenPort
  try {
    writeAtomic(file, data)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`cannot write OmniChat pairing file at ${file}: ${msg}`)
  }
  return data
}

/**
 * Reads the pairing file, or creates a fresh one when it is missing, corrupt or has an unusable pairing secret.
 * Throws an Error with a clear message when the file cannot be written (e.g. the directory cannot be created).
 */
export function loadOrCreatePairing({ file, randomBytes = crypto.randomBytes, now = Date.now } = {}) {
  const existing = readPairing(file)
  if (existing) return { file, created: false, data: existing }
  const data = {
    version: 1,
    pairing: randomBytes(32).toString('base64url'),
    createdAt: new Date(now()).toISOString(),
    allowedOrigins: [],
  }
  try {
    writeAtomic(file, data)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`cannot create OmniChat pairing file at ${file}: ${msg}`)
  }
  return { file, created: true, data }
}

/** Writes the record atomically. Returns true on success, false on I/O failure. Never throws. */
export function savePairing(file, data) {
  try {
    writeAtomic(file, data)
    return true
  } catch {
    return false
  }
}

/** Read-modify-write helper. Returns the updated record, or null when there is no valid pairing file. */
function update(file, mutate) {
  const data = readPairing(file)
  if (!data) return null
  mutate(data)
  return savePairing(file, data) ? data : null
}

/** Sets pairedAt when it is not already set. Returns the record, or null when there is no valid pairing file. */
export function markPaired(file, now = Date.now) {
  return update(file, (d) => {
    if (!d.pairedAt) d.pairedAt = new Date(now()).toISOString()
  })
}

/** Appends an origin to allowedOrigins when absent. Returns the record, or null when there is no valid pairing file. */
export function addAllowedOrigin(file, origin) {
  return update(file, (d) => {
    if (!d.allowedOrigins.includes(origin)) d.allowedOrigins.push(origin)
  })
}

/** Stores the local listen port. Returns the record, or null when there is no valid pairing file. */
export function setListenPort(file, port) {
  return update(file, (d) => {
    d.listenPort = port
  })
}
