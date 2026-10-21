/**
 * Host abstraction over VS Code (spec §9 `src/host/types.ts`).
 *
 * Tools depend only on this interface, so they can be tested with an
 * in-memory or Node-backed fake and never import `vscode` directly.
 * Paths passed to the host are absolute and already guarded (see
 * `src/guard/paths.ts`).
 */

export type FileKind = "file" | "dir" | "symlink";

export interface FileStat {
  kind: FileKind;
  size: number;
}

export interface DirEntry {
  name: string;
  kind: FileKind;
}

/** A text editor buffer that is open in the host. */
export interface OpenDocument {
  text: string;
  dirty: boolean;
}

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

/** Lines and columns are 1-based. */
export interface Diagnostic {
  path: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  severity: DiagnosticSeverity;
  source?: string;
  code?: string;
  message: string;
}

/** A whole-file replacement applied as one undoable workspace edit. */
export interface FileEdit {
  /** Undo label, e.g. "OmniChat edit". */
  label: string;
  /** Absolute path. */
  path: string;
  /** Complete new file content. */
  content: string;
}

export interface Host {
  /** Absolute workspace folder roots (the spec's `roots`). */
  readonly roots: readonly string[];
  /** Resolves symlinks. Rejects with an `ENOENT`-coded error if missing. */
  realpath(abs: string): Promise<string>;
  readFile(abs: string): Promise<Uint8Array>;
  writeFile(abs: string, data: Uint8Array): Promise<void>;
  stat(abs: string): Promise<FileStat>;
  readdir(abs: string): Promise<DirEntry[]>;
  /** Open editor buffers keyed by absolute path, for dirty-editor checks. */
  readonly openDocuments: ReadonlyMap<string, OpenDocument>;
  /** Current diagnostics for all files (filtering is done by the caller). */
  diagnostics(): readonly Diagnostic[];
  /** Applies the edit as one undoable workspace edit and saves it. */
  applyEdit(edit: FileEdit): Promise<{ created: boolean }>;
}
