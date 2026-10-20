import fs from 'node:fs'
import { createRequire } from 'node:module'
import { validateConfig } from './config.js'
import { createHost } from './host.js'
import { OmniBridge } from './bridge.js'
import { LocalLink } from './local.js'
import { dshHome } from './pairing.js'
import { OmniModels } from './omnimodels.js'
import { OmniChatBridgeController, hostContribution, makeBridgeOps } from './remote.js'
import { createUpdater } from './updater.js'

export const name = 'omnichat-bridge'

// Only the session controller is mandatory (it exists in the web/desktop profiles). Everything else
// (agentDefaultModel, agents, sessions) is looked up defensively with ctx.get() inside the host adapter.
export const inject = ['sessionController']

export const PREFIX = '[omnichat]'

// stderr is where dsh's host process (web terminal / desktop host log) shows plugin output.
function makeLog(_ctx) {
  return (msg) => {
    try {
      console.error(`${PREFIX} ${msg}`)
    } catch {
      /* ignore */
    }
  }
}

function detectDshVersion() {
  try {
    const req = createRequire(process.argv[1] ?? import.meta.url)
    const v = req('@deepseek-ai/dsh/package.json')?.version
    if (typeof v === 'string') return v
  } catch {
    /* not resolvable: leave unset */
  }
  return process.env.DSH_VERSION || undefined
}

function readPluginVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))?.version
    if (typeof v === 'string') return v
  } catch {
    /* unreadable: fall through */
  }
  return '0.0.0'
}

/** A dsh service by name (ctx.get, else ctx.<name>); undefined when unavailable. Never throws. */
function service(ctx, name) {
  try {
    return ctx.get(name) ?? ctx[name]
  } catch {
    return undefined
  }
}

/**
 * The OmniChat model import (omnimodels.js). Services are looked up on every call. Never throws: without it
 * the settings-page import reports omni-not-connected and the bridge runs as before.
 */
function makeOmni(ctx, log, bridge) {
  try {
    return new OmniModels({
      send: (frame) => bridge.sendToServer(frame),
      getServices: () => {
        try {
          return { settings: service(ctx, 'settings'), credentials: service(ctx, 'credentials') }
        } catch {
          return {}
        }
      },
      dshHome: dshHome(),
      log: (m) => log(bridge.scrub(m)),
      linked: () => bridge.ws?.readyState === 1,
    })
  } catch (e) {
    log(`model import not available: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/**
 * Settings-page remote (`omnichatbridge`). Optional: without ctx.typert the controller is still constructed
 * and nothing is registered. Any failure is logged and never affects the bridge.
 */
function registerRemote(ctx, log, { config, link, pluginVersion, omni, updater }) {
  try {
    const ops = makeBridgeOps({ config, link, pluginVersion, omni, updater })
    new OmniChatBridgeController(ctx, ops)
    if (typeof ctx.typert?.register === 'function') ctx.typert.register(hostContribution())
  } catch (e) {
    log(`settings remote not registered: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Cordis plugin entry. Never throws: any failure is logged once and the plugin stays inert,
 * so a broken OmniChat bridge can never take dsh down.
 */
export function apply(ctx, rawConfig) {
  const log = makeLog(ctx)
  try {
    const { config, errors, warnings } = validateConfig(rawConfig)
    for (const w of warnings) log(`warning: ${w}`)
    if (!config) {
      log(`disabled: invalid configuration: ${errors.join('; ')}`)
      return
    }
    const host = createHost(ctx, log)
    const missing = host.missing()
    if (missing.length) {
      log(`disabled: this dsh build lacks ${missing.join(', ')} (internal API changed?)`)
      return
    }
    if (config.mirror && !host.hasMirrorApi()) {
      log('warning: session history API (sessionController.inspect / sessions) is missing: mirroring is off, remote runs still work')
      config.mirror = false
    }
    const local = config.mode === 'local'
    const pluginVersion = readPluginVersion()
    const link = local ? new LocalLink({ config, log: (m) => log(m), rawLog: log, pluginVersion }) : undefined
    const bridge = new OmniBridge({ host, config, log, dshVersion: detectDshVersion(), pluginVersion, link })
    // Plugin update check and staging (updater.js). Nothing is requested until the settings page asks.
    const updater = createUpdater({ currentVersion: pluginVersion, dshHome: dshHome(), token: config.updateToken, log: (m) => log(bridge.scrub(m)) })
    const omni = makeOmni(ctx, log, bridge)
    if (omni) bridge.omni = omni
    ctx.effect(() => {
      try {
        bridge.start()
      } catch (e) {
        log(`failed to start: ${e instanceof Error ? e.message : String(e)}`)
      }
      return () => {
        try {
          bridge.stop()
        } catch {
          /* ignore */
        }
      }
    }, 'omnichat-bridge')
    registerRemote(ctx, log, { config, link, pluginVersion, omni, updater })
    if (local) log(`plugin loaded (local mode, 127.0.0.1:${config.listenPort}, name '${config.name}', mirror ${config.mirror ? 'on' : 'off'})`)
    else log(`plugin loaded (server ${new URL(config.serverUrl).origin}, name '${config.name}', mirror ${config.mirror ? 'on' : 'off'})`)
  } catch (e) {
    try {
      log(`startup error: ${e instanceof Error ? e.message : String(e)}`)
    } catch {
      /* ignore */
    }
  }
}
