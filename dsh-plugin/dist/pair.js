#!/usr/bin/env node
// Prints the OmniChat pairing code and local address for the omnichat-bridge plugin (local mode).
// Usage: node dist/pair.js [--home <dir>] [--file <path>] [--json]
import fs from 'node:fs'
import path from 'node:path'
import { defaultPairingFile, readPairing } from './pairing.js'

const DEFAULT_PORT = 19401
const USAGE = 'usage: node dist/pair.js [--home <dir>] [--file <path>] [--json]'

function parseArgs(argv) {
  const out = { home: undefined, file: undefined, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--home' || a === '--file') {
      const v = argv[++i]
      if (!v) throw new Error(`${a} needs a value`)
      out[a.slice(2)] = v
    } else throw new Error(`unknown argument "${a}"`)
  }
  return out
}

function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n${USAGE}\n`)
    return 2
  }
  const file = path.resolve(args.file ?? defaultPairingFile(args.home ? { DSH_HOME: args.home } : process.env))

  if (!fs.existsSync(file)) {
    process.stderr.write(`No pairing file at ${file}. Start dsh once with the omnichat-bridge plugin installed (local mode).\n`)
    return 1
  }
  const data = readPairing(file)
  if (!data) {
    process.stderr.write(`Pairing file at ${file} is invalid. Start dsh once with the omnichat-bridge plugin installed (local mode) to regenerate it.\n`)
    return 1
  }

  const port = data.listenPort ?? DEFAULT_PORT
  const url = `ws://127.0.0.1:${port}/omnichat-bridge`
  const paired = typeof data.pairedAt === 'string'
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ code: data.pairing, port, url, file, paired })}\n`)
  } else {
    process.stdout.write(`OmniChat pairing code: ${data.pairing}\nLocal address: ${url}\nFile: ${file}\n`)
  }
  return 0
}

process.exitCode = main(process.argv.slice(2))
