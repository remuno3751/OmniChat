// Fake OmniChat server for CLI tests: REST + WebSocket on a random local port.
// Scenarios are chosen by markers in the user's message, e.g. "[tool]", "[ctx]", "[slow]".
import http from "node:http";
import crypto from "node:crypto";
import { acceptWebSocket } from "./ws-server.mjs";

export const USERNAME = "alice";
export const PASSWORD = "pw-correct-horse";

const now = () => Date.now();
const newToken = () => "tok_" + crypto.randomBytes(16).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startFakeServer(opts = {}) {
  const state = {
    tokens: new Map(), // token -> device id
    devices: [],
    providers: [
      { id: "prov-lm", name: "LM Studio", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", model: "google/gemma-4-e4b", models: ["google/gemma-4-e4b", "qwen/qwen3-8b"] },
      { id: "prov-ol", name: "Ollama", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "llama3", models: ["llama3"] },
      { id: "prov-lab", name: "Lab", kind: "openai-compatible", baseUrl: "http://10.0.0.5:8000/v1", model: "google/gemma-4-e4b", models: ["google/gemma-4-e4b"] },
    ],
    projects: new Map(),
    conversations: new Map(),
    messages: new Map(),
    seq: 0,
    log: [], // every HTTP request: {method, url, auth, body}
    wsFrames: [], // every frame received from a client: {frame, token}
    approvalReplies: [],
    benchSets: new Map([["set-1", { id: "set-1", name: "smoke", prompts: ["one", "two"], systemPrompt: null }]]),
    benchRuns: new Map(),
    lastImport: null,
    registration: opts.registration ?? true,
    benchFinishAfter: opts.benchFinishAfter ?? 2,
    benchFail: !!opts.benchFail,
    toolApprovalTimeoutMs: opts.toolApprovalTimeoutMs ?? 1500,
    chunkDelayMs: opts.chunkDelayMs ?? 5,
  };
  const active = new Map(); // assistant message id -> {stopped}
  const pendingApprovals = new Map(); // approvalId -> resolve(decision)
  const sockets = new Set();

  const bump = () => ++state.seq;

  function issueDevice(name, platform) {
    const id = crypto.randomUUID();
    const token = newToken();
    state.devices.push({ id, name, platform, createdAt: now(), lastSeenAt: now() });
    state.tokens.set(token, id);
    return { id, token };
  }

  function json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  }
  const sendText = (res, status, body, type = "text/plain") => {
    res.writeHead(status, { "content-type": type });
    res.end(body);
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
        resolve(body);
      });
    });

  const broadcast = (obj) => { for (const s of sockets) s.send(obj); };

  function upsertConv(id, patch) {
    const prev = state.conversations.get(id);
    const c = {
      title: "New chat", providerId: null, model: null, projectId: null, systemPrompt: null,
      systemMode: "append", effort: null, params: null, headId: null, searchMode: null, tools: null,
      createdAt: now(), updatedAt: now(), deleted: false,
      ...prev, ...patch, id,
    };
    c.seq = bump();
    state.conversations.set(id, c);
    return c;
  }

  function putMessage(m) {
    m.seq = bump();
    state.messages.set(m.id, m);
    return m;
  }

  function sync() {
    return {
      seq: state.seq,
      conversations: [...state.conversations.values()],
      messages: [...state.messages.values()],
      providers: state.providers.map((p) => ({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, model: p.model, hasKey: false, deleted: false, seq: 1 })),
      projects: [...state.projects.values()],
    };
  }

  function modelGroups() {
    return state.providers.map((p) => ({
      providerId: p.id,
      providerName: p.name,
      kind: p.kind,
      models: p.models.map((id) => ({ id, name: id })),
    }));
  }

  async function streamText(conv, asst, chunks, kind = "text") {
    for (const part of chunks) {
      if (active.get(asst.id)?.stopped) return false;
      broadcast({ type: "delta", messageId: asst.id, conversationId: conv.id, text: part, kind });
      await sleep(state.chunkDelayMs);
    }
    return !active.get(asst.id)?.stopped;
  }

  function finish(asst, status, content, extra = {}) {
    const m = putMessage({ ...asst, status, content, reasoning: extra.reasoning ?? null, ...(extra.fields ?? {}) });
    broadcast({ type: "upsert", messages: [m] });
    active.delete(asst.id);
    return m;
  }

  const METRICS = { ttftMs: 120, totalMs: 900, decodeTps: 42.5, prefillTps: 310, promptTokens: 12, completionTokens: 5, reasoningTokens: 0, source: "backend" };

  async function runScenario(conv, asst, content) {
    active.set(asst.id, { stopped: false });

    if (content.includes("[ctx]")) {
      active.delete(asst.id);
      state.messages.delete(asst.id);
      broadcast({ type: "error", code: "context_overflow", message: "context window exceeded: 9000 tokens > 4096", messageId: asst.id });
      return;
    }
    if (content.includes("[frameerr]")) {
      active.delete(asst.id);
      broadcast({ type: "error", message: "bad request: something is wrong" });
      return;
    }
    if (content.includes("[err]")) {
      await sleep(state.chunkDelayMs);
      finish(asst, "error", "backend returned HTTP 500: boom");
      return;
    }
    if (content.includes("[slow]")) {
      for (let i = 0; i < 400; i++) {
        if (active.get(asst.id)?.stopped) break;
        broadcast({ type: "delta", messageId: asst.id, conversationId: conv.id, text: "tick ", kind: "text" });
        await sleep(10);
      }
      finish(asst, "stopped", "tick ".repeat(3), { fields: { metrics: { ...METRICS, completionTokens: 3 } } });
      return;
    }
    if (content.includes("[think]")) {
      if (!(await streamText(conv, asst, ["Let me ", "think."], "reasoning"))) return finish(asst, "stopped", "");
      if (!(await streamText(conv, asst, ["Answer ", "after thinking."]))) return finish(asst, "stopped", "Answer ");
      finish(asst, "done", "Answer after thinking.", { reasoning: "Let me think.", fields: { metrics: METRICS } });
      return;
    }
    if (content.includes("[tool]") || content.includes("[tool-noperm]")) {
      const needsApproval = content.includes("[tool]");
      const call = {
        id: "call-1",
        name: needsApproval ? "web_search" : "current_time",
        arguments: needsApproval ? { query: "omnichat" } : {},
        status: "running",
        startedAt: now(),
      };
      broadcast({ type: "tool", messageId: asst.id, conversationId: conv.id, call: { ...call } });
      if (needsApproval) {
        call.status = "pending";
        broadcast({ type: "tool", messageId: asst.id, conversationId: conv.id, call: { ...call } });
        const approvalId = crypto.randomUUID();
        broadcast({ type: "tool_approval", approvalId, messageId: asst.id, conversationId: conv.id, tool: "web_search", arguments: { query: "omnichat" }, permissions: ["network"] });
        const decision = await new Promise((resolve) => {
          const t = setTimeout(() => { pendingApprovals.delete(approvalId); resolve("deny"); }, state.toolApprovalTimeoutMs);
          pendingApprovals.set(approvalId, (d) => { clearTimeout(t); resolve(d); });
        });
        if (decision === "deny") {
          call.status = "denied";
          call.error = "denied by user";
          broadcast({ type: "tool", messageId: asst.id, conversationId: conv.id, call: { ...call } });
          if (!(await streamText(conv, asst, ["Answering without search."]))) return finish(asst, "stopped", "");
          finish(asst, "done", "Answering without search.", { fields: { metrics: METRICS, toolCalls: [call] } });
          return;
        }
        call.status = "running";
      }
      call.status = "done";
      call.result = "[1] Omnichat — https://example.com/omnichat";
      call.durationMs = 12;
      broadcast({ type: "tool", messageId: asst.id, conversationId: conv.id, call: { ...call } });
      if (!(await streamText(conv, asst, ["Found ", "results."]))) return finish(asst, "stopped", "Found ");
      finish(asst, "done", "Found results.", { fields: { metrics: METRICS, toolCalls: [call] } });
      return;
    }
    // default: echo the message in three chunks
    const answer = `You said: ${content}`;
    const parts = [answer.slice(0, 10), answer.slice(10, 25), answer.slice(25)].filter(Boolean);
    if (!(await streamText(conv, asst, parts))) return finish(asst, "stopped", answer.slice(0, 10));
    const sources = content.includes("[search]")
      ? [{ index: 1, title: "Example A", url: "https://example.com/a" }, { index: 2, title: "Example B", url: "https://example.org/b" }]
      : null;
    finish(asst, "done", answer, { fields: { metrics: METRICS, sources } });
  }

  function handleSend(frame, conn) {
    const conv = state.conversations.get(frame.conversationId);
    if (!conv) return conn.send({ type: "error", message: "unknown conversation" });
    const user = putMessage({
      id: frame.userMessageId, conversationId: conv.id, role: "user", content: frame.content, status: "done",
      createdAt: now(), parentId: conv.headId, reasoning: null, metrics: null, sources: null, toolCalls: null,
    });
    const asst = putMessage({
      id: frame.assistantMessageId, conversationId: conv.id, role: "assistant", content: "", status: "streaming",
      createdAt: now(), parentId: user.id, reasoning: null, metrics: null, sources: null, toolCalls: null,
    });
    upsertConv(conv.id, { headId: asst.id, updatedAt: now() });
    broadcast({ type: "upsert", messages: [user, asst] });
    runScenario(state.conversations.get(conv.id), asst, frame.content).catch(() => {});
  }

  function benchRunView(run) {
    return { ...run, polls: undefined, cancelRequested: undefined, results: [] };
  }

  async function route(req, res) {
    const url = new URL(req.url, "http://x");
    const body = await readBody(req);
    const auth = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    state.log.push({ method: req.method, url: req.url, auth: auth || null, body });
    const p = url.pathname;
    const m = req.method;
    const open = p === "/ping" || p === "/version" || p === "/healthz" || p.startsWith("/auth/");
    if (!open && !state.tokens.has(auth)) return json(res, 401, { error: "unauthorized" });
    const cur = state.tokens.get(auth);

    if (p === "/ping") return json(res, 200, { t: now() });
    if (p === "/version") return json(res, 200, { name: "omnichat-server", version: "fake", webUi: false, searxng: false });
    if (p === "/auth/register" && m === "POST") {
      if (!state.registration) return json(res, 403, { error: "registration is disabled" });
      const dev = issueDevice(body?.deviceName ?? "Unknown device", body?.platform ?? "unknown");
      return json(res, 200, { userId: "user-2", username: body?.username, token: dev.token, deviceId: dev.id, isAdmin: false });
    }
    if (p === "/auth/login" && m === "POST") {
      if (body?.username !== USERNAME || body?.password !== PASSWORD) return json(res, 401, { error: "invalid username or password" });
      const dev = issueDevice(body?.deviceName ?? "Unknown device", body?.platform ?? "unknown");
      return json(res, 200, { userId: "user-1", username: USERNAME, token: dev.token, deviceId: dev.id, isAdmin: true });
    }
    if (p === "/auth/logout" && m === "POST") {
      const did = state.tokens.get(auth);
      state.tokens.delete(auth);
      state.devices = state.devices.filter((d) => d.id !== did);
      return json(res, 200, { ok: true });
    }
    if (p === "/devices" && m === "GET") {
      return json(res, 200, { devices: state.devices.map((d) => ({ ...d, current: d.id === cur })) });
    }
    if (p === "/sync" && m === "GET") return json(res, 200, sync());
    if (p === "/models" && m === "GET") return json(res, 200, { groups: modelGroups() });
    if (p.startsWith("/conversations/") && m === "PUT") {
      const id = decodeURIComponent(p.slice("/conversations/".length));
      const c = upsertConv(id, { ...(body ?? {}), updatedAt: now() });
      broadcast({ type: "upsert", conversations: [c] });
      return json(res, 200, c);
    }
    if (p.startsWith("/projects/") && m === "PUT") {
      const id = decodeURIComponent(p.slice("/projects/".length));
      const pr = { id, name: body?.name ?? "New project", systemPrompt: null, systemMode: "append", defaultProviderId: null, defaultModel: null, effort: null, params: null, createdAt: now(), updatedAt: now(), deleted: false, seq: bump() };
      state.projects.set(id, pr);
      return json(res, 200, pr);
    }
    if (p === "/history/search" && m === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const results = [];
      for (const msg of state.messages.values()) {
        const i = msg.content.toLowerCase().indexOf(q);
        if (!q || i < 0) continue;
        const conv = state.conversations.get(msg.conversationId);
        results.push({
          messageId: msg.id, conversationId: msg.conversationId, conversationTitle: conv?.title ?? "", projectId: null,
          role: msg.role, snippet: `${msg.content.slice(0, i)}\u0001${msg.content.slice(i, i + q.length)}\u0002${msg.content.slice(i + q.length)}`,
          createdAt: msg.createdAt,
        });
      }
      const limit = Number(url.searchParams.get("limit") ?? 20);
      return json(res, 200, { results: results.slice(0, limit), total: results.length });
    }
    const exp = p.match(/^\/conversations\/([^/]+)\/export$/);
    if (exp && m === "GET") {
      const conv = state.conversations.get(decodeURIComponent(exp[1]));
      if (!conv) return json(res, 404, { error: "conversation not found" });
      const msgs = [...state.messages.values()].filter((x) => x.conversationId === conv.id);
      const fmt = url.searchParams.get("format") ?? "md";
      if (fmt === "json") return sendText(res, 200, JSON.stringify({ version: 1, conversations: [{ ...conv, messages: msgs }] }, null, 2), "application/json");
      const md = `# ${conv.title}\n\n` + msgs.map((x) => `**${x.role === "user" ? "You" : "Assistant"}:** ${x.content}`).join("\n\n") + "\n";
      return sendText(res, 200, md, "text/markdown");
    }
    if (p === "/bench/sets" && m === "GET") return json(res, 200, { sets: [...state.benchSets.values()] });
    if (p === "/bench/runs" && m === "POST") {
      const set = state.benchSets.get(body?.setId);
      if (!set) return json(res, 404, { error: "prompt set not found" });
      if ([...state.benchRuns.values()].some((r) => r.status === "running")) return json(res, 409, { error: "a benchmark run is already running" });
      const targets = (body?.targets ?? []).map((t) => ({ ...t, providerName: state.providers.find((x) => x.id === t.providerId)?.name ?? "?" }));
      const repeats = body?.repeats ?? 1;
      const runId = crypto.randomUUID();
      state.benchRuns.set(runId, {
        id: runId, setId: set.id, setName: set.name, status: "running", startedAt: now(), finishedAt: null,
        targets, repeats, warmup: body?.warmup ?? true, maxTokens: body?.maxTokens ?? 256, promptCount: set.prompts.length,
        total: targets.length * set.prompts.length * repeats, done: 0, polls: 0, cancelRequested: false,
      });
      return json(res, 200, { runId });
    }
    const runM = p.match(/^\/bench\/runs\/([^/]+)(\/cancel)?$/);
    if (runM) {
      const run = state.benchRuns.get(runM[1]);
      if (!run) return json(res, 404, { error: "run not found" });
      if (runM[2] && m === "POST") {
        run.cancelRequested = true;
        return json(res, 200, { ok: true });
      }
      if (m === "GET") {
        run.polls++;
        if (run.cancelRequested && run.status === "running") {
          run.status = "cancelled";
          run.finishedAt = now();
        } else if (run.status === "running") {
          run.done = Math.min(run.total, run.done + Math.ceil(run.total / state.benchFinishAfter));
          if (run.done >= run.total) {
            run.status = state.benchFail ? "error" : "done";
            run.error = state.benchFail ? "backend unreachable" : undefined;
            run.finishedAt = now();
          }
        }
        const summary = run.status === "done" ? run.targets.map((t, ti) => ({
          targetIndex: ti, providerName: t.providerName, model: t.model, quantization: null, contextLength: null,
          n: run.total / run.targets.length, avgTtftMs: 120, avgPrefillTps: 300, avgDecodeTps: 40 + ti * 10,
          p50DecodeTps: 40 + ti * 10, minDecodeTps: 38 + ti * 10, maxDecodeTps: 42 + ti * 10, errors: 0, estimatedShare: 0,
        })) : [];
        return json(res, 200, { ...benchRunView(run), summary });
      }
    }
    if (p === "/config/export" && m === "GET") {
      const format = url.searchParams.get("format") ?? "json";
      if (format === "yaml") return sendText(res, 200, "version: 1\nsettings:\n  systemPrompt: Be brief.\n", "application/yaml");
      return json(res, 200, {
        version: 1, exportedAt: now(), settings: { systemPrompt: "Be brief." },
        projects: [...state.projects.values()].map((x) => ({ name: x.name })), presets: [],
        benchSets: [...state.benchSets.values()].map((s) => ({ name: s.name, prompts: s.prompts, systemPrompt: null })),
      });
    }
    if (p === "/config/import" && m === "POST") {
      if (body?.format === "json") {
        try { JSON.parse(body.content); } catch { return json(res, 400, { error: "content is not valid JSON" }); }
      }
      state.lastImport = body;
      const skipped = String(body?.content ?? "").includes("bad-preset") ? ["preset bad-preset: text is required"] : [];
      return json(res, 200, { created: { projects: 1, presets: 0, benchSets: 1 }, updated: { settings: 1 }, skipped });
    }
    return json(res, 404, { error: `no route ${m} ${p}` });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => json(res, 500, { error: String(e?.message ?? e) }));
  });

  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url, "http://x");
    const token = url.searchParams.get("token") ?? "";
    if (url.pathname !== "/ws" || !state.tokens.has(token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const conn = acceptWebSocket(req, socket, {
      onMessage: (frame, c) => {
        state.wsFrames.push({ frame, token });
        if (frame.type === "send") handleSend(frame, c);
        else if (frame.type === "stop") {
          const a = active.get(frame.messageId);
          if (a) a.stopped = true;
        } else if (frame.type === "tool_approval_reply") {
          state.approvalReplies.push(frame);
          const resolve = pendingApprovals.get(frame.approvalId);
          if (resolve) { pendingApprovals.delete(frame.approvalId); resolve(frame.decision); }
        } else if (frame.type === "ping") c.send({ type: "pong", t: frame.t });
      },
      onClose: () => {},
    });
    sockets.add(conn);
    conn.send({ type: "hello", seq: state.seq, route: "loopback", serverTime: now() });
    socket.on("close", () => sockets.delete(conn));
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  // A device token that exists before any CLI login (for "already logged in" tests).
  const seeded = issueDevice("seed", "test");
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    seededToken: seeded.token,
    seededDeviceId: seeded.id,
    broadcast,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) { try { s.close(1001, "bye"); } catch { /* ignore */ } }
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
