// Stamp the release version (from a git tag like v1.2.3 or v1.2.3-rc.1) into the desktop app.
// MSI/WiX only takes numeric pre-release parts, so a suffix like -beta.7 becomes -7 here;
// the CI renames output files to include the full tag.
//   node desktop/tools/set-version.mjs v1.2.3 [desktop|server-app]   (second argument: which Tauri app, default desktop)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raw = (process.argv[2] || '').replace(/^v/, '');
const m = /^(\d+)\.(\d+)\.(\d+)/.exec(raw);
if (!m) { console.error('usage: set-version.mjs vX.Y.Z[-pre]'); process.exit(1); }
// a pre-release keeps its number as a numeric suffix (v1.2.3-beta.7 -> 1.2.3-7: WiX accepts numeric pre-release parts),
// so every beta/rc gets a distinct version and the installers upgrade in place instead of seeing the "same version"
const pre = /^\d+\.\d+\.\d+-.*?(\d+)$/.exec(raw);
const v = `${m[1]}.${m[2]}.${m[3]}` + (pre && Number(pre[1]) <= 65535 ? `-${Number(pre[1])}` : '');
const target = process.argv[3] || 'desktop';
if (!['desktop', 'server-app'].includes(target)) { console.error('unknown target ' + target); process.exit(1); }
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', target, 'src-tauri');

const confPath = join(dir, 'tauri.conf.json');
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
conf.version = v;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');

const cargoPath = join(dir, 'Cargo.toml');
writeFileSync(cargoPath, readFileSync(cargoPath, 'utf8').replace(/^version = ".*"$/m, `version = "${v}"`));
console.log(target + ' version ->', v);
