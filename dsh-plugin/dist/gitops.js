// Git helpers for "checkpoint before an agent run, changes after it, rewind on request".
//
// Safety contract: nothing here touches the user's branch, the real index, the
// stash or the config. All tree snapshots go through a TEMPORARY index file
// (GIT_INDEX_FILE inside os.tmpdir()), and the only refs written live under
// refs/omnichat/checkpoints/.

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * @typedef {object} Checkpoint
 * @property {string} checkpointId
 * @property {string} ref
 * @property {number} createdAt
 * @property {boolean} dirty
 * @property {string} tree
 * @property {string} commit
 */

/**
 * @typedef {{ ok: true, checkpoint: Checkpoint } | { ok: false, unavailable: string }} CheckpointResult
 */

/**
 * @typedef {object} FileChange
 * @property {string} path
 * @property {'added' | 'modified' | 'deleted' | 'renamed'} status
 * @property {number} additions
 * @property {number} deletions
 * @property {string} [patch]
 */

export const NOT_GIT = 'not a git repository'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const CHECKPOINT_NS = 'refs/omnichat/checkpoints/'
const ID_RE = /^[A-Za-z0-9._-]{1,80}$/
const REF_RE = /^refs\/omnichat\/checkpoints\/[A-Za-z0-9._-]{1,120}$/
const MAX_PATCH_CHARS = 200 * 1024
const MAX_TOTAL_PATCH_CHARS = 1024 * 1024
const MAX_PATCHED_FILES = 500
const TRUNCATED_MARK = '\n... [patch truncated]\n'
const BINARY_PATCH = 'Binary files differ'

const GIT_BASE_ARGS = [
  '--literal-pathspecs',
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
  '-c', 'core.quotepath=false',
]

/**
 * @typedef {object} GitResult
 * @property {number} code
 * @property {Buffer} stdout
 * @property {string} stderr
 */

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string>} [extraEnv]
 * @param {boolean} [plain] skip the byte-exactness -c overrides (use the user's own git config)
 * @returns {Promise<GitResult>}
 */
function git(cwd, args, extraEnv = {}, plain = false) {
  const env = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'omnichat',
    GIT_COMMITTER_NAME: 'omnichat',
    GIT_AUTHOR_EMAIL: 'omnichat@localhost',
    GIT_COMMITTER_EMAIL: 'omnichat@localhost',
    ...extraEnv,
  }
  return new Promise((resolve) => {
    execFile(
      'git',
      plain ? args : [...GIT_BASE_ARGS, ...args],
      { cwd, env, windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 120000, encoding: 'buffer' },
      (err, stdout, stderr) => {
        let code = 0
        if (err) {
          const c = err.code
          code = typeof c === 'number' ? c : -1
        }
        resolve({
          code,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0),
          stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? ''),
        })
      },
    )
  })
}

/** @param {GitResult} r */
const out = (r) => r.stdout.toString('utf8').trim()
/** @param {GitResult} r */
const nulRecords = (r) => r.stdout.toString('utf8').split('\0').filter((s) => s.length > 0)
/** @param {string} child @param {string} dir */
const isInside = (child, dir) => child.startsWith(dir + path.sep)

/** @param {string} cwd @returns {Promise<string | null>} */
export async function repoRoot(cwd) {
  const r = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (r.code !== 0) return null
  const top = out(r)
  return top ? path.resolve(top) : null
}

/** @param {string} root @returns {Promise<string | null>} */
async function headOf(root) {
  const r = await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])
  return r.code === 0 && out(r) ? out(r) : null
}

/**
 * @param {string} root
 * @param {string} tree
 * @param {string} message
 * @param {string | null} parent
 * @returns {Promise<string | null>}
 */
async function makeCommit(root, tree, message, parent) {
  const args = ['commit-tree', tree]
  if (parent) args.push('-p', parent)
  args.push('-m', message)
  const r = await git(root, args)
  return r.code === 0 && out(r) ? out(r) : null
}

/**
 * Tree snapshot of the working tree, computed via a temporary index. Root must be a repo top-level.
 * @param {string} root
 * @returns {Promise<string | null>}
 */
async function snapshotIn(root) {
  let tmp = null
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omnichat-gitops-'))
    const tmpIndex = path.join(tmp, 'index')
    const env = { GIT_INDEX_FILE: tmpIndex }
    // Start from HEAD's tree, never from a copy of the real index: the real index caches stat data
    // and (with autocrlf) normalized blobs, which would hide the exact bytes of unchanged files.
    if (await headOf(root)) {
      const rt = await git(root, ['read-tree', 'HEAD'], env)
      if (rt.code !== 0) return null
    }
    const add = await git(root, ['add', '-A'], env)
    if (add.code !== 0) return null
    const wt = await git(root, ['write-tree'], env)
    if (wt.code !== 0 || !out(wt)) return null
    return out(wt)
  } catch {
    return null
  } finally {
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  }
}

/** @param {string} cwd @returns {Promise<string | null>} */
export async function snapshotTree(cwd) {
  const root = await repoRoot(cwd)
  if (!root) return null
  return snapshotIn(root)
}

const KEEP_CHECKPOINTS = 200

/** Keeps the newest KEEP_CHECKPOINTS refs under refs/omnichat/checkpoints/ so the user's repo does not collect them forever. */
async function pruneCheckpoints(root, keepRef) {
  try {
    const r = await git(root, ['for-each-ref', '--sort=creatordate', '--format=%(refname)', CHECKPOINT_NS])
    if (r.code !== 0) return
    const refs = out(r)
      .split('\n')
      .filter((x) => x.startsWith(CHECKPOINT_NS) && x !== keepRef)
    for (const ref of refs.slice(0, Math.max(0, refs.length - (KEEP_CHECKPOINTS - 1)))) await git(root, ['update-ref', '-d', ref])
  } catch {
    /* best effort */
  }
}

/**
 * @param {string} cwd
 * @param {string} [checkpointId]
 * @returns {Promise<CheckpointResult>}
 */
export async function createCheckpoint(cwd, checkpointId) {
  try {
    const id = checkpointId ?? crypto.randomUUID()
    if (!ID_RE.test(id)) return { ok: false, unavailable: 'invalid checkpoint id' }
    const root = await repoRoot(cwd)
    if (!root) return { ok: false, unavailable: NOT_GIT }
    const tree = await snapshotIn(root)
    if (!tree) return { ok: false, unavailable: 'failed to snapshot working tree' }
    const head = await headOf(root)
    const commit = await makeCommit(root, tree, `omnichat checkpoint ${id}`, head)
    if (!commit) return { ok: false, unavailable: 'commit-tree failed' }
    const ref = CHECKPOINT_NS + id
    const upd = await git(root, ['update-ref', ref, commit])
    if (upd.code !== 0) return { ok: false, unavailable: `update-ref failed: ${upd.stderr.trim()}` }

    // Read-only: GIT_OPTIONAL_LOCKS=0 stops git from writing a refreshed index. Plain config, so the
    // user's own autocrlf/eol settings decide what "modified" means.
    const status = await git(root, ['status', '--porcelain', '--untracked-files=normal'], {}, true)
    const dirty = status.code === 0 ? status.stdout.length > 0 : tree !== EMPTY_TREE
    await pruneCheckpoints(root, ref)
    return {
      ok: true,
      checkpoint: { checkpointId: id, ref, createdAt: Date.now(), dirty, tree, commit },
    }
  } catch (e) {
    return { ok: false, unavailable: e.message }
  }
}

/**
 * @param {string} cwd
 * @param {string} baseTree
 * @returns {Promise<{ changes: FileChange[], truncated: boolean }>}
 */
export async function computeChanges(cwd, baseTree) {
  const empty = { changes: [], truncated: false }
  try {
    const root = await repoRoot(cwd)
    if (!root) return empty
    const endTree = await snapshotIn(root)
    if (!endTree || endTree === baseTree) return empty

    const diffArgs = ['diff', '--no-color', '--no-ext-diff', '-M']
    const range = [baseTree, endTree]
    const [numR, nameR] = await Promise.all([
      git(root, [...diffArgs, '--numstat', '-z', ...range]),
      git(root, [...diffArgs, '--name-status', '-z', ...range]),
    ])
    if (numR.code !== 0 || nameR.code !== 0) return empty

    // --name-status -z: "M\0path\0", renames/copies: "R100\0old\0new\0"
    /** @type {Map<string, { code: string, oldPath?: string }>} */
    const statusByPath = new Map()
    const nTok = nameR.stdout.toString('utf8').split('\0')
    for (let i = 0; i < nTok.length; ) {
      const st = nTok[i]
      if (!st) {
        i++
        continue
      }
      const code = st[0]
      if (code === 'R' || code === 'C') {
        const oldPath = nTok[i + 1]
        const newPath = nTok[i + 2]
        if (newPath === undefined) break
        statusByPath.set(newPath, { code, oldPath })
        i += 3
      } else {
        const p = nTok[i + 1]
        if (p === undefined) break
        statusByPath.set(p, { code })
        i += 2
      }
    }

    // --numstat -z: "add\tdel\tpath\0", renames: "add\tdel\t\0old\0new\0", binary: "-\t-\tpath\0"
    /** @type {Map<string, { additions: number, deletions: number, binary: boolean }>} */
    const statsByPath = new Map()
    const sTok = numR.stdout.toString('utf8').split('\0')
    for (let i = 0; i < sTok.length; ) {
      const rec = sTok[i]
      if (!rec) {
        i++
        continue
      }
      const parts = rec.split('\t')
      const pathPart = parts.slice(2).join('\t')
      const entry = {
        additions: Number(parts[0]) || 0,
        deletions: Number(parts[1]) || 0,
        binary: parts[0] === '-',
      }
      if (pathPart === '') {
        const newPath = sTok[i + 2]
        if (newPath === undefined) break
        statsByPath.set(newPath, entry)
        i += 3
      } else {
        statsByPath.set(pathPart, entry)
        i += 1
      }
    }

    /** @type {Array<{ change: FileChange, oldPath?: string, binary: boolean }>} */
    const items = []
    for (const [p, s] of statusByPath) {
      const stats = statsByPath.get(p)
      const status =
        s.code === 'A' || s.code === 'C'
          ? 'added'
          : s.code === 'D'
            ? 'deleted'
            : s.code === 'R'
              ? 'renamed'
              : 'modified'
      items.push({
        change: { path: p, status, additions: stats?.additions ?? 0, deletions: stats?.deletions ?? 0 },
        oldPath: s.oldPath,
        binary: stats?.binary ?? false,
      })
    }
    items.sort((a, b) => (a.change.path < b.change.path ? -1 : a.change.path > b.change.path ? 1 : 0))

    let truncated = false
    let totalChars = 0
    let fetched = 0
    for (const it of items) {
      if (totalChars >= MAX_TOTAL_PATCH_CHARS || fetched >= MAX_PATCHED_FILES) {
        truncated = true
        continue
      }
      if (it.binary) {
        it.change.patch = BINARY_PATCH
        totalChars += BINARY_PATCH.length
        continue
      }
      fetched++
      const pathspec =
        it.oldPath && it.oldPath !== it.change.path ? [it.oldPath, it.change.path] : [it.change.path]
      const r = await git(root, [...diffArgs, ...range, '--', ...pathspec])
      let text = r.code === 0 ? r.stdout.toString('utf8') : ''
      if (text.length > MAX_PATCH_CHARS) {
        text = text.slice(0, MAX_PATCH_CHARS) + TRUNCATED_MARK
        truncated = true
      }
      const room = MAX_TOTAL_PATCH_CHARS - totalChars
      if (text.length > room) {
        text = text.slice(0, room) + TRUNCATED_MARK
        truncated = true
      }
      totalChars += text.length
      it.change.patch = text
    }

    return { changes: items.map((i) => i.change), truncated }
  } catch {
    return empty
  }
}

/**
 * Removes empty directories from `start` upward, never touching root or root/.git.
 * @param {string} start
 * @param {string} root
 * @param {string} gitDir
 */
function pruneEmptyDirs(start, root, gitDir) {
  let dir = start
  while (isInside(dir, root) && !isInside(dir, gitDir) && dir !== gitDir) {
    try {
      fs.rmdirSync(dir)
    } catch {
      break
    }
    dir = path.dirname(dir)
  }
}

/**
 * @param {string} cwd
 * @param {string} ref
 * @param {{ removeNew?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string, restored?: number, removed?: number, backupRef?: string }>}
 */
export async function rewindTo(cwd, ref, opts = {}) {
  try {
    if (!REF_RE.test(ref)) return { ok: false, error: 'invalid ref' }
    const root = await repoRoot(cwd)
    if (!root) return { ok: false, error: NOT_GIT }

    const cp = await git(root, ['rev-parse', '--verify', '-q', `${ref}^{tree}`])
    if (cp.code !== 0 || !out(cp)) return { ok: false, error: 'checkpoint not found' }
    const cpTree = out(cp)

    // Safety backup of the current working tree before anything is written.
    const backupTree = await snapshotIn(root)
    if (!backupTree) return { ok: false, error: 'failed to snapshot current working tree' }
    const head = await headOf(root)
    const backupCommit = await makeCommit(root, backupTree, `omnichat pre-rewind backup ${Date.now()}`, head)
    if (!backupCommit) return { ok: false, error: 'failed to create backup commit' }
    const backupRef = `${CHECKPOINT_NS}pre-rewind-${Date.now()}`
    const upd = await git(root, ['update-ref', backupRef, backupCommit])
    if (upd.code !== 0) return { ok: false, error: `failed to create backup ref: ${upd.stderr.trim()}` }

    // Restore the checkpoint's files through a temporary index.
    let tmp = null
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omnichat-gitops-'))
      const env = { GIT_INDEX_FILE: path.join(tmp, 'index') }
      const readTree = await git(root, ['read-tree', cpTree], env)
      if (readTree.code !== 0) {
        return { ok: false, error: `read-tree failed: ${readTree.stderr.trim()}`, backupRef }
      }
      const checkout = await git(root, ['checkout-index', '-a', '-f'], env)
      if (checkout.code !== 0) {
        return { ok: false, error: `checkout-index failed: ${checkout.stderr.trim()}`, backupRef }
      }
    } finally {
      if (tmp) {
        try {
          fs.rmSync(tmp, { recursive: true, force: true })
        } catch {
          /* best effort */
        }
      }
    }

    const listed = await git(root, ['ls-tree', '-r', '-z', '--name-only', cpTree])
    const restored = nulRecords(listed).length

    let removed = 0
    if (opts.removeNew) {
      const added = await git(root, ['diff-tree', '-r', '-z', '--name-only', '--diff-filter=A', cpTree, backupTree])
      if (added.code !== 0) return { ok: false, error: 'diff-tree failed', restored, backupRef }
      const gitDir = path.join(root, '.git')
      for (const rel of nulRecords(added)) {
        const abs = path.resolve(root, rel)
        if (!isInside(abs, root) || abs === gitDir || isInside(abs, gitDir)) continue
        try {
          fs.rmSync(abs, { force: true })
        } catch {
          continue
        }
        removed++
        pruneEmptyDirs(path.dirname(abs), root, gitDir)
      }
    }

    return { ok: true, restored, removed, backupRef }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}
