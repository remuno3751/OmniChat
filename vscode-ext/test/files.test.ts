import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeHost } from "../src/host/node";
import { createRegistry, type ToolContext } from "../src/tools/index";
import { glob, listDir, readFile, registerFileTools } from "../src/tools/files";
import { globToRegExp } from "../src/tools/glob-match";
import { READ_FILE_MAX_BYTES } from "../src/tools/limits";

let root: string;
let outside: string;

function ctxFor(dir: string): ToolContext {
  return {
    host: createNodeHost([dir]),
    root: dir,
    roots: [dir],
    signal: new AbortController().signal,
    cwd: dir,
  };
}

const read = (ctx: ToolContext, p: string, extra: Record<string, number> = {}) =>
  readFile({ path: p, offset: 1, limit: 2000, ...extra }, ctx);

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "omni-files-root-"));
  outside = await fsp.mkdtemp(path.join(os.tmpdir(), "omni-files-outside-"));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});

describe("read_file", () => {
  it("returns lines with offset and limit and reports truncation", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    await fsp.writeFile(path.join(root, "a.txt"), lines.join("\n") + "\n");
    const ctx = ctxFor(root);

    const all = await read(ctx, "a.txt");
    expect(all).toEqual({
      path: "a.txt",
      content: lines.join("\n"),
      startLine: 1,
      endLine: 10,
      totalLines: 10,
      truncated: false,
    });

    const part = await read(ctx, "a.txt", { offset: 3, limit: 2 });
    expect(part).toMatchObject({ content: "line 3\nline 4", startLine: 3, endLine: 4, totalLines: 10, truncated: true });
  });

  it("truncates at the default 2000-line limit", async () => {
    const body = Array.from({ length: 3000 }, (_, i) => `row ${i + 1}`).join("\n");
    await fsp.writeFile(path.join(root, "big.txt"), body);
    const res = (await read(ctxFor(root), "big.txt")) as { endLine: number; totalLines: number; truncated: boolean };
    expect(res.endLine).toBe(2000);
    expect(res.totalLines).toBe(3000);
    expect(res.truncated).toBe(true);
  });

  it("keeps a leading BOM", async () => {
    await fsp.writeFile(path.join(root, "bom.txt"), Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("hi")]));
    const res = (await read(ctxFor(root), "bom.txt")) as { content: string };
    expect(res.content.charCodeAt(0)).toBe(0xfeff);
  });

  it("refuses a file over 5 MB with too_large", async () => {
    await fsp.writeFile(path.join(root, "huge.txt"), Buffer.alloc(READ_FILE_MAX_BYTES + 1, "a"));
    await expectCode(read(ctxFor(root), "huge.txt"), "too_large");
  });

  it("refuses binary files", async () => {
    await fsp.writeFile(path.join(root, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
    await expectCode(read(ctxFor(root), "bin.dat"), "binary_file");
  });

  it("refuses secret files with protected_path, but allows .env.example", async () => {
    await fsp.writeFile(path.join(root, ".env"), "TOKEN=x");
    await fsp.writeFile(path.join(root, "id_rsa"), "key");
    await fsp.writeFile(path.join(root, ".env.example"), "TOKEN=");
    await fsp.mkdir(path.join(root, ".ssh"));
    await fsp.writeFile(path.join(root, ".ssh", "config"), "x");
    const ctx = ctxFor(root);
    await expectCode(read(ctx, ".env"), "protected_path");
    await expectCode(read(ctx, "id_rsa"), "protected_path");
    await expectCode(read(ctx, ".ssh/config"), "protected_path");
    await expect(read(ctx, ".env.example")).resolves.toMatchObject({ truncated: false });
  });

  it("refuses a benign-looking symlink to a secret file", async () => {
    await fsp.writeFile(path.join(root, ".env"), "TOKEN=x");
    await fsp.symlink(path.join(root, ".env"), path.join(root, "config.txt"));
    await expectCode(read(ctxFor(root), "config.txt"), "protected_path");
  });

  it("refuses a symlink that escapes the workspace", async () => {
    const secretFile = path.join(outside, "notes.txt");
    await fsp.writeFile(secretFile, "outside");
    await fsp.symlink(secretFile, path.join(root, "link.txt"));
    await expectCode(read(ctxFor(root), "link.txt"), "outside_workspace");
  });

  it("refuses a path that lexically leaves the workspace", async () => {
    await expectCode(read(ctxFor(root), "../whatever.txt"), "outside_workspace");
    await expectCode(read(ctxFor(root), path.join(outside, "x.txt")), "outside_workspace");
  });

  it("refuses a dangling symlink as outside_workspace, even when its target is inside the root", async () => {
    await fsp.symlink(path.join(root, "missing-target.txt"), path.join(root, "dangling.txt"));
    await fsp.symlink(path.join(outside, "missing.txt"), path.join(root, "dangling-out.txt"));
    const ctx = ctxFor(root);
    await expectCode(read(ctx, "dangling.txt"), "outside_workspace");
    await expectCode(read(ctx, "dangling-out.txt"), "outside_workspace");
  });

  it("refuses a path under a dangling directory symlink", async () => {
    await fsp.symlink(path.join(root, "nowhere"), path.join(root, "dl"));
    await expectCode(read(ctxFor(root), "dl/file.txt"), "outside_workspace");
  });

  it("reports a plain missing file as not_found", async () => {
    await expectCode(read(ctxFor(root), "nope.txt"), "not_found");
  });
});

describe("list_dir", () => {
  it("lists entries, hides dotfiles by default and skips secrets", async () => {
    await fsp.writeFile(path.join(root, "a.ts"), "abc");
    await fsp.writeFile(path.join(root, ".hidden"), "h");
    await fsp.writeFile(path.join(root, ".env"), "s");
    await fsp.mkdir(path.join(root, "sub"));
    const ctx = ctxFor(root);

    const res = await listDir({ path: ".", depth: 1, includeHidden: false }, ctx);
    expect(res.truncated).toBe(false);
    expect(res.entries).toEqual([
      { path: "a.ts", type: "file", size: 3 },
      { path: "sub", type: "dir" },
    ]);

    const withHidden = await listDir({ path: ".", depth: 1, includeHidden: true }, ctx);
    expect(withHidden.entries.map((e) => e.path)).toEqual([".hidden", "a.ts", "sub"]);
  });

  it("recurses to depth but not into node_modules or .git, and does not follow symlinks", async () => {
    await fsp.mkdir(path.join(root, "src", "deep"), { recursive: true });
    await fsp.writeFile(path.join(root, "src", "deep", "x.ts"), "");
    await fsp.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await fsp.writeFile(path.join(root, "node_modules", "pkg", "i.js"), "");
    await fsp.mkdir(path.join(root, ".git"));
    await fsp.writeFile(path.join(root, ".git", "HEAD"), "");
    await fsp.symlink(outside, path.join(root, "src", "escape"));
    const res = await listDir({ path: ".", depth: 3, includeHidden: false }, ctxFor(root));
    const paths = res.entries.map((e) => e.path);
    expect(paths).toContain("node_modules");
    expect(paths).toContain("src/deep/x.ts");
    expect(paths).toContain("src/escape");
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".git/"))).toBe(false);
    expect(res.entries.find((e) => e.path === "src/escape")?.type).toBe("symlink");
  });

  it("caps the entries at 500 and reports truncated", async () => {
    for (let i = 0; i < 510; i++) await fsp.writeFile(path.join(root, `f${String(i).padStart(3, "0")}.txt`), "");
    const res = await listDir({ path: ".", depth: 1, includeHidden: false }, ctxFor(root));
    expect(res.entries).toHaveLength(500);
    expect(res.truncated).toBe(true);
  });

  it("refuses a listing of a secret directory and a path outside the workspace", async () => {
    await fsp.mkdir(path.join(root, ".aws"));
    const ctx = ctxFor(root);
    await expectCode(listDir({ path: ".aws", depth: 1, includeHidden: true }, ctx), "protected_path");
    await expectCode(listDir({ path: outside, depth: 1, includeHidden: false }, ctx), "outside_workspace");
  });
});

describe("glob", () => {
  it("matches files, excludes node_modules and .git, sorts and limits", async () => {
    await fsp.mkdir(path.join(root, "src", "lib"), { recursive: true });
    await fsp.writeFile(path.join(root, "src", "b.ts"), "");
    await fsp.writeFile(path.join(root, "src", "lib", "a.ts"), "");
    await fsp.writeFile(path.join(root, "top.ts"), "");
    await fsp.writeFile(path.join(root, "readme.md"), "");
    await fsp.mkdir(path.join(root, "node_modules", "x"), { recursive: true });
    await fsp.writeFile(path.join(root, "node_modules", "x", "y.ts"), "");
    await fsp.mkdir(path.join(root, ".git"));
    await fsp.writeFile(path.join(root, ".git", "z.ts"), "");
    const ctx = ctxFor(root);

    const all = await glob({ pattern: "**/*.ts", limit: 200 }, ctx);
    expect(all).toEqual({ files: ["src/b.ts", "src/lib/a.ts", "top.ts"], truncated: false });

    const limited = await glob({ pattern: "**/*.ts", limit: 2 }, ctx);
    expect(limited).toEqual({ files: ["src/b.ts", "src/lib/a.ts"], truncated: true });

    const scoped = await glob({ pattern: "*.ts", path: "src", limit: 200 }, ctx);
    expect(scoped.files).toEqual(["src/b.ts"]);
  });

  it("does not return secret files or follow symlinks", async () => {
    await fsp.writeFile(path.join(root, ".env"), "x");
    await fsp.writeFile(path.join(root, "k.pem"), "x");
    await fsp.writeFile(path.join(outside, "o.txt"), "x");
    await fsp.symlink(outside, path.join(root, "linkdir"));
    const res = await glob({ pattern: "**/*", limit: 200 }, ctxFor(root));
    expect(res.files).toEqual([]);
  });

  it("supports braces and character classes", () => {
    expect(globToRegExp("**/*.{ts,js}").test("a/b/c.js")).toBe(true);
    expect(globToRegExp("**/*.{ts,js}").test("a/c.md")).toBe(false);
    expect(globToRegExp("file[0-9].txt").test("file7.txt")).toBe(true);
    expect(globToRegExp("file[!0-9].txt").test("file7.txt")).toBe(false);
  });
});

describe("host realpath", () => {
  it("rejects a missing path with ENOENT and a dangling symlink with a non-ENOENT code", async () => {
    const host = createNodeHost([root]);
    await fsp.symlink(path.join(root, "gone"), path.join(root, "dangling"));
    await expect(host.realpath(path.join(root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const err = await host.realpath(path.join(root, "dangling")).then(
      () => undefined,
      (e: unknown) => e as { code?: string },
    );
    expect(err?.code).toBeDefined();
    expect(err?.code).not.toBe("ENOENT");
  });
});

describe("registerFileTools", () => {
  it("registers read_file, list_dir and glob", () => {
    const registry = createRegistry();
    expect(() => registerFileTools(registry)).not.toThrow();
  });
});
