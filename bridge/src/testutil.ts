import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

export function tmpDir(prefix = "omnichat-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const rec = (seq: number, time: number, type: string, data: unknown) => ({ seq, time, type, data });

/** Appends ONE independently compressed zstd frame holding the given JSONL records. */
export function appendFrame(file: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.appendFileSync(file, zlib.zstdCompressSync(Buffer.from(text, "utf8")));
}

export function sessionFile(dshHome: string, slug: string, sessionId: string): string {
  return path.join(dshHome, "sessions", slug, sessionId, "session.v4.jsonl.zstd");
}

export const header = (id: string, cwd: string, t = 1000) => ({ type: "session", version: 4, id, createdAt: t, cwd });
export const userMsg = (seq: number, t: number, text: string, kind = "user") =>
  rec(seq, t, "user/message", { content: [{ type: "text", text }], source: { kind }, role: "user", id: `id-${seq}` });
export const asst = (seq: number, t: number, turn: number, step: number, parts: unknown[]) =>
  rec(seq, t, "assistant/message", { turn, step, message: { role: "assistant", content: parts } });

export const SECRET = "Bearer sk-SUPER-SECRET-123";
export const CORDIS = `# patch
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencodex:
        displayName: OpenCodex
        api: openai-responses
        baseURL: http://127.0.0.1:10100/v1
        headers:
          Authorization: ${SECRET}
        models:
          - id: lm-studio/lfm2.5-24b-a2b
            name: lfm (lm-studio)
            contextWindow: 32768
          - id: gpt-5.5
            name: gpt-5.5 (native)
      other:
        models:
          - id: m1
- id: something-else
  config:
    providers:
      bogus:
        models:
          - id: nope
`;

