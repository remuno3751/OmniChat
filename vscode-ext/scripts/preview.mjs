#!/usr/bin/env node
// Dev-only preview harness. Renders the webviews in headless Chromium with a mocked VS Code API
// and writes PNG screenshots. Usage: node scripts/preview.mjs <outDir>
// Not part of the build or the vsix. Never change html.ts from here: the CSP is only passed in.
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MEDIA = join(ROOT, "media");
const CWD = "/home/user/OmniChat_Dev/vscode-ext";
const outDir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: node scripts/preview.mjs <outDir>");

/** Bundles html.ts and the view models to one temp ESM file; loads it. */
async function loadLib(tmp) {
  const file = join(tmp, "lib.mjs");
  const src = [
    `export * as html from ${JSON.stringify(join(ROOT, "src/ui/html.ts"))};`,
    `export * as approval from ${JSON.stringify(join(ROOT, "src/ui/approvalModel.ts"))};`,
    `export * as activity from ${JSON.stringify(join(ROOT, "src/ui/activityModel.ts"))};`,
  ].join("\n");
  await build({
    stdin: { contents: src, resolveDir: ROOT, loader: "ts", sourcefile: "preview-entry.ts" },
    bundle: true, format: "esm", platform: "node", target: "es2022", outfile: file, logLevel: "silent",
  });
  return import(pathToFileURL(file).href);
}

/** Finds the Chromium binary under PLAYWRIGHT_BROWSERS_PATH (no `playwright install`). */
function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  const dirs = readdirSync(base).filter((d) => /^chromium/.test(d)).sort().reverse();
  for (const dir of dirs) {
    for (const rel of ["chrome-linux/chrome", "chrome-linux/headless_shell"]) {
      const exe = join(base, dir, rel);
      if (existsSync(exe) && statSync(exe).isFile()) return exe;
    }
  }
  throw new Error(`no Chromium under ${base}`);
}

// Body markup mirrors the panel hosts (src/ui/activityPanel.ts, src/ui/panels.ts approval html).
const ACTIVITY_BODY = [
  '<main class="oc-page">',
  '<header class="oc-header"><span class="oc-plate"><span class="oc-mark"></span>OmniChat</span>',
  '<span id="oc-cwd" class="oc-activity__cwd"></span></header>',
  '<section id="oc-body" class="oc-msgs" role="region" aria-live="polite">',
  '<section id="oc-empty" class="oc-msg oc-corners">',
  '<p id="oc-empty-text" class="oc-activity__empty"></p>',
  '<p class="oc-tips"><span class="oc-tips__label">TIPS:</span><span id="oc-tips" class="oc-tips__text"></span></p>',
  "</section>",
  '<section id="oc-run" class="oc-msg oc-msg--assistant oc-corners oc-activity__run" hidden>',
  '<div class="oc-activity__head">',
  '<div class="oc-activity__phase"><span id="oc-track" class="oc-track"></span>',
  '<span id="oc-count" class="oc-track__count"></span></div>',
  '<span id="oc-phase" class="oc-activity__phase-name"></span>',
  '<span id="oc-await" class="oc-chip oc-chip--wait" hidden></span>',
  "</div>",
  '<ol id="oc-steps" class="oc-activity__steps"></ol>',
  "</section></section></main>",
].join("");
const APPROVAL_BODY = [
  '<main class="oc-page">',
  '<header class="oc-header"><span class="oc-plate"><span class="oc-mark"></span>OmniChat</span></header>',
  '<div id="oc-queue" class="oc-msgs" role="region" aria-live="polite">',
  '<p id="oc-empty" class="oc-approval__reason">承認待ちはありません</p>',
  "</div></main>",
].join("");

const fileUrl = (...parts) => pathToFileURL(join(MEDIA, ...parts)).href;

/** Full document for one page. The body class sets the light/dark mode for theme-runtime.js. */
function pageHtml(lib, { page, theme, mode, title, decorations = "auto" }) {
  const isActivity = page === "activity";
  const html = lib.html.buildWebviewHtml({
    title,
    nonce: "preview0nonce",
    cspSource: "file:", // preview only: `*` does not match file: URLs in Chromium
    theme,
    decorations,
    scriptUri: fileUrl("webview", isActivity ? "activity.js" : "approval.js"),
    styleUris: isActivity
      ? [fileUrl("webview", "base.css"), fileUrl("webview", "activity.css"), fileUrl("generated", "tokens.css")]
      : [fileUrl("webview", "base.css"), fileUrl("generated", "tokens.css")],
    body: isActivity ? ACTIVITY_BODY : APPROVAL_BODY,
    fontUri: (name) => fileUrl("fonts", name),
  });
  const runtime = `<script nonce="preview0nonce" src="${fileUrl("webview", "theme-runtime.js")}"></script>`;
  return html
    .replace("<body ", `<body class="vscode-${mode}" `)
    .replace("</main>", `</main>${runtime}`);
}

/** Activity states built with the real reducer, plus one step set forced to `pending`. */
function activityStates(lib) {
  const { reduce } = lib.activity;
  const apply = (state, ...events) => events.reduce((s, e) => reduce(s, e), state);
  const start = { type: "runStart", runId: "run-42", cwd: CWD, mode: "agent" };
  const midRun = apply(null, start,
    { type: "toolCall", callId: "c1", tool: "read_file", args: { path: "src/ui/activityModel.ts" } },
    { type: "toolResult", callId: "c1", ok: true, summary: "", durationMs: 42 },
    { type: "toolCall", callId: "c2", tool: "grep", args: { pattern: "awaitingApproval", path: "src/ui" } },
    { type: "toolResult", callId: "c2", ok: true, summary: "3 matches", durationMs: 118 },
    { type: "toolCall", callId: "c3", tool: "edit_file", args: { path: "src/ui/activityPanel.ts" } },
    { type: "toolResult", callId: "c3", ok: true, summary: "", durationMs: 35 },
    { type: "toolCall", callId: "c4", tool: "run_command", args: { command: "npm test" } },
    { type: "toolCall", callId: "c5", tool: "git_status", args: {} },
  );
  midRun.steps[4] = { ...midRun.steps[4], status: "pending" };
  const errorRun = apply(null, { ...start, runId: "run-43" },
    { type: "toolCall", callId: "e1", tool: "read_file", args: { path: "package.json" } },
    { type: "toolResult", callId: "e1", ok: true, summary: "", durationMs: 9 },
    { type: "toolCall", callId: "e2", tool: "run_command",
      args: { command: 'curl -H "Authorization: Bearer abc123secret" https://api.example.com/v1/sync' } },
    { type: "toolResult", callId: "e2", ok: false, durationMs: 860,
      summary: "HTTP 401 Unauthorized --token=ghp_exampleSecret123" },
    { type: "toolCall", callId: "e3", tool: "run_command", args: { command: "npm publish --token=npm_secret999" } },
    { type: "toolResult", callId: "e3", ok: false, summary: "ENEEDAUTH", durationMs: 412 },
    { type: "runDone", ok: false, error: "tool failed" },
  );
  return { midRun, errorRun };
}

/** Approval frames: a normal edit with a diff, and a protected force push. */
function approvalFrames(lib) {
  const writeView = lib.approval.buildApprovalView({
    type: "approval", requestId: "r-1", approvalId: "ap-write", callId: "c9", tool: "edit_file",
    path: "src/ui/activityModel.ts", reason: "write inside workspace", protected: false,
    before: "export const MAX_STEPS = 200;\nexport const LABEL_MAX_CHARS = 80;\n",
    after: "export const MAX_STEPS = 200;\nexport const LABEL_MAX_CHARS = 96;\nexport const NOTE_MAX_CHARS = 120;\n",
  });
  const protectedView = lib.approval.buildApprovalView({
    type: "approval", requestId: "r-2", approvalId: "ap-push", callId: "c10", tool: "run_command",
    path: CWD, reason: "protected branch: main", command: "git push --force origin main",
    protectedReasons: ["force push to protected branch main"],
  });
  return { writeView, protectedView };
}

/** Each scenario: viewport, the themes it runs under, and the messages sent after load. */
function scenarios(lib) {
  const { midRun, errorRun } = activityStates(lib);
  const { writeView, protectedView } = approvalFrames(lib);
  const FRONTIER = ["frontier-dark", "frontier-light"];
  const ALL = ["frontier-dark", "frontier-light", "simple-dark", "astral-dark"];
  const activity = (state) => [{ type: "state", state }];
  return [
    { name: "activity", page: "activity", size: [720, 640], themes: ALL, title: "OmniChat: 活動", msgs: activity(midRun) },
    { name: "activity-narrow", page: "activity", size: [380, 640], themes: FRONTIER, title: "OmniChat: 活動", msgs: activity(midRun) },
    { name: "activity-error", page: "activity", size: [720, 640], themes: FRONTIER, title: "OmniChat: 活動", msgs: activity(errorRun) },
    { name: "activity-empty", page: "activity", size: [720, 640], themes: FRONTIER, title: "OmniChat: 活動", msgs: activity(null) },
    { name: "approval-write", page: "approval", size: [720, 520], themes: FRONTIER, title: "OmniChat: 承認",
      msgs: [{ type: "sync", views: [writeView] }] },
    { name: "approval-protected", page: "approval", size: [720, 520], themes: ALL, title: "OmniChat: 承認",
      msgs: [{ type: "sync", views: [protectedView] }] },
  ];
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "oc-preview-"));
  const lib = await loadLib(tmp);
  const browser = await chromium.launch({
    executablePath: findChromium(),
    headless: true,
    args: ["--no-sandbox", "--allow-file-access-from-files"], // file:// fonts and CSS for preview only
  });
  const written = [];
  const problems = [];
  try {
    for (const sc of scenarios(lib)) {
      for (const themeId of sc.themes) {
        const [theme, mode] = themeId.split("-");
        const file = `${themeId}-${sc.name}.png`;
        const htmlPath = join(tmp, `${themeId}-${sc.name}.html`);
        writeFileSync(htmlPath, pageHtml(lib, { page: sc.page, theme, mode, title: sc.title }));
        const context = await browser.newContext({
          viewport: { width: sc.size[0], height: sc.size[1] },
          reducedMotion: "reduce", // the one-shot enter animation would otherwise be mid-flight
        });
        await context.addInitScript(() => {
          window.acquireVsCodeApi = () => ({
            postMessage: (m) => { (window.__ocPosted = window.__ocPosted || []).push(m); },
            getState: () => undefined,
            setState: () => {},
          });
        });
        const page = await context.newPage();
        page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") problems.push(`${file}: ${m.text()}`); });
        page.on("pageerror", (e) => problems.push(`${file}: ${e.message}`));
        await page.goto(pathToFileURL(htmlPath).href);
        for (const msg of sc.msgs) await page.evaluate((m) => window.postMessage(m, "*"), msg);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(150);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) problems.push(`${file}: horizontal overflow ${overflow}px`);
        const out = join(outDir, file);
        await page.screenshot({ path: out });
        written.push(out);
        await context.close();
      }
    }
  } finally {
    await browser.close();
    rmSync(tmp, { recursive: true, force: true });
  }
  for (const f of written) console.log(`${statSync(f).size.toString().padStart(8)} B  ${f}`);
  for (const p of problems) console.warn(`[preview] ${p}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
