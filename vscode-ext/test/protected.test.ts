import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RealpathFn } from "../src/guard/paths";
import { checkProtected } from "../src/guard/protected";
import type { ToolName } from "../src/protocol/frames";

/** One case of test/fixtures/protected-cases.json (plain JSON, shared with the server policy). */
interface FixtureCase {
  id: string;
  tool: ToolName;
  args: Record<string, unknown>;
  cwd?: string;
  roots: string[];
  fakeRealpath?: Record<string, string>;
  platform?: "posix" | "win32";
  expected: { protected: boolean; rule?: string };
}

const cases = JSON.parse(
  readFileSync(new URL("./fixtures/protected-cases.json", import.meta.url), "utf8"),
) as FixtureCase[];

/**
 * Fake realpath. A mapped path, or anything beneath it, resolves to its target
 * (longest key first). Every other path resolves to itself.
 */
function fakeRealpath(map: Record<string, string> = {}): RealpathFn {
  const entries = Object.entries(map).sort((x, y) => y[0].length - x[0].length);
  return async (p) => {
    for (const [from, to] of entries) {
      if (p === from) return to;
      if (p.startsWith(`${from}/`)) return `${to}${p.slice(from.length)}`;
    }
    return p;
  };
}

describe("protected-cases fixture", () => {
  it("has at least 100 uniquely identified, roughly balanced cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(100);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    const share = cases.filter((c) => c.expected.protected).length / cases.length;
    expect(share).toBeGreaterThan(0.4);
    expect(share).toBeLessThan(0.6);
  });

  it.each(cases)("$id", async (c) => {
    const verdict = await checkProtected(
      { tool: c.tool, args: c.args },
      {
        roots: c.roots,
        cwd: c.cwd ?? c.roots[0],
        realpath: fakeRealpath(c.fakeRealpath),
        platform: c.platform ?? "posix",
      },
    );
    expect(verdict.protected).toBe(c.expected.protected);
    if (c.expected.rule !== undefined) {
      expect(verdict.protected ? verdict.rule : undefined).toBe(c.expected.rule);
    }
  });
});

describe("checkProtected fails closed", () => {
  it("protects when realpath fails with a non-ENOENT error", async () => {
    const realpath: RealpathFn = async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    const verdict = await checkProtected(
      { tool: "read_file", args: { path: "src/a.ts" } },
      { roots: ["/ws/proj"], cwd: "/ws/proj", realpath },
    );
    expect(verdict).toEqual({ protected: true, rule: "unparseable", reason: expect.any(String) });
  });

  it("protects an unknown tool name", async () => {
    const verdict = await checkProtected(
      { tool: "nope" as ToolName, args: {} },
      { roots: ["/ws/proj"], cwd: "/ws/proj" },
    );
    expect(verdict.protected).toBe(true);
  });
});
