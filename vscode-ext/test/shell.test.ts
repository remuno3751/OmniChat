import { describe, expect, it } from "vitest";
import {
  MAX_COMMAND_LENGTH,
  ShellParseError,
  hasExpansion,
  isAssignment,
  isRedirectOp,
  parseShell,
  pathArgs,
  splitCommands,
  unwrap,
} from "../src/guard/shell";

const SPLIT_CASES: [string, string[][]][] = [
  ["ls", [["ls"]]],
  ["ls -la /tmp", [["ls", "-la", "/tmp"]]],
  ["echo hi; rm -rf ~", [["echo", "hi"], ["rm", "-rf", "~"]]],
  ["a && b || c", [["a"], ["b"], ["c"]]],
  ["a | b |& c", [["a"], ["b"], ["c"]]],
  ["a & b", [["a"], ["b"]]],
  ["a\nb", [["a"], ["b"]]],
  ["a;;b", [["a"], ["b"]]],
  ["", []],
  ["   ;  ;  ", []],
  ["a;", [["a"]]],
  ["a\\\nb", [["ab"]]],
  ['rm -rf "/"', [["rm", "-rf", "/"]]],
  ["r\\m -rf /", [["rm", "-rf", "/"]]],
  ['r""m -rf /', [["rm", "-rf", "/"]]],
  ['echo "a;b"', [["echo", "a;b"]]],
  ["echo 'a && b | c'", [["echo", "a && b | c"]]],
  ['echo "it\'s"', [["echo", "it's"]]],
  ["echo 'a\"b'", [["echo", 'a"b']]],
  [String.raw`echo "a\"b"`, [["echo", 'a"b']]],
  ["echo a\\;b", [["echo", "a;b"]]],
  ['echo ""', [["echo", ""]]],
  ["echo ''''", [["echo", ""]]],
  [String.raw`echo "\\"`, [["echo", "\\"]]],
  [String.raw`echo "a\nb"`, [["echo", "a\\nb"]]],
  ["echo a\\ b", [["echo", "a b"]]],
  ["echo ab\"cd\"'ef'", [["echo", "abcdef"]]],
  ["echo 'x' \"y\" z", [["echo", "x", "y", "z"]]],
  ["$'\\x72m' -rf /", [["rm", "-rf", "/"]]],
  ["$'\\162m' -rf /", [["rm", "-rf", "/"]]],
  ['$"rm" -rf /', [["rm", "-rf", "/"]]],
  ["$(echo rm) -rf /", [["echo", "rm"], ["$(echo rm)", "-rf", "/"]]],
  ["echo `whoami`", [["whoami"], ["echo", "`whoami`"]]],
  ['echo "$(rm -rf /)"', [["rm", "-rf", "/"], ["echo", "$(rm -rf /)"]]],
  ["echo '$(rm -rf /)'", [["echo", "$(rm -rf /)"]]],
  ["x=$(ls; rm -f a)", [["ls"], ["rm", "-f", "a"], ["x=$(ls; rm -f a)"]]],
  ["cat <(rm -rf /)", [["rm", "-rf", "/"], ["cat", "<(rm -rf /)"]]],
  ["cmd >(rm -rf /)", [["rm", "-rf", "/"], ["cmd", ">(rm -rf /)"]]],
  ["(rm -rf /)", [["rm", "-rf", "/"]]],
  ["echo $((1+2))", [["1+2"], ["echo", "$((1+2))"]]],
  ["echo hi > /etc/x", [["echo", "hi", ">", "/etc/x"]]],
  ["echo hi >> out.txt", [["echo", "hi", ">>", "out.txt"]]],
  ["cmd 2> err.log", [["cmd", "2>", "err.log"]]],
  ["cmd 2>&1", [["cmd", "2>&", "1"]]],
  ["cat <<< 'a;b'", [["cat", "<<<", "a;b"]]],
  ["cmd &> all.log", [["cmd", "&>", "all.log"]]],
  ["cat < in.txt", [["cat", "<", "in.txt"]]],
  ["cat <<EOF", [["cat", "<<", "EOF"]]],
  ["echo ünï; rm -rf /ü", [["echo", "ünï"], ["rm", "-rf", "/ü"]]],
  ['echo "🙂 ; rm"', [["echo", "🙂 ; rm"]]],
  ["echo #comment; rm -rf /", [["echo"]]],
  ["echo a#b", [["echo", "a#b"]]],
  ["if true; then rm -rf /; fi", [["if", "true"], ["then", "rm", "-rf", "/"], ["fi"]]],
  ["{ rm -rf /; }", [["{", "rm", "-rf", "/"], ["}"]]],
  ["FOO=bar rm -rf /", [["FOO=bar", "rm", "-rf", "/"]]],
  ["rm -rf ./*", [["rm", "-rf", "./*"]]],
  ["a".repeat(MAX_COMMAND_LENGTH), [["a".repeat(MAX_COMMAND_LENGTH)]]],
  ["\\".repeat(4000), [["\\".repeat(2000)]]],
  [";".repeat(4000), []],
  ["a ".repeat(3000), [Array(3000).fill("a")]],
];

const ERROR_CASES: [string, string][] = [
  ['echo "unterminated', "unterminated double quote"],
  ["echo 'open", "unterminated single quote"],
  ["echo $(ls", "unterminated"],
  ["echo `ls", "unterminated"],
  ["echo ) x", "unexpected )"],
  ["(rm -rf /", "unterminated"],
  ["a \\", "trailing backslash"],
  ["echo $'abc", "unterminated"],
  ["echo a >", "redirect without target"],
  ["echo > ; ls", "redirect without target"],
  ["echo 2>", "redirect without target"],
  ["x".repeat(MAX_COMMAND_LENGTH + 1), "longer than"],
  ["$(".repeat(100) + ")".repeat(100), "nesting"],
];

const UNWRAP_CASES: [string[], string[][]][] = [
  [["echo", "hi"], [["echo", "hi"]]],
  [[], []],
  [["sudo"], [["sudo"]]],
  [["sudo", "rm", "-rf", "/"], [["sudo", "rm", "-rf", "/"], ["rm", "-rf", "/"]]],
  [["sudo", "-u", "root", "rm", "x"], [["sudo", "-u", "root", "rm", "x"], ["rm", "x"]]],
  [["sudo", "--", "rm", "x"], [["sudo", "--", "rm", "x"], ["rm", "x"]]],
  [["/usr/bin/sudo", "rm"], [["/usr/bin/sudo", "rm"], ["rm"]]],
  [["env", "A=1", "B=2", "rm", "-rf", "x"], [["env", "A=1", "B=2", "rm", "-rf", "x"], ["rm", "-rf", "x"]]],
  [["A=1", "rm", "x"], [["rm", "x"]]],
  [["timeout", "5", "rm", "-rf", "/"], [["timeout", "5", "rm", "-rf", "/"], ["rm", "-rf", "/"]]],
  [["command", "rm", "x"], [["command", "rm", "x"], ["rm", "x"]]],
  [["xargs", "-0", "rm"], [["xargs", "-0", "rm"], ["rm"]]],
  [["xargs", "-n", "1", "rm", "x"], [["xargs", "-n", "1", "rm", "x"], ["rm", "x"]]],
  [["nohup", "time", "-p", "xargs", "-I", "{}", "rm", "{}"], [
    ["nohup", "time", "-p", "xargs", "-I", "{}", "rm", "{}"],
    ["time", "-p", "xargs", "-I", "{}", "rm", "{}"],
    ["xargs", "-I", "{}", "rm", "{}"],
    ["rm", "{}"],
  ]],
  [["!", "rm", "x"], [["!", "rm", "x"], ["rm", "x"]]],
  [["then", "rm", "-rf", "/"], [["then", "rm", "-rf", "/"], ["rm", "-rf", "/"]]],
  [[">", "f", "rm", "-rf", "/"], [["rm", "-rf", "/"]]],
  [["sudo", "env", "X=1", "nice", "-n", "5", "rm", "y"], [
    ["sudo", "env", "X=1", "nice", "-n", "5", "rm", "y"],
    ["env", "X=1", "nice", "-n", "5", "rm", "y"],
    ["nice", "-n", "5", "rm", "y"],
    ["rm", "y"],
  ]],
];

const PATH_CASES: [string[], string[]][] = [
  [["rm", "-rf", "/"], ["/"]],
  [["ls", "-la"], []],
  [["rm", "-rf", "~"], ["~"]],
  [["cp", "../secret", "x"], ["../secret"]],
  [["tool", "--out=/etc/x"], ["/etc/x"]],
  [["tool", "--name=foo"], []],
  [["echo", "hi", ">", "/etc/x"], ["/etc/x"]],
  [["cmd", "2>", "err.log"], ["err.log"]],
  [["cmd", "2>&", "1"], []],
  [["x", ">", "/a", "2>&", "1"], ["/a"]],
  [["dir", "C:\\Windows"], ["C:\\Windows"]],
  [["cp", "\\\\server\\share\\f", "d"], ["\\\\server\\share\\f"]],
  [["cat", ".env"], [".env"]],
  [["x", "a/b"], ["a/b"]],
  [["echo", "plain"], []],
  [["rm", "-rf", "$HOME"], ["$HOME"]],
  [["cmd", "--path=~/x"], ["~/x"]],
];

describe("splitCommands: separators, quotes and substitutions", () => {
  it.each(SPLIT_CASES)("splits %j", (input, expected) => {
    expect(splitCommands(input)).toEqual(expected);
  });
});

describe("parseShell: malformed or oversized input fails closed", () => {
  it.each(ERROR_CASES)("rejects %j", (input, fragment) => {
    const r = parseShell(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(fragment);
  });

  it("returns ok:false for input over the length cap", () => {
    expect(parseShell("a".repeat(MAX_COMMAND_LENGTH + 1)).ok).toBe(false);
    expect(parseShell("a".repeat(MAX_COMMAND_LENGTH)).ok).toBe(true);
  });

  it("splitCommands throws ShellParseError on failure", () => {
    expect(() => splitCommands('"x')).toThrow(ShellParseError);
  });

  it("returns ok:true with commands on success", () => {
    expect(parseShell("ls")).toEqual({ ok: true, commands: [["ls"]] });
  });
});

describe("unwrap: wrapped commands are exposed", () => {
  it.each(UNWRAP_CASES)("unwrap(%j)", (argv, expected) => {
    expect(unwrap(argv)).toEqual(expected);
  });
});

describe("pathArgs", () => {
  it.each(PATH_CASES)("pathArgs(%j)", (argv, expected) => {
    expect(pathArgs(argv)).toEqual(expected);
  });
});

describe("token helpers", () => {
  it.each([">", ">>", ">|", "2>", "2>&", "&>", "&>>", "<", "<<", "<<<", "<<-", "<>"])(
    "isRedirectOp(%j) is true",
    (tok) => expect(isRedirectOp(tok)).toBe(true),
  );
  it.each(["rm", "-rf", "/", "a>b", "=x", "2x>"])("isRedirectOp(%j) is false", (tok) => {
    expect(isRedirectOp(tok)).toBe(false);
  });
  it.each(["A=1", "_x=", "PATH+=/bin"])("isAssignment(%j)", (tok) => expect(isAssignment(tok)).toBe(true));
  it.each(["1A=2", "--x=1", "/a=b", "rm"])("isAssignment(%j) is false", (tok) => {
    expect(isAssignment(tok)).toBe(false);
  });
  it.each(["r?", "*", "$x", "$(id)", "{/,}", "~", "a`b`", "[ab]"])("hasExpansion(%j)", (w) => {
    expect(hasExpansion(w)).toBe(true);
  });
  it.each(["rm", "-rf", "/tmp/x", "a.b"])("hasExpansion(%j) is false", (w) => {
    expect(hasExpansion(w)).toBe(false);
  });
});

describe("adversarial inputs terminate quickly", () => {
  it("handles long quote runs without backtracking", () => {
    const input = "'\"".repeat(2000) + '"' + "'".repeat(1);
    expect(() => parseShell(input)).not.toThrow();
    expect(parseShell('"'.repeat(3000)).ok).toBe(true);
  });

  it("handles many nested-looking but unterminated substitutions", () => {
    expect(parseShell("$(a ".repeat(1500)).ok).toBe(false);
  });
});
