import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  compareSemver,
  isCompatible,
  parseSemver,
} from "../src/protocol/version.js";

describe("PROTOCOL_VERSION", () => {
  it("is a positive integer", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

describe("parseSemver", () => {
  it("parses x.y.z", () => {
    expect(parseSemver("0.2.10")).toEqual({ major: 0, minor: 2, patch: 10 });
  });

  it.each(["", "1", "1.2", "1.2.3.4", "v1.2.3", "1.2.3-beta", "01.2.3", "a.b.c", " 1.2.3"])(
    "rejects %j",
    (bad) => {
      expect(() => parseSemver(bad)).toThrow(/invalid semver/);
    },
  );
});

describe("compareSemver", () => {
  it("orders by major, minor, then patch", () => {
    expect(compareSemver("1.0.0", "0.9.9")).toBe(1);
    expect(compareSemver("0.9.9", "1.0.0")).toBe(-1);
    expect(compareSemver("0.2.0", "0.10.0")).toBe(-1);
    expect(compareSemver("0.2.10", "0.2.9")).toBe(1);
    expect(compareSemver("0.2.0", "0.2.0")).toBe(0);
  });

  it("throws on invalid input", () => {
    expect(() => compareSemver("1.2", "1.2.3")).toThrow();
  });
});

describe("isCompatible(serverMin, extVersion)", () => {
  it("accepts an extension at or above the server minimum", () => {
    expect(isCompatible("0.2.0", "0.2.0")).toBe(true);
    expect(isCompatible("0.2.0", "0.3.0")).toBe(true);
    expect(isCompatible("0.2.0", "1.0.0")).toBe(true);
  });

  it("rejects an outdated extension (spec example: 0.1.0 vs >= 0.2.0)", () => {
    expect(isCompatible("0.2.0", "0.1.0")).toBe(false);
    expect(isCompatible("0.2.0", "0.0.9")).toBe(false);
  });

  it("rejects invalid extension versions", () => {
    expect(isCompatible("0.2.0", "garbage")).toBe(false);
  });
});
