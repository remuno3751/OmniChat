/**
 * Glob pattern to RegExp for the glob tool (spec docs/design/VSCODE-BRIDGE.md §3).
 * Pure string logic, no host or fs access.
 */

/**
 * Converts a glob to an anchored RegExp over `/`-separated relative paths.
 * `**` crosses directories, `*` and `?` do not, `{a,b}` alternates (no nesting),
 * `[...]` is a character class (`[!...]` negates).
 */
function toRegExpSource(p: string): string {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as string;
    if (c === "*") {
      if (p[i + 1] === "*") {
        if (p[i + 2] === "/") {
          out += "(?:[^/]*/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "{" && p.indexOf("}", i) > i) {
      const close = p.indexOf("}", i);
      const options = p.slice(i + 1, close).split(",").map(toRegExpSource);
      out += `(?:${options.join("|")})`;
      i = close;
    } else if (c === "[" && p.indexOf("]", i + 1) > i + 1) {
      const close = p.indexOf("]", i + 1);
      const body = p.slice(i + 1, close);
      out += body.startsWith("!") ? `[^${body.slice(1)}]` : `[${body}]`;
      i = close;
    } else {
      out += c.replace(/[.+^$()|\\\]{}[]/g, "\\$&");
    }
  }
  return out;
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  return new RegExp(`^${toRegExpSource(normalized)}$`);
}
