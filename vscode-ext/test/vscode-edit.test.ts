import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeHost } from "../src/host/node";
import type { Host, OpenDocument } from "../src/host/types";
import {
  createVscodeHost,
  fsKey,
  openDocumentFor,
  relUnder,
  type VscodeApi,
} from "../src/host/vscode";
import type { ToolContext } from "../src/tools/index";
import { editFile, writeFile } from "../src/tools/edit";

// ---------------------------------------------------------------------------
// Fake VS Code API (only what createVscodeHost touches)
// ---------------------------------------------------------------------------

interface Buf {
  uri: { scheme: string; fsPath: string };
  text: string;
  dirty: boolean;
}

interface FakeOptions {
  disk?: Record<string, string>;
  /** Result of workspace.applyEdit. */
  applyOk?: boolean;
  /** Replaces the default save. Receives the buffer and the disk map. */
  save?: (b: Buf, disk: Map<string, string>) => Promise<boolean>;
}

function fakeVscode(opts: FakeOptions = {}) {
  const disk = new Map<string, string>(Object.entries(opts.disk ?? {}));
  const bufs = new Map<string, Buf>();

  const uriOf = (p: string) => ({ scheme: "file", fsPath: p });
  const ensure = (p: string): Buf => {
    let b = bufs.get(p);
    if (!b) {
      b = { uri: uriOf(p), text: disk.get(p) ?? "", dirty: false };
      bufs.set(p, b);
    }
    return b;
  };
  const recomputeDirty = (b: Buf) => {
    b.dirty = b.text !== (disk.get(b.uri.fsPath) ?? "");
  };
  const defaultSave = async (b: Buf): Promise<boolean> => {
    if (!b.dirty) return false;
    disk.set(b.uri.fsPath, b.text);
    b.dirty = false;
    return true;
  };
  const docOf = (b: Buf) => ({
    uri: b.uri,
    getText: () => b.text,
    get isDirty() {
      return b.dirty;
    },
    positionAt: (n: number) => n,
    save: () => (opts.save ? opts.save(b, disk) : defaultSave(b)),
  });

  class FakeWorkspaceEdit {
    ops: { kind: string; path: string; text?: string }[] = [];
    replace(uri: { fsPath: string }, _range: unknown, text: string) {
      this.ops.push({ kind: "replace", path: uri.fsPath, text });
    }
    createFile(uri: { fsPath: string }) {
      this.ops.push({ kind: "create", path: uri.fsPath });
    }
    insert(uri: { fsPath: string }, _pos: unknown, text: string) {
      this.ops.push({ kind: "insert", path: uri.fsPath, text });
    }
  }

  const api = {
    workspace: {
      fs: {
        stat: async (uri: { fsPath: string }) => {
          const p = uri.fsPath;
          if (!disk.has(p) && !bufs.has(p)) {
            throw Object.assign(new Error("missing"), { code: "FileNotFound" });
          }
          return { type: 1, size: (bufs.get(p)?.text ?? disk.get(p) ?? "").length };
        },
        readFile: async (uri: { fsPath: string }) => {
          const p = uri.fsPath;
          const text = bufs.get(p)?.text ?? disk.get(p);
          if (text === undefined) throw Object.assign(new Error("missing"), { code: "FileNotFound" });
          return new TextEncoder().encode(text);
        },
        createDirectory: async () => {},
      },
      get textDocuments() {
        return [...bufs.values()].map(docOf);
      },
      workspaceFolders: [],
      openTextDocument: async (uri: { fsPath: string }) => docOf(ensure(uri.fsPath)),
      applyEdit: async (we: FakeWorkspaceEdit) => {
        if (opts.applyOk === false) return false;
        for (const op of we.ops) {
          if (op.kind === "create") {
            bufs.set(op.path, { uri: uriOf(op.path), text: "", dirty: true });
          } else if (op.kind === "replace") {
            const b = ensure(op.path);
            b.text = op.text ?? "";
            recomputeDirty(b);
          } else if (op.kind === "insert") {
            const b = ensure(op.path);
            b.text = (op.text ?? "") + b.text;
            recomputeDirty(b);
          }
        }
        return true;
      },
    },
    WorkspaceEdit: FakeWorkspaceEdit,
    Range: class {},
    Position: class {},
    Uri: { file: uriOf },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    languages: { getDiagnostics: () => [] },
  };
  return { api: api as unknown as VscodeApi, disk, bufs };
}

// ---------------------------------------------------------------------------
// Host applyEdit: save() semantics and rollback
// ---------------------------------------------------------------------------

describe("vscode host applyEdit save handling", () => {
  it("treats save() returning false on a clean buffer as success", async () => {
    const { api, disk } = fakeVscode({
      disk: { "/ws/a.md": "old" },
      // Save already happened (auto-save); save() reports false.
      save: async (b, d) => {
        d.set(b.uri.fsPath, b.text);
        b.dirty = false;
        return false;
      },
    });
    const host = createVscodeHost(api);
    const res = await host.applyEdit({ label: "t", path: "/ws/a.md", content: "new" });
    expect(res).toEqual({ created: false });
    expect(disk.get("/ws/a.md")).toBe("new");
  });

  it("throws EIO naming the path when save fails on a still-dirty buffer, and restores it", async () => {
    const { api, disk, bufs } = fakeVscode({
      disk: { "/ws/a.md": "old" },
      save: async () => false, // leaves the buffer dirty
    });
    const host = createVscodeHost(api);
    const err = await host
      .applyEdit({ label: "t", path: "/ws/a.md", content: "new" })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "EIO" });
    expect((err as Error).message).toContain("save failed for /ws/a.md");
    expect((err as Error).message).toContain("restored");
    // Buffer is back to the saved text, so the next attempt is not refused as dirty.
    expect(bufs.get("/ws/a.md")?.text).toBe("old");
    expect(bufs.get("/ws/a.md")?.dirty).toBe(false);
    expect(disk.get("/ws/a.md")).toBe("old");
    expect(host.openDocuments.get("/ws/a.md")?.dirty).toBe(false);
  });

  it("reports a rejected workspace edit with the path in the message", async () => {
    const { api } = fakeVscode({ disk: { "/ws/a.md": "old" }, applyOk: false });
    const host = createVscodeHost(api);
    await expect(
      host.applyEdit({ label: "t", path: "/ws/a.md", content: "new" }),
    ).rejects.toMatchObject({ code: "EIO", message: expect.stringContaining("/ws/a.md") });
  });
});

// ---------------------------------------------------------------------------
// Windows-style keys and case-insensitive relative paths
// ---------------------------------------------------------------------------

describe("open document keys", () => {
  it("stores open documents under a forward-slash, case-folded key", async () => {
    const { api } = fakeVscode({ disk: { "C:\\Users\\Me\\proj\\a.md": "old" } });
    const host = createVscodeHost(api, { autoSave: () => false });
    await host.applyEdit({ label: "t", path: "C:\\Users\\Me\\proj\\a.md", content: "new" });
    expect([...host.openDocuments.keys()]).toEqual(["c:/users/me/proj/a.md"]);
    const doc = openDocumentFor(host.openDocuments, "C:/Users/Me/proj/a.md");
    expect(doc).toMatchObject({ text: "new", dirty: true });
  });

  it("matches a Windows-style key with backslashes in the map", () => {
    const map = new Map<string, OpenDocument>([
      ["C:\\Users\\Me\\proj\\a.md", { text: "x", dirty: true }],
    ]);
    expect(openDocumentFor(map, "c:/users/me/proj/a.md")?.dirty).toBe(true);
    expect(openDocumentFor(map, "c:/users/me/proj/b.md")).toBeUndefined();
  });

  it("fsKey lowercases Windows paths only", () => {
    expect(fsKey("C:\\A\\B")).toBe("c:/a/b");
    expect(fsKey("\\\\Server\\Share\\X")).toBe("//server/share/x");
    expect(fsKey("/Tmp/A")).toBe("/Tmp/A");
  });

  it("relUnder ignores case and separators for a Windows root", () => {
    expect(relUnder("C:/Users/Me/proj", "c:\\users\\me\\proj\\.git\\config")).toBe(".git/config");
    expect(relUnder("C:/Users/Me/proj", "C:/Users/Me/proj")).toBe(".");
    expect(relUnder("C:/Users/Me/proj", "D:/other/x")).toBe("D:/other/x");
    expect(relUnder("/tmp/root", "/tmp/rootx/y")).toBe("/tmp/rootx/y");
  });
});

// ---------------------------------------------------------------------------
// Tool level (real temp files through the node host)
// ---------------------------------------------------------------------------

let root: string;

function ctxFor(dir: string, host?: Host): ToolContext {
  return {
    host: host ?? createNodeHost([dir]),
    root: dir,
    roots: [dir],
    signal: new AbortController().signal,
    cwd: dir,
  };
}

const readText = (p: string) => fsp.readFile(p, "utf8");

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "omni-vscode-edit-"));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe("edit_file line endings", () => {
  it("matches a multi-line oldString across a mixed CRLF/LF file", async () => {
    const file = path.join(root, "mixed.md");
    await fsp.writeFile(file, "a\r\nb\nc\r\n");
    await editFile(
      { path: "mixed.md", oldString: "a\nb", newString: "x\ny", replaceAll: false },
      ctxFor(root),
    );
    // Untouched line "c" keeps its CRLF. The inserted text takes the dominant CRLF.
    expect(await readText(file)).toBe("x\r\ny\nc\r\n");
  });

  it("keeps CRLF in a CRLF file for a multi-line replacement", async () => {
    const file = path.join(root, "crlf.md");
    await fsp.writeFile(file, "one\r\ntwo\r\nthree\r\n");
    await editFile(
      { path: "crlf.md", oldString: "one\ntwo", newString: "1\n2\n3", replaceAll: false },
      ctxFor(root),
    );
    expect(await readText(file)).toBe("1\r\n2\r\n3\r\nthree\r\n");
  });

  it("counts a mixed-EOL multi-line match once for uniqueness", async () => {
    const file = path.join(root, "dup.md");
    await fsp.writeFile(file, "p\r\nq\np\nq\n");
    await expect(
      editFile({ path: "dup.md", oldString: "p\nq", newString: "z", replaceAll: false }, ctxFor(root)),
    ).rejects.toMatchObject({ code: "not_unique", details: { count: 2 } });
  });
});

describe("dirty-editor guard with a backslash key", () => {
  it("refuses edit_file when the open buffer key uses backslashes", async () => {
    const file = path.join(root, "dirty.md");
    await fsp.writeFile(file, "disk");
    const key = file.replace(/\//g, "\\");
    const open = new Map<string, OpenDocument>([[key, { text: "unsaved", dirty: true }]]);
    const ctx = ctxFor(root, createNodeHost([root], { openDocuments: open }));
    await expect(
      editFile({ path: "dirty.md", oldString: "disk", newString: "x", replaceAll: false }, ctx),
    ).rejects.toMatchObject({ code: "dirty_editor" });
    expect(await readText(file)).toBe("disk");
  });

  it("refuses write_file when the open buffer key uses backslashes", async () => {
    const file = path.join(root, "dirty.md");
    await fsp.writeFile(file, "disk");
    const key = file.replace(/\//g, "\\");
    const open = new Map<string, OpenDocument>([[key, { text: "unsaved", dirty: true }]]);
    const ctx = ctxFor(root, createNodeHost([root], { openDocuments: open }));
    await expect(writeFile({ path: "dirty.md", content: "x", createDirs: true }, ctx)).rejects.toMatchObject({
      code: "dirty_editor",
    });
  });
});

describe("error messages", () => {
  it("passes the host's real failure reason to the model", async () => {
    const { api } = fakeVscode({ disk: { "C:/ws/a.md": "old" }, applyOk: false });
    // The root does not exist on disk, so the stub realpath stands in for the file system.
    const host: Host = { ...createVscodeHost(api), realpath: async (p: string) => p };
    const ctx: ToolContext = {
      host,
      root: "C:/ws",
      roots: ["C:/ws"],
      signal: new AbortController().signal,
      cwd: "C:/ws",
    };
    const err = await editFile(
      { path: "a.md", oldString: "old", newString: "new", replaceAll: false },
      ctx,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "io_error" });
    expect((err as Error).message).toContain("write failed");
    expect((err as Error).message).toContain("rejected the edit");
  });
});

describe("protected path with a case-different root", () => {
  it("refuses .git through a Windows root whose case differs from the path", async () => {
    // No disk access happens before the lexical check, so a stub host is enough.
    const host = {
      realpath: async (p: string) => p,
    } as unknown as Host;
    const ctx: ToolContext = {
      host,
      root: "C:/Users/Me/proj",
      roots: ["C:/Users/Me/proj"],
      signal: new AbortController().signal,
      cwd: "C:/Users/Me/proj",
    };
    await expect(
      writeFile({ path: "c:/users/me/proj/.git/config", content: "x", createDirs: true }, ctx),
    ).rejects.toMatchObject({ code: "protected_path" });
  });
});
