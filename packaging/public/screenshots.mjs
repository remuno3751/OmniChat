// Takes the README screenshots with a headless Chrome/Edge against a LOCAL demo server (never a real one):
//   node packaging/public/screenshots.mjs <outDir> <serverUrl> <token-json> [--chrome <path>]
// The demo server needs a demo account with one finished chat; <token-json> is that account's stored login
// (the value of localStorage["omnichat.auth"]). Uses the `ws` package from server/node_modules.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../server/package.json", import.meta.url));
const WebSocket = require("ws");

const [outDir, serverUrl, authJson] = process.argv.slice(2);
const chromeArg = process.argv.indexOf("--chrome");
const chrome = chromeArg > 0 ? process.argv[chromeArg + 1] : "C:/Program Files/Google/Chrome/Application/chrome.exe";
if (!outDir || !serverUrl || !authJson) { console.error("usage: screenshots.mjs <outDir> <serverUrl> <auth-json>"); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "oc-shot-"));
const proc = spawn(chrome, ["--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${profile}`, "--hide-scrollbars", "--no-first-run", "--lang=ja", "about:blank"], { stdio: "ignore" });

async function targetWs() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:9333/json")).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error("chrome did not start");
}

const ws = new WebSocket(await targetWs());
await new Promise((r) => ws.on("open", r));
let id = 0;
const pending = new Map();
ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

async function open(device, w, h, scale, mobile = false) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: scale, mobile });
  const url = `${serverUrl}/shotprep.html?auth=${encodeURIComponent(authJson)}&device=${encodeURIComponent(JSON.stringify(device))}`;
  await send("Page.navigate", { url });
  await sleep(5000);
}
/** Clicks the smallest element whose text equals `text` (or whose aria-label does). */
async function clickText(text) {
  const pos = await ev(`(() => {
    const t = ${JSON.stringify(text)};
    const all = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 ? (e.textContent || '').trim() === t : false);
    const byLabel = [...document.querySelectorAll('[aria-label]')].filter((e) => e.getAttribute('aria-label') === t);
    const el = all[0] || byLabel[0];
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!pos) throw new Error("not found: " + text);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  await sleep(1200);
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(outDir, name), Buffer.from(r.data, "base64"));
  console.log("saved", name);
}

try {
  // desktop, light, chat with a finished reply
  await open({ language: "ja", theme: "light" }, 1440, 900, 1);
  await clickText("How do I run OmniChat on my home server?");
  await sleep(1500);
  await shot("chat-light.png");

  // desktop, dark
  await open({ language: "ja", theme: "dark" }, 1440, 900, 1);
  await clickText("How do I run OmniChat on my home server?");
  await sleep(1500);
  await shot("chat-dark.png");

  // settings: models (context overflow slider)
  await open({ language: "ja", theme: "light" }, 1440, 900, 1);
  await clickText("設定");
  await clickText("モデル");
  await sleep(3000);
  await ev("(() => { const e = [...document.querySelectorAll('*')].find((x) => x.children.length === 0 && (x.textContent || '').includes('コンテキストがいっぱいになったとき')); if (e) e.scrollIntoView({ block: 'center' }); })()");
  await sleep(500);
  await shot("settings-models.png");

  // settings: appearance (themes)
  await clickText("外観");
  await sleep(800);
  await shot("settings-appearance.png");

  // phone, light
  await open({ language: "ja", theme: "light" }, 390, 844, 2, true);
  await sleep(1000);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: 26, y: 26, button: "left", clickCount: 1 });
  await sleep(1000);
  await shot("mobile-list.png");
  await clickText("How do I run OmniChat on my home server?");
  await sleep(1500);
  await shot("mobile-chat.png");
} finally {
  ws.close();
  proc.kill();
}
