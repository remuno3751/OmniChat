import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import {
  assertPublicUrl,
  extractReadable,
  fetchImage,
  fetchPageText,
  isPrivateAddress,
  safeFetch,
  UnsafeUrlError,
} from "./pages.js";

const PAGE = `<!doctype html><html><head><title>Test &amp; Page</title>
<meta property="og:image" content="/img/hero.jpg"></head>
<body><nav><a href="/x">Menu item</a></nav>
<script>var secret = "SCRIPT_TEXT";</script><style>.x{color:red}</style>
<article><h1>Heading here</h1><p>First paragraph with <b>bold</b> words and an entity &eacute; &mdash; done.</p>
<p>Second paragraph that is long enough to matter.</p>
<img src="/img/photo.jpg" alt="A photo" width="640" height="480">
<img src="/img/site-logo.png"><img src="/img/tiny.gif" width="16" height="16"></article>
<footer>FOOTER_TEXT</footer></body></html>`;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);

function sjisPage(): Buffer {
  return Buffer.concat([
    Buffer.from('<!doctype html><html><head><meta charset="shift_jis"><title>sj</title></head><body><article><p>', "latin1"),
    Buffer.from([0x93, 0xfa, 0x96, 0x7b]), // 日本 in Shift_JIS
    Buffer.from(" text here padded</p></article></body></html>", "latin1"),
  ]);
}

function eucjpPage(): Buffer {
  return Buffer.concat([
    Buffer.from("<!doctype html><html><head><title>ej</title></head><body><p>", "latin1"),
    Buffer.from([0xc6, 0xfc, 0xcb, 0xdc]), // 日本 in EUC-JP
    Buffer.from("</p></body></html>", "latin1"),
  ]);
}

function route(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (status: number, type: string, body: Buffer | string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": type, ...headers });
    res.end(body);
  };
  switch (url.pathname) {
    case "/html":
      return send(200, "text/html; charset=utf-8", PAGE);
    case "/redirect":
      res.writeHead(302, { Location: "/html" }).end();
      return;
    case "/loop":
      res.writeHead(302, { Location: "/loop" }).end();
      return;
    case "/big":
      return send(200, "text/html", Buffer.alloc(2_000_000, 0x61));
    case "/slow": {
      const t = setTimeout(() => res.end("late"), 2000);
      req.on("close", () => clearTimeout(t));
      return;
    }
    case "/gzip":
      return send(200, "text/html", zlib.gzipSync(Buffer.from(PAGE)), { "Content-Encoding": "gzip" });
    case "/br":
      return send(200, "text/html", zlib.brotliCompressSync(Buffer.from(PAGE)), { "Content-Encoding": "br" });
    case "/sjis":
      return send(200, "text/html", sjisPage());
    case "/eucjp":
      return send(200, "text/html; charset=EUC-JP", eucjpPage());
    case "/json":
      return send(200, "application/json", "{}");
    case "/missing":
      return send(404, "text/html", "nope");
    case "/image.png":
      return send(200, "image/png", PNG);
    case "/svg-as-png":
      return send(200, "image/png", '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    default:
      return send(404, "text/plain", "not found");
  }
}

async function serve(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(route);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test("isPrivateAddress flags loopback, private, link-local, CGNAT and mapped forms", () => {
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.0.5",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "[::ffff:127.0.0.1]", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe",
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2001:4860:4860::8888"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("assertPublicUrl rejects bad schemes, credentials and private literals without network", async () => {
  for (const url of [
    "http://127.0.0.1/",
    "http://[::ffff:127.0.0.1]/",
    "http://2130706433/",
    "http://169.254.169.254/latest/meta-data",
    "http://[fd00::1]/",
    "file:///etc/passwd",
    "ftp://8.8.8.8/x",
    "https://user:pass@8.8.8.8/",
    "http://user@8.8.8.8/",
  ]) {
    await assert.rejects(assertPublicUrl(url), UnsafeUrlError, url);
  }
  const ok = await assertPublicUrl("https://8.8.8.8/page");
  assert.equal(ok.hostname, "8.8.8.8");
});

test("assertPublicUrl rejects localhost via DNS", async () => {
  await assert.rejects(assertPublicUrl("http://localhost:1/"), UnsafeUrlError);
});

test("safeFetch refuses private targets by default", async () => {
  await assert.rejects(safeFetch("http://127.0.0.1:9/html"), UnsafeUrlError);
});

test("safeFetch fetches with allowPrivate and follows redirects", async () => {
  const srv = await serve();
  try {
    const r = await safeFetch(`${srv.base}/redirect`, { allowPrivate: true });
    assert.equal(r.status, 200);
    assert.ok(r.finalUrl.endsWith("/html"));
    assert.match(r.contentType, /text\/html/);
    assert.ok(r.body.toString("utf8").includes("First paragraph"));
  } finally {
    await srv.close();
  }
});

test("safeFetch stops after maxRedirects", async () => {
  const srv = await serve();
  try {
    await assert.rejects(safeFetch(`${srv.base}/loop`, { allowPrivate: true, maxRedirects: 3 }), /too many redirects/);
  } finally {
    await srv.close();
  }
});

test("safeFetch re-validates every redirect hop", async () => {
  const srv = await serve();
  try {
    const seen: string[] = [];
    await assert.rejects(
      safeFetch(`${srv.base}/redirect`, {
        allowPrivate: true,
        validate: async (u: string) => {
          seen.push(u);
          const x = new URL(u);
          if (x.pathname === "/html") throw new UnsafeUrlError("hop resolves to a private address");
          return x;
        },
      }),
      UnsafeUrlError,
    );
    assert.equal(seen.length, 2);
  } finally {
    await srv.close();
  }
});

test("safeFetch enforces the byte limit", async () => {
  const srv = await serve();
  try {
    await assert.rejects(safeFetch(`${srv.base}/big`, { allowPrivate: true, maxBytes: 10_000 }), /exceeds/);
  } finally {
    await srv.close();
  }
});

test("safeFetch enforces the timeout", async () => {
  const srv = await serve();
  try {
    await assert.rejects(safeFetch(`${srv.base}/slow`, { allowPrivate: true, timeoutMs: 150 }), /timeout/);
  } finally {
    await srv.close();
  }
});

test("safeFetch reports non-2xx as HTTP status", async () => {
  const srv = await serve();
  try {
    await assert.rejects(safeFetch(`${srv.base}/missing`, { allowPrivate: true }), /HTTP 404/);
  } finally {
    await srv.close();
  }
});

test("fetchPageText decodes gzip and brotli bodies", async () => {
  const srv = await serve();
  try {
    for (const path of ["/gzip", "/br"]) {
      const p = await fetchPageText(`${srv.base}${path}`, { allowPrivate: true });
      assert.ok(p.text.includes("First paragraph"), path);
    }
  } finally {
    await srv.close();
  }
});

test("fetchPageText decodes Shift_JIS from meta charset and EUC-JP from the header", async () => {
  const srv = await serve();
  try {
    const sj = await fetchPageText(`${srv.base}/sjis`, { allowPrivate: true });
    assert.ok(sj.text.includes("日本"));
    const ej = await fetchPageText(`${srv.base}/eucjp`, { allowPrivate: true });
    assert.ok(ej.text.includes("日本"));
  } finally {
    await srv.close();
  }
});

test("fetchPageText returns title, text without chrome, images and the final URL", async () => {
  const srv = await serve();
  try {
    const p = await fetchPageText(`${srv.base}/redirect`, { allowPrivate: true });
    assert.equal(p.title, "Test & Page");
    assert.ok(p.url.endsWith("/html"));
    assert.ok(p.text.includes("Heading here"));
    assert.ok(p.text.includes("First paragraph with bold words and an entity é — done."));
    assert.ok(p.text.includes("\n\n"));
    for (const junk of ["SCRIPT_TEXT", "Menu item", "FOOTER_TEXT", "color:red"]) assert.ok(!p.text.includes(junk), junk);
    assert.equal(p.truncated, false);
    assert.equal(p.images[0].url, `${srv.base}/img/hero.jpg`);
    assert.ok(p.images.some((i) => i.url === `${srv.base}/img/photo.jpg` && i.alt === "A photo"));
    assert.ok(!p.images.some((i) => /logo|tiny/.test(i.url)));
  } finally {
    await srv.close();
  }
});

test("fetchPageText truncates at maxChars", async () => {
  const srv = await serve();
  try {
    const p = await fetchPageText(`${srv.base}/html`, { allowPrivate: true, maxChars: 20 });
    assert.equal(p.truncated, true);
    assert.equal(p.text.length, 20);
  } finally {
    await srv.close();
  }
});

test("fetchPageText rejects non-HTML content types", async () => {
  const srv = await serve();
  try {
    await assert.rejects(fetchPageText(`${srv.base}/json`, { allowPrivate: true }), /unsupported content type: application\/json/);
  } finally {
    await srv.close();
  }
});

test("fetchImage detects the type by magic bytes", async () => {
  const srv = await serve();
  try {
    const img = await fetchImage(`${srv.base}/image.png`, { allowPrivate: true });
    assert.equal(img.mime, "image/png");
    assert.equal(img.bytes, PNG.length);
    assert.deepEqual(Buffer.from(img.base64, "base64"), PNG);
    await assert.rejects(fetchImage(`${srv.base}/svg-as-png`, { allowPrivate: true }), /unsupported image/);
  } finally {
    await srv.close();
  }
});

test("extractReadable keeps the article, drops chrome, resolves and filters images", () => {
  const para = "Paragraph of real article content that keeps going for a while so the container wins. ";
  const html = `<html><head><title>  Big &amp;  News </title><meta property="og:image" content="https://cdn.example.com/a.jpg"></head><body>
<header><a>HEADER_LINK</a></header>
<div class="sidebar"><a>SIDEBAR_LINK one</a><a>SIDEBAR_LINK two</a></div>
<article><h2>Story</h2><p>${para}Tom &amp; Jerry.</p><p>${para}</p><p>${para}</p>
<img src="/pic/one.jpg" alt="Pic &quot;one&quot;"><img src="data:image/png;base64,AAAA">
<img src="/pic/logo-x.png"><img src="/pic/small.png" width="50"><img src="/pic/two.webp"><img src="x.svg"></article>
<footer>FOOTER_TEXT</footer><script>SCRIPT_TEXT</script></body></html>`;
  const r = extractReadable(html, "https://example.com/news/story.html");
  assert.equal(r.title, "Big & News");
  assert.ok(r.text.startsWith("Story"));
  assert.ok(r.text.includes("Tom & Jerry."));
  for (const junk of ["HEADER_LINK", "SIDEBAR_LINK", "FOOTER_TEXT", "SCRIPT_TEXT"]) assert.ok(!r.text.includes(junk), junk);
  assert.deepEqual(
    r.images.map((i) => i.url),
    ["https://cdn.example.com/a.jpg", "https://example.com/pic/one.jpg", "https://example.com/pic/two.webp"],
  );
  assert.equal(r.images[1].alt, 'Pic "one"');
});
