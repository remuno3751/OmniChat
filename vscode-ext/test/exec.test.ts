import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/tools/exec";
import type { ToolContext } from "../src/tools/index";

function makeCtx(root: string, signal: AbortSignal = new AbortController().signal): ToolContext {
  return { host: {} as never, root, roots: [root], cwd: root, signal };
}

/** True when the pid exists and is not a zombie (Linux /proc check, else kill(0)). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

async function waitDead(pid: number, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe.skipIf(process.platform === "win32")("runCommand (POSIX)", () => {
  let dir: string;
  let savedToken: string | undefined;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "exec-test-")));
    savedToken = process.env.FAKE_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.FAKE_TOKEN;
    else process.env.FAKE_TOKEN = savedToken;
    delete process.env.OMNICHAT_X;
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs echo and returns stdout with exit 0", async () => {
    const res = await runCommand({ command: "echo hello", timeoutMs: 10_000 }, makeCtx(dir), {
      killGraceMs: 200,
    });
    expect(res.stdout).toBe("hello\n");
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.truncated).toBe(false);
  });

  it("reports a nonzero exit code without throwing", async () => {
    const res = await runCommand(
      { command: "echo oops >&2; exit 3", timeoutMs: 10_000 },
      makeCtx(dir),
    );
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toBe("oops\n");
  });

  it("kills the whole process tree on timeout", async () => {
    const res = await runCommand(
      { command: "sleep 30 & echo $! > pid.txt; wait", cwd: ".", timeoutMs: 1000 },
      makeCtx(dir),
      { killGraceMs: 200 },
    );
    expect(res.timedOut).toBe(true);
    const pid = Number(readFileSync(join(dir, "pid.txt"), "utf8").trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(await waitDead(pid)).toBe(true);
  }, 15_000);

  it("rejects with code cancelled when the signal aborts", async () => {
    const ac = new AbortController();
    const p = runCommand({ command: "sleep 30", timeoutMs: 20_000 }, makeCtx(dir, ac.signal), {
      killGraceMs: 200,
    });
    setTimeout(() => ac.abort(), 200);
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
  }, 15_000);

  it("scrubs secret-looking and OMNICHAT_* variables but keeps PATH", async () => {
    process.env.FAKE_TOKEN = "x";
    process.env.OMNICHAT_X = "y";
    const res = await runCommand(
      {
        command: 'printf "%s|%s|%s|%s" "${FAKE_TOKEN:-unset}" "${OMNICHAT_X:-unset}" "$TERM" "${PATH:+set}"',
        timeoutMs: 10_000,
      },
      makeCtx(dir),
    );
    expect(res.stdout).toBe("unset|unset|dumb|set");
  });

  it("caps large output with head and tail and sets truncated", async () => {
    const res = await runCommand(
      { command: "yes | head -c 200000", timeoutMs: 10_000 },
      makeCtx(dir),
    );
    expect(res.truncated).toBe(true);
    expect(res.stdout).toContain("bytes omitted");
    expect(res.stdout.length).toBeLessThan(70_000);
    expect(res.stdout.startsWith("y\n")).toBe(true);
  });

  it("runs in a relative cwd inside the root", async () => {
    mkdirSync(join(dir, "sub"));
    const res = await runCommand({ command: "pwd", cwd: "sub", timeoutMs: 10_000 }, makeCtx(dir));
    expect(res.stdout.endsWith("/sub\n")).toBe(true);
  });

  it("refuses a cwd outside the roots", async () => {
    await expect(
      runCommand({ command: "echo hi", cwd: "/", timeoutMs: 10_000 }, makeCtx(dir)),
    ).rejects.toMatchObject({ code: "outside_workspace" });
    await expect(
      runCommand({ command: "echo hi", cwd: "../", timeoutMs: 10_000 }, makeCtx(dir)),
    ).rejects.toMatchObject({ code: "outside_workspace" });
  });
});
