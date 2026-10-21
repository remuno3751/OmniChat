import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as gitops from "@gitops";
import { createRunGit, createRunHooks } from "../src/git/checkpoint";
import type { ChangesFrame, CheckpointFrame } from "../src/protocol/frames";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "pipe" });

let dir: string;
let repo: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "omnichat-cp-test-"));
  repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const runGit = () => createRunGit({ gitops });
const noDocs = new Map<string, { dirty: boolean }>();

describe("createRunGit with the real gitops", () => {
  it("begin then edit then finish reports the changes against the checkpoint", async () => {
    const g = runGit();
    const begun = await g.begin(repo, "r1");
    expect(begun.checkpoint).toMatchObject({ type: "checkpoint", requestId: "r1", dirty: false });
    expect(begun.checkpointId).toEqual(expect.any(String));
    expect(begun.checkpoint).toHaveProperty("ref", `refs/omnichat/checkpoints/${begun.checkpointId}`);

    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    fs.writeFileSync(path.join(repo, "b.txt"), "new\n");
    const frame: ChangesFrame = await g.finish(repo, begun.checkpointId!, "r1");

    expect(frame).toMatchObject({ type: "changes", requestId: "r1", truncated: false });
    const byPath = Object.fromEntries(frame.changes.map((c) => [c.path, c]));
    expect(byPath["a.txt"]).toMatchObject({ status: "modified", additions: 1, deletions: 1 });
    expect(byPath["a.txt"]!.patch).toContain("+two");
    expect(byPath["b.txt"]).toMatchObject({ status: "added", additions: 1 });
  });

  it("a non-git cwd yields an unavailable checkpoint and an empty changes frame via the hooks", async () => {
    const plain = path.join(dir, "plain");
    fs.mkdirSync(plain);
    const g = runGit();
    const begun = await g.begin(plain, "r2");
    expect(begun.checkpoint).toEqual({ type: "checkpoint", requestId: "r2", unavailable: gitops.NOT_GIT });
    expect(begun.checkpointId).toBeNull();

    const hooks = createRunHooks(g);
    const pre = await hooks.beforeRun({ runId: "r2", cwd: plain });
    expect(pre).toEqual([{ type: "checkpoint", requestId: "r2", unavailable: gitops.NOT_GIT }]);
    const post = await hooks.afterRun({ runId: "r2" });
    expect(post.frames).toEqual([{ type: "changes", requestId: "r2", changes: [], truncated: false }]);
    expect(post.warning).toBe(gitops.NOT_GIT);
  });

  it("hooks: changes for a git run, with no warning", async () => {
    const hooks = createRunHooks(runGit());
    const [cp] = await hooks.beforeRun({ runId: "r3", cwd: repo });
    expect((cp as CheckpointFrame).type).toBe("checkpoint");
    fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
    const post = await hooks.afterRun({ runId: "r3" });
    expect(post.warning).toBeUndefined();
    expect((post.frames[0] as ChangesFrame).changes.map((c) => c.path)).toEqual(["a.txt"]);
  });

  it("rewind restores tracked files and removes files created after the checkpoint", async () => {
    const g = runGit();
    const begun = await g.begin(repo, "r4");
    const ref = (begun.checkpoint as Extract<CheckpointFrame, { ref: string }>).ref;

    fs.writeFileSync(path.join(repo, "a.txt"), "edited\n");
    fs.writeFileSync(path.join(repo, "c.txt"), "created later\n");

    const res = await g.rewind(repo, ref, { removeNew: true, openDocuments: noDocs });
    expect(res).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("one\n");
    expect(fs.existsSync(path.join(repo, "c.txt"))).toBe(false);
  });

  it("rewind refuses when an open buffer under the repo is dirty, and changes nothing", async () => {
    const g = runGit();
    const begun = await g.begin(repo, "r5");
    const ref = (begun.checkpoint as Extract<CheckpointFrame, { ref: string }>).ref;
    fs.writeFileSync(path.join(repo, "a.txt"), "edited\n");

    const docs = new Map([[path.join(repo, "a.txt"), { dirty: true }]]);
    const res = await g.rewind(repo, ref, { removeNew: false, openDocuments: docs });
    expect(res).toEqual({ ok: false, error: "dirty_editors" });
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("edited\n");
  });

  it("rewind on a non-git cwd reports not a git repository", async () => {
    const plain = path.join(dir, "plain2");
    fs.mkdirSync(plain);
    const res = await runGit().rewind(plain, "refs/omnichat/checkpoints/x", { removeNew: false, openDocuments: noDocs });
    expect(res).toEqual({ ok: false, error: gitops.NOT_GIT });
  });
});
