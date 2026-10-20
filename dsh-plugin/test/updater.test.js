import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  CHECK_INTERVAL_MS,
  compareSemver,
  createUpdater,
  installCommand,
  parsePerAsset,
  parseSemver,
  parseSums,
  pickPlugin,
  UpdateFailure,
} from '../dist/updater.js'

// The updater runs against a loopback fake of the GitHub releases API. Every request is recorded so the
// tests can check ETag handling, redirects and where the Authorization header went.

const cleanup = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()()
})

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnichat-updater-'))
  cleanup.push(async () => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** A plugin package spec. The bytes are deterministic, so a checksum can be computed in the test. */
const plugin = (version, extra = {}) => ({ version, data: Buffer.from(`tgz-bytes-${version}`), ...extra })

/** A release spec. `sums`: 'sums' (SHA256SUMS), 'per' (<asset>.sha256), 'none', or 'wrong' (bad hash). */
const release = (tag, plugins, extra = {}) => ({ tag, plugins, sums: 'sums', ...extra })

async function startGithub({ token = null } = {}) {
  let etagN = 1
  let nextId = 1000
  const srv = {
    base: '',
    cdn: '',
    port: 0,
    token,
    mode: null, // null | 'rate' | 'notfound'
    hits: [],
    etag: 'W/"1"',
    releases: [],
    assets: new Map(), // id -> { name, data }
    byName: new Map(), // name -> { name, data }
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const auth = req.headers.authorization ?? null
    const hit = { path: url.pathname, auth, host: req.headers.host ?? null, ifNoneMatch: req.headers['if-none-match'] ?? null, status: 0 }
    srv.hits.push(hit)
    const send = (code, headers = {}, body = '') => {
      hit.status = code
      res.writeHead(code, headers)
      res.end(body)
    }
    if (url.pathname.startsWith('/repos/')) {
      if (srv.mode === 'rate') return send(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) }, '{}')
      if (srv.mode === 'notfound') return send(404, {}, '{}')
      if (srv.token && auth !== `Bearer ${srv.token}`) return send(401, {}, '{}')
      if (req.headers['if-none-match'] === srv.etag) return send(304, { etag: srv.etag })
      return send(200, { 'content-type': 'application/json', etag: srv.etag }, JSON.stringify(srv.releases))
    }
    if (url.pathname.startsWith('/assets/')) {
      if (srv.token && auth !== `Bearer ${srv.token}`) return send(401, {}, '{}')
      const asset = srv.assets.get(Number(url.pathname.slice('/assets/'.length)))
      if (!asset) return send(404)
      // The API asset URL redirects to a CDN host, as GitHub does. The CDN host is a different name for the same loopback server.
      return send(302, { location: `${srv.cdn}/cdn/${asset.id}` })
    }
    if (url.pathname.startsWith('/cdn/')) {
      const asset = srv.assets.get(Number(url.pathname.slice('/cdn/'.length)))
      if (!asset) return send(404)
      return send(200, { 'content-length': String(asset.data.length) }, asset.data)
    }
    if (url.pathname.startsWith('/dl/')) {
      const asset = srv.byName.get(decodeURIComponent(url.pathname.slice('/dl/'.length)))
      if (!asset) return send(404)
      return send(200, { 'content-length': String(asset.data.length) }, asset.data)
    }
    if (url.pathname === '/loop') return send(302, { location: '/loop' })
    return send(404)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  srv.port = server.address().port
  srv.base = `http://127.0.0.1:${srv.port}`
  srv.cdn = `http://localhost:${srv.port}`
  // Replaces the release list. Every call changes the ETag.
  srv.setReleases = (specs) => {
    srv.etag = `W/"${++etagN}"`
    srv.assets.clear()
    srv.byName.clear()
    srv.releases = specs.map((spec) => {
      const assets = []
      const add = (name, data, browserUrl) => {
        const id = nextId++
        const entry = { id, name, data }
        srv.assets.set(id, entry)
        srv.byName.set(name, entry)
        assets.push({
          id,
          name,
          size: data.length,
          url: `${srv.base}/assets/${id}`,
          browser_download_url: browserUrl ?? `${srv.base}/dl/${encodeURIComponent(name)}`,
        })
      }
      const plugins = spec.plugins ?? []
      for (const p of plugins) add(`omnichat-dsh-bridge-${p.version}.tgz`, p.data ?? Buffer.from(`tgz-bytes-${p.version}`), p.browserUrl)
      const hashOf = (name, data) => (spec.sums === 'wrong' ? sha256(Buffer.from('not the file')) : sha256(data))
      if (spec.sums === 'sums' && plugins.length) {
        const lines = plugins.map((p) => {
          const name = `omnichat-dsh-bridge-${p.version}.tgz`
          const data = p.data ?? Buffer.from(`tgz-bytes-${p.version}`)
          return `${hashOf(name, data)}  ${name}`
        })
        const body = Buffer.from(lines.join('\n') + '\n')
        add('SHA256SUMS', body)
      }
      if ((spec.sums === 'per' || spec.sums === 'wrong') && plugins.length) {
        for (const p of plugins) {
          const name = `omnichat-dsh-bridge-${p.version}.tgz`
          const data = p.data ?? Buffer.from(`tgz-bytes-${p.version}`)
          add(`${name}.sha256`, Buffer.from(`${hashOf(name, data)}  ${name}\n`))
        }
      }
      return {
        tag_name: spec.tag,
        name: spec.tag,
        draft: !!spec.draft,
        prerelease: !!spec.prerelease,
        published_at: '2026-10-01T00:00:00Z',
        assets,
      }
    })
  }
  cleanup.push(async () => {
    await new Promise((resolve) => server.close(resolve))
  })
  return srv
}

/** An updater wired to the fake server and a scratch dshHome. `env` is empty, so the host environment is ignored. */
function makeUpdater(srv, extra = {}) {
  const dshHome = tempDir()
  const logs = []
  const u = createUpdater({
    currentVersion: '0.5.0',
    dshHome,
    env: {},
    apiBase: srv.base,
    log: (m) => logs.push(m),
    ...extra,
  })
  return { u, dshHome, logs, stagedDir: path.join(dshHome, 'omnichat-update') }
}

function stagedFiles(stagedDir) {
  if (!fs.existsSync(stagedDir)) return []
  return fs.readdirSync(stagedDir).filter((f) => f.endsWith('.tgz') || f.endsWith('.part'))
}

// ---------------------------------------------------------------- semver and parsing (pure)

test('semver: SemVer 2.0 precedence, v prefix and +build ignored, invalid versions give null', () => {
  const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']
  for (let i = 0; i + 1 < order.length; i++) {
    assert.equal(compareSemver(order[i], order[i + 1]), -1, `${order[i]} < ${order[i + 1]}`)
    assert.equal(compareSemver(order[i + 1], order[i]), 1)
  }
  assert.equal(compareSemver('0.6.0', '0.6.0'), 0)
  assert.equal(compareSemver('v0.6.0+build.7', '0.6.0'), 0)
  assert.equal(compareSemver('0.10.0', '0.9.9'), 1, 'numeric, not lexical')
  assert.equal(compareSemver('0.6', '0.6.0'), null)
  assert.equal(compareSemver('x', '0.6.0'), null)
  assert.deepEqual(parseSemver('0.6.0-rc.1').pre, ['rc', '1'])
})

test('pickPlugin: newest stable plugin over stable releases, version from the asset name', () => {
  const found = pickPlugin([
    { tag: 'v1.2.3', prerelease: false, assets: [{ name: 'omnichat-dsh-bridge-0.6.0.tgz' }] },
    { tag: 'v9.9.9', prerelease: true, assets: [{ name: 'omnichat-dsh-bridge-0.9.0.tgz' }] },
    { tag: 'v2.0.0', prerelease: false, assets: [{ name: 'omnichat-dsh-bridge-0.7.0-beta.1.tgz' }, { name: 'omnichat-dsh-bridge-0.6.5.tgz' }] },
  ])
  assert.equal(found.version, '0.6.5')
  assert.equal(found.release.tag, 'v2.0.0')
  assert.equal(pickPlugin([{ tag: 'v1', prerelease: false, assets: [{ name: 'omnichat-server-bundle-1.0.0.zip' }] }]), null)
})

test('parseSums and parsePerAsset read sha256sum output', () => {
  const hex = 'a'.repeat(64)
  const sums = parseSums(`${hex}  omnichat-dsh-bridge-0.6.0.tgz\r\n${'B'.repeat(64)} *other.zip\nnot a line\n`)
  assert.equal(sums.get('omnichat-dsh-bridge-0.6.0.tgz'), hex)
  assert.equal(sums.get('other.zip'), 'b'.repeat(64), 'hex is lower-cased, binary marker tolerated')
  assert.equal(parsePerAsset(`${hex}\n`, 'x.tgz'), hex)
  assert.equal(parsePerAsset(`${hex}  x.tgz\n`, 'x.tgz'), hex)
  assert.equal(parsePerAsset(`${hex}  y.tgz\n`, 'x.tgz'), null, 'a checksum for another file is not used')
})

test('installCommand: one PowerShell-safe line with the path quoted and escaped', () => {
  assert.equal(
    installCommand('desktop', 'C:\\Users\\me\\.dsh\\omnichat-update\\omnichat-dsh-bridge-0.6.0.tgz'),
    'dsh plugin --profile desktop remove @omnichat/dsh-bridge; dsh plugin --profile desktop add "C:\\Users\\me\\.dsh\\omnichat-update\\omnichat-dsh-bridge-0.6.0.tgz"',
  )
  assert.ok(installCommand('web', 'C:\\a$b`c"d.tgz').endsWith('add "C:\\a`$b``c`"d.tgz"'))
})

// ---------------------------------------------------------------- check

test('a newer plugin release is found and marked as an available update', async () => {
  const srv = await startGithub()
  srv.setReleases([release('v0.6.0', [plugin('0.6.0')])])
  const { u } = makeUpdater(srv)
  const s = await u.check()
  assert.equal(s.current, '0.5.0')
  assert.equal(s.latest.version, '0.6.0')
  assert.equal(s.latest.name, 'omnichat-dsh-bridge-0.6.0.tgz')
  assert.equal(s.updateAvailable, true)
  assert.equal(s.error, null)
  assert.equal(typeof s.checkedAt, 'number')
  assert.equal(s.command, null, 'no command before staging')
})

test('an equal or older plugin is not an update', async () => {
  const srv = await startGithub()
  srv.setReleases([release('v0.6.0', [plugin('0.6.0')])])
  const equal = makeUpdater(srv, { currentVersion: '0.6.0' })
  assert.equal((await equal.u.check()).updateAvailable, false)
  const older = makeUpdater(srv, { currentVersion: '0.7.0' })
  const s = await older.u.check()
  assert.equal(s.latest.version, '0.6.0')
  assert.equal(s.updateAvailable, false)
})

test('draft releases and prerelease releases are ignored', async () => {
  const srv = await startGithub()
  srv.setReleases([
    release('v0.9.0', [plugin('0.9.0')], { prerelease: true }),
    release('v0.8.0', [plugin('0.8.0')], { draft: true }),
    release('v0.7.0', [plugin('0.7.0-beta.1')]),
    release('v0.6.0', [plugin('0.6.0')]),
  ])
  const { u } = makeUpdater(srv)
  const s = await u.check()
  assert.equal(s.latest.version, '0.6.0')
})

test('the plugin version comes from the asset name, not the release tag', async () => {
  const srv = await startGithub()
  srv.setReleases([release('v3.4.5', [plugin('0.6.0')])])
  const { u } = makeUpdater(srv)
  const s = await u.check()
  assert.equal(s.latest.version, '0.6.0')
  assert.equal(s.latest.tag, 'v3.4.5')
})

test('no plugin asset gives a no-plugin error, not an update', async () => {
  const srv = await startGithub()
  srv.setReleases([release('v1.0.0', [])])
  const { u } = makeUpdater(srv)
  const s = await u.check()
  assert.equal(s.error.code, 'no-plugin')
  assert.equal(s.latest, null)
  assert.equal(s.updateAvailable, false)
})

test('a repeat check sends If-None-Match and reuses the cached list on 304', async () => {
  const srv = await startGithub()
  srv.setReleases([release('v0.6.0', [plugin('0.6.0')])])
  const { u } = makeUpdater(srv)
  await u.check()
  const s = await u.check()
  const list = srv.hits.filter((h) => h.path.startsWith('/repos/'))
  assert.equal(list.length, 2)
  assert.equal(list[0].ifNoneMatch, null)
  assert.equal(list[1].ifNoneMatch, srv.etag)
  assert.equal(list[1].status, 304)
  assert.equal(s.latest.version, '0.6.0', 'the cached release list still gives the result')
  assert.equal(s.error, null)
})

test('rate limit and 404 give readable messages', async () => {
  const srv = await startGithub()
  srv.mode = 'rate'
  const { u } = makeUpdater(srv)
  const limited = await u.check()
  assert.equal(limited.error.code, 'rate-limited')
  assert.match(limited.error.message, /rate limit/)

  srv.mode = 'notfound'
  const missing = await makeUpdater(srv).u.check()
  assert.equal(missing.error.code, 'not-found')
  assert.match(missing.error.message, /OMNICHAT_UPDATE_REPO/)
  assert.match(missing.error.message, /token/)
})

test('the token goes to the API host only, and never into an error message', async () => {
  const secret = 'ghp_SECRET_TOKEN_12345'
  const srv = await startGithub({ token: secret })
  srv.setReleases([release('v0.6.0', [plugin('0.6.0')])])

  // With a token that the server rejects: the message must not repeat it.
  const wrong = await makeUpdater(srv, { token: 'ghp_WRONG_TOKEN_999' }).u.check()
  assert.equal(wrong.error.code, 'unauthorized')
  assert.ok(!wrong.error.message.includes('ghp_WRONG_TOKEN_999'))
  assert.ok(!JSON.stringify(wrong).includes('ghp_WRONG_TOKEN_999'))

  srv.hits.length = 0 // only the requests of the correct-token updater below
  const ok = await makeUpdater(srv, { token: secret }).u.check()
  assert.equal(ok.latest.version, '0.6.0')
  for (const h of srv.hits) {
    if (h.auth !== null) assert.equal(h.auth, `Bearer ${secret}`)
  }
  assert.ok(srv.hits.some((h) => h.path.startsWith('/repos/') && h.auth === `Bearer ${secret}`), 'the API call carries the token')
})

test('the token config field wins over OMNICHAT_UPDATE_TOKEN and is not logged', async () => {
  const srv = await startGithub({ token: 'from-config' })
  srv.setReleases([release('v0.6.0', [plugin('0.6.0')])])
  const dshHome = tempDir()
  const logs = []
  const u = createUpdater({
    currentVersion: '0.5.0',
    dshHome,
    env: { OMNICHAT_UPDATE_TOKEN: 'from-env' },
    token: 'from-config',
    apiBase: srv.base,
    log: (m) => logs.push(m),
  })
  const s = await u.check()
  assert.equal(s.latest.version, '0.6.0')
  assert.ok(srv.hits.every((h) => h.auth === null || h.auth === 'Bearer from-config'))
  assert.ok(!logs.join('\n').includes('from-config'))
})

test('a non-loopback http API base is refused before any request', async () => {
  let calls = 0
  const dshHome = tempDir()
  const u = createUpdater({
    currentVersion: '0.5.0',
    dshHome,
    env: {},
    apiBase: 'http://github.example.com',
    fetchImpl: async () => { calls += 1; return new Response('[]') },
  })
  const s = await u.check()
  assert.equal(s.error.code, 'unsupported')
  assert.equal(calls, 0)
})

test('an invalid repository name is refused', async () => {
  const srv = await startGithub()
  const { u } = makeUpdater(srv, { repo: 'bad repo/../x' })
  const s = await u.check()
  assert.equal(s.error.code, 'unsupported')
  assert.equal(srv.hits.length, 0)
})

test('check is limited to one request per interval unless forced', async () => {
  const srv = await startGithub()
  srv.setReleases([release('v0.6.0', [plugin('0.6.0')])])
  let clock = 1_000_000
  const { u } = makeUpdater(srv, { now: () => clock })
  await u.check()
  await u.check({ maxAgeMs: CHECK_INTERVAL_MS })
  assert.equal(srv.hits.filter((h) => h.path.startsWith('/repos/')).length, 1, 'fresh cache: no request')
  clock += CHECK_INTERVAL_MS - 1
  await u.check({ maxAgeMs: CHECK_INTERVAL_MS })
  assert.equal(srv.hits.filter((h) => h.path.startsWith('/repos/')).length, 1, 'still fresh just before 6 hours')
  clock += 1
  await u.check({ maxAgeMs: CHECK_INTERVAL_MS })
  assert.equal(srv.hits.filter((h) => h.path.startsWith('/repos/')).length, 2, 'stale after 6 hours')
  await u.check()
  assert.equal(srv.hits.filter((h) => h.path.startsWith('/repos/')).length, 3, 'a forced check always asks')
})

test('the last check survives a restart (new updater, same dshHome)', async () => {
  const srv = await startGithub()
  srv.setReleases([release('v0.6.0', [plugin('0.6.0')])])
  const { u, dshHome } = makeUpdater(srv)
  await u.check()
  const again = createUpdater({ currentVersion: '0.5.0', dshHome, env: {}, apiBase: srv.base })
  assert.equal(again.state().latest.version, '0.6.0')
  await again.check({ maxAgeMs: CHECK_INTERVAL_MS })
  assert.equal(srv.hits.filter((h) => h.path.startsWith('/repos/')).length, 1, 'fresh across restarts: no request')
})

// ---------------------------------------------------------------- stage

test('stage downloads, verifies and stores the package with the right hash and returns the command', async () => {
  const srv = await startGithub()
  const data = Buffer.from('the real plugin package bytes')
  srv.setReleases([release('v0.6.0', [plugin('0.6.0', { data })])])
  const { u, dshHome, stagedDir } = makeUpdater(srv)
  await u.check()
  const s = await u.stage()
  const file = path.join(stagedDir, 'omnichat-dsh-bridge-0.6.0.tgz')
  assert.equal(s.staged.version, '0.6.0')
  assert.equal(s.staged.file, file)
  assert.equal(s.staged.sha256, sha256(data))
  assert.deepEqual(fs.readFileSync(file), data)
  assert.equal(sha256(fs.readFileSync(file)), sha256(data))
  assert.equal(s.command, installCommand('desktop', file))
  assert.match(s.command, /^dsh plugin --profile desktop remove @omnichat\/dsh-bridge; dsh plugin --profile desktop add "/)
  assert.deepEqual(stagedFiles(stagedDir), ['omnichat-dsh-bridge-0.6.0.tgz'], 'no .part file is left behind')
  assert.ok(file.startsWith(path.join(dshHome, 'omnichat-update')))
})

test('a staged package is still offered after a restart', async () => {
  const srv = await startGithub()
  srv.setReleases([release('v0.6.0', [plugin('0.6.0')])])
  const { u, dshHome } = makeUpdater(srv)
  await u.check()
  await u.stage()
  const again = createUpdater({ currentVersion: '0.5.0', dshHome, env: {}, apiBase: srv.base })
  const s = again.state()
  assert.equal(s.staged.version, '0.6.0')
  assert.ok(s.command && s.command.includes('omnichat-dsh-bridge-0.6.0.tgz'))
})

test('a per-asset .sha256 file is accepted when there is no SHA256SUMS', async () => {
  const srv = await startGithub()
  srv.setReleases([release('v0.6.0', [plugin('0.6.0')], { sums: 'per' })])
  const { u, stagedDir } = makeUpdater(srv)
  const s = await u.stage()
  assert.equal(s.staged.version, '0.6.0')
  assert.deepEqual(stagedFiles(stagedDir), ['omnichat-dsh-bridge-0.6.0.tgz'])
})

test('a checksum mismatch refuses to stage and leaves no file behind', async () => {
  const srv = await startGithub()
  srv.setReleases([release('v0.6.0', [plugin('0.6.0')], { sums: 'wrong' })])
  const { u, stagedDir } = makeUpdater(srv)
  await assert.rejects(u.stage(), (e) => {
    assert.ok(e instanceof UpdateFailure)
    assert.equal(e.code, 'checksum-mismatch')
    return true
  })
  assert.deepEqual(stagedFiles(stagedDir), [])
  assert.equal(u.state().staged, null)
  assert.equal(u.state().command, null)
})

test('a missing checksum refuses to stage and downloads nothing', async () => {
  const srv = await startGithub()
  srv.setReleases([release('v0.6.0', [plugin('0.6.0')], { sums: 'none' })])
  const { u, stagedDir } = makeUpdater(srv)
  await assert.rejects(u.stage(), (e) => {
    assert.equal(e.code, 'checksum-missing')
    return true
  })
  assert.deepEqual(stagedFiles(stagedDir), [])
  assert.equal(srv.hits.filter((h) => h.path.startsWith('/dl/')).length, 0, 'the package itself was never fetched')
})

test('the token is sent to the API host only: the CDN redirect hop gets no Authorization', async () => {
  const secret = 'ghp_REDIRECT_CHECK'
  const srv = await startGithub({ token: secret })
  srv.setReleases([release('v0.6.0', [plugin('0.6.0')])])
  const { u } = makeUpdater(srv, { token: secret })
  const s = await u.stage()
  assert.equal(s.staged.version, '0.6.0')
  const cdn = srv.hits.filter((h) => h.path.startsWith('/cdn/'))
  assert.ok(cdn.length >= 2, 'the package and the checksum were fetched through the redirect')
  for (const h of cdn) {
    assert.equal(h.auth, null, 'no Authorization on the redirected hop')
    assert.equal(h.host, `localhost:${srv.port}`)
  }
  for (const h of srv.hits.filter((x) => x.path.startsWith('/assets/'))) {
    assert.equal(h.auth, `Bearer ${secret}`)
    assert.equal(h.host, `127.0.0.1:${srv.port}`)
  }
})

test('without a token the browser download URL is used and no Authorization is sent', async () => {
  const srv = await startGithub()
  srv.setReleases([release('v0.6.0', [plugin('0.6.0')])])
  const { u } = makeUpdater(srv)
  await u.stage()
  assert.ok(srv.hits.some((h) => h.path.startsWith('/dl/omnichat-dsh-bridge-0.6.0.tgz')))
  assert.ok(srv.hits.every((h) => h.auth === null))
})

test('an endless redirect is stopped after five hops', async () => {
  const srv = await startGithub()
  srv.setReleases([release('v0.6.0', [plugin('0.6.0', { browserUrl: `${srv.base}/loop` })], { sums: 'per' })])
  const { u, stagedDir } = makeUpdater(srv)
  await assert.rejects(u.stage(), (e) => {
    assert.equal(e.code, 'download')
    assert.match(e.message, /redirect/)
    return true
  })
  assert.deepEqual(stagedFiles(stagedDir), [])
})

test('a download larger than the cap is refused and nothing is kept', async () => {
  const srv = await startGithub()
  srv.setReleases([release('v0.6.0', [plugin('0.6.0', { data: Buffer.alloc(4096, 1) })])])
  const { u, stagedDir } = makeUpdater(srv, { maxBytes: 1024 })
  await assert.rejects(u.stage(), (e) => {
    assert.equal(e.code, 'download')
    return true
  })
  assert.deepEqual(stagedFiles(stagedDir), [])
})

test('stage with nothing newer than the installed version stages nothing', async () => {
  const srv = await startGithub()
  srv.setReleases([release('v0.5.0', [plugin('0.5.0')])])
  const { u, stagedDir } = makeUpdater(srv)
  const s = await u.stage()
  assert.equal(s.updateAvailable, false)
  assert.equal(s.staged, null)
  assert.deepEqual(stagedFiles(stagedDir), [])
})

test('staging a newer version removes the older staged package', async () => {
  const srv = await startGithub()
  srv.setReleases([release('v0.6.0', [plugin('0.6.0')])])
  const { u, stagedDir } = makeUpdater(srv)
  await u.stage()
  srv.setReleases([release('v0.7.0', [plugin('0.7.0')])])
  await u.check()
  const s = await u.stage()
  assert.equal(s.staged.version, '0.7.0')
  assert.deepEqual(stagedFiles(stagedDir), ['omnichat-dsh-bridge-0.7.0.tgz'])
})

test('the profile in the command comes from DSH_PROFILE and falls back to desktop', async () => {
  const srv = await startGithub()
  srv.setReleases([release('v0.6.0', [plugin('0.6.0')])])
  const dshHome = tempDir()
  const u = createUpdater({ currentVersion: '0.5.0', dshHome, env: { DSH_PROFILE: 'web' }, apiBase: srv.base })
  await u.stage()
  assert.match(u.state().command, /--profile web remove/)
  const bad = createUpdater({ currentVersion: '0.5.0', dshHome: tempDir(), env: { DSH_PROFILE: 'we b;rm' }, apiBase: srv.base })
  assert.equal(bad.state().profile, 'desktop')
})
