import { describe, expect, it } from "vitest";
import { checkPairing, checkServerUrl, isPrivateHost, parsePairing, toWsUrl } from "../src/pairing";
import { stringsFor } from "../src/ui/strings";

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const goodUri = (code: string) => `vscode://omnichat.omnichat-vscode/pair?code=${code}`;

describe("plain http on private addresses", () => {
  it.each([
    "http://192.168.1.10:8787",
    "http://10.1.2.3:8787",
    "http://172.16.0.5:8787",
    "http://172.31.255.1:8787",
    "http://169.254.10.10:8787",
    "http://100.64.0.1:8787",
    "http://100.101.102.103:8787",
    "http://100.127.255.255:8787",
    "http://[::1]:8787",
    "http://[fd12:3456::1]:8787",
    "http://[fe80::1]:8787",
    "http://my-pc.local:8787",
    "http://nas.lan:8787",
    "http://box.home.arpa:8787",
    "http://pc.tail1234.ts.net:8787",
    "http://svc.internal:8787",
    "http://my-pc:8787",
  ])("accepts %s", (s) => {
    expect(parsePairing(encode({ s, t: "t1", n: "pc" }))?.serverUrl).toBe(s);
  });

  it.each([
    "http://8.8.8.8:8787",
    "http://172.32.0.1:8787",
    "http://172.15.0.1:8787",
    "http://100.128.0.1:8787",
    "http://100.63.0.1:8787",
    "http://192.169.0.1:8787",
    "http://[2001:db8::1]:8787",
    "http://omnichat.example.com",
    "http://evil.local.example.com",
  ])("rejects public %s with http_public", (s) => {
    expect(checkPairing(encode({ s, t: "t1", n: "pc" }))).toEqual({ ok: false, reason: "http_public" });
  });

  it("still rejects credentials in the URL", () => {
    expect(checkServerUrl("http://u:p@192.168.0.1:8787")).toEqual({ ok: false, reason: "server_url" });
    expect(checkServerUrl("https://u:p@x.example")).toEqual({ ok: false, reason: "server_url" });
  });

  it("classifies hosts", () => {
    expect(isPrivateHost("192.168.1.1")).toBe(true);
    expect(isPrivateHost("example.com")).toBe(false);
  });

  it("maps http servers to ws:// and https to wss://", () => {
    expect(toWsUrl("http://192.168.1.10:8787")).toBe("ws://192.168.1.10:8787");
    expect(toWsUrl("http://100.101.102.103:8787/")).toBe("ws://100.101.102.103:8787");
    expect(toWsUrl("http://pc.tail1234.ts.net:8787")).toBe("ws://pc.tail1234.ts.net:8787");
    expect(toWsUrl("https://pc.tail1234.ts.net")).toBe("wss://pc.tail1234.ts.net");
    expect(toWsUrl("http://example.com")).toBeNull();
  });
});

describe("checkPairing: reasons", () => {
  const reason = (input: string): string => {
    const r = checkPairing(input);
    return r.ok ? "ok" : r.reason;
  };
  it("reports why a code was rejected", () => {
    expect(reason("")).toBe("empty");
    expect(reason("  \n ")).toBe("empty");
    expect(reason("A".repeat(9000))).toBe("too_long");
    expect(reason("hello world")).toBe("format");
    expect(reason(Buffer.from("{nope").toString("base64url"))).toBe("decode");
    expect(reason(encode([1]))).toBe("shape");
    expect(reason(encode({ s: "ftp://x", t: "t", n: "pc" }))).toBe("server_url");
    expect(reason(encode({ s: "http://example.com", t: "t", n: "pc" }))).toBe("http_public");
    expect(reason(encode({ s: "https://x.example", t: "a b", n: "pc" }))).toBe("credential");
    expect(reason(encode({ s: "https://x.example", t: "t", n: " " }))).toBe("device_name");
    expect(reason("vscode://other.extension/pair?code=abc")).toBe("uri");
    expect(reason("vscode://omnichat.omnichat-vscode/pair")).toBe("uri");
  });

  it("has a JA and EN message for every reason", () => {
    for (const lang of ["ja", "en"] as const) {
      const messages = stringsFor(lang).pairReasons;
      for (const key of ["empty", "too_long", "uri", "format", "decode", "shape", "server_url", "http_public", "credential", "device_name"]) {
        expect(messages[key as keyof typeof messages], `${lang}.${key}`).toBeTruthy();
      }
    }
  });
});

describe("checkPairing: forgiving paste", () => {
  const lan = { s: "http://192.168.1.10:8787", t: "tok_abc123", n: "VS Code (PC)" };
  const lanCode = encode(lan);
  const want = { serverUrl: "http://192.168.1.10:8787", token: "tok_abc123", name: "VS Code (PC)" };

  it.each([
    ["plain", lanCode],
    ["newlines and spaces", `  \r\n${lanCode}\n  `],
    ["zero-width characters", `​${lanCode.slice(0, 10)}‍${lanCode.slice(10)}﻿`],
    ["double quotes", `"${lanCode}"`],
    ["single quotes", `'${lanCode}'`],
    ["curly quotes", `“${lanCode}”`],
    ["backticks", "`" + lanCode + "`"],
    ["a wrapped line break inside", `${lanCode.slice(0, 20)}\n${lanCode.slice(20)}`],
    ["the full vscode link", goodUri(lanCode)],
    ["the full link in quotes", `"${goodUri(lanCode)}"\n`],
    ["a vscode-insiders link", goodUri(lanCode).replace("vscode:", "vscode-insiders:")],
  ])("accepts %s", (_label, input) => {
    expect(parsePairing(input)).toEqual(want);
  });
});
