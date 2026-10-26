// WS /voice/ws: relays one call between the app and Aria's /live/ws, and records it (voice-history.ts).
// Frames pass through unchanged, except:
// - Aria's `ready` gets the conversationId (none for a private call) and is followed by ONE `settings` frame with the
//   user's saved prefs: the base for this connection. Later client `settings` frames win. The client's `hello` is not
//   touched: an underlay there would overwrite Aria's saved values (docs/design/ARIA-HOST.md 「中継の規則」).
// - `omni_stats` (latency to the first audio) is relay-made and goes to the app only.
// - `private=1`: no conversation and no history; usage (seconds, turns) is still counted.
// - Aria closing: the app gets 1011 `aria_restarting` (abnormal) or 1000 `aria_closed`. The relay never retries by itself;
//   the app reconnects.
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { deviceFromToken } from "./auth.js";
import { db, getConversationRow, nextSeq, toConversation } from "./db.js";
import { broadcast } from "./hub.js";
import { ariaLiveUrl } from "./voice-aria.js";
import { titleVoiceConversation } from "./chat.js";
import { VoiceRecorder } from "./voice-history.js";
import { getPrefs, prefsToAriaValues, readVoiceConfig } from "./voice-store.js";
import { recordVoiceUsage, voiceQuotaExceeded } from "./voice-usage.js";

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
/** One live call per user: userId -> the app's socket. */
const activeCalls = new Map<string, WebSocket>();
/** Call seconds are recorded this often, so a crash loses at most a minute. The quota is checked at the same time. */
const USAGE_FLUSH_MS = 60_000;

export function handleVoiceUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
  const user = deviceFromToken(url.searchParams.get("token"));
  if (!user) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return void socket.destroy();
  }
  const requested = url.searchParams.get("conversationId") || null;
  const priv = url.searchParams.get("private") === "1";
  wss.handleUpgrade(req, socket, head, (ws) => startCall(ws, user.userId, requested, priv));
}

function startCall(client: WebSocket, userId: string, requested: string | null, priv: boolean): void {
  if (readVoiceConfig().mode === "off") return void client.close(4409, "voice_off");
  if (voiceQuotaExceeded(userId)) return void client.close(4429, "quota");
  if (activeCalls.has(userId)) return void client.close(4429, "busy");
  // the URL carries the chat token: it is only used to connect, never logged or sent back
  let ariaUrl: string;
  try {
    const u = new URL(ariaLiveUrl(userId));
    if (priv) u.searchParams.set("private", "1");
    ariaUrl = u.toString();
  } catch { return void client.close(4502, "aria_unreachable"); }

  let conversationId: string | null = null;
  let createdHere = false;
  if (!priv) {
    if (requested) {
      if (!ownConversation(userId, requested)) return void client.close(4404, "conversation_not_found");
      conversationId = requested;
    } else { conversationId = newConversation(userId); createdHere = true; }
  }

  activeCalls.set(userId, client);
  const recorder = conversationId ? new VoiceRecorder(userId, conversationId) : null;
  const aria = new WebSocket(ariaUrl, { handshakeTimeout: 10_000 });
  let ariaOpen = false;
  let done = false;
  let settingsSent = false;
  const early: { data: RawData | string; binary: boolean }[] = []; // app frames received before Aria is open

  // usage and latency state
  let connectedAt = 0; // Aria connected: the call's clock
  let billedSec = 0; // seconds already recorded for this call
  let trigger: number | null = null; // last user trigger (typed text, speech end, final transcript)
  let firstAudio: number | null = null; // ms from the trigger to the first audio of the reply
  const replyChars = new Map<number | undefined, number>(); // assistant text per Aria turn

  /** Records the call seconds not yet recorded (the delta since the last flush). */
  const flushSeconds = (): void => {
    if (!connectedAt) return;
    const total = Math.round((Date.now() - connectedAt) / 1000);
    if (total > billedSec) usage(userId, { seconds: total - billedSec });
    billedSec = Math.max(billedSec, total);
  };

  /** Tears the call down once. A code closes the app's socket too (Aria-side end); none = the app already left. */
  const end = (code?: number, reason?: string) => {
    if (done) return;
    done = true;
    clearInterval(usageTimer);
    if (activeCalls.get(userId) === client) activeCalls.delete(userId);
    flushSeconds();
    recorder?.finish();
    // a chat this call created keeps its provisional title unless the title generator can name it (fire-and-forget, never throws)
    if (createdHere && conversationId) void titleVoiceConversation(userId, conversationId);
    try { if (aria.readyState === WebSocket.CONNECTING) aria.terminate(); else aria.close(); } catch { /* ignore */ }
    if (code !== undefined) try { client.close(code, reason); } catch { /* ignore */ }
  };

  const usageTimer = setInterval(() => {
    flushSeconds();
    if (voiceQuotaExceeded(userId)) end(4429, "quota");
  }, USAGE_FLUSH_MS);
  usageTimer.unref?.();

  client.on("message", (data: RawData, binary: boolean) => {
    if (done) return;
    if (binary) {
      if (ariaOpen) aria.send(data, { binary: true });
      else early.push({ data, binary: true });
      return;
    }
    const text = data.toString();
    if (parseJson(text)?.type === "text") markTrigger();
    if (ariaOpen) aria.send(text, { binary: false });
    else early.push({ data: text, binary: false });
  });
  client.on("close", () => end());
  client.on("error", () => end());

  aria.on("open", () => {
    ariaOpen = true;
    connectedAt = Date.now();
    for (const f of early.splice(0)) aria.send(f.data, { binary: f.binary });
  });
  // errors may name the URL: close with a fixed reason only
  aria.on("error", () => { if (!ariaOpen) end(4502, "aria_unreachable"); });
  aria.on("close", (code) => {
    if (!ariaOpen) return end(4502, "aria_unreachable");
    const restarting = code === 1001 || code === 1006 || code === 1011 || code === 1012;
    end(restarting ? 1011 : 1000, restarting ? "aria_restarting" : "aria_closed");
  });
  aria.on("message", (data: RawData, binary: boolean) => {
    if (binary) return void sendToApp(client, data, true);
    const text = data.toString();
    const msg = parseJson(text);
    if (msg?.type === "ready") {
      sendToApp(client, JSON.stringify(conversationId ? { ...msg, conversationId } : msg), false);
      if (!settingsSent) {
        settingsSent = true;
        aria.send(JSON.stringify({ type: "settings", values: prefsToAriaValues(getPrefs(userId)), persist: false }), { binary: false });
      }
      return;
    }
    sendToApp(client, text, false);
    if (!msg || typeof msg !== "object") return;
    track(msg);
    recorder?.onAriaMessage(msg);
  });

  const markTrigger = () => { trigger = Date.now(); firstAudio = null; };

  /** Usage and latency from Aria's frames. Never throws into the socket handlers. */
  const track = (msg: any) => {
    try {
      switch (msg.type) {
        case "speech_end": markTrigger(); break;
        case "transcript": if (msg.final === true) markTrigger(); break;
        case "audio": if (trigger !== null && firstAudio === null) firstAudio = Date.now() - trigger; break;
        case "text": if (typeof msg.delta === "string") replyChars.set(msg.turn, (replyChars.get(msg.turn) ?? 0) + msg.delta.length); break;
        case "turn_end": {
          // one omni_stats per turn: Aria's first_audio_ms when it sends one, else the measured latency
          const stat = msg.stats && typeof msg.stats === "object" ? msg.stats : {};
          const ms = typeof stat.first_audio_ms === "number" ? stat.first_audio_ms : firstAudio;
          if (ms !== null && ms !== undefined) sendToApp(client, JSON.stringify({ type: "omni_stats", latencyMs: Math.round(ms) }), false);
          const chars = typeof stat.reply_chars === "number" ? stat.reply_chars : (replyChars.get(msg.turn) ?? 0);
          replyChars.delete(msg.turn);
          usage(userId, { turns: 1, replyChars: chars });
          trigger = null;
          firstAudio = null;
          break;
        }
      }
    } catch (e) {
      console.error("voice relay failed", (e as Error).message);
    }
  };
}

function usage(userId: string, u: { seconds?: number; turns?: number; replyChars?: number }): void {
  try { recordVoiceUsage(userId, u); } catch (e) { console.error("voice usage failed", (e as Error).message); }
}

function parseJson(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

function sendToApp(client: WebSocket, data: RawData | string, binary: boolean): void {
  if (client.readyState !== WebSocket.OPEN) return;
  client.send(data, { binary });
}

function ownConversation(userId: string, id: string): boolean {
  const row = getConversationRow(id);
  return !!row && row.user_id === userId && !row.deleted;
}

const pad = (n: number) => String(n).padStart(2, "0");
function newConversation(userId: string): string {
  const id = randomUUID();
  const now = new Date();
  const title = `通話 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const t = now.getTime();
  db.prepare("INSERT INTO conversations (id, user_id, title, auto_title, created_at, updated_at, deleted, seq, mode) VALUES (?,?,?,?,?,?,0,?,'chat')")
    .run(id, userId, title, title, t, t, nextSeq()); // auto_title = title: the server still owns this title, so the generator may replace it
  broadcast(userId, { type: "upsert", conversations: [toConversation(getConversationRow(id))] });
  return id;
}
