// Test double for dsh: emulates NDJSON output. Prompt keywords: FAIL, SLOW (waits for kill), BADLINES.
const args = process.argv.slice(2);
const si = args.indexOf("--session-id");
const sessionId = si >= 0 ? args[si + 1] : "session-fake-1";
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const c of process.stdin) prompt += c;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
out({ type: "session", sessionId, cwd: process.cwd() });
out({ type: "status", phase: "turn_start", turn: 1 });
if (prompt.includes("PATCHES")) {
  const fs = await import("node:fs");
  const files = args.flatMap((a, i) => (a === "--patch" ? [args[i + 1]] : []));
  out({ type: "patches", files: files.map((f) => ({ file: f, text: fs.readFileSync(f, "utf8") })) });
}
if (prompt.includes("BADLINES")) process.stdout.write("not json\n{broken\n");
if (prompt.includes("SLOW")) {
  out({ type: "text", text: "working" });
  setInterval(() => {}, 1000);
} else if (prompt.includes("FAIL")) {
  out({ type: "status", phase: "turn_end", reason: { kind: "error", error: { message: "no credentials", code: "E" } } });
  process.stderr.write("boom: missing credentials\n");
  process.exit(1);
} else {
  // WRITE:<rel>=<text>;<rel>=<text> (\n escapes), DELETE:<rel>, SUBAGENT: file-system and sub-agent test hooks.
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  let callN = 0;
  const toolPair = (tool, input, result) => {
    const callId = "w" + ++callN;
    out({ type: "tool_call", callId, tool, input });
    out({ type: "tool_result", callId, status: "completed", result });
  };
  const wm = /WRITE:(\S+)/.exec(prompt);
  if (wm) {
    for (const pair of wm[1].split(";")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const rel = pair.slice(0, eq);
      const text = pair.slice(eq + 1).replace(/\\n/g, "\n");
      const abs = pathm.resolve(process.cwd(), rel);
      fsm.mkdirSync(pathm.dirname(abs), { recursive: true });
      fsm.writeFileSync(abs, text);
      toolPair("write", { path: rel }, "ok");
    }
  }
  for (const dm of prompt.matchAll(/DELETE:(\S+)/g)) {
    fsm.rmSync(pathm.resolve(process.cwd(), dm[1]), { force: true });
  }
  if (prompt.includes("SUBAGENT")) {
    out({ type: "tool_call", callId: "sa1", tool: "subagent_fork", input: { description: "helper", prompt: "do x" } });
    out({ type: "tool_result", callId: "sa1", status: "completed", result: "helper says hi" });
  }
  out({ type: "text", text: "echo:" + prompt });
  out({ type: "final", text: "echo:" + prompt });
  out({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } });
}
