import { describe, expect, it } from "vitest";
import { escapeHtml, renderMarkdown, safeUrl } from "../src/webview/render/markdown";
import { plainToHtml } from "../src/webview/render/chat-text";

const OPTS = { copyLabel: "Copy" };
const ALLOWED_TAGS = new Set(
  "p h3 strong em del code pre div span button a ul ol li blockquote table thead tbody tr th td hr br svg path".split(" "),
);
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z][a-zA-Z0-9-]*(?:="[^"<>]*")?)*)\s*(\/?)>/g;
const ATTR_RE = /([a-zA-Z][a-zA-Z0-9-]*)(?:="([^"<>]*)")?/g;

/**
 * Verifies that every '<' in the output belongs to a tag from the allow-list, that attributes are well-formed
 * (no on* handlers), and that every href is http(s) or vscode. Returns the text with tags removed.
 */
function checkSafe(html: string): string {
  const stripped = html.replace(TAG_RE, (_m, _slash: string, name: string, attrs: string) => {
    const tag = name.toLowerCase();
    expect(ALLOWED_TAGS.has(tag), `disallowed tag <${name}>`).toBe(true);
    for (const a of attrs.matchAll(ATTR_RE)) {
      const attr = a[1].toLowerCase();
      expect(attr.startsWith("on"), `event handler attribute ${attr}`).toBe(false);
      if (attr === "href") {
        expect(a[2], "href must be present").toBeDefined();
        expect(/^(https?:\/\/|vscode:)/i.test(unescape(a[2] ?? "")), `unsafe href ${a[2]}`).toBe(true);
      }
    }
    return "";
  });
  expect(stripped.includes("<"), "stray '<' in output").toBe(false);
  expect(stripped.includes(">"), "stray '>' in output").toBe(false);
  return stripped;
}

function unescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function textOf(html: string): string {
  return unescape(html.replace(TAG_RE, ""));
}

const PAYLOADS = [
  "<script>alert(1)</script>",
  '<img src=x onerror=alert(1)>',
  '"><svg onload=1>',
];

describe("escapeHtml", () => {
  it("escapes the five HTML characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("safeUrl", () => {
  it.each([
    ["https://x.test/a?b=1", "https://x.test/a?b=1"],
    ["HTTP://X.test", "HTTP://X.test"],
    [" https://x.test ", "https://x.test"],
    [" vscode://ext/x ", "vscode://ext/x"],
    ["VSCODE:open", "VSCODE:open"],
  ])("accepts %j", (input, expected) => {
    expect(safeUrl(input)).toBe(expected);
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:x",
    "java\nscript:x",
    "java\u0000script:x",
    "https\t://x",
    "&#106;avascript:x",
    "data:text/html,x",
    "file:///etc/passwd",
    "blob:https://x.test/uuid",
    "/relative/path",
    "relative/path",
    "ftp://x.test",
    "",
    "   ",
  ])("rejects %j", (input) => {
    expect(safeUrl(input)).toBeNull();
  });
});

describe("XSS corpus", () => {
  it.each(PAYLOADS)("neutralises %j in paragraphs, headings and inline code", (p) => {
    for (const md of [p, `# ${p}`, `\`${p}\``, `text \`${p}\` more`]) {
      const html = renderMarkdown(md, OPTS);
      checkSafe(html);
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("<svg");
    }
  });

  it.each(PAYLOADS)("neutralises %j in fenced code body and language", (p) => {
    const body = renderMarkdown("```\n" + p + "\n```", OPTS);
    checkSafe(body);
    expect(body).not.toContain("<script");
    expect(body).not.toContain("<img");
    const lang = renderMarkdown('```"><img src=x onerror=1>\nx\n```', OPTS);
    checkSafe(lang);
    expect(lang).not.toContain("<img");
    expect(lang).toContain("&quot;&gt;&lt;img");
  });

  it.each(PAYLOADS)("neutralises %j in tables, lists and link text", (p) => {
    const table = renderMarkdown(`| h ${p} |\n|---|\n| ${p} |`, OPTS);
    checkSafe(table);
    expect(table).not.toContain("<script");
    expect(table).not.toContain("<img");
    const list = renderMarkdown(`- ${p}\n- [ ] ${p}\n- [x] ${p}`, OPTS);
    checkSafe(list);
    expect(list).not.toContain("<img");
    const link = renderMarkdown(`[${p}](https://x.test)`, OPTS);
    checkSafe(link);
    expect(link).not.toContain("<img");
    expect(link).toContain('href="https://x.test"');
  });

  it("neutralises hostile link and image urls", () => {
    const cases = [
      "[a](javascript:alert(1))",
      "[a](JaVaScRiPt:alert(1))",
      "[a](java\tscript:x)",
      "[a](data:text/html,x)",
      '[a](https://x.test/?a="onmouseover="x)',
      '[a](https://x.test/"><img src=x onerror=1>)',
      "![a](javascript:alert(1))",
      '![<img src=x onerror=1>](https://x.test/c.png)',
      '![a](https://x.test/"onerror="1.png)',
      "![a](data:image/svg+xml,<svg onload=1>)",
      "![a](javascript:alert(1))\n\n![b](https://x.test/i.png \"t<script>\")",
    ];
    for (const md of cases) {
      const html = renderMarkdown(md, OPTS);
      checkSafe(html);
      expect(html).not.toContain("<img");
      expect(html).not.toContain("<script");
      expect(html).not.toMatch(/<a [^>]*href="(?!https?:\/\/|vscode:)/);
    }
    expect(renderMarkdown("[a](javascript:alert(1))", OPTS)).not.toContain("<a ");
    expect(renderMarkdown("[a](JaVaScRiPt:alert(1))", OPTS)).not.toContain("<a ");
    expect(renderMarkdown("[a](data:text/html,x)", OPTS)).not.toContain("<a ");
  });

  it("keeps raw HTML in the source as literal text", () => {
    const html = renderMarkdown("<b>x</b> <script>y</script>", OPTS);
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>");
    checkSafe(html);
  });
});

describe("links", () => {
  it("renders http, https and vscode links as anchors with rel", () => {
    const html = renderMarkdown("[ok](https://example.com/a?b=1) [v](vscode://file/x) [h](http://x.test)", OPTS);
    expect(html).toContain('<a class="oc-md-link" href="https://example.com/a?b=1" rel="noopener noreferrer">ok</a>');
    expect(html).toContain('<a class="oc-md-link" href="vscode://file/x" rel="noopener noreferrer">v</a>');
    expect(html).toContain('href="http://x.test"');
    checkSafe(html);
  });

  it("escapes quotes inside an accepted href", () => {
    const html = renderMarkdown('[a](https://x.test/?a="onmouseover="x)', OPTS);
    expect(html).toContain("&quot;onmouseover=&quot;x");
    expect(html).not.toContain('"onmouseover');
  });

  it("renders unsafe link text as plain text", () => {
    expect(renderMarkdown("[**bold** text](javascript:x)", OPTS)).toBe("<p>bold text</p>");
  });
});

describe("code blocks", () => {
  it("has the copy button with data-oc-copy and the label", () => {
    const html = renderMarkdown("```ts\nconst a = 1;\n```", { copyLabel: "Copy <code>" });
    expect(html).toContain('<button type="button" class="oc-code__copy" data-oc-copy aria-label="Copy &lt;code&gt;" title="Copy &lt;code&gt;">');
    expect(html).toContain("oc-ico--check");
    expect(html).toContain('<span class="oc-code__lang">ts</span>');
    expect(html).toContain('<div class="oc-code"><div class="oc-code__bar">');
    checkSafe(html);
  });

  it("uses the label text for an empty language", () => {
    const html = renderMarkdown("```\nplain\n```", OPTS);
    expect(html).toContain('<span class="oc-code__lang">text</span>');
  });

  it("produces token spans for TypeScript and Python", () => {
    const ts = renderMarkdown("```ts\nconst s = 'hi'; // note\nconst n = 42;\n```", OPTS);
    expect(ts).toContain('<span class="oc-tk oc-tk--keyword">const</span>');
    expect(ts).toContain('<span class="oc-tk oc-tk--string">&#39;hi&#39;</span>');
    expect(ts).toContain('<span class="oc-tk oc-tk--number">42</span>');
    expect(ts).toContain("oc-tk--comment");
    const py = renderMarkdown("```python\ndef f(x):\n    return 'a'\n```", OPTS);
    expect(py).toContain('<span class="oc-tk oc-tk--keyword">def</span>');
    expect(py).toContain('<span class="oc-tk oc-tk--keyword">return</span>');
    expect(py).toContain("oc-tk--string");
    checkSafe(ts);
    checkSafe(py);
  });

  it("keeps the concatenated token text equal to the body", () => {
    const body = "const x = 'a' // hi <b>\nlet n = 42;\n\tfoo(bar) & baz";
    const html = renderMarkdown("```ts\n" + body + "\n```", OPTS);
    const inner = /<code>([\s\S]*?)<\/code>/.exec(html);
    expect(inner).not.toBeNull();
    expect(textOf(inner![1])).toBe(body);
  });

  it("skips highlighting above maxHighlightLines but keeps the text", () => {
    const body = "const a = 1;\nconst b = 2;\nconst c = 3;";
    const html = renderMarkdown("```ts\n" + body + "\n```", { copyLabel: "Copy", maxHighlightLines: 2 });
    expect(html).not.toContain("oc-tk");
    expect(textOf(/<code>([\s\S]*?)<\/code>/.exec(html)![1])).toBe(body);
  });
});

describe("streaming and robustness", () => {
  it("renders an unclosed fence as oc-md-raw while streaming", () => {
    const html = renderMarkdown("Intro\n\n```ts\nconst a = 1", { streaming: true, copyLabel: "Copy" });
    expect(html).toContain('<pre class="oc-md-raw">');
    expect(html).not.toContain("oc-code__copy");
    checkSafe(html);
  });

  it("does not throw on an unclosed fence when not streaming", () => {
    expect(() => renderMarkdown("```ts\nconst a = 1", OPTS)).not.toThrow();
  });

  it("returns an empty string for empty input", () => {
    expect(renderMarkdown("", OPTS)).toBe("");
  });

  it("does not throw on non-string input", () => {
    expect(() => renderMarkdown(undefined as unknown as string, OPTS)).not.toThrow();
    expect(renderMarkdown(null as unknown as string, OPTS)).toBe("");
  });

  it("handles 200k characters quickly without throwing", () => {
    const text =
      "paragraph with **bold**, *em*, ~~gone~~ and `code` and [link](https://x.test)\n\n".repeat(2000) +
      "```ts\n" + "const x = 1; // c\n".repeat(4000) + "```\n" +
      "- item\n".repeat(3000);
    expect(text.length).toBeGreaterThan(190_000);
    const t0 = performance.now();
    let html = "";
    expect(() => {
      html = renderMarkdown(text, OPTS);
    }).not.toThrow();
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(500);
    expect(html.length).toBeGreaterThan(0);
  });
});

describe("block rendering", () => {
  it("renders headings as h3 with a level class", () => {
    expect(renderMarkdown("# T", OPTS)).toBe('<h3 class="oc-md-h oc-md-h1">T</h3>');
    expect(renderMarkdown("### S", OPTS)).toBe('<h3 class="oc-md-h oc-md-h3">S</h3>');
  });

  it("renders emphasis, inline code and strike", () => {
    const html = renderMarkdown("**b** *i* ~~s~~ `c`", OPTS);
    expect(html).toContain("<strong>b</strong>");
    expect(html).toContain("<em>i</em>");
    expect(html).toContain("<del>s</del>");
    expect(html).toContain('<code class="oc-md-code">c</code>');
  });

  it("renders block quotes", () => {
    expect(renderMarkdown("> quoted", OPTS)).toBe("<blockquote><p>quoted</p></blockquote>");
  });

  it("renders nested lists", () => {
    const html = renderMarkdown("- a\n  - b\n  - c\n- d", OPTS);
    expect(html.match(/<ul>/g)).toHaveLength(2);
    expect(html).toContain("<li>");
    expect(html).toContain("<p>b</p>");
    checkSafe(html);
  });

  it("renders ordered lists with start and task items as spans, not inputs", () => {
    const ordered = renderMarkdown("3. a\n4. b", OPTS);
    expect(ordered.startsWith('<ol start="3">')).toBe(true);
    const tasks = renderMarkdown("- [x] done\n- [ ] todo", OPTS);
    expect(tasks).toContain('<span class="oc-md-check oc-md-check--on" role="checkbox" aria-checked="true" aria-disabled="true">');
    expect(tasks).toContain('aria-checked="false"');
    expect(tasks).not.toContain("<input");
    checkSafe(tasks);
  });

  it("renders tables in a scroll wrapper with alignment classes", () => {
    const html = renderMarkdown("| a | b |\n|:--|--:|\n| 1 | 2 |", OPTS);
    expect(html.startsWith('<div class="oc-md-table"><table>')).toBe(true);
    expect(html).toContain('<th class="oc-md-al-left">a</th>');
    expect(html).toContain('<th class="oc-md-al-right">b</th>');
    expect(html).toContain('<td class="oc-md-al-left">1</td>');
    expect(html).toContain('<td class="oc-md-al-right">2</td>');
    expect(html).not.toContain("style=");
    checkSafe(html);
  });

  it("renders horizontal rules", () => {
    expect(renderMarkdown("---", OPTS)).toBe("<hr>");
  });

  it("renders images as links, never as img", () => {
    const html = renderMarkdown("![cat](https://x.test/c.png)", OPTS);
    expect(html).toContain('href="https://x.test/c.png"');
    expect(html).toContain("cat");
    expect(html).not.toContain("<img");
    const bad = renderMarkdown("![cat](javascript:alert(1))", OPTS);
    expect(bad).not.toContain("<a ");
    expect(bad).toContain("cat");
  });
});

describe("plainToHtml", () => {
  it("escapes and converts newlines without interpreting Markdown", () => {
    expect(plainToHtml("<b>**x**</b>\nline2")).toBe("&lt;b&gt;**x**&lt;/b&gt;<br>line2");
    expect(plainToHtml("a\r\nb")).toBe("a<br>b");
  });
});

describe("size cap", () => {
  it("renders text beyond 60k chars as escaped plain text, fast", async () => {
    const { renderMarkdown, MAX_MARKDOWN_CHARS } = await import("../src/webview/render/markdown");
    const t0 = Date.now();
    const out = renderMarkdown("*a ".repeat(60000) + "<b>tail</b>", { copyLabel: "Copy" });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(out).toContain("&lt;b&gt;tail&lt;/b&gt;");
    expect(out).not.toContain("<b>");
    expect(MAX_MARKDOWN_CHARS).toBe(60000);
  });
});

describe("inline code file paths", () => {
  it("marks path-like inline code with data-oc-path and line", () => {
    const html = renderMarkdown("see `src/a/b.ts:12` and `plain`", OPTS);
    checkSafe(html);
    expect(html).toContain('data-oc-path="src/a/b.ts" data-oc-line="12"');
    expect(html).toContain('<code class="oc-md-code">plain</code>');
  });
  it("does not mark urls or versions", () => {
    expect(renderMarkdown("`https://a.com/x.ts` `1.2.3`", OPTS)).not.toContain("data-oc-path");
  });
});
