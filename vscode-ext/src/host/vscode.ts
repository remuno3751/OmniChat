/**
 * VS Code implementation of {@link Host} (spec docs/design/VSCODE-BRIDGE.md §3, §9).
 *
 * The `vscode` module is injected, never imported at runtime, so this file loads
 * under vitest. Errors use the `code` convention of `./node.ts`: `ENOENT` for
 * missing paths, `EDANGLING` for broken symlinks, `EIO` for rejected edits.
 */
import { promises as fsp, type Stats } from "node:fs";
import { dirname } from "node:path";
import type * as VS from "vscode";
import type {
  Diagnostic,
  DiagnosticSeverity,
  DirEntry,
  FileEdit,
  FileKind,
  FileStat,
  Host,
  OpenDocument,
} from "./types";

export type VscodeApi = typeof VS;

export interface VscodeHostOptions {
  /** Read on each applyEdit. Defaults to true (spec `omnichat.autoSave`). */
  autoSave?: () => boolean;
}

function errCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  return String((err as { code: unknown }).code);
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Canonical key for a file path, shared by the host and the tools. Backslashes
 * become forward slashes. Drive-letter and UNC paths are lowercased, because
 * Windows compares them case-insensitively (the same rule as `isWithin` in guard/paths.ts).
 */
export function fsKey(p: string): string {
  const s = p.replace(/\\/g, "/");
  const windowsStyle = /^[A-Za-z]:/.test(s) || s.startsWith("//");
  return windowsStyle ? s.toLowerCase() : s;
}

/**
 * `abs` relative to `root`, comparing with {@link fsKey}. Returns `"."` for the
 * root itself and `abs` unchanged when it lies outside the root.
 */
export function relUnder(root: string, abs: string): string {
  const r = fsKey(root);
  const a = fsKey(abs);
  if (a === r) return ".";
  const base = r.endsWith("/") ? r : `${r}/`;
  return a.startsWith(base) ? abs.replace(/\\/g, "/").slice(base.length) : abs;
}

/** The open buffer for `abs`, matched by {@link fsKey} so separators and drive case do not matter. */
export function openDocumentFor(
  map: ReadonlyMap<string, OpenDocument>,
  abs: string,
): OpenDocument | undefined {
  const direct = map.get(abs);
  if (direct !== undefined) return direct;
  const want = fsKey(abs);
  for (const [key, doc] of map) if (fsKey(key) === want) return doc;
  return undefined;
}

/** `vscode.FileSystemError` codes for "no such entry". */
function isNotFound(err: unknown): boolean {
  const code = errCode(err);
  return code === "FileNotFound" || code === "FileNotADirectory";
}

/** Maps a `FileSystemError` for a missing entry to the `ENOENT` convention. Other errors pass through. */
async function guard<T>(p: PromiseLike<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (isNotFound(err)) throw coded("ENOENT", "not found");
    throw err;
  }
}

/**
 * Same contract as `realpathOrMissing` in `./node.ts`: a dangling or looping
 * symlink rejects with `EDANGLING`, never `ENOENT`, so it cannot pass as
 * "missing, safe". Missing paths reject with `ENOENT`.
 */
async function realpathOrMissing(abs: string): Promise<string> {
  try {
    return await fsp.realpath(abs);
  } catch (err) {
    if (errCode(err) !== "ENOENT" && errCode(err) !== "ENOTDIR") throw err;
  }

  let cur = abs;
  for (;;) {
    let st: Stats;
    try {
      st = await fsp.lstat(cur);
    } catch (err) {
      if (errCode(err) !== "ENOENT" && errCode(err) !== "ENOTDIR") throw err;
      const parent = dirname(cur);
      if (parent === cur) throw coded("ENOENT", "not found");
      cur = parent;
      continue;
    }
    if (st.isSymbolicLink()) throw coded("EDANGLING", "dangling symbolic link");
    await fsp.realpath(cur);
    throw coded("ENOENT", "not found");
  }
}

export function createVscodeHost(vscode: VscodeApi, options: VscodeHostOptions = {}): Host {
  const autoSave = options.autoSave ?? (() => true);
  const fs = vscode.workspace.fs;
  const { FileType, DiagnosticSeverity: Sev } = vscode;
  const uriOf = (abs: string): VS.Uri => vscode.Uri.file(abs);

  const kindOf = (type: number): FileKind => {
    if (type & FileType.SymbolicLink) return "symlink";
    if (type & FileType.Directory) return "dir";
    return "file";
  };

  const existsOnDisk = async (uri: VS.Uri): Promise<boolean> => {
    try {
      await fs.stat(uri);
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  };

  const severityOf = (s: VS.DiagnosticSeverity): DiagnosticSeverity => {
    switch (s) {
      case Sev.Error:
        return "error";
      case Sev.Warning:
        return "warning";
      case Sev.Information:
        return "info";
      default:
        return "hint";
    }
  };

  const toDiagnostic = (path: string, d: VS.Diagnostic): Diagnostic => {
    const out: Diagnostic = {
      path,
      line: d.range.start.line + 1,
      col: d.range.start.character + 1,
      endLine: d.range.end.line + 1,
      endCol: d.range.end.character + 1,
      severity: severityOf(d.severity),
      message: d.message,
    };
    if (d.source) out.source = d.source;
    if (d.code !== undefined) {
      const code = typeof d.code === "object" ? d.code.value : d.code;
      out.code = String(code);
    }
    return out;
  };

  /**
   * Best-effort rollback after a failed save: replaces the buffer with the text it
   * had before the edit, then saves once more. That text was clean (edit_file and
   * write_file refuse dirty buffers), so the save writes what disk already holds.
   * The caller re-checks `isDirty` afterwards.
   */
  const restoreBuffer = async (doc: VS.TextDocument, original: string): Promise<void> => {
    try {
      const we = new vscode.WorkspaceEdit();
      const range = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      we.replace(doc.uri, range, original);
      await vscode.workspace.applyEdit(we);
      if (doc.isDirty) await doc.save();
    } catch {
      // Ignored: the caller reports the buffer state from `isDirty`.
    }
  };

  return {
    get roots(): readonly string[] {
      return (vscode.workspace.workspaceFolders ?? [])
        .filter((f) => f.uri.scheme === "file")
        .map((f) => f.uri.fsPath);
    },

    get openDocuments(): ReadonlyMap<string, OpenDocument> {
      const map = new Map<string, OpenDocument>();
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme !== "file") continue;
        map.set(fsKey(doc.uri.fsPath), { text: doc.getText(), dirty: doc.isDirty });
      }
      return map;
    },

    realpath: realpathOrMissing,

    async readFile(abs: string): Promise<Uint8Array> {
      return guard(fs.readFile(uriOf(abs)));
    },

    async writeFile(abs: string, data: Uint8Array): Promise<void> {
      await guard(fs.writeFile(uriOf(abs), data));
    },

    async stat(abs: string): Promise<FileStat> {
      const st = await guard(fs.stat(uriOf(abs)));
      return { kind: st.type & FileType.Directory ? "dir" : "file", size: st.size };
    },

    async readdir(abs: string): Promise<DirEntry[]> {
      const entries = await guard(fs.readDirectory(uriOf(abs)));
      return entries.map(([name, type]) => ({ name, kind: kindOf(type) }));
    },

    diagnostics(): readonly Diagnostic[] {
      const out: Diagnostic[] = [];
      for (const [uri, list] of vscode.languages.getDiagnostics()) {
        if (uri.scheme !== "file") continue;
        for (const d of list) out.push(toDiagnostic(uri.fsPath, d));
      }
      return out;
    },

    async applyEdit(edit: FileEdit): Promise<{ created: boolean }> {
      const uri = uriOf(edit.path);
      const existed = await existsOnDisk(uri);
      // `edit.label` ("OmniChat edit") is not applied: @types/vscode has no WorkspaceEdit label.
      const we = new vscode.WorkspaceEdit();
      // Text before the edit, used to restore the buffer when the save fails.
      let original: string | undefined;

      if (existed) {
        // Replace the whole buffer so the change is one undoable step.
        const doc = await vscode.workspace.openTextDocument(uri);
        original = doc.getText();
        const range = new vscode.Range(doc.positionAt(0), doc.positionAt(original.length));
        we.replace(uri, range, edit.content);
      } else {
        // createDirectory has mkdirp semantics, so missing parents are created.
        await guard(fs.createDirectory(uriOf(dirname(edit.path))));
        we.createFile(uri, { overwrite: false, ignoreIfExists: false });
        we.insert(uri, new vscode.Position(0, 0), edit.content);
      }

      if (!(await vscode.workspace.applyEdit(we))) {
        throw coded("EIO", `VS Code rejected the edit to ${edit.path}`);
      }

      if (autoSave()) {
        // Saving puts the change on disk; the undo stack keeps the edit either way.
        const doc = await vscode.workspace.openTextDocument(uri);
        // save() returns false when the buffer is already clean (for example it was
        // auto-saved or the text did not change). That is success, not an error.
        const saved = doc.isDirty ? await doc.save() : true;
        if (!saved && doc.isDirty) {
          if (original !== undefined) await restoreBuffer(doc, original);
          const state = doc.isDirty
            ? "the editor still has unsaved changes"
            : "the editor buffer was restored to the saved text";
          throw coded("EIO", `save failed for ${edit.path}; ${state}`);
        }
      }
      return { created: !existed };
    },
  };
}

/** Opens `text` as a new untitled editor buffer of the given language and shows it. */
export async function openUntitled(api: VscodeApi, text: string, language: string): Promise<void> {
  const doc = await api.workspace.openTextDocument({ language, content: text });
  await api.window.showTextDocument(doc, { preview: false });
}
