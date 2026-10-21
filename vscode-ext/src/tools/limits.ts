/**
 * Numeric caps and timeouts for tools (pure, no vscode dependency).
 * Spec: docs/design/VSCODE-BRIDGE.md §3 (limits) and §9 (file layout).
 */

// ---- read_file ----
/** Default `limit` (lines) for read_file. */
export const READ_FILE_DEFAULT_LIMIT_LINES = 2000;
/** Maximum `limit` (lines) for read_file. */
export const READ_FILE_MAX_LIMIT_LINES = 5000;
/** File reads larger than this return `too_large`. */
export const READ_FILE_MAX_BYTES = 5 * 1024 * 1024;
/** Binary detection: a NUL byte in the first N bytes means `binary_file`. */
export const BINARY_SNIFF_BYTES = 8 * 1024;

// ---- list_dir ----
export const LIST_DIR_DEFAULT_DEPTH = 1;
export const LIST_DIR_MIN_DEPTH = 1;
export const LIST_DIR_MAX_DEPTH = 3;
/** Maximum entries returned by list_dir. */
export const LIST_DIR_MAX_ENTRIES = 500;

// ---- glob ----
export const GLOB_DEFAULT_LIMIT = 200;
export const GLOB_MAX_LIMIT = 1000;

// ---- grep ----
export const GREP_DEFAULT_LIMIT = 100;
export const GREP_MAX_LIMIT = 500;
export const GREP_MIN_CONTEXT = 0;
export const GREP_MAX_CONTEXT = 5;
/** Matched line text is cut to this many characters. */
export const GREP_MAX_LINE_CHARS = 300;
/** Files larger than this are skipped by grep. */
export const GREP_MAX_FILE_BYTES = 1024 * 1024;
/** grep is aborted (truncated:true) after this many milliseconds. */
export const GREP_TIMEOUT_MS = 20_000;

// ---- write_file ----
/** Maximum `content` size for write_file. */
export const WRITE_FILE_MAX_BYTES = 1024 * 1024;

// ---- run_command ----
/** Maximum `command` length in characters. */
export const RUN_COMMAND_MAX_CHARS = 8000;
export const RUN_COMMAND_DEFAULT_TIMEOUT_MS = 120_000;
export const RUN_COMMAND_MAX_TIMEOUT_MS = 600_000;
/** Per-stream (stdout / stderr) output cap in bytes. */
export const RUN_COMMAND_OUTPUT_MAX_BYTES = 64 * 1024;
/** Of the per-stream cap, bytes kept from the head. */
export const RUN_COMMAND_OUTPUT_HEAD_BYTES = 16 * 1024;
/** Of the per-stream cap, bytes kept from the tail. */
export const RUN_COMMAND_OUTPUT_TAIL_BYTES = 48 * 1024;

// ---- get_diagnostics ----
export const DIAGNOSTICS_DEFAULT_LIMIT = 200;

// ---- git ----
export const GIT_STATUS_MAX_FILES = 500;
export const GIT_DIFF_MAX_BYTES = 200 * 1024;
export const GIT_DIFF_DEFAULT_CONTEXT = 3;
export const GIT_DIFF_MIN_CONTEXT = 0;
export const GIT_DIFF_MAX_CONTEXT = 20;
export const GIT_LOG_DEFAULT_LIMIT = 20;
export const GIT_LOG_MAX_LIMIT = 100;
/** Maximum git_commit message length in characters. */
export const GIT_COMMIT_MAX_MESSAGE_CHARS = 4000;

// ---- common ----
/** Maximum serialized size of one tool_result, in bytes. */
export const TOOL_RESULT_MAX_BYTES = 256 * 1024;

/**
 * Keep the first and last characters of `text` so the result is at most
 * `maxChars` characters of content plus a marker. Head gets 1/4 of the budget,
 * tail gets the rest. Surrogate pairs are never split.
 *
 * Returns `text` unchanged when it already fits. The marker reads
 * `\n[... N chars truncated ...]\n`, where N is the number of characters removed.
 * The output length is at most `maxChars + marker.length`.
 */
export function truncateHeadTail(text: string, maxChars: number): string {
  const budget = Math.max(0, Math.floor(maxChars));
  if (text.length <= budget) return text;

  const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
  const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

  let headLen = Math.floor(budget / 4);
  if (headLen > 0 && isHigh(text.charCodeAt(headLen - 1))) headLen--;

  let tailLen = budget - headLen;
  let tailStart = text.length - tailLen;
  if (tailStart < text.length && tailStart > 0 && isLow(text.charCodeAt(tailStart))) {
    tailStart++;
  }
  // Ensure head and tail do not overlap (only possible with tiny budgets).
  if (tailStart < headLen) tailStart = headLen;

  const removed = tailStart - headLen;
  const marker = `\n[... ${removed} chars truncated ...]\n`;
  return text.slice(0, headLen) + marker + text.slice(tailStart);
}
