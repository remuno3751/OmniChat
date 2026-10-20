// Fails when a build artifact still contains this machine's identity: the account name in a path, the host name,
// or one of the machine's own IP addresses (build paths in Rust panics / native libs, the LAN address React Native writes
// into resources.arsc). Nothing personal is hard-coded: the values come from the machine that runs the build.
//   node packaging/local/scan-leaks.mjs <file>...
// Files are scanned as raw bytes (ASCII and UTF-16). Compressed entries inside an APK/ZIP are not searched; stored ones
// (native libraries, resources.arsc) are, which is where such strings end up.
import fs from "node:fs";
import os from "node:os";

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const user = os.userInfo().username;
const needles = [];
if (user && user.length >= 3) needles.push({ name: `account name "${user}" in a path`, re: new RegExp(`[\\\\/]${esc(user)}([\\\\/]|$)`, "i") });
const host = os.hostname();
if (host && host.length >= 4) needles.push({ name: `host name "${host}"`, re: new RegExp(esc(host), "i") });
for (const list of Object.values(os.networkInterfaces())) {
  for (const a of list ?? []) {
    if (a.family !== "IPv4" || a.internal) continue;
    needles.push({ name: `local address ${a.address}`, re: new RegExp(`(^|[^0-9.])${esc(a.address)}($|[^0-9])`) });
  }
}

let bad = 0;
for (const f of process.argv.slice(2)) {
  const b = fs.readFileSync(f);
  const views = [b.toString("latin1"), b.toString("utf16le")];
  const hits = new Set();
  for (const n of needles) for (const v of views) if (n.re.test(v)) hits.add(n.name);
  if (hits.size) { bad++; console.error(`LEAK ${f}: ${[...hits].join("; ")}`); }
  else console.log(`clean ${f}`);
}
if (bad) {
  console.error(`${bad} artifact(s) contain machine-specific data: fix the build (path remapping), do not upload`);
  process.exit(1);
}
