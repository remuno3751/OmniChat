import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeHost } from "../src/host/node";
import type { ToolContext } from "../src/tools/index";
import { readFile } from "../src/tools/files";
import { writeFile } from "../src/tools/edit";
import { resolveCwd } from "../src/tools/exec";
import { isOutsideVerdict, outsideCandidate, outsideRefusal } from "../src/guard/outside";
import type { ProtectedVerdict } from "../src/guard/protected";

// Outside-workspace access when the server allows it (approval.outsideOk). Uses real temp dirs
// through the node host, so it runs on Windows without symlink privileges.

describe("isOutsideVerdict", () => {
  const v = (rule: string, reason: string): ProtectedVerdict => ({ protected: true, rule, reason });

  it("is true for P1-outside and for a command path outside the workspace", () => {
    expect(isOutsideVerdict(v("P1-outside", "path is outside the workspace"))).toBe(true);
    expect(isOutsideVerdict(v("C-path", "path outside the workspace"))).toBe(true);
  });

  it("is false for secret, .git, rm, git, sys and unparseable rules", () => {
    expect(isOutsideVerdict(v("P3-secret", "secret-looking path"))).toBe(false);
    expect(isOutsideVerdict(v("P2-git-write", "write inside .git"))).toBe(false);
    expect(isOutsideVerdict(v("C-path", "literal secret or .git path"))).toBe(false);
    expect(isOutsideVerdict(v("C-rm", "recursive rm"))).toBe(false);
    expect(isOutsideVerdict(v("C-git", "push"))).toBe(false);
    expect(isOutsideVerdict(v("C-sys", "download piped into a shell"))).toBe(false);
    expect(isOutsideVerdict(v("unparseable", "command is not a string"))).toBe(false);
  });

  it("is false for an unprotected verdict", () => {
    expect(isOutsideVerdict({ protected: false })).toBe(false);
  });
});

describe("outsideCandidate", () => {
  it("takes an absolute path as given, normalised", () => {
    expect(outsideCandidate("/work/app", "/etc/hosts")).toBe("/etc/hosts");
    expect(outsideCandidate("/work/app", "C:\\Other\\x.txt")).toBe("C:/Other/x.txt");
  });

  it("resolves a relative path that escapes with .. lexically against the root", () => {
    expect(outsideCandidate("/work/app", "../other/a.ts")).toBe("/work/other/a.ts");
  });

  it("refuses home-relative forms", () => {
    expect(outsideCandidate("/work/app", "~/secrets")).toBeNull();
    expect(outsideCandidate("/work/app", "$HOME/x")).toBeNull();
  });
});

describe("outsideRefusal", () => {
  it("refuses secret-looking outside paths, lexically and through the real target", async () => {
    expect(await outsideRefusal("/home/u/project/.env", undefined, false)).toBe("secret-looking path");
    const real = async () => "/etc/ssh/id_rsa";
    expect(await outsideRefusal("/tmp/link", real, false)).toBe("secret-looking path");
  });

  it("refuses writes inside .git but allows reads there", async () => {
    expect(await outsideRefusal("/elsewhere/repo/.git/config", undefined, true)).toBe("write inside .git");
    expect(await outsideRefusal("/elsewhere/repo/.git/config", undefined, false)).toBeNull();
  });

  it("allows an ordinary outside path", async () => {
    expect(await outsideRefusal("/elsewhere/notes.txt", undefined, true)).toBeNull();
  });
});

describe("tools with allowOutside", () => {
  let root: string;
  let outside: string;

  const ctxFor = (allowOutside: boolean | undefined): ToolContext => ({
    host: createNodeHost([root]),
    root,
    roots: [root],
    signal: new AbortController().signal,
    cwd: root,
    allowOutside,
  });

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "omni-ao-root-"));
    outside = await fsp.mkdtemp(path.join(os.tmpdir(), "omni-ao-outside-"));
    await fsp.writeFile(path.join(outside, "note.txt"), "hello outside");
    await fsp.writeFile(path.join(outside, ".env"), "TOKEN=1");
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  });

  const read = (ctx: ToolContext, p: string) => readFile({ path: p, offset: 1, limit: 2000 }, ctx);

  it("refuses an outside file without the flag, as before", async () => {
    await expect(read(ctxFor(false), path.join(outside, "note.txt"))).rejects.toMatchObject({
      code: "outside_workspace",
    });
    await expect(read(ctxFor(undefined), path.join(outside, "note.txt"))).rejects.toMatchObject({
      code: "outside_workspace",
    });
  });

  it("reads an outside file with the flag", async () => {
    const result = await read(ctxFor(true), path.join(outside, "note.txt"));
    expect(JSON.stringify(result)).toContain("hello outside");
  });

  it("still refuses an outside secret path with the flag", async () => {
    await expect(read(ctxFor(true), path.join(outside, ".env"))).rejects.toMatchObject({
      code: "protected_path",
    });
  });

  it("refuses a relative path that escapes the root only with the flag", async () => {
    const rel = path.relative(root, path.join(outside, "note.txt")).split(path.sep).join("/");
    await expect(read(ctxFor(false), rel)).rejects.toMatchObject({ code: "outside_workspace" });
    expect(JSON.stringify(await read(ctxFor(true), rel))).toContain("hello outside");
  });

  it("refuses a write inside .git outside the workspace even with the flag", async () => {
    const gitFile = path.join(outside, ".git", "config");
    await expect(
      writeFile({ path: gitFile, content: "x", createDirs: true }, ctxFor(true)),
    ).rejects.toMatchObject({ code: "protected_path" });
  });

  it("resolves an outside cwd for a command only with the flag", async () => {
    await expect(resolveCwd(ctxFor(false), outside)).rejects.toMatchObject({ code: "outside_workspace" });
    expect(await resolveCwd(ctxFor(true), outside)).toBe(outside.replace(/\\/g, "/"));
  });
});
