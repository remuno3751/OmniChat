import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startFakeServer } from "./helpers/fake-server.mjs";
import { makeHome, runCli, writeConfig, runInProcess, startInProcess } from "./helpers/cli.mjs";

const sends = (srv) => srv.state.wsFrames.filter((x) => x.frame.type === "send").map((x) => x.frame);
const approvals = (srv) => srv.state.approvalReplies.map((f) => f.decision);
const waitFor = async (fn, ms = 10000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("chat (child process)", () => {
  let srv;
  let h;
  let base;
  before(async () => { srv = await startFakeServer(); });
  after(async () => { await srv.close(); });
  beforeEach(() => {
    h = makeHome();
    writeConfig(h.configPath, { server: srv.url, token: srv.seededToken });
    base = { configPath: h.configPath, home: h.home };
  });

  test("streams the answer to stdout and prints the conversation id on stderr", async () => {
    const r = await runCli(["chat", "hello there"], base);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "You said: hello there\n");
    assert.match(r.stderr, /conversation: [0-9a-f-]{36}/);
    const s = sends(srv).at(-1);
    assert.equal(s.content, "hello there");
    assert.match(s.conversationId, /^[0-9a-f-]{36}$/);
  });

  test("reads the message from stdin when it is piped (no argument)", async () => {
    const r = await runCli(["chat"], { ...base, input: "from stdin\n" });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(sends(srv).at(-1).content, "from stdin");
  });

  test('"-" reads stdin and joins with further arguments', async () => {
    const r = await runCli(["chat", "-", "and more"], { ...base, input: "piped\n" });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(sends(srv).at(-1).content, "piped\n\nand more");
  });

  test("an empty message is a usage error (exit 2)", async () => {
    const r = await runCli(["chat"], { ...base, input: "  \n" });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /message is empty/);
  });

  test("--json prints the final message object and metrics", async () => {
    const r = await runCli(["chat", "json please", "--json"], base);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.status, "done");
    assert.equal(out.message.content, "You said: json please");
    assert.equal(out.metrics.decodeTps, 42.5);
    assert.match(out.conversationId, /^[0-9a-f-]{36}$/);
  });

  test("--model resolves <providerName>/<modelId> and stores the provider on the conversation", async () => {
    const r = await runCli(["chat", "m", "--model", "Lab/google/gemma-4-e4b"], base);
    assert.equal(r.code, 0, r.stderr);
    const put = srv.state.log.filter((e) => e.method === "PUT" && e.url.startsWith("/conversations/")).at(-1);
    assert.equal(put.body.providerId, "prov-lab");
    assert.equal(put.body.model, "google/gemma-4-e4b");
  });

  test("an ambiguous bare --model lists the candidates and sends nothing", async () => {
    const before = sends(srv).length;
    const r = await runCli(["chat", "m", "--model", "google/gemma-4-e4b"], base);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ambiguous; candidates:[\s\S]*LM Studio\/google\/gemma-4-e4b[\s\S]*Lab\/google\/gemma-4-e4b/);
    assert.equal(sends(srv).length, before);
  });

  test("--project: unknown project is an error unless --create-project", async () => {
    const r = await runCli(["chat", "x", "--project", "Research"], base);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /project "Research" not found; pass --create-project/);
    const c = await runCli(["chat", "x", "--project", "Research", "--create-project"], base);
    assert.equal(c.code, 0, c.stderr);
    assert.match(c.stderr, /created project "Research"/);
    const put = srv.state.log.filter((e) => e.method === "PUT" && e.url.startsWith("/conversations/")).at(-1);
    assert.ok(put.body.projectId, "conversation is filed under the project");
  });

  test("--conv continues an existing conversation by id prefix; --new starts another", async () => {
    const first = await runCli(["chat", "one", "--json"], base);
    const id = JSON.parse(first.stdout).conversationId;
    const second = await runCli(["chat", "two", "--conv", id.slice(0, 8), "--json"], base);
    assert.equal(JSON.parse(second.stdout).conversationId, id);
    const third = await runCli(["chat", "three", "--new", "--json"], base);
    assert.notEqual(JSON.parse(third.stdout).conversationId, id);
    const bad = await runCli(["chat", "x", "--conv", "zzzz"], base);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /conversation "zzzz" not found/);
    const both = await runCli(["chat", "x", "--conv", id, "--new"], base);
    assert.equal(both.code, 2);
  });

  test("--effort and --search are passed through; invalid values are usage errors", async () => {
    const r = await runCli(["chat", "e", "--effort", "high", "--search", "always"], base);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(sends(srv).at(-1).effort, "high");
    const put = srv.state.log.filter((e) => e.method === "PUT" && e.url.startsWith("/conversations/")).at(-1);
    assert.equal(put.body.searchMode, "always");
    const bad = await runCli(["chat", "e", "--effort", "extreme"], base);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--effort must be one of/);
  });

  test("--thinking prints reasoning to stderr only; without it reasoning is hidden", async () => {
    const plain = await runCli(["chat", "[think]"], base);
    assert.equal(plain.stdout, "Answer after thinking.\n");
    assert.ok(!plain.stderr.includes("Let me think"));
    const withT = await runCli(["chat", "[think]", "--thinking"], base);
    assert.equal(withT.stdout, "Answer after thinking.\n");
    assert.match(withT.stderr, /Let me think\./);
  });

  test("search sources are printed after the answer as [n] title - url", async () => {
    const r = await runCli(["chat", "[search] what is it"], base);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\n\[1\] Example A — https:\/\/example\.com\/a\n\[2\] Example B — https:\/\/example\.org\/b\n$/);
    const quiet = await runCli(["chat", "[search] x", "--no-sources"], base);
    assert.ok(!quiet.stdout.includes("[1] Example A"));
  });

  test("context_overflow is a readable error with exit code 1", async () => {
    const r = await runCli(["chat", "[ctx] big"], base);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /context window exceeded: 9000 tokens > 4096/);
    assert.match(r.stderr, /--new/);
  });

  test("frame-level error is shown and exits 1", async () => {
    const r = await runCli(["chat", "[frameerr]"], base);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /error: bad request: something is wrong/);
  });

  test("a failed generation (status error) exits 1 with the server text", async () => {
    const r = await runCli(["chat", "[err]"], base);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /backend returned HTTP 500: boom/);
  });

  test("tool approval: non-interactive default is deny", async () => {
    const r = await runCli(["chat", "[tool] find it"], base);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(approvals(srv).at(-1), "deny");
    assert.match(r.stderr, /tool web_search\(\{"query":"omnichat"\}\) \[network\] needs approval: denied/);
    assert.match(r.stderr, /\[tool\] web_search denied/);
    assert.equal(r.stdout, "Answering without search.\n");
  });

  test("--approve once runs the tool and shows its summary", async () => {
    const r = await runCli(["chat", "[tool] find it", "--approve", "once"], base);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(approvals(srv).at(-1), "once");
    assert.match(r.stderr, /\[tool\] web_search done \(12 ms\)/);
    assert.equal(r.stdout, "Found results.\n");
  });

  test("--approve always stores the decision as always", async () => {
    const r = await runCli(["chat", "[tool]", "--approve", "always"], base);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(approvals(srv).at(-1), "always");
  });

  test("tools without permissions never ask", async () => {
    const before = srv.state.approvalReplies.length;
    const r = await runCli(["chat", "[tool-noperm]"], base);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(srv.state.approvalReplies.length, before);
    assert.match(r.stderr, /\[tool\] current_time done/);
  });

  test("--stats prints speed on stderr", async () => {
    const r = await runCli(["chat", "s", "--stats"], base);
    assert.match(r.stderr, /ttft 120 ms, decode 42\.5 tok\/s, 5 tokens/);
  });

  test("stdout has no colour codes when not a terminal, even with colour env unset", async () => {
    const r = await runCli(["chat", "[think] c"], { ...base, env: { NO_COLOR: undefined } });
    assert.ok(!r.stdout.includes("\u001b["));
    assert.ok(!r.stderr.includes("\u001b["));
  });

  test("--debug logs requests but never the token", async () => {
    const r = await runCli(["chat", "dbg", "--debug"], base);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /\[debug\] ws connect/);
    assert.ok(!r.stderr.includes(srv.seededToken), "token must be redacted in debug output");
    assert.ok(!r.stderr.includes("token=" + srv.seededToken));
  });

  test("unreachable server during chat exits 1 with a hint", async () => {
    writeConfig(h.configPath, { server: "http://127.0.0.1:9", token: "tok_x" });
    const r = await runCli(["chat", "x"], { ...base, timeoutMs: 15000 });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot reach server/);
  });
});

describe("chat (in-process: TTY prompts and Ctrl+C)", () => {
  let srv;
  let h;
  before(async () => { srv = await startFakeServer({ chunkDelayMs: 5 }); });
  after(async () => { await srv.close(); });
  beforeEach(() => {
    h = makeHome();
    writeConfig(h.configPath, { server: srv.url, token: srv.seededToken });
  });

  const tty = (args, ask) => runInProcess(args, { configPath: h.configPath, home: h.home, isTTY: true, ask });

  test("TTY approval prompt: y = once", async () => {
    const asked = [];
    const r = await tty(["chat", "[tool] go"], async (q) => { asked.push(q); return "y"; });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(approvals(srv).at(-1), "once");
    assert.match(asked[0], /Allow tool web_search/);
  });

  test("TTY approval prompt: a = always", async () => {
    const r = await tty(["chat", "[tool] go"], async () => "a");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(approvals(srv).at(-1), "always");
  });

  test("TTY approval prompt: empty answer (default N) denies", async () => {
    const r = await tty(["chat", "[tool] go"], async () => "");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(approvals(srv).at(-1), "deny");
  });

  test("Ctrl+C while streaming sends stop for the reply and exits 130", async () => {
    const h2 = startInProcess(["chat", "[slow] long"], { configPath: h.configPath, home: h.home });
    await waitFor(() => h2.stdout().length > 0 || srv.state.wsFrames.some((x) => x.frame.type === "send"));
    await waitFor(() => h2.stdout().includes("tick"));
    h2.fireSigint();
    const r = await h2.done;
    assert.equal(r.code, 130, r.stderr);
    const stop = srv.state.wsFrames.map((x) => x.frame).find((f) => f.type === "stop");
    assert.ok(stop, "a stop frame must be sent");
    const send = sends(srv).at(-1);
    assert.equal(stop.messageId, send.assistantMessageId);
    assert.match(r.stderr, /interrupted: asking the server to stop/);
  });
});
