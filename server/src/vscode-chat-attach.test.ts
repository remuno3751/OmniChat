// Attachments of a vscode-bridge prompt (vscode-chat-attach.ts) and images of a Code turn (buildWire with a real model).
// One server for the database and files; modules that touch the database are imported after DATA_DIR / DB_PATH are set.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { startServer, api, type TestServer } from "./test-server.js";
import { AttachmentTypeError } from "./attachments-types.js";

const PW = "password123";
const MB = 1024 * 1024;

let s: TestServer;
let userId = "";
let prep: any; // ./vscode-chat-attach.js
let att: any; // ./attachments.js
let chatAtt: any; // ./attachments-chat.js

const b64 = (buf: Buffer) => buf.toString("base64");
const txt = (name: string, text = "hello code attachment") => ({ name, mime: "text/plain", data: b64(Buffer.from(text, "utf8")) });
const png = () => ({ name: "shot.png", mime: "image/png", data: b64(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)])) });
const wav = () => ({ name: "voice.wav", mime: "audio/wav", data: b64(Buffer.concat([Buffer.from("RIFF"), Buffer.from([36, 0, 0, 0]), Buffer.from("WAVEfmt "), Buffer.alloc(40, 1)])) });
const readyRows = (): any[] => att.attachmentsOfUser(userId).filter((r: any) => r.status === "ready");
const VIS_YES = async () => "yes" as const;
const VIS_NO = async () => "no" as const;
const MODEL = "prov-1::vision-model";

before(async () => {
  s = await startServer({ OMNICHAT_OPEN_FIRST_REGISTRATION: "1", ALLOW_REGISTRATION: "1" });
  const r = await api(s.base, "POST", "/auth/register", { username: "coder", password: PW, deviceName: "t", platform: "test" });
  assert.ok(r.json?.token, "registration failed");
  process.env.DATA_DIR = s.tmp;
  process.env.DB_PATH = `${s.tmp}/t.db`;
  const dbm = await import("./db.js");
  userId = (dbm.db.prepare("SELECT id FROM users WHERE username = ?").get("coder") as { id: string }).id;
  att = await import("./attachments.js");
  chatAtt = await import("./attachments-chat.js");
  prep = await import("./vscode-chat-attach.js");
});
after(() => { s?.stop(); });

test("a. absent or empty attachments are ok with no ids", async () => {
  assert.deepEqual(await prep.prepareAttachments(userId, MODEL, undefined, { vision: VIS_NO }), { ok: true, ids: [] });
  assert.deepEqual(await prep.prepareAttachments(userId, MODEL, null, { vision: VIS_NO }), { ok: true, ids: [] });
  assert.deepEqual(await prep.prepareAttachments(userId, MODEL, [], { vision: VIS_NO }), { ok: true, ids: [] });
});

test("b. shape and count: not an array, more than 4 files, bad items, bad base64 are attachment_invalid", async () => {
  const deps = { vision: VIS_YES };
  for (const raw of ["x", { name: "a" }, [null], ["str"], [{ name: "a.txt", mime: "text/plain" }], [{ ...txt("a.txt"), name: 5 }]]) {
    const r = await prep.prepareAttachments(userId, MODEL, raw, deps);
    assert.equal(r.ok, false, JSON.stringify(raw).slice(0, 60));
    assert.equal(r.error, "attachment_invalid");
  }
  const five = [txt("1.txt"), txt("2.txt"), txt("3.txt"), txt("4.txt"), txt("5.txt")];
  assert.equal((await prep.prepareAttachments(userId, MODEL, five, deps)).error, "attachment_invalid");
  assert.equal((await prep.prepareAttachments(userId, MODEL, [{ name: "a.txt", mime: "text/plain", data: "abc" }], deps)).error, "attachment_invalid");
  assert.equal((await prep.prepareAttachments(userId, MODEL, [{ name: "a.txt", mime: "text/plain", data: "ab$d" }], deps)).error, "attachment_invalid");
  assert.equal(readyRows().length, 0, "nothing stored");
});

test("c. size limits: one file over 4 MiB or files over 5 MiB together are attachment_too_large", async () => {
  const deps = { vision: VIS_YES };
  const big = { name: "big.txt", mime: "text/plain", data: b64(Buffer.alloc(4 * MB + 1, 0x61)) };
  assert.equal((await prep.prepareAttachments(userId, MODEL, [big], deps)).error, "attachment_too_large");
  const exact = { name: "ok.txt", mime: "text/plain", data: b64(Buffer.alloc(4 * MB, 0x61)) };
  assert.equal((await prep.prepareAttachments(userId, MODEL, [exact], deps)).ok, true, "exactly 4 MiB is fine");
  const two = [
    { name: "a.txt", mime: "text/plain", data: b64(Buffer.alloc(3 * MB, 0x61)) },
    { name: "b.txt", mime: "text/plain", data: b64(Buffer.alloc(3 * MB, 0x62)) },
  ];
  const r = await prep.prepareAttachments(userId, MODEL, two, deps);
  assert.equal(r.error, "attachment_too_large");
  assert.equal(readyRows().filter((x: any) => x.size === 4 * MB).length, 1, "only the 4 MiB file from above is stored");
});

test("d. a document is stored and its id returned, whatever the vision", async () => {
  const r = await prep.prepareAttachments(userId, MODEL, [txt("notes.txt", "line one")], { vision: VIS_NO });
  assert.equal(r.ok, true);
  assert.equal(r.ids.length, 1);
  const rec = att.getAttachmentRow(r.ids[0]);
  assert.equal(rec.kind, "document");
  assert.equal(rec.name, "notes.txt");
});

test("e. an image is refused without vision (nothing stored); with vision yes it is stored", async () => {
  const before = readyRows().length;
  const no = await prep.prepareAttachments(userId, MODEL, [txt("a.txt"), png()], { vision: VIS_NO });
  assert.deepEqual(no.ok, false);
  assert.equal(no.error, "attachment_not_supported");
  assert.equal(readyRows().length, before, "a refused prompt stores nothing, not even its documents");
  let asked = "";
  const yes = await prep.prepareAttachments(userId, MODEL, [png()], { vision: async (u: string, m: string) => { asked = `${u}|${m}`; return "yes"; } });
  assert.equal(yes.ok, true);
  assert.equal(asked, `${userId}|${MODEL}`, "the real model ref is checked");
  assert.equal(att.getAttachmentRow(yes.ids[0]).kind, "image");
  const unknown = await prep.prepareAttachments(userId, MODEL, [png()], { vision: async () => "unknown" as const });
  assert.equal(unknown.error, "attachment_not_supported", "unknown counts as no");
});

test("f. audio is refused (attachment_not_supported) and nothing is stored", async () => {
  const before = readyRows().length;
  const r = await prep.prepareAttachments(userId, MODEL, [txt("ok.txt"), wav()], { vision: VIS_YES });
  assert.equal(r.error, "attachment_not_supported");
  assert.equal(readyRows().length, before);
});

test("g. a file whose content does not match its name is attachment_invalid", async () => {
  const r = await prep.prepareAttachments(userId, MODEL, [{ name: "fake.png", mime: "image/png", data: b64(Buffer.from("just text")) }], { vision: VIS_YES });
  assert.equal(r.ok, false);
  assert.equal(r.error, "attachment_invalid");
  const exe = await prep.prepareAttachments(userId, MODEL, [{ name: "tool.exe", mime: "application/octet-stream", data: b64(Buffer.from("MZ....")) }], { vision: VIS_YES });
  assert.equal(exe.error, "attachment_invalid");
});

test("h. cleanup: when a later file fails to store, the earlier ones are deleted again", async () => {
  const stored: any[] = [];
  const real = att.storeUpload;
  const deps = {
    vision: VIS_YES,
    store: async (u: string, n: string, buf: Buffer) => {
      if (stored.length === 1) throw new AttachmentTypeError(507, "attachment_quota_exceeded", "the storage quota is full");
      const r = await real(u, n, buf);
      stored.push(r.rec);
      return r;
    },
  };
  const before = readyRows().length;
  const r = await prep.prepareAttachments(userId, MODEL, [txt("first.txt", "first"), txt("second.txt", "second")], deps);
  assert.equal(r.ok, false);
  assert.equal(r.error, "attachment_invalid");
  assert.equal(stored.length, 1, "the first file was stored before the failure");
  assert.equal(readyRows().length, before, "no ready row is left");
  const rec = att.getAttachmentRow(stored[0].id);
  assert.equal(rec.status, "deleted");
  assert.equal(existsSync(att.filePathOf(rec)), false, "its bytes are gone");
});

test("i. a store that throws the too-large code is reported as attachment_too_large", async () => {
  const r = await prep.prepareAttachments(userId, MODEL, [txt("x.txt")], {
    vision: VIS_YES,
    store: async () => { throw new AttachmentTypeError(413, "attachment_too_large", "the file is larger than the limit"); },
  });
  assert.equal(r.error, "attachment_too_large");
});

test("j. buildWire: a vscode-bridge turn sends its image as an image part only when the real model reads images", async () => {
  const r = await prep.prepareAttachments(userId, MODEL, [png()], { vision: VIS_YES });
  const rec = att.getAttachmentRow(r.ids[0]);
  const items = [{ id: "m1", role: "user", content: "what is this?" }];
  const yes = await chatAtt.buildWire(items, () => [rec], VIS_YES, "vscode-bridge", "openai-compatible");
  const w = yes.get("m1");
  assert.equal(w.images, 1);
  assert.equal(w.parts[1].type, "image_url");
  assert.match(w.parts[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(w.content, "what is this?");

  const noVision = await chatAtt.buildWire(items, () => [rec], VIS_NO, "vscode-bridge", "openai-compatible");
  assert.equal(noVision.get("m1").images, 0);
  assert.equal(noVision.get("m1").parts, undefined);

  const otherKind = await chatAtt.buildWire(items, () => [rec], VIS_YES, "vscode-bridge", "anthropic");
  assert.equal(otherKind.get("m1").images, 0, "only openai-compatible models get image bytes");

  const dsh = await chatAtt.buildWire(items, () => [rec], VIS_YES, "dsh-bridge");
  assert.equal(dsh.get("m1").images, 0, "dsh-bridge stays document-only");
});

test("k. visionOfModelRef: an unusable ref is unknown", async () => {
  assert.equal(await chatAtt.visionOfModelRef(userId, "no-separator"), "unknown");
  assert.equal(await chatAtt.visionOfModelRef(userId, "missing-provider::m"), "unknown");
  assert.equal(await chatAtt.visionOfModelRef(userId, null), "unknown");
});
