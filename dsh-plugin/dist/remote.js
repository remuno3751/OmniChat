/**
 * omnichat-dsh-bridge — Host owner of the `omnichatbridge` Remote namespace.
 *
 * The settings page (browser half) shows the local pairing state and can regenerate the pairing code.
 * getState and regenerate take no parameters; approve and deny take a pending request id. All four return the
 * same state object. The code itself is only ever returned to the settings page; it is never logged.
 *
 * Plain-JS equivalent of a Typert `@Remote` owner class (same shape as dsh-web-search's remote.js):
 * - `TypertRemoteService` registers the service on ctx at construction.
 * - Endpoint discovery is dual-path: `ctx.typert.local` (populated by `ctx.typert.register()`, see
 *   {@link hostContribution}) and the SRC prototype descriptor written by `markRemote()`.
 * - Business failures throw `RemoteError(code, message, details)` with `isDSHRemoteError: true`.
 *
 * `@deepseek-ai/dsh-typert-protocol` is provided by the dsh host and is not a dependency of this package.
 * When it cannot be imported, the shims below are used so this module still loads (tests, other hosts).
 */

import { UpdateFailure, CHECK_INTERVAL_MS } from './updater.js'

let RemoteError
let TypertRemoteService

try {
  const protocol = await import('@deepseek-ai/dsh-typert-protocol')
  RemoteError = protocol.RemoteError
  TypertRemoteService = protocol.TypertRemoteService
} catch {
  /* not available: use the shims below */
}

if (typeof RemoteError !== 'function') {
  RemoteError = class RemoteError extends Error {
    constructor(code, message, details = {}) {
      super(message)
      this.name = 'RemoteError'
      this.code = code
      this.details = details
      this.isDSHRemoteError = true
    }
  }
}

if (typeof TypertRemoteService !== 'function') {
  TypertRemoteService = class TypertRemoteService {
    constructor(ctx, serviceKey, opts = {}) {
      this.ctx = ctx
      this.serviceKey = serviceKey
      this.namespace = opts.namespace
      this.typertRemote = { service: this, serviceKey, namespace: opts.namespace }
    }
  }
}

export const OMNICHAT_NAMESPACE = 'omnichatbridge'
export const OMNICHAT_SERVICE_KEY = 'omniChatBridgeController'
export const OMNICHAT_PACKAGE = 'omnichat-dsh-bridge'

// ─── SRC prototype descriptor (fallback for Gateway remoteMethods()) ───
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

function markRemote(prototype, method) {
  const existing = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR)?.value
  const methods = [
    ...(existing?.methods ?? []),
    Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }),
  ]
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({ version: 1, methods: Object.freeze(methods) }),
  })
}

const OMNI_METHODS = ['omniModels', 'omniImport', 'omniSync', 'omniRemove']
// Plugin update check and staging (updater.js). Both take one json `args` parameter.
const UPDATE_METHODS = ['updateState', 'updateRun']
const REMOTE_METHODS = ['getState', 'regenerate', 'approve', 'deny', ...OMNI_METHODS, ...UPDATE_METHODS]

// Parameter descriptors for the methods that take an argument. Same shape as the dsh-web-search plugin (one json `args` parameter, here { id }); verified on a real dsh host.
const ARGS_PARAMETER = [{ name: 'args', wire: 'args', source: 'json', codec: { mode: 'src-json' } }]
const METHOD_PARAMETERS = {
  approve: ARGS_PARAMETER,
  deny: ARGS_PARAMETER,
  omniModels: ARGS_PARAMETER,
  omniImport: ARGS_PARAMETER,
  omniSync: ARGS_PARAMETER,
  omniRemove: ARGS_PARAMETER,
  updateState: ARGS_PARAMETER,
  updateRun: ARGS_PARAMETER,
}

/** The "not local" failure: the pairing code only exists while the plugin runs the local link. */
export function notLocalError() {
  return new RemoteError('omnichatbridge/not-local', 'The OmniChat pairing code is only available in local mode', {})
}

/** A pending request id from a plain string or from `{ id }`; anything else yields undefined. */
function requestId(arg) {
  if (typeof arg === 'string') return arg
  if (arg && typeof arg === 'object') return arg.id
  return undefined
}

/** Normalises the `args` of the omni methods: anything that is not an object becomes {}. */
function omniArgs(args) {
  return args && typeof args === 'object' ? args : {}
}

/** Runs an OmniChat operation: RemoteErrors pass through, anything else becomes omnichatbridge/omni-failed. */
async function omniCall(fn) {
  try {
    return await fn()
  } catch (e) {
    if (e && e.isDSHRemoteError) throw e
    throw new RemoteError('omnichatbridge/omni-failed', (e && e.message) || 'The OmniChat model import failed', {})
  }
}

/** Maps a failure of approve/deny to a RemoteError. Remote errors pass through; unknown requests keep their own code. */
function asRemoteError(e, code, fallback) {
  if (e && e.isDSHRemoteError) return e
  if (e && e.code === 'unknown-request') {
    return new RemoteError('omnichatbridge/unknown-request', (e && e.message) || 'No such pending request', {})
  }
  return new RemoteError(code, (e && e.message) || fallback, {})
}

/**
 * Build the host-side Typert contribution registered via `ctx.typert.register`.
 * @returns the Typert `face: 'host'` contribution for this package.
 */
export function hostContribution() {
  return {
    package: OMNICHAT_PACKAGE,
    face: 'host',
    model: { services: [], events: [], objects: [] },
    schemas: [],
    invocations: REMOTE_METHODS.map((method) => ({
      id: `${OMNICHAT_PACKAGE}#${OMNICHAT_NAMESPACE}/${method}`,
      service: OMNICHAT_SERVICE_KEY,
      namespace: OMNICHAT_NAMESPACE,
      method,
      invocation: { kind: 'direct' },
      parameters: METHOD_PARAMETERS[method] ?? [],
      result: { mode: 'src-json' },
    })),
  }
}

/**
 * Maps an updater failure to a RemoteError. Checksum refusals keep their own code
 * (omnichatbridge/checksum-missing, omnichatbridge/checksum-mismatch); everything else is update-failed.
 * The message comes from the updater, which never puts the token in it.
 */
function updateRemoteError(e) {
  if (e && e.isDSHRemoteError) return e
  const reason = e && typeof e.code === 'string' ? e.code : 'other'
  const code = reason === 'checksum-missing' || reason === 'checksum-mismatch'
    ? `omnichatbridge/${reason}`
    : 'omnichatbridge/update-failed'
  const message = (e && e.message) || 'The plugin update failed'
  return new RemoteError(code, message, { reason })
}

/** Runs an update operation: RemoteErrors pass through, updater failures are mapped, anything else is update-failed. */
async function updateCall(fn) {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof UpdateFailure || (e && e.isDSHRemoteError)) throw updateRemoteError(e)
    throw updateRemoteError(new UpdateFailure('other', (e && e.message) || 'The plugin update failed'))
  }
}

/**
 * Plugin update operations (see updater.js). `updateState` checks GitHub at most once per 6 hours
 * (cached result otherwise); `updateRun` checks and/or stages when asked.
 */
function updateBridgeOps(updater) {
  const need = () => {
    if (!updater || typeof updater !== 'object') {
      throw new RemoteError('omnichatbridge/update-failed', 'Plugin updates are not available in this bridge', { reason: 'unavailable' })
    }
    return updater
  }
  return {
    updateState: () => need().check({ maxAgeMs: CHECK_INTERVAL_MS }),
    updateRun: async (args) => {
      const u = need()
      if (args.check === true) await u.check()
      if (args.stage === true) return u.stage()
      return u.state()
    },
  }
}

/**
 * The OmniChat model-import operations (see omnimodels.js). Without an `omni` instance every call throws
 * omnichatbridge/omni-not-connected.
 */
function omniBridgeOps(omni) {
  const need = () => {
    if (!omni || typeof omni !== 'object') {
      throw new RemoteError('omnichatbridge/omni-not-connected', 'The OmniChat model import is not available', {})
    }
    return omni
  }
  return {
    omniModels: () => need().state({ refresh: true }),
    omniImport: (args) => need().import(args),
    omniSync: (args) => need().sync(args),
    omniRemove: (args) => need().remove(args),
  }
}

/**
 * Host operations behind the controller. `link` is the LocalLink in local mode; in remote mode it is absent and
 * the state is the fixed "not local" shape. `name` and `version` are echoed in every state object.
 * `omni` is the OmniModels instance (optional). `updater` is the plugin update check (updater.js, optional).
 */
export function makeBridgeOps({ config, link, pluginVersion, omni, updater }) {
  const name = typeof config?.name === 'string' ? config.name : ''
  const version = typeof pluginVersion === 'string' ? pluginVersion : '0.0.0'
  const omniOps = omniBridgeOps(omni)
  const updateOps = updateBridgeOps(updater)
  if (!link) {
    const remoteState = () => ({
      mode: 'remote',
      active: false,
      code: null,
      port: null,
      address: null,
      paired: false,
      pairedAt: null,
      allowedOrigins: [],
      clients: 0,
      locked: false,
      lockedUntilMs: 0,
      pending: [],
      name,
      version,
    })
    return {
      getState: () => remoteState(),
      regenerate: () => {
        throw notLocalError()
      },
      approve: () => {
        throw notLocalError()
      },
      deny: () => {
        throw notLocalError()
      },
      ...omniOps,
      ...updateOps,
    }
  }
  return {
    getState: () => ({ mode: 'local', ...link.status(), name, version }),
    regenerate: () => ({ mode: 'local', ...link.regenerate(), name, version }),
    approve: (arg) => ({ mode: 'local', ...link.approve(requestId(arg)), name, version }),
    deny: (arg) => ({ mode: 'local', ...link.deny(requestId(arg)), name, version }),
    ...omniOps,
    ...updateOps,
  }
}

/**
 * Host service backing the generated `ctx.remote.omnichatbridge` namespace.
 * @param ctx - plugin context (the fiber owning the registration).
 * @param ops - `{ getState(), regenerate() }`, see {@link makeBridgeOps}.
 */
export class OmniChatBridgeController extends TypertRemoteService {
  constructor(ctx, ops) {
    super(ctx, OMNICHAT_SERVICE_KEY, { namespace: OMNICHAT_NAMESPACE })
    this.ops = ops
  }

  /** Current pairing state (the same shape `regenerate` returns). */
  async getState() {
    try {
      return await this.ops.getState()
    } catch (e) {
      if (e && e.isDSHRemoteError) throw e
      throw new RemoteError('omnichatbridge/state-failed', (e && e.message) || 'Reading the bridge state failed', {})
    }
  }

  /** Replace the pairing code and disconnect the attached app. Throws not-local in remote mode. */
  async regenerate() {
    try {
      return await this.ops.regenerate()
    } catch (e) {
      if (e && e.isDSHRemoteError) throw e
      throw new RemoteError('omnichatbridge/regenerate-failed', (e && e.message) || 'Regenerating the pairing code failed', {})
    }
  }

  /** Approve a pending pairing request by id (a string or `{ id }`). Throws not-local in remote mode. */
  // The parameter name must be `args`: dsh reads SRC parameter names from the method signature.
  async approve(args) {
    try {
      return await this.ops.approve(args)
    } catch (e) {
      throw asRemoteError(e, 'omnichatbridge/approve-failed', 'Approving the pairing request failed')
    }
  }

  /** Refuse a pending pairing request by id (a string or `{ id }`). Throws not-local in remote mode. */
  async deny(args) {
    try {
      return await this.ops.deny(args)
    } catch (e) {
      throw asRemoteError(e, 'omnichatbridge/deny-failed', 'Denying the pairing request failed')
    }
  }

  /** OmniChat models as dsh sees them: the OmniState (see omnimodels.js). Never throws for transport problems. */
  async omniModels(args) {
    return omniCall(() => this.ops.omniModels(omniArgs(args)))
  }

  /** Import the given OmniChat model ids (`{ids, baseUrl?}`) into dsh. Returns the OmniState. */
  async omniImport(args) {
    return omniCall(() => this.ops.omniImport(omniArgs(args)))
  }

  /** Refresh the imported OmniChat models (`{addNew?}`). Returns the OmniState plus `diff`. */
  async omniSync(args) {
    return omniCall(() => this.ops.omniSync(omniArgs(args)))
  }

  /** Remove imported OmniChat models (`{all?, ids?}`). Returns the OmniState. */
  async omniRemove(args) {
    return omniCall(() => this.ops.omniRemove(omniArgs(args)))
  }

  /** Plugin update state: the installed and latest plugin versions (`updater.js`). Checks GitHub at most every 6 hours. */
  async updateState(args) {
    return updateCall(() => this.ops.updateState(omniArgs(args)))
  }

  /** Plugin update actions: `{check?: true, stage?: true}`. Stage downloads and verifies the new package; it is never installed live. */
  async updateRun(args) {
    return updateCall(() => this.ops.updateRun(omniArgs(args)))
  }
}

// ─── SRC fallback: write prototype descriptor for Gateway remoteMethods() ───
for (const method of REMOTE_METHODS) {
  markRemote(OmniChatBridgeController.prototype, method)
}

export { RemoteError }
