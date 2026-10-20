// npm run plugin:new -- <id> [--dir <outDir>]
// Creates <outDir or ./>/<id>/ with plugin.json, index.mjs and README.md. Refuses to overwrite an existing folder.
import { resolve } from "node:path";
import { scaffoldPlugin } from "./plugin-lib.mts";

const args = process.argv.slice(2);
let id: string | undefined;
let outDir = ".";
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--dir") {
    const v = args[++i];
    if (!v) { console.error("--dir needs a path"); process.exit(1); }
    outDir = v;
  } else if (a.startsWith("--")) {
    console.error(`unknown option ${a}\nusage: npm run plugin:new -- <id> [--dir <outDir>]`);
    process.exit(1);
  } else if (id === undefined) {
    id = a;
  } else {
    console.error(`unexpected argument ${a}\nusage: npm run plugin:new -- <id> [--dir <outDir>]`);
    process.exit(1);
  }
}

if (!id) {
  console.error("usage: npm run plugin:new -- <id> [--dir <outDir>]\n  id: [a-z0-9][a-z0-9_-]{0,39}");
  process.exit(1);
}

try {
  const dir = await scaffoldPlugin(id, resolve(outDir));
  console.log(`created ${dir}`);
  console.log(`  plugin.json, index.mjs, README.md`);
  console.log(`next: npm run plugin:check -- "${dir}"`);
} catch (e: any) {
  console.error(`plugin:new failed: ${String(e?.message ?? e)}`);
  process.exit(1);
}
