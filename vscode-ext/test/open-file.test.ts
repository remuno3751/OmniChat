import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveOpenFile } from "../src/ui/chatView";

/**
 * openFile resolves a webview path inside the workspace roots only: no traversal out of a root,
 * no absolute path outside the roots, and no protected files (secrets, .git internals).
 */
let base: string;
let root: string;
let other: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "oc-open-"));
  root = join(base, "app");
  other = join(base, "second");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(other, { recursive: true });
  mkdirSync(join(base, "outside"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, ".env"), "SECRET=1\n");
  writeFileSync(join(root, ".git", "config"), "[core]\n");
  writeFileSync(join(other, "b.md"), "# b\n");
  writeFileSync(join(base, "outside", "secret.txt"), "x\n");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("resolveOpenFile", () => {
  it("opens a relative path inside a root", async () => {
    const r = await resolveOpenFile("src/a.ts", [root]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.abs.replace(/\\/g, "/")).toMatch(/\/app\/src\/a\.ts$/);
  });

  it("opens an absolute path that lies inside a root", async () => {
    const r = await resolveOpenFile(join(root, "src", "a.ts"), [root]);
    expect(r.ok).toBe(true);
  });

  it("finds a relative path in the second root", async () => {
    const r = await resolveOpenFile("b.md", [root, other]);
    expect(r.ok).toBe(true);
  });

  it("refuses a traversal that climbs out of the root", async () => {
    expect(await resolveOpenFile("../outside/secret.txt", [root])).toEqual({ ok: false });
    expect(await resolveOpenFile("src/../../outside/secret.txt", [root])).toEqual({ ok: false });
  });

  it("refuses an absolute path outside every root", async () => {
    expect(await resolveOpenFile(join(base, "outside", "secret.txt"), [root, other])).toEqual({ ok: false });
  });

  it("refuses a home-relative path", async () => {
    expect(await resolveOpenFile("~/notes.txt", [root])).toEqual({ ok: false });
  });

  it("refuses protected files: secrets and .git internals", async () => {
    expect(await resolveOpenFile(".env", [root])).toEqual({ ok: false });
    expect(await resolveOpenFile(".git/config", [root])).toEqual({ ok: false });
  });

  it("refuses when there are no roots", async () => {
    expect(await resolveOpenFile("src/a.ts", [])).toEqual({ ok: false });
  });
});
