import { describe, expect, it } from "vitest";
import { createTokenStore, TOKEN_KEY, type SecretStorageLike } from "../src/secrets";

const TOKEN = "omt_s3cr3t-value-Zx9";

/** In-memory SecretStorage fake that records which keys were used. */
function fakeStorage(): SecretStorageLike & { data: Map<string, string>; keys: string[] } {
  const data = new Map<string, string>();
  const keys: string[] = [];
  return {
    data,
    keys,
    async get(key) {
      keys.push(key);
      return data.get(key);
    },
    async store(key, value) {
      keys.push(key);
      data.set(key, value);
    },
    async delete(key) {
      keys.push(key);
      data.delete(key);
    },
  };
}

/** Returns the error message thrown by `fn`, or fails the test if it does not throw. */
async function messageOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a rejection");
}

describe("createTokenStore", () => {
  it("round-trips a token under the omnichat.deviceToken key", async () => {
    const storage = fakeStorage();
    const store = createTokenStore(storage);

    expect(await store.get()).toBeUndefined();
    await store.set(TOKEN);
    expect(await store.get()).toBe(TOKEN);
    expect(storage.data.get(TOKEN_KEY)).toBe(TOKEN);
    expect(new Set(storage.keys)).toEqual(new Set([TOKEN_KEY]));

    await store.delete();
    expect(await store.get()).toBeUndefined();
    expect(storage.data.size).toBe(0);
  });

  it("rejects an empty token", async () => {
    const store = createTokenStore(fakeStorage());
    await expect(store.set("")).rejects.toThrow("token must be a non-empty string");
  });

  it("never puts the token in a thrown message, even when storage echoes it", async () => {
    const leaky: SecretStorageLike = {
      get: async () => {
        throw new Error(`read failed for ${TOKEN}`);
      },
      store: async (_key, value) => {
        throw new Error(`store refused ${value}`);
      },
      delete: async () => {
        throw new Error(`delete failed ${TOKEN}`);
      },
    };
    const store = createTokenStore(leaky);

    const messages = [
      await messageOf(() => store.get()),
      await messageOf(() => store.set(TOKEN)),
      await messageOf(() => store.delete()),
    ];
    for (const message of messages) {
      expect(message).not.toContain(TOKEN);
      expect(message).toMatch(/secret storage (read|write|delete) failed/);
    }
  });

  it("does not leak the token through a synchronous throw from storage", async () => {
    const throwing: SecretStorageLike = {
      get: () => {
        throw new Error(TOKEN);
      },
      store: () => {
        throw new Error(TOKEN);
      },
      delete: () => {
        throw new Error(TOKEN);
      },
    };
    const store = createTokenStore(throwing);
    expect(await messageOf(() => store.set(TOKEN))).not.toContain(TOKEN);
    expect(await messageOf(() => store.get())).not.toContain(TOKEN);
  });
});
