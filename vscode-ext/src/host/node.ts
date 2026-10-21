/**
 * Node `fs`-backed implementation of {@link Host} for tests and headless use
 * (spec docs/design/VSCODE-BRIDGE.md §9). Not used inside VS Code.
 */
import { promises as fsp, type Dirent, type Stats } from "node:fs";
import * as path from "node:path";
import type {
  Diagnostic,
  DirEntry,
  FileEdit,
  FileKind,
  FileStat,
  Host,
  OpenDocument,
} from "./types";

export interface NodeHostOptions {
  /** Open editor buffers keyed by absolute path. */
  openDocuments?: Map<string, OpenDocument>;
  /** Diagnostics to report; empty by default. */
  diagnostics?: Diagnostic[];
}

function errCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  return String((err as { code: unknown }).code);
}

function isMissing(err: unknown): boolean {
  const code = errCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function kindOf(entry: Dirent): FileKind {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "dir";
  return "file";
}

/**
 * `fs.realpath` that keeps dangling symlinks apart from missing paths.
 *
 * - Resolvable path: returns the real path.
 * - Missing path (no symlink involved): realpaths the nearest existing
 *   ancestor, then rejects with an `ENOENT` code. The caller may treat the
 *   path as a new file under that ancestor.
 * - Symlink that does not resolve (dangling or looping, at any level of the
 *   path): rejects with `EDANGLING`, never `ENOENT`. The path guard maps this
 *   to a refusal, so a dangling link can never pass as "missing, safe".
 */
async function realpathOrMissing(abs: string): Promise<string> {
  try {
    return await fsp.realpath(abs);
  } catch (err) {
    if (!isMissing(err)) throw err;
  }

  let cur = abs;
  for (;;) {
    let st: Stats;
    try {
      st = await fsp.lstat(cur);
    } catch (err) {
      if (!isMissing(err)) throw err;
      const parent = path.dirname(cur);
      if (parent === cur) throw coded("ENOENT", "not found");
      cur = parent;
      continue;
    }
    if (st.isSymbolicLink()) {
      throw coded("EDANGLING", "dangling symbolic link");
    }
    // `cur` is a real entry, so its realpath must work. `abs` is a new file below it.
    await fsp.realpath(cur);
    throw coded("ENOENT", "not found");
  }
}

export function createNodeHost(roots: readonly string[], options: NodeHostOptions = {}): Host {
  const diagnostics = options.diagnostics ?? [];
  return {
    roots: roots.map((r) => path.resolve(r)),
    openDocuments: options.openDocuments ?? new Map<string, OpenDocument>(),

    realpath: realpathOrMissing,

    async readFile(abs: string): Promise<Uint8Array> {
      return new Uint8Array(await fsp.readFile(abs));
    },

    async writeFile(abs: string, data: Uint8Array): Promise<void> {
      await fsp.writeFile(abs, data);
    },

    async stat(abs: string): Promise<FileStat> {
      const st = await fsp.stat(abs);
      return { kind: st.isDirectory() ? "dir" : "file", size: st.size };
    },

    async readdir(abs: string): Promise<DirEntry[]> {
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, kind: kindOf(e) }));
    },

    diagnostics(): readonly Diagnostic[] {
      return diagnostics;
    },

    async applyEdit(edit: FileEdit): Promise<{ created: boolean }> {
      let created = true;
      try {
        await fsp.stat(edit.path);
        created = false;
      } catch {
        // Missing: this edit creates the file.
      }
      await fsp.mkdir(path.dirname(edit.path), { recursive: true });
      await fsp.writeFile(edit.path, edit.content, "utf8");
      return { created };
    },
  };
}
