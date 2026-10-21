import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeHost } from "../src/host/node";
import type { Host, OpenDocument } from "../src/host/types";
import { createRegistry, type ToolContext } from "../src/tools/index";
import { editFile, registerEditTools, writeFile } from "../src/tools/edit";
import { WRITE_FILE_MAX_BYTES } from "../src/tools/limits";

let root: string;
let outside: string;

function ctxFor(dir: string, host?: Host): ToolContext {
  return {
    host: host ?? createNodeHost([dir]),
    root: dir,
    roots: [dir],
    signal: new AbortController().signal,
    cwd: dir,
  };
}

const write = (ctx: ToolContext, p: string, content: string, createDirs = true) =>
  writeFile({ path: p, content, createDirs }, ctx);

const edit = (
  ctx: ToolContext,
  p: string,
  oldString: string,
  newString: string,
  replaceAll = false,
) => editFile({ path: p, oldString, newString, replaceAll }, ctx);

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

const readText = (p: string) => fsp.readFile(p, "utf8");

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "omni-edit-root-"));
  outside = await fsp.mkdtemp(path.join(os.tmpdir(), "omni-edit-out-"));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});

describe("write_file", () => {
  it("creates a new file and reports created and bytes", async () => {
    const ctx = ctxFor(root);
    const res = await write(ctx, "a.txt", "héllo");
    expect(res).toEqual({ path: "a.txt", created: true, bytes: 6 });
    expect(await readText(path.join(root, "a.txt"))).toBe("héllo");
  });

  it("replaces an existing file and reports created false", async () => {
    await fsp.writeFile(path.join(root, "a.txt"), "old");
    const res = await write(ctxFor(root), "a.txt", "new");
    expect(res.created).toBe(false);
    expect(await readText(path.join(root, "a.txt"))).toBe("new");
  });

  it("creates missing directories by default", async () => {
    const res = await write(ctxFor(root), "x/y/z.txt", "hi");
    expect(res.created).toBe(true);
    expect(await readText(path.join(root, "x/y/z.txt"))).toBe("hi");
  });

  it("refuses a missing parent when createDirs is false", async () => {
    await expectCode(write(ctxFor(root), "nope/z.txt", "hi", false), "not_found");
    await expect(fsp.stat(path.join(root, "nope"))).rejects.toThrow();
  });

  it("refuses content above 1 MB at argument validation", async () => {
    const registry = createRegistry();
    registerEditTools(registry);
    const big = "a".repeat(WRITE_FILE_MAX_BYTES + 1);
    const res = await registry.execute(
      {
        runId: "r",
        callId: "c",
        tool: "write_file",
        args: { path: "a.txt", content: big },
        timeoutMs: 1000,
      } as never,
      ctxFor(root),
    );
    expect(res).toMatchObject({ ok: false, error: { code: "invalid_args" } });
  });

  it("refuses paths outside the workspace", async () => {
    const target = path.join(outside, "x.txt");
    await expectCode(write(ctxFor(root), target, "x"), "outside_workspace");
    await expectCode(write(ctxFor(root), "../escape.txt", "x"), "outside_workspace");
    await expectCode(write(ctxFor(root), "~/x.txt", "x"), "outside_workspace");
  });

  it("refuses secret and .git paths with protected_path", async () => {
    const ctx = ctxFor(root);
    await expectCode(write(ctx, ".env", "K=1"), "protected_path");
    await expectCode(write(ctx, "keys/server.pem", "x"), "protected_path");
    await expectCode(write(ctx, ".ssh/config", "x"), "protected_path");
    await expectCode(write(ctx, ".git/config", "x"), "protected_path");
    await expectCode(write(ctx, "sub/.git", "gitdir: x"), "protected_path");
  });

  it("allows .env.example", async () => {
    const res = await write(ctxFor(root), ".env.example", "K=");
    expect(res.created).toBe(true);
  });

  it("refuses a symlink that points at a secret file", async () => {
    await fsp.writeFile(path.join(root, ".env"), "SECRET=1");
    await fsp.symlink(path.join(root, ".env"), path.join(root, "link.txt"));
    await expectCode(write(ctxFor(root), "link.txt", "x"), "protected_path");
  });

  it("refuses a dangling symlink pointing outside instead of creating its target", async () => {
    const target = path.join(outside, "made.txt");
    await fsp.symlink(target, path.join(root, "dangling.txt"));
    await expectCode(write(ctxFor(root), "dangling.txt", "x"), "outside_workspace");
    await expect(fsp.stat(target)).rejects.toThrow();
  });
});

describe("edit_file", () => {
  it("replaces a single unique match", async () => {
    const file = path.join(root, "a.ts");
    await fsp.writeFile(file, "const a = 1;\nconst b = 2;\n");
    const res = await edit(ctxFor(root), "a.ts", "const a = 1;", "const a = 10;");
    expect(res).toEqual({ path: "a.ts", replacements: 1 });
    expect(await readText(file)).toBe("const a = 10;\nconst b = 2;\n");
  });

  it("returns not_found when oldString does not occur", async () => {
    await fsp.writeFile(path.join(root, "a.txt"), "hello");
    await expectCode(edit(ctxFor(root), "a.txt", "bye", "x"), "not_found");
  });

  it("returns not_unique with the count when matches are ambiguous", async () => {
    const file = path.join(root, "a.txt");
    await fsp.writeFile(file, "x x x");
    const ctx = ctxFor(root);
    await expect(edit(ctx, "a.txt", "x", "y")).rejects.toMatchObject({
      code: "not_unique",
      details: { count: 3 },
    });
    expect(await readText(file)).toBe("x x x");
  });

  it("replaces every match when replaceAll is true", async () => {
    const file = path.join(root, "a.txt");
    await fsp.writeFile(file, "foo bar foo");
    const res = await edit(ctxFor(root), "a.txt", "foo", "$&baz", true);
    expect(res).toEqual({ path: "a.txt", replacements: 2 });
    expect(await readText(file)).toBe("$&baz bar $&baz");
  });

  it("refuses when oldString equals newString", async () => {
    await fsp.writeFile(path.join(root, "a.txt"), "same");
    await expectCode(edit(ctxFor(root), "a.txt", "same", "same"), "invalid_args");
  });

  it("preserves CRLF when the file uses CRLF and args use LF", async () => {
    const file = path.join(root, "win.txt");
    await fsp.writeFile(file, "one\r\ntwo\r\nthree\r\n");
    await edit(ctxFor(root), "win.txt", "one\ntwo", "1\n2\n2b");
    expect(await readText(file)).toBe("1\r\n2\r\n2b\r\nthree\r\n");
  });

  it("matches CRLF oldString against a CRLF file with CRLF input", async () => {
    const file = path.join(root, "win.txt");
    await fsp.writeFile(file, "a\r\nb\r\n");
    await edit(ctxFor(root), "win.txt", "a\r\nb", "c");
    expect(await readText(file)).toBe("c\r\n");
  });

  it("keeps LF endings in an LF file", async () => {
    const file = path.join(root, "lf.txt");
    await fsp.writeFile(file, "a\nb\n");
    await edit(ctxFor(root), "lf.txt", "a\nb", "x\ny");
    expect(await readText(file)).toBe("x\ny\n");
  });

  it("keeps a leading BOM", async () => {
    const file = path.join(root, "bom.txt");
    await fsp.writeFile(file, "﻿hello");
    await edit(ctxFor(root), "bom.txt", "hello", "bye");
    const buf = await fsp.readFile(file);
    expect(buf.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(buf.subarray(3).toString("utf8")).toBe("bye");
  });

  it("returns not_found for a missing file and refuses protected paths", async () => {
    const ctx = ctxFor(root);
    await expectCode(edit(ctx, "missing.txt", "a", "b"), "not_found");
    await fsp.writeFile(path.join(root, ".env"), "A=1");
    await expectCode(edit(ctx, ".env", "A=1", "A=2"), "protected_path");
    await expectCode(edit(ctx, ".git/HEAD", "a", "b"), "protected_path");
  });

  it("refuses files outside the workspace", async () => {
    const target = path.join(outside, "o.txt");
    await fsp.writeFile(target, "a");
    await expectCode(edit(ctxFor(root), target, "a", "b"), "outside_workspace");
  });

  it("refuses binary files", async () => {
    await fsp.writeFile(path.join(root, "b.bin"), Buffer.from([0x61, 0x00, 0x62]));
    await expectCode(edit(ctxFor(root), "b.bin", "a", "c"), "binary_file");
  });

  it("refuses a file with unsaved editor changes and leaves it untouched", async () => {
    const file = path.join(root, "dirty.txt");
    await fsp.writeFile(file, "disk");
    const open = new Map<string, OpenDocument>([
      [file, { text: "unsaved", dirty: true }],
    ]);
    const ctx = ctxFor(root, createNodeHost([root], { openDocuments: open }));
    await expect(edit(ctx, "dirty.txt", "disk", "x")).rejects.toMatchObject({
      code: "dirty_editor",
      details: { path: "dirty.txt" },
    });
    expect(await readText(file)).toBe("disk");
  });

  it("refuses write_file over a dirty existing file, but allows a new file", async () => {
    const file = path.join(root, "dirty.txt");
    await fsp.writeFile(file, "disk");
    const open = new Map<string, OpenDocument>([[file, { text: "unsaved", dirty: true }]]);
    const ctx = ctxFor(root, createNodeHost([root], { openDocuments: open }));
    await expect(write(ctx, "dirty.txt", "x")).rejects.toMatchObject({
      code: "dirty_editor",
      details: { path: "dirty.txt" },
    });
    expect(await readText(file)).toBe("disk");
    const res = await write(ctx, "fresh.txt", "x");
    expect(res.created).toBe(true);
  });

  it("edits a file whose editor buffer is clean", async () => {
    const file = path.join(root, "clean.txt");
    await fsp.writeFile(file, "disk");
    const open = new Map<string, OpenDocument>([[file, { text: "disk", dirty: false }]]);
    const ctx = ctxFor(root, createNodeHost([root], { openDocuments: open }));
    await edit(ctx, "clean.txt", "disk", "new");
    expect(await readText(file)).toBe("new");
  });
});
