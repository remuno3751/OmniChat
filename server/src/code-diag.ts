import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";

/**
 * Diagnostic log of Code turns (v0.5.6 TODO 1-1): one JSON line per turn with the provider, the model, the tool names that
 * were offered to the model and the working folder. Never tool arguments, results or secrets.
 * The file is code-diag.log in DATA_DIR; when it grows past 1 MB its older half is dropped.
 */
export interface CodeDiagRecord {
  conversationId: string;
  providerKind: string;
  providerName?: string;
  model: string;
  tools: string[];
  cwd?: string;
}

const MAX_BYTES = 1024 * 1024;

/** Appends one record. Never throws: a logging failure must not break a turn. */
export function logCodeDiag(rec: CodeDiagRecord): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const file = join(DATA_DIR, "code-diag.log");
    rotateIfLarge(file);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n";
    appendFileSync(file, line, "utf8");
  } catch { /* ignore: diagnostics are best effort */ }
}

/** Keeps the last half of the file (cut at a line boundary) when it is larger than MAX_BYTES. */
function rotateIfLarge(file: string): void {
  let size = 0;
  try { size = statSync(file).size; } catch { return; } // no file yet
  if (size <= MAX_BYTES) return;
  const text = readFileSync(file, "utf8");
  const cut = text.indexOf("\n", Math.floor(text.length / 2));
  writeFileSync(file, cut < 0 ? "" : text.slice(cut + 1), "utf8");
}
