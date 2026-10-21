/**
 * Token storage over VS Code `SecretStorage` (spec docs/design/VSCODE-BRIDGE.md §6).
 *
 * Errors thrown here are generic on purpose. The underlying error text is
 * dropped because it can echo the token, and the token value is never logged.
 */

/** The key the device token is stored under. */
export const TOKEN_KEY = "omnichat.deviceToken";

/** Structural subset of `vscode.SecretStorage`, so tests can pass a fake. */
export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export interface TokenStore {
  get(): Promise<string | undefined>;
  /** Rejects with an error whose message never contains the token. */
  set(token: string): Promise<void>;
  delete(): Promise<void>;
}

async function attempt<T>(op: string, fn: () => PromiseLike<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new Error(`secret storage ${op} failed`);
  }
}

export function createTokenStore(secretStorage: SecretStorageLike): TokenStore {
  return {
    get: () => attempt("read", () => secretStorage.get(TOKEN_KEY)),

    async set(token: string): Promise<void> {
      if (typeof token !== "string" || token.length === 0) {
        throw new Error("token must be a non-empty string");
      }
      await attempt("write", () => secretStorage.store(TOKEN_KEY, token));
    },

    delete: () => attempt("delete", () => secretStorage.delete(TOKEN_KEY)),
  };
}
