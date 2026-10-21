import { describe, expect, it } from "vitest";
import { CHAT_MIN_SERVER, chatSupport, compareVersions } from "../src/chat/support";

describe("compareVersions", () => {
  it("orders prerelease numbers numerically", () => {
    expect(compareVersions("0.5.4-beta.2", "0.5.4-beta.10")).toBe(-1);
    expect(compareVersions("0.5.4-beta.10", "0.5.4-beta.2")).toBe(1);
    expect(compareVersions("0.5.4-beta.2", "0.5.4-beta.2")).toBe(0);
  });

  it("ranks a release above its prereleases", () => {
    expect(compareVersions("0.5.4-beta.10", "0.5.4")).toBe(-1);
    expect(compareVersions("0.5.4", "0.5.4-rc.1")).toBe(1);
  });

  it("compares the core version first", () => {
    expect(compareVersions("0.5.3", "0.5.4-beta.1")).toBe(-1);
    expect(compareVersions("0.6.0-alpha", "0.5.9")).toBe(1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
  });

  it("applies the semver identifier rules", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1); // shorter set is lower
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1); // numeric before alphanumeric
    expect(compareVersions("1.0.0-alpha.beta", "1.0.0-beta")).toBe(-1); // lexical
    expect(compareVersions("1.0.0-beta.11", "1.0.0-beta.2")).toBe(1);
  });

  it("ignores build metadata", () => {
    expect(compareVersions("0.5.4+build.7", "0.5.4")).toBe(0);
  });

  it("returns null for invalid versions", () => {
    expect(compareVersions("beta", "0.5.4")).toBeNull();
    expect(compareVersions("0.5", "0.5.4")).toBeNull();
    expect(compareVersions("0.5.4-beta.01", "0.5.4")).toBeNull(); // leading zero
    expect(compareVersions("0.5.4-", "0.5.4")).toBeNull();
    expect(compareVersions("0.5.4-beta..1", "0.5.4")).toBeNull();
    expect(compareVersions("0.5.4", "")).toBeNull();
  });
});

describe("chatSupport", () => {
  it("is unknown before the welcome arrives", () => {
    expect(chatSupport(null)).toBe("unknown");
  });

  it("trusts the features list when the server sends one", () => {
    expect(chatSupport({ serverVersion: "0.5.3", features: ["chat"] })).toBe("ok");
    expect(chatSupport({ serverVersion: "0.9.0", features: [] })).toBe("unsupported");
    expect(chatSupport({ serverVersion: "0.9.0", features: ["files"] })).toBe("unsupported");
  });

  it("falls back to the server version when there is no features list", () => {
    expect(CHAT_MIN_SERVER).toBe("0.5.4-beta.2");
    expect(chatSupport({ serverVersion: "0.5.4-beta.2" })).toBe("ok");
    expect(chatSupport({ serverVersion: "0.5.4-beta.10" })).toBe("ok");
    expect(chatSupport({ serverVersion: "0.5.4" })).toBe("ok");
    expect(chatSupport({ serverVersion: "0.5.4-beta.1" })).toBe("unsupported");
    expect(chatSupport({ serverVersion: "0.5.4-beta.1", features: undefined })).toBe("unsupported");
    expect(chatSupport({ serverVersion: "0.5.3" })).toBe("unsupported");
  });

  it("is unknown when the version is missing or unparsable", () => {
    expect(chatSupport({})).toBe("unknown");
    expect(chatSupport({ serverVersion: "nightly" })).toBe("unknown");
  });
});
