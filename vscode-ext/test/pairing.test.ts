import { describe, expect, it } from "vitest";
import { normalizeServerUrl, parsePairing, toWsUrl } from "../src/pairing";

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const good = { s: "https://omnichat.example.com", t: "tok_abc123", n: "my-pc" };
const goodCode = encode(good);
const goodUri = (code: string) => `vscode://omnichat.omnichat-vscode/pair?code=${code}`;
const expected = { serverUrl: "https://omnichat.example.com", token: "tok_abc123", name: "my-pc" };

describe("parsePairing: codes", () => {
  it("parses a valid base64url code", () => {
    expect(parsePairing(goodCode)).toEqual(expected);
  });

  it("trims surrounding whitespace around the code", () => {
    expect(parsePairing(`  ${goodCode}\n`)).toEqual(expected);
  });

  it("trims the device name and keeps a path prefix on the server", () => {
    const code = encode({ s: "https://host.example/omni/", t: "t1", n: "  laptop  " });
    expect(parsePairing(code)).toEqual({ serverUrl: "https://host.example/omni", token: "t1", name: "laptop" });
  });

  it("accepts padded base64url", () => {
    const padded = Buffer.from(JSON.stringify(good)).toString("base64url") + "==";
    expect(parsePairing(padded)).toEqual(expected);
  });
});

describe("parsePairing: vscode:// URI", () => {
  it("parses the pairing URI", () => {
    expect(parsePairing(goodUri(goodCode))).toEqual(expected);
  });

  it("parses a percent-encoded code in the query", () => {
    const encodedCode = encodeURIComponent(goodCode);
    expect(parsePairing(goodUri(encodedCode))).toEqual(expected);
  });

  it("rejects a URI with the wrong scheme, host, path or missing code", () => {
    expect(parsePairing(`https://omnichat.omnichat-vscode/pair?code=${goodCode}`)).toBeNull();
    expect(parsePairing(`vscode://other.extension/pair?code=${goodCode}`)).toBeNull();
    expect(parsePairing(`vscode://omnichat.omnichat-vscode/open?code=${goodCode}`)).toBeNull();
    expect(parsePairing("vscode://omnichat.omnichat-vscode/pair")).toBeNull();
    expect(parsePairing("vscode://omnichat.omnichat-vscode/pair?code=")).toBeNull();
  });

  it("rejects a URI whose code is not a valid pairing code", () => {
    expect(parsePairing(goodUri("not-a-code!"))).toBeNull();
  });
});

describe("parsePairing: garbage", () => {
  it.each([
    ["empty string", ""],
    ["whitespace only", "   \n\t"],
    ["non-base64 characters", "!!!***"],
    ["base64 with an inner space", `${goodCode.slice(0, 5)} ${goodCode.slice(5)}`],
    ["standard base64 with +", "ab+cd"],
    ["plain text", "hello world"],
    ["invalid JSON", Buffer.from("{not json").toString("base64url")],
    ["JSON array", encode([good])],
    ["JSON null", encode(null)],
    ["JSON number", encode(42)],
    ["JSON string", encode("https://x.example")],
  ])("returns null for %s", (_label, input) => {
    expect(parsePairing(input)).toBeNull();
  });

  it("never throws, even for non-string input", () => {
    expect(() => parsePairing(undefined as unknown as string)).not.toThrow();
    expect(parsePairing(undefined as unknown as string)).toBeNull();
    expect(parsePairing(null as unknown as string)).toBeNull();
    expect(parsePairing(123 as unknown as string)).toBeNull();
  });
});

describe("parsePairing: wrong shapes", () => {
  it.each([
    ["missing s", { t: "t1", n: "pc" }],
    ["missing t", { s: "https://x.example", n: "pc" }],
    ["missing n", { s: "https://x.example", t: "t1" }],
    ["s is a number", { s: 1, t: "t1", n: "pc" }],
    ["t is an object", { s: "https://x.example", t: { a: 1 }, n: "pc" }],
    ["n is an array", { s: "https://x.example", t: "t1", n: ["pc"] }],
    ["empty token", { s: "https://x.example", t: "", n: "pc" }],
    ["token with a space", { s: "https://x.example", t: "a b", n: "pc" }],
    ["token with a newline", { s: "https://x.example", t: "a\nb", n: "pc" }],
    ["token too long", { s: "https://x.example", t: "a".repeat(513), n: "pc" }],
    ["empty name", { s: "https://x.example", t: "t1", n: "   " }],
    ["name too long", { s: "https://x.example", t: "t1", n: "n".repeat(65) }],
    ["name with a control character", { s: "https://x.example", t: "t1", n: "pc\u0007" }],
  ])("rejects %s", (_label, body) => {
    expect(parsePairing(encode(body))).toBeNull();
  });

  it("accepts a name of exactly 64 characters", () => {
    expect(parsePairing(encode({ ...good, n: "n".repeat(64) }))?.name).toHaveLength(64);
  });
});

describe("parsePairing: bad server URLs", () => {
  it.each([
    ["ftp scheme", "ftp://x.example"],
    ["javascript scheme", "javascript:alert(1)"],
    ["plain http to a public host", "http://omnichat.example.com"],
    ["credentials in the URL", "https://user:pass@x.example"],
    ["no host", "https://"],
    ["not a URL", "not a url"],
    ["empty", ""],
  ])("rejects %s", (_label, s) => {
    expect(parsePairing(encode({ s, t: "t1", n: "pc" }))).toBeNull();
  });

  it("allows http for loopback hosts", () => {
    expect(parsePairing(encode({ s: "http://localhost:8080", t: "t1", n: "pc" }))?.serverUrl).toBe(
      "http://localhost:8080",
    );
    expect(parsePairing(encode({ s: "http://127.0.0.1:8080", t: "t1", n: "pc" }))).not.toBeNull();
  });
});

describe("parsePairing: size limits", () => {
  it("rejects a huge input without processing it", () => {
    expect(parsePairing("A".repeat(1_000_000))).toBeNull();
    expect(parsePairing("vscode://omnichat.omnichat-vscode/pair?code=" + "A".repeat(1_000_000))).toBeNull();
  });

  it("rejects a valid-looking code over the input cap", () => {
    const longName = encode({ s: "https://x.example", t: "t1", n: "n".repeat(64) });
    const padded = longName + "A".repeat(9000 - longName.length);
    expect(parsePairing(padded)).toBeNull();
  });

  it("rejects a server URL over the length cap", () => {
    const s = "https://x.example/" + "a".repeat(2100);
    expect(parsePairing(encode({ s, t: "t1", n: "pc" }))).toBeNull();
  });
});

describe("normalizeServerUrl / toWsUrl", () => {
  it("normalizes to origin plus path without a trailing slash", () => {
    expect(normalizeServerUrl("https://x.example/")).toBe("https://x.example");
    expect(normalizeServerUrl("https://x.example/a/b/?q=1#f")).toBe("https://x.example/a/b");
  });

  it("maps https to wss and loopback http to ws", () => {
    expect(toWsUrl("https://x.example")).toBe("wss://x.example");
    expect(toWsUrl("http://localhost:8080/omni")).toBe("ws://localhost:8080/omni");
  });

  it("returns null for invalid URLs", () => {
    expect(toWsUrl("ftp://x.example")).toBeNull();
    expect(toWsUrl("http://x.example")).toBeNull(); // public host needs https
    expect(toWsUrl("")).toBeNull();
    expect(normalizeServerUrl(42)).toBeNull();
  });
});
