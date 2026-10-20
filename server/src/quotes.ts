/**
 * Live market quotes (stocks, FX, crypto) for the `smart` search mode. Web search snippets never contain a current price, so
 * "today's Toyota share price" would otherwise end in "I have no real-time data". Keyless Yahoo Finance endpoints; best effort,
 * never throws. Prices can be delayed (up to ~20 min on some exchanges): the block says so.
 */
const QUOTE_RE = /株価|株式|終値|始値|時価|為替|ドル円|円相場|為替レート|ビットコイン|イーサリアム|暗号資産|仮想通貨|日経平均|ダウ平均|S&P|ナスダック|\b(stock price|share price|stock quote|quote|exchange rate|bitcoin|ethereum|btc|eth|nikkei|nasdaq|dow jones)\b|\b[A-Z]{3}\/?(USD|JPY|EUR)\b/i;

export const isQuoteQuery = (text: string): boolean => QUOTE_RE.test(text);

const UA = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };
const T = (ms = 6000) => AbortSignal.timeout(ms);

interface Found { symbol: string; type: string; name: string }

async function findSymbol(query: string, preferJp: boolean): Promise<Found | null> {
  const fx = /^([A-Za-z]{3})\s*[\/ ]?\s*([A-Za-z]{3})$/.exec(query.trim());
  if (fx) return { symbol: `${fx[1]}${fx[2]}=X`.toUpperCase(), type: "CURRENCY", name: `${fx[1]}/${fx[2]}`.toUpperCase() };
  const u = new URL("https://query1.finance.yahoo.com/v1/finance/search");
  u.searchParams.set("q", query); u.searchParams.set("quotesCount", "6"); u.searchParams.set("newsCount", "0");
  const res = await fetch(u, { headers: UA, signal: T() });
  if (!res.ok) return null;
  const list: any[] = ((await res.json())?.quotes ?? []).filter((q: any) => q?.symbol && ["EQUITY", "ETF", "INDEX", "CURRENCY", "CRYPTOCURRENCY", "FUTURE"].includes(q.quoteType));
  const pick = (preferJp ? list.find((q) => /\.T$/.test(q.symbol)) : null) ?? list[0];
  return pick ? { symbol: pick.symbol, type: pick.quoteType, name: pick.longname || pick.shortname || pick.symbol } : null;
}

const fmtTime = (epoch: number): string => {
  const tz = process.env.OMNICHAT_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(new Date(epoch * 1000)) + ` (${tz})`;
};

/** Resolves the instrument the user means (`ask` = one small non-streamed model call) and returns a prompt block, or null. */
export async function fetchQuoteBlock(userText: string, ask: (system: string, user: string) => Promise<string>): Promise<string | null> {
  try {
    const SYS = 'Name the one financial instrument (company, index, currency pair or crypto) the user is asking about, in English letters. Reply with ONLY JSON like {"query":"Sony Group"}, {"query":"USD/JPY"} or {"query":"bitcoin"}. For a Japanese company give its English name. Always answer with your best guess; never leave it empty.';
    const parse = (raw: string) => /"query"\s*:\s*"([^"]*)"/.exec(raw.replace(/<think>[\s\S]*?<\/think>/gi, ""))?.[1]?.trim();
    const q = parse(await ask(SYS, userText.slice(0, 400))) || parse(await ask(SYS, `Which company, currency or crypto is this about? "${userText.slice(0, 200)}"`));
    if (!q) return null;
    const found = await findSymbol(q, /[぀-ヿ一-鿿]/.test(userText));
    if (!found) return null;
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(found.symbol)}?interval=1d&range=5d`, { headers: UA, signal: T() });
    if (!res.ok) return null;
    const r = (await res.json())?.chart?.result?.[0];
    const price = r?.meta?.regularMarketPrice;
    if (typeof price !== "number") return null;
    const closes: number[] = (r.indicators?.quote?.[0]?.close ?? []).filter((x: any) => typeof x === "number");
    const prev = closes.length >= 2 ? closes[closes.length - 2] : r.meta.chartPreviousClose;
    const chg = typeof prev === "number" && prev ? ` (${price - prev >= 0 ? "+" : ""}${(price - prev).toFixed(2)}, ${((price / prev - 1) * 100).toFixed(2)}% vs previous close ${prev})` : "";
    const when = typeof r.meta.regularMarketTime === "number" ? fmtTime(r.meta.regularMarketTime) : "unknown time";
    return `Live market quote (Yahoo Finance, fetched just now; may be delayed up to ~20 minutes): ${found.name} [${found.symbol}, ${r.meta.exchangeName ?? ""}] = ${price} ${r.meta.currency ?? ""}${chg}, last trade ${when}. Give this figure to the user directly with its time and a one-line note that prices keep moving. Do NOT say you cannot access real-time prices.`;
  } catch { return null; }
}
