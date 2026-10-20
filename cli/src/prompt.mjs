import readline from "node:readline";
import { CliError, readAll } from "./util.mjs";

/** Read a secret: raw-mode prompt without echo on a TTY, first line of stdin otherwise. */
export async function readSecretLine(ctx, label) {
  const { stdin, stderr } = ctx.io;
  if (ctx.io.stdinIsTTY && typeof stdin.setRawMode === "function") {
    stderr.write(label);
    return new Promise((resolve, reject) => {
      let buf = "";
      stdin.setRawMode(true);
      stdin.setEncoding?.("utf8");
      stdin.resume();
      const finish = (fn) => {
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
        stderr.write("\n");
        fn();
      };
      const onData = (chunk) => {
        for (const ch of String(chunk)) {
          if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish(() => resolve(buf));
          if (ch === "\u0003") return finish(() => reject(new CliError("aborted", 130)));
          if (ch === "\u007f" || ch === "\b") { buf = [...buf].slice(0, -1).join(""); continue; }
          if (ch >= " ") buf += ch;
        }
      };
      stdin.on("data", onData);
    });
  }
  const text = await readAll(stdin);
  return text.split(/\r?\n/)[0] ?? "";
}

/** Ask a visible question on a TTY. Resolves to the answer, or "\u0003" on Ctrl+C. */
export function defaultAsk(question, io) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: io.stdin, output: io.stderr, terminal: !!io.stdinIsTTY });
    let answered = false;
    rl.on("SIGINT", () => { answered = true; rl.close(); resolve("\u0003"); });
    rl.on("close", () => { if (!answered) resolve(""); });
    rl.question(question, (a) => { answered = true; rl.close(); resolve(a); });
  });
}
