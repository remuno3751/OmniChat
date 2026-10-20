/* Audio transcription for attachments (docs/design/ATTACHMENTS.md "音声"): POST <base_url>/audio/transcriptions (OpenAI-compatible, multipart).
   The provider key is decrypted only for the request. Errors carry no key and no response body. */
import { getUsableProviderRow } from "./shared-providers.js";
import { decryptSecret } from "./secret.js";

const TRANSCRIBE_TIMEOUT_MS = 120_000;

export interface TranscribeOutcome { text?: string; warning?: string }

/** `transcribeModel` is "<providerId>::<model>". Never throws. */
export async function transcribeAudio(userId: string, transcribeModel: string, buf: Buffer, name: string, mime: string): Promise<TranscribeOutcome> {
  const cut = transcribeModel.indexOf("::");
  if (cut <= 0) return { warning: "文字起こしのモデルの設定が正しくありません。音声は保存されています" };
  const providerId = transcribeModel.slice(0, cut);
  const model = transcribeModel.slice(cut + 2);
  const row = getUsableProviderRow(userId, providerId);
  const base = String(row?.base_url ?? "").trim().replace(/\/+$/, "");
  if (!row || !base) return { warning: "文字起こしのプロバイダーが使えません。音声は保存されています" };
  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buf)], { type: mime }), name);
    form.append("model", model);
    const headers: Record<string, string> = {};
    const key = decryptSecret(row.api_key);
    if (key) headers.authorization = `Bearer ${key}`;
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
    if (!res.ok) return { warning: `文字起こしに失敗しました(HTTP ${res.status})。音声は保存されています` };
    const j = (await res.json().catch(() => null)) as { text?: unknown } | null;
    if (typeof j?.text !== "string") return { warning: "文字起こしの応答に text がありませんでした。音声は保存されています" };
    return { text: j.text };
  } catch {
    return { warning: "文字起こしに失敗しました(接続エラー)。音声は保存されています" };
  }
}
