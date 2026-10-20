import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const patchFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cordis.patch.yml')
const lines = fs.readFileSync(patchFile, 'utf8').split(/\r?\n/)

// dsh rejects the whole installation when this file is not valid YAML (a real failure on 2026-10-17:
// `? 'remote' : 'local'` inside an unquoted `!!js` scalar was read as a mapping key). Keep every `!!js`
// value free of a colon followed by a space, and of ` #` (comment start) inside the expression.
test('cordis.patch.yml: unquoted !!js scalars contain no ": " or " #"', () => {
  const bad = []
  lines.forEach((line, i) => {
    const m = /^\s*[A-Za-z0-9_-]+:\s+!!js\s+(.*)$/.exec(line)
    if (!m) return
    const expr = m[1]
    if (/^["']/.test(expr)) return // quoted scalars are fine
    if (/:\s/.test(expr) || /\s#/.test(expr) || /:$/.test(expr)) bad.push(`line ${i + 1}: ${line.trim()}`)
  })
  assert.deepEqual(bad, [])
})

test('cordis.patch.yml: has the omnichat-bridge entry with a mode default of local', () => {
  const text = lines.join('\n')
  assert.match(text, /id: omnichat-bridge/)
  assert.match(text, /mode: !!js .*'local'/)
})
