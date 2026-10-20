// npm run plugin:check -- <dir> [--no-run]
// Validates a plugin folder before install. Exit 1 on failure; tool run problems are warnings only.
// --no-run skips calling the tools (they may have side effects).
import { checkPlugin, formatReport } from "./plugin-lib.mts";

const args = process.argv.slice(2);
const runTools = !args.includes("--no-run");
const dirs = args.filter((a) => !a.startsWith("--"));
const unknown = args.filter((a) => a.startsWith("--") && a !== "--no-run");

if (unknown.length || dirs.length !== 1) {
  console.error("usage: npm run plugin:check -- <dir> [--no-run]");
  process.exit(1);
}

const result = await checkPlugin(dirs[0], { runTools });
console.log(formatReport(result));
process.exit(result.errors.length ? 1 : 0);
