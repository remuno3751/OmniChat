import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, type Ctx } from "./test-chat-util.js";
import { api } from "./test-server.js";

// Stills pets (pets.ts): one image per state, stored in pet_stills / pet_stills_meta. Sprite pets are covered in v4.test.ts.

let c: Ctx;
let tok2 = "";

function pngHeader(w: number, h: number, pad = 0): Buffer {
  const b = Buffer.alloc(64 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function webpX(w: number, h: number): Buffer {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(32, 4); b.write("WEBP", 8, "latin1"); b.write("VP8X", 12, "latin1"); b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
}
const png = (w = 64, h = 64, pad = 0) => ({ mime: "image/png", dataBase64: pngHeader(w, h, pad).toString("base64") });
const webp = (w = 64, h = 64) => ({ mime: "image/webp", dataBase64: webpX(w, h).toString("base64") });
const stills = (id: string, images: unknown, extra: Record<string, unknown> = {}) =>
  ({ id, displayName: "Cat Pet", description: "a cat", images, ...extra });

const post = (b: unknown, tok?: string) => c.call("POST", "/pets/stills", b, tok);
const list = async (tok?: string) => ((await c.call("GET", "/pets", undefined, tok)).json.pets) as any[];
async function raw(path: string, tok = c.token): Promise<{ status: number; type: string | null; body: Buffer }> {
  const r = await fetch(`${c.s.base}${path}`, { headers: { authorization: `Bearer ${tok}` } });
  return { status: r.status, type: r.headers.get("content-type"), body: Buffer.from(await r.arrayBuffer()) };
}

before(async () => {
  c = await setup({ ALLOW_REGISTRATION: "1" });
  tok2 = (await api(c.s.base, "POST", "/auth/register", { username: "stills-second", password: "password123" })).json.token;
});
after(() => c?.stop());

test("stills: create, list, get image, replace, delete", async () => {
  const idle = png(64, 64);
  const thinking = webp(128, 96);
  const r = await post(stills("cat", { idle, thinking }));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.kind, "stills");
  assert.equal(r.json.id, "cat");
  assert.equal(r.json.spriteVersionNumber, 2);
  assert.equal(r.json.mime, "image/png");
  assert.deepEqual(r.json.states, ["idle", "thinking"]);

  const item = (await list()).find((p) => p.id === "cat");
  assert.ok(item, "listed");
  assert.equal(item.kind, "stills");
  assert.equal(item.name, "Cat Pet");
  assert.equal(item.description, "a cat");
  assert.equal(item.spriteVersionNumber, 2);
  assert.equal(item.mime, "image/png", "mime of idle");
  assert.deepEqual(item.states, ["idle", "thinking"]);
  assert.equal(item.size, pngHeader(64, 64).length + webpX(128, 96).length);
  assert.ok(!("sheetBase64" in item) && !("data" in item));

  const i = await raw("/pets/cat/image/idle");
  assert.equal(i.status, 200);
  assert.equal(i.type, "image/png");
  assert.deepEqual(i.body, pngHeader(64, 64));
  const t = await raw("/pets/cat/image/thinking");
  assert.equal(t.type, "image/webp");
  assert.deepEqual(t.body, webpX(128, 96));
  assert.equal((await raw("/pets/cat/image/done")).status, 404, "missing state is 404");
  assert.equal((await raw("/pets/cat/image/blink")).status, 404, "unknown state is 404");
  assert.equal((await raw("/pets/cat/sheet")).status, 404, "stills pet has no sheet");

  // same id replaces the whole pet
  const r2 = await post(stills("cat", { idle: png(32, 32) }, { displayName: "Cat 2" }));
  assert.equal(r2.status, 200);
  const again = (await list()).filter((p) => p.id === "cat");
  assert.equal(again.length, 1);
  assert.equal(again[0].name, "Cat 2");
  assert.deepEqual(again[0].states, ["idle"]);
  assert.equal((await raw("/pets/cat/image/thinking")).status, 404, "old state removed on replace");

  const d = await c.call("DELETE", "/pets/cat");
  assert.equal(d.status, 200);
  assert.equal((await list()).some((p) => p.id === "cat"), false);
  assert.equal((await raw("/pets/cat/image/idle")).status, 404);
  assert.equal((await c.call("DELETE", "/pets/cat")).status, 404);
});

test("stills: validation errors", async () => {
  const cases: [string, unknown][] = [
    ["bad id", stills("bad id!", { idle: png() })],
    ["missing displayName", { id: "v1", images: { idle: png() } }],
    ["images not object", stills("v2", [png()])],
    ["missing idle", stills("v3", { thinking: png() })],
    ["bad state name", stills("v4", { idle: png(), blink: png() })],
    ["bad mime gif", stills("v5", { idle: { mime: "image/gif", dataBase64: png().dataBase64 } })],
    ["mime does not match bytes", stills("v6", { idle: { mime: "image/webp", dataBase64: png().dataBase64 } })],
    ["not an image", stills("v7", { idle: { mime: "image/png", dataBase64: Buffer.alloc(100).toString("base64") } })],
    ["empty data", stills("v8", { idle: { mime: "image/png", dataBase64: "" } })],
    ["too small (8px)", stills("v9", { idle: png(8, 8) })],
    ["too large (2000px)", stills("v10", { idle: png(2000, 16) })],
    ["over 600 KiB", stills("v11", { idle: png(64, 64, 700 * 1024) })],
    ["over 3 MiB total", stills("v12", { idle: png(64, 64, 550 * 1024), thinking: png(64, 64, 550 * 1024), working: png(64, 64, 550 * 1024), tool: png(64, 64, 550 * 1024), done: png(64, 64, 550 * 1024), error: png(64, 64, 550 * 1024) })]
  ];
  for (const [name, body] of cases) {
    const r = await post(body);
    assert.equal(r.status, 400, `${name}: ${r.text}`);
  }
  assert.equal((await raw("/pets/v11/image/idle")).status, 404, "rejected pet not stored");
  assert.equal((await list()).some((p) => String(p.id).startsWith("v")), false);
  assert.equal((await post(stills("nokey", { idle: png() }))).status, 200, "a valid pet still works afterwards");
  await c.call("DELETE", "/pets/nokey");
});

test("stills: auth and per-user isolation", async () => {
  const anon = await fetch(`${c.s.base}/pets/stills`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(anon.status, 401);
  assert.equal((await raw("/pets", "")).status, 401);

  assert.equal((await post(stills("iso", { idle: png() }))).status, 200);
  assert.equal((await post(stills("iso", { idle: webp() }), tok2)).status, 200, "other user may use the same id");
  assert.equal((await list(tok2)).filter((p) => p.id === "iso").length, 1);
  assert.equal((await list()).find((p) => p.id === "iso").mime, "image/png", "other user did not overwrite");

  assert.equal((await raw("/pets/iso/image/idle", tok2)).type, "image/webp");
  assert.equal((await raw("/pets/iso/image/idle")).type, "image/png");
  assert.equal((await c.call("DELETE", "/pets/iso", undefined, tok2)).status, 200);
  assert.equal((await list(tok2)).some((p) => p.id === "iso"), false);
  assert.equal((await list()).some((p) => p.id === "iso"), true, "owner's pet untouched");
  assert.equal((await raw("/pets/iso/image/idle", tok2)).status, 404);
  assert.equal((await c.call("DELETE", "/pets/iso")).status, 200);
});

test("stills: pets count toward the 50-pet limit together with sprite pets", async () => {
  const sheet = pngHeader(1536, 2288).toString("base64");
  for (let i = 0; i < 20; i++) {
    const r = await c.call("POST", "/pets", { manifest: { id: `sp${i}`, displayName: "S", description: "", spriteVersionNumber: 2, spritesheetPath: "s.png" }, sheetBase64: sheet, mime: "image/png" });
    assert.equal(r.status, 200, r.text);
  }
  for (let i = 0; i < 30; i++) assert.equal((await post(stills(`st${i}`, { idle: png() }))).status, 200);
  assert.equal((await list()).length, 50);

  assert.equal((await post(stills("st-over", { idle: png() }))).status, 400, "51st pet rejected (stills)");
  const sprite = await c.call("POST", "/pets", { manifest: { id: "sp-over", displayName: "S", description: "", spriteVersionNumber: 2, spritesheetPath: "s.png" }, sheetBase64: sheet, mime: "image/png" });
  assert.equal(sprite.status, 400, "51st pet rejected (sprite)");
  assert.equal((await post(stills("st3", { idle: webp() }))).status, 200, "replacing an existing pet is allowed at the limit");

  // cleanup
  for (let i = 0; i < 30; i++) await c.call("DELETE", `/pets/st${i}`);
  for (let i = 0; i < 20; i++) await c.call("DELETE", `/pets/sp${i}`);
  assert.equal((await list()).length, 0);
});

test("sprite pets still work next to stills pets", async () => {
  const sheet = pngHeader(1536, 2288);
  const r = await c.call("POST", "/pets", { manifest: { id: "mint", displayName: "Mint", description: "m", spriteVersionNumber: 2, spritesheetPath: "s.png" }, sheetBase64: sheet.toString("base64"), mime: "image/png" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.kind, "sprite");
  assert.equal(assertPet(await list(), "mint").kind, "sprite");
  assert.equal(assertPet(await list(), "mint").states, undefined);
  assert.equal(assertPet(await list(), "mint").spriteVersionNumber, 2);

  assert.equal((await post(stills("cat2", { idle: png() }))).status, 200);
  const sheetRes = await raw("/pets/mint/sheet");
  assert.equal(sheetRes.status, 200);
  assert.deepEqual(sheetRes.body, sheet);
  assert.equal((await raw("/pets/mint/image/idle")).status, 404, "sprite pet has no state images");

  // a stills upload with the id of a sprite pet replaces it: one pet per id
  assert.equal((await post(stills("mint", { idle: webp() }))).status, 200);
  const mints = (await list()).filter((p) => p.id === "mint");
  assert.equal(mints.length, 1);
  assert.equal(mints[0].kind, "stills");
  assert.equal((await raw("/pets/mint/sheet")).status, 404);

  // and a sprite upload with the id of a stills pet replaces that
  const r2 = await c.call("POST", "/pets", { manifest: { id: "cat2", displayName: "Sprite cat", description: "", spriteVersionNumber: 1, spritesheetPath: "s.png" }, sheetBase64: pngHeader(1536, 1872).toString("base64"), mime: "image/png" });
  assert.equal(r2.status, 200, r2.text);
  const cats = (await list()).filter((p) => p.id === "cat2");
  assert.equal(cats.length, 1);
  assert.equal(cats[0].kind, "sprite");
  assert.equal((await raw("/pets/cat2/image/idle")).status, 404);

  for (const id of ["mint", "cat2"]) assert.equal((await c.call("DELETE", `/pets/${id}`)).status, 200);
});

function assertPet(pets: any[], id: string): any {
  const p = pets.find((x) => x.id === id);
  assert.ok(p, `pet ${id} listed`);
  return p;
}
