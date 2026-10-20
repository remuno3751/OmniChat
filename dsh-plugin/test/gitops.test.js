import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NOT_GIT, computeChanges, createCheckpoint, repoRoot, rewindTo, snapshotTree } from '../dist/gitops.js'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const created = []

/** Temp dirs live only under os.tmpdir(). */
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

after(() => {
  for (const d of created) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

function track(dir) {
  created.push(dir)
  return dir
}

/** Test-side git: raw line endings, fixed identity, never refreshes the index. */
function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim()
}

function write(repo, rel, data) {
  const abs = path.join(repo, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, data)
}

function makeRepo(files) {
  const dir = track(tmpDir('omnichat-gitops-repo-'))
  git(dir, 'init', '-q')
  for (const [rel, data] of Object.entries(files)) write(dir, rel, data)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

function snapState(repo) {
  return {
    head: git(repo, 'rev-parse', 'HEAD'),
    branch: git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'),
    status: git(repo, 'status', '--porcelain'),
    stash: git(repo, 'stash', 'list'),
    index: fs.readFileSync(path.join(repo, '.git', 'index')),
  }
}

test('non-git directory is reported as unavailable', async () => {
  const dir = track(tmpDir('omnichat-gitops-plain-'))
  assert.deepEqual(await createCheckpoint(dir), { ok: false, unavailable: NOT_GIT })
  assert.equal(await snapshotTree(dir), null)
  assert.equal(await repoRoot(dir), null)
  assert.deepEqual(await computeChanges(dir, EMPTY_TREE), { changes: [], truncated: false })
})

test('createCheckpoint leaves HEAD, branch, stash, status and real index untouched', async () => {
  const repo = makeRepo({ 'a.txt': 'one\n', 'dir/b.txt': 'two\n' })
  const before = snapState(repo)

  const clean = await createCheckpoint(repo, 'clean-1')
  assert.equal(clean.ok, true)
  if (!clean.ok) return
  assert.equal(clean.checkpoint.ref, 'refs/omnichat/checkpoints/clean-1')
  assert.equal(clean.checkpoint.dirty, false)
  assert.equal(git(repo, 'rev-parse', '--verify', clean.checkpoint.ref), clean.checkpoint.commit)
  assert.deepEqual(snapState(repo).head, before.head)
  assert.deepEqual(snapState(repo).status, before.status)
  assert.ok(snapState(repo).index.equals(before.index), 'real index bytes changed')

  write(repo, 'untracked.txt', 'new\n')
  const untracked = await createCheckpoint(repo, 'untracked-1')
  assert.equal(untracked.ok && untracked.checkpoint.dirty, true)

  write(repo, 'a.txt', 'changed\n')
  const modified = await createCheckpoint(repo, 'modified-1')
  assert.equal(modified.ok && modified.checkpoint.dirty, true)

  const after1 = snapState(repo)
  assert.equal(after1.head, before.head)
  assert.equal(after1.branch, before.branch)
  assert.equal(after1.stash, '')
  assert.ok(after1.index.equals(before.index), 'real index bytes changed')
})

test('createCheckpoint works in a fresh repo with no commits', async () => {
  const repo = track(tmpDir('omnichat-gitops-fresh-'))
  git(repo, 'init', '-q')
  const empty = await createCheckpoint(repo, 'fresh-empty')
  assert.equal(empty.ok && empty.checkpoint.dirty, false)
  assert.equal(empty.ok && empty.checkpoint.tree, EMPTY_TREE)

  write(repo, 'x.txt', 'hello\n')
  const cp = await createCheckpoint(repo, 'fresh-1')
  assert.equal(cp.ok, true)
  if (!cp.ok) return
  assert.equal(cp.checkpoint.dirty, true)
  assert.equal(git(repo, 'rev-parse', '--verify', cp.checkpoint.ref), cp.checkpoint.commit)
})

test('createCheckpoint rejects invalid ids', async () => {
  const repo = makeRepo({ 'a.txt': 'a\n' })
  assert.deepEqual(await createCheckpoint(repo, 'bad id;rm'), { ok: false, unavailable: 'invalid checkpoint id' })
})

test('computeChanges reports statuses, counts and patches without touching HEAD or index', async () => {
  const repo = makeRepo({
    'modify.txt': 'one\ntwo\nthree\nfour\n',
    'delete.txt': 'a\nb\nc\nd\n',
    'old.txt': 'line1\nline2\nline3\nline4\nline5\nline6\n',
  })
  const cp = await createCheckpoint(repo, 'diff-base')
  assert.equal(cp.ok, true)
  if (!cp.ok) return
  const base = cp.checkpoint.tree
  const headBefore = git(repo, 'rev-parse', 'HEAD')
  const indexBefore = fs.readFileSync(path.join(repo, '.git', 'index'))

  write(repo, 'modify.txt', 'one\nTWO\nthree\nfour\nfive\nsix\n')
  fs.rmSync(path.join(repo, 'delete.txt'))
  fs.renameSync(path.join(repo, 'old.txt'), path.join(repo, 'renamed.txt'))
  write(repo, 'added.txt', 'p\nq\nr\ns\nt\n')
  write(repo, 'bin.dat', Buffer.from([0, 1, 2, 255, 0, 7]))
  write(repo, 'sub dir/ünï file.txt', 'x\ny\n')

  const res = await computeChanges(repo, base)
  assert.equal(res.truncated, false)
  assert.deepEqual(
    res.changes.map((c) => c.path),
    ['added.txt', 'bin.dat', 'delete.txt', 'modify.txt', 'renamed.txt', 'sub dir/ünï file.txt'],
  )
  const by = new Map(res.changes.map((c) => [c.path, c]))

  const modify = by.get('modify.txt')
  assert.equal(modify.status, 'modified')
  assert.equal(modify.additions, 3)
  assert.equal(modify.deletions, 1)
  assert.ok(modify.patch.includes('+++ b/modify.txt'))

  const added = by.get('added.txt')
  assert.equal(added.status, 'added')
  assert.equal(added.additions, 5)
  assert.equal(added.deletions, 0)
  assert.ok(added.patch.includes('+++ b/added.txt'))

  const del = by.get('delete.txt')
  assert.equal(del.status, 'deleted')
  assert.equal(del.additions, 0)
  assert.equal(del.deletions, 4)

  const renamed = by.get('renamed.txt')
  assert.equal(renamed.status, 'renamed')
  assert.ok(renamed.patch.includes('rename from old.txt'))

  const bin = by.get('bin.dat')
  assert.equal(bin.status, 'added')
  assert.equal(bin.additions, 0)
  assert.equal(bin.deletions, 0)
  assert.equal(bin.patch, 'Binary files differ')

  const uni = by.get('sub dir/ünï file.txt')
  assert.equal(uni.status, 'added')
  assert.equal(uni.additions, 2)
  assert.ok(uni.patch.includes('+++ b/sub dir/ünï file.txt'))

  // Unchanged tree yields no changes.
  const now = await snapshotTree(repo)
  assert.ok(now)
  assert.deepEqual(await computeChanges(repo, now), { changes: [], truncated: false })

  assert.equal(git(repo, 'rev-parse', 'HEAD'), headBefore)
  assert.ok(fs.readFileSync(path.join(repo, '.git', 'index')).equals(indexBefore), 'real index bytes changed')
})

test('computeChanges caps a single oversized patch', async () => {
  const repo = makeRepo({ 'keep.txt': 'keep\n' })
  const cp = await createCheckpoint(repo, 'cap-single')
  assert.equal(cp.ok, true)
  if (!cp.ok) return
  write(repo, 'huge.txt', 'abcdefghij\n'.repeat(30000))
  const res = await computeChanges(repo, cp.checkpoint.tree)
  const huge = res.changes.find((c) => c.path === 'huge.txt')
  assert.ok(huge.patch.length <= 200 * 1024 + 100, `patch length ${huge.patch.length}`)
  assert.equal(res.truncated, true)
})

test('computeChanges caps total patch characters', async () => {
  const repo = makeRepo({ 'keep.txt': 'keep\n' })
  const cp = await createCheckpoint(repo, 'cap-total')
  assert.equal(cp.ok, true)
  if (!cp.ok) return
  for (let i = 0; i < 10; i++) write(repo, `f${String(i).padStart(2, '0')}.txt`, 'abcdefghij\n'.repeat(15000))
  const res = await computeChanges(repo, cp.checkpoint.tree)
  assert.equal(res.truncated, true)
  const total = res.changes.reduce((n, c) => n + (c.patch?.length ?? 0), 0)
  assert.ok(total <= 1024 * 1024 + 10 * 100, `total patch chars ${total}`)
  for (const name of ['f07.txt', 'f08.txt', 'f09.txt']) {
    assert.equal(res.changes.find((c) => c.path === name).patch, undefined, `${name} should have no patch`)
  }
})

test('rewindTo restores bytes exactly under autocrlf=true and removeNew deletes new files', async () => {
  const crlf = Buffer.from('alpha\r\nbeta\r\n')
  const lf = Buffer.from('gamma\ndelta\n')
  const bin = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
  const originals = { 'crlf.txt': crlf, 'lf.txt': lf, 'bin.dat': bin, 'keep.txt': Buffer.from('k\n') }
  const repo = makeRepo(originals)
  git(repo, 'config', 'core.autocrlf', 'true')

  const cp = await createCheckpoint(repo, 'rw-1')
  assert.equal(cp.ok, true)
  if (!cp.ok) return
  const ref = cp.checkpoint.ref

  write(repo, 'crlf.txt', 'changed\n')
  fs.rmSync(path.join(repo, 'lf.txt'))
  write(repo, 'bin.dat', Buffer.alloc(10, 9))
  write(repo, 'added.txt', 'new\n')
  write(repo, 'newdir/deep/inner.txt', 'deep\n')

  const before = snapState(repo)
  const r = await rewindTo(repo, ref)
  assert.equal(r.ok, true, r.error)
  assert.ok(r.backupRef)
  assert.equal(git(repo, 'rev-parse', '--verify', '-q', r.backupRef).length, 40)
  for (const [rel, data] of Object.entries(originals)) {
    assert.ok(fs.readFileSync(path.join(repo, rel)).equals(data), `${rel} not byte-identical`)
  }
  assert.ok(fs.existsSync(path.join(repo, 'added.txt')))
  assert.ok(fs.existsSync(path.join(repo, 'newdir/deep/inner.txt')))
  const afterRewind = snapState(repo)
  assert.equal(afterRewind.head, before.head)
  assert.equal(afterRewind.branch, before.branch)
  assert.ok(afterRewind.index.equals(before.index), 'real index bytes changed')

  const r2 = await rewindTo(repo, ref, { removeNew: true })
  assert.equal(r2.ok, true, r2.error)
  assert.ok(!fs.existsSync(path.join(repo, 'added.txt')))
  assert.ok(!fs.existsSync(path.join(repo, 'newdir')), 'empty new directory left behind')
  for (const [rel, data] of Object.entries(originals)) {
    assert.ok(fs.readFileSync(path.join(repo, rel)).equals(data), `${rel} not byte-identical`)
  }
  assert.equal(snapState(repo).head, before.head)
})

test('rewindTo rejects invalid refs and unknown checkpoints', async () => {
  const repo = makeRepo({ 'a.txt': 'a\n' })
  for (const ref of ['refs/heads/main', '../x', ';rm']) {
    assert.deepEqual(await rewindTo(repo, ref), { ok: false, error: 'invalid ref' })
  }
  const missing = await rewindTo(repo, 'refs/omnichat/checkpoints/does-not-exist')
  assert.deepEqual(missing, { ok: false, error: 'checkpoint not found' })
})

test("autocrlf repo: committed CRLF file is not 'dirty' and rewinds byte-exactly even when unchanged since the commit", async () => {
  const dir = track(tmpDir('omnichat-gitops-crlf-'))
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  g('init', '-q')
  g('config', 'core.autocrlf', 'true')
  const crlf = Buffer.from('l1\r\nl2\r\nl3\r\n')
  fs.writeFileSync(path.join(dir, 'crlf.txt'), crlf)
  fs.writeFileSync(path.join(dir, 'other.txt'), 'x\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'init')
  const cp = await createCheckpoint(dir, 'crlf-1')
  assert.equal(cp.ok, true)
  assert.equal(cp.checkpoint.dirty, false)
  fs.writeFileSync(path.join(dir, 'crlf.txt'), 'destroyed\n')
  fs.writeFileSync(path.join(dir, 'other.txt'), 'y\n')
  const r = await rewindTo(dir, cp.checkpoint.ref)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.ok(fs.readFileSync(path.join(dir, 'crlf.txt')).equals(crlf))
  assert.equal(fs.readFileSync(path.join(dir, 'other.txt'), 'utf8'), 'x\n')
})

test('old checkpoint refs are pruned beyond the newest 200', async () => {
  const repo = makeRepo({ 'a.txt': 'one\n' })
  const head = git(repo, 'rev-parse', 'HEAD')
  const lines = Array.from({ length: 205 }, (_, n) => `create refs/omnichat/checkpoints/old-${String(n).padStart(3, '0')} ${head}`).join('\n') + '\n'
  execFileSync('git', ['update-ref', '--stdin'], { cwd: repo, input: lines, windowsHide: true })
  const cp = await createCheckpoint(repo, 'fresh')
  assert.equal(cp.ok, true)
  const refs = git(repo, 'for-each-ref', '--format=%(refname)', 'refs/omnichat/checkpoints/').split('\n')
  assert.equal(refs.length, 200)
  assert.ok(refs.includes('refs/omnichat/checkpoints/fresh'))
})
