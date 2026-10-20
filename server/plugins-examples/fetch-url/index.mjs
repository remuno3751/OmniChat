// OmniChat example plugin: declares "network", so the server hands it `ctx.fetch` and asks the user for approval first.
// Runs IN-PROCESS with the server's OS permissions. It can reach anything the server can reach (LAN, localhost):
// do not expose it to people you do not trust.
const MAX_CHARS = 6000;

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export const tools = {
  async fetch_url(args, ctx) {
    let url;
    try { url = new URL(String(args?.url ?? "")); } catch { throw new Error("url must be an absolute http(s) URL"); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http and https URLs are supported");
    if (!ctx.fetch) throw new Error("network permission is not granted");
    const res = await ctx.fetch(url.href, { headers: { "User-Agent": "OmniChat-fetch-url/1.0", Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" } });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    if (!/^(text\/|application\/(json|xml|xhtml))/i.test(type)) throw new Error(`unsupported content type: ${type || "unknown"}`);
    const body = await res.text();
    const text = /html/i.test(type) ? htmlToText(body) : body.trim();
    return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n...[truncated]` : text;
  },
};
