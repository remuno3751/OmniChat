import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsLimiter, LIST_MAX_ENTRIES, PREVIEW_MAX_BYTES, isDenied, listDir, readFile, resolveSafe } from "./fsread.js";

// Same cases as dsh-plugin/test/fsread.test.js (the plugin copy of this module).

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-fsread-"));
  const ws = path.join(root, "ws");
  const outside = path.join(root, "outside");
  const w = (rel: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), data);
  };
  w("index.html", "<!doctype html><p>hi</p>");
  w("style.css", "body{color:red}");
  w("app.js", "console.log(1)");
  w("data.json", "{\"a\":1}");
  w("notes.md", "# notes");
  w("sub/inner.txt", "inner");
  w("sub/deep/x.md", "deep");
  w("sub/.hidden-in-sub.txt", "h");
  w(".hidden.txt", "h");
  w(".env", "TOKEN=1");
  w(".git/config", "[core]");
  w("node_modules/pkg/index.js", "x");
  w("key.pem", "pem");
  w("my-secret.txt", "s");
  w("credentials.json", "{}");
  w("id_rsa.txt", "k");
  w("prog.exe", "MZ");
  w("run.sh", "#!/bin/sh");
  w("store.db", "SQLite");
  const bin = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  w("pixel.png", bin);
  w("big.txt", Buffer.alloc(PREVIEW_MAX_BYTES + 1, 0x61));
  for (let i = 0; i < LIST_MAX_ENTRIES + 5; i++) w(`many/a${String(i).padStart(4, "0")}.txt`, "m");
  fs.mkdirSync(path.join(outside, "dir"), { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE");
  fs.writeFileSync(path.join(outside, "dir", "y.txt"), "OUTSIDE-DIR");
  // Links: file and directory (symlink), and a junction on Windows. Skipped where the OS refuses.
  let links = true;
  try {
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "link-file.txt"), "file");
    fs.symlinkSync(path.join(outside, "dir"), path.join(ws, "link-dir"), "dir");
    fs.symlinkSync(path.join(ws, "sub", "inner.txt"), path.join(ws, "inside-link.txt"), "file");
    fs.symlinkSync(path.join(ws, ".env"), path.join(ws, "alias.txt"), "file");
  } catch {
    links = false;
  }
  let junction = false;
  try {
    fs.symlinkSync(path.join(outside, "dir"), path.join(ws, "junc-dir"), "junction");
    junction = true;
  } catch {
    junction = false;
  }
  return { root, ws, outside, links, junction };
}

const text = (b64: string) => Buffer.from(b64, "base64").toString("utf8");

test("list: visible entries only; hidden, denied and node_modules are not shown", () => {
  const f = fixture();
  const r = listDir(f.ws, "");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const names = r.entries.map((e) => e.name);
  for (const n of ["index.html", "style.css", "app.js", "pixel.png", "data.json", "sub", "big.txt", "prog.exe"]) assert.ok(names.includes(n), n);
  assert.equal(r.entries.find((e) => e.name === "sub")?.kind, "dir");
  assert.equal(r.entries.find((e) => e.name === "index.html")?.kind, "file");
  assert.equal(r.entries.find((e) => e.name === "index.html")?.size, Buffer.byteLength("<!doctype html><p>hi</p>"));
  for (const n of [".hidden.txt", ".env", ".git", "node_modules", "key.pem", "my-secret.txt", "credentials.json", "id_rsa.txt", "alias.txt"])
    assert.ok(!names.includes(n), `${n} must not be listed`);
  assert.ok(!names.includes("link-file.txt"), "link to outside must not be listed");
  assert.ok(!names.includes("link-dir"), "dir link to outside must not be listed");
  const sub = listDir(f.ws, "sub");
  assert.ok(sub.ok && sub.entries.map((e) => e.name).join() === "deep,inner.txt", "sub: hidden file left out");
});

test("read: html, css, js, json, md, txt come back as text with the right mime", () => {
  const f = fixture();
  const cases: Array<[string, string, string]> = [
    ["index.html", "text/html", "<!doctype html><p>hi</p>"],
    ["style.css", "text/css", "body{color:red}"],
    ["app.js", "text/javascript", "console.log(1)"],
    ["data.json", "application/json", "{\"a\":1}"],
    ["notes.md", "text/markdown", "# notes"],
    ["sub/inner.txt", "text/plain", "inner"],
    ["INDEX-not-there.html", "", ""],
  ];
  for (const [p, mime, body] of cases) {
    const r = readFile(f.ws, p);
    if (!mime) {
      assert.equal(r.ok, false);
      continue;
    }
    assert.equal(r.ok, true, `${p}: ${JSON.stringify(r)}`);
    if (!r.ok) continue;
    assert.equal(r.mime, mime);
    assert.equal(text(r.content), body);
    assert.equal(r.truncated, false);
  }
});

test("read: binary png is byte-exact (base64 round trip)", () => {
  const f = fixture();
  const r = readFile(f.ws, "pixel.png");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.mime, "image/png");
  assert.equal(r.size, 256);
  assert.deepEqual(Buffer.from(r.content, "base64"), Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
});

test("refuse: .., absolute, drive letter, UNC, \\\\?\\, NUL, empty segments", () => {
  const f = fixture();
  const bad = [
    "..", "../outside/secret.txt", "sub/../../outside/secret.txt", "a/../../x", "sub/..", "sub/../index.html",
    "/etc/passwd", "\\etc\\passwd", "C:\\Windows\\win.ini", "C:/Windows/win.ini", "c:win.ini",
    "\\\\server\\share\\x.txt", "//server/share/x.txt", "\\\\?\\C:\\Windows\\win.ini", "\\\\.\\C:\\x",
    "index.html\0", "sub\0/inner.txt", "sub//inner.txt", "index.html:stream", "CON.txt", "nul",
  ];
  for (const p of bad) {
    const r = readFile(f.ws, p);
    assert.equal(r.ok, false, `read must refuse ${JSON.stringify(p)}`);
    assert.equal(listDir(f.ws, p).ok, false, `list must refuse ${JSON.stringify(p)}`);
  }
  assert.equal(resolveSafe(f.ws, "../x").ok, false);
  assert.equal(resolveSafe(f.ws, 42).ok, false, "non-string path");
  assert.equal(readFile(f.ws, undefined).ok, false);
});

test("symlinks and junctions that lead outside are refused (skipped where the OS does not allow links)", (t) => {
  const f = fixture();
  if (!f.links && !f.junction) return t.skip("symlinks and junctions not permitted here");
  if (f.links) {
    assert.equal(readFile(f.ws, "link-file.txt").ok, false, "file link to outside");
    assert.equal(readFile(f.ws, "link-dir/y.txt").ok, false, "dir link to outside");
    assert.equal(listDir(f.ws, "link-dir").ok, false, "list through dir link");
    assert.equal(readFile(f.ws, "alias.txt").ok, false, "link to a denied file inside the folder");
    const inside = readFile(f.ws, "inside-link.txt");
    assert.equal(inside.ok, true, "a link that stays inside is fine");
    if (inside.ok) assert.equal(text(inside.content), "inner");
  }
  if (f.junction) {
    assert.equal(readFile(f.ws, "junc-dir/y.txt").ok, false, "junction to outside");
    assert.equal(listDir(f.ws, "junc-dir").ok, false, "list through junction");
  }
  const root = listDir(f.ws, "");
  assert.ok(root.ok && !root.entries.some((e) => e.name.startsWith("link-") || e.name.startsWith("junc-")));
});

test("hidden, secret, node_modules and .git paths are neither listed nor read", () => {
  const f = fixture();
  for (const p of [".hidden.txt", ".env", ".git/config", "node_modules/pkg/index.js", "node_modules", "key.pem", "my-secret.txt", "credentials.json", "id_rsa.txt", "sub/.hidden-in-sub.txt", ".git"]) {
    assert.equal(readFile(f.ws, p).ok, false, `read ${p}`);
    assert.equal(listDir(f.ws, p).ok, false, `list ${p}`);
  }
  assert.equal(isDenied(".env.local"), true);
  assert.equal(isDenied("server.key"), true);
  assert.equal(isDenied("cert.p12"), true);
  assert.equal(isDenied("cert.pfx"), true);
  assert.equal(isDenied("app.keystore"), true);
  assert.equal(isDenied("id_ed25519.pub"), true);
  assert.equal(isDenied("MySecretNotes.md"), true);
  assert.equal(isDenied("aws-credentials"), true);
  assert.equal(isDenied("index.html"), false);
  assert.equal(isDenied("keyboard.css"), false);
});

test("extensions outside the allow list are refused", () => {
  const f = fixture();
  for (const p of ["prog.exe", "run.sh", "store.db"]) {
    const r = readFile(f.ws, p);
    assert.deepEqual(r.ok, false);
    if (!r.ok) assert.equal(r.error, "file type not allowed", p);
  }
  assert.equal(readFile(f.ws, "index.html.exe").ok, false);
});

test("size: over 3 MB is the head with truncated true; maxBytes lowers the limit; the cap cannot be raised", () => {
  const f = fixture();
  const big = readFile(f.ws, "big.txt");
  assert.equal(big.ok, true);
  if (big.ok) {
    assert.equal(big.truncated, true);
    assert.equal(big.size, PREVIEW_MAX_BYTES + 1);
    assert.equal(Buffer.from(big.content, "base64").length, PREVIEW_MAX_BYTES);
  }
  const small = readFile(f.ws, "big.txt", 10);
  assert.ok(small.ok && small.truncated && Buffer.from(small.content, "base64").length === 10);
  const raised = readFile(f.ws, "big.txt", PREVIEW_MAX_BYTES * 10);
  assert.ok(raised.ok && Buffer.from(raised.content, "base64").length === PREVIEW_MAX_BYTES, "clamped to 3 MB");
  const idx = readFile(f.ws, "index.html", 4);
  assert.ok(idx.ok && idx.truncated && text(idx.content) === "<!do", "small file, smaller maxBytes");
  const bogus = readFile(f.ws, "index.html", "lots");
  assert.ok(bogus.ok && !bogus.truncated, "invalid maxBytes falls back to the default");
});

test("list: at most 2000 entries, with truncated true", () => {
  const f = fixture();
  const r = listDir(f.ws, "many");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.entries.length, LIST_MAX_ENTRIES);
    assert.equal(r.truncated, true);
    assert.equal(r.entries[0]?.name, "a0000.txt", "sorted by name");
  }
});

test("read a directory, a missing file, and list a file are errors", () => {
  const f = fixture();
  assert.deepEqual(readFile(f.ws, "sub"), { ok: false, error: "not a file" });
  assert.deepEqual(readFile(f.ws, ""), { ok: false, error: "not a file" });
  assert.equal(readFile(f.ws, "nope.html").ok, false);
  assert.equal(listDir(f.ws, "nope").ok, false);
  assert.deepEqual(listDir(f.ws, "index.html"), { ok: false, error: "not a directory" });
});

test("Windows: case is ignored for paths inside the folder", (t) => {
  if (process.platform !== "win32") return t.skip("Windows only");
  const f = fixture();
  assert.equal(readFile(f.ws, "INDEX.HTML").ok, true);
  assert.equal(readFile(f.ws, "Sub/Inner.TXT").ok, true);
  assert.equal(listDir(f.ws, "SUB").ok, true);
  const dir = listDir(f.ws, "LINK-DIR");
  assert.equal(dir.ok, false, "case-folded link to outside is still refused");
});

test("limiter: 20 per second, 4 at once", () => {
  let now = 0;
  const lim = new FsLimiter(() => now, 20, 4);
  const releases: Array<() => void> = [];
  for (let i = 0; i < 4; i++) {
    const rel = lim.admit();
    assert.ok(rel, `admit ${i}`);
    releases.push(rel!);
  }
  assert.equal(lim.admit(), null, "5th at once is refused");
  releases.pop()!();
  releases.forEach((r) => r());
  for (let i = 0; i < 16; i++) {
    const rel = lim.admit();
    assert.ok(rel, `per-second ${i}`);
    rel!();
  }
  assert.equal(lim.admit(), null, "21st within a second is refused");
  now = 1000;
  assert.ok(lim.admit(), "admitted again after a second");
});
