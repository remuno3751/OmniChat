/**
 * Does the user's message depend on information newer than a model's training data (prices, news, releases, "latest ...")?
 * Used by the `smart` search mode to decide when to search the web first. Deliberately generous: a wasted search costs a second,
 * a missed one produces a confidently outdated answer.
 */
const JA = /株価|株式|日経|為替|レート|相場|ビットコイン|暗号資産|仮想通貨|価格|値段|最安|最新|最近|現在|今日|昨日|明日|今週|先週|今月|先月|今年|昨年|来年|ニュース|速報|天気|気温|発売|新作|新型|新製品|発表|リリース|アップデート|バージョン|ランキング|順位|試合|結果|当選|評判|レビュー|対応状況|いつ|現行|まだ|もう.*(出|発売|販売)|存在する|実在/;
const EN = /\b(stock|share price|price|prices|cost|exchange rate|crypto|bitcoin|latest|newest|recent|recently|currently|current|today|tonight|yesterday|tomorrow|this (week|month|year)|last (week|month|year)|news|weather|forecast|release[sd]?|released|launch(ed)?|announce[sd]?|update[sd]?|version|score|standings|ranking|rumou?rs?|available|in stock|still)\b/i;
const PRODUCT = /\b(rtx|gtx|rx|arc|radeon|geforce|ryzen|core ultra|snapdragon|iphone|ipad|galaxy|pixel|playstation|ps\d|switch\s?\d|gpt|claude|gemini|llama|qwen|deepseek|mistral)\s*-?\d/i;
const YEAR = /\b(20[2-9]\d)\b|(20[2-9]\d)年/;

export function needsFreshInfo(text: string, now = new Date()): boolean {
  const t = text.trim();
  if (!t) return false;
  if (JA.test(t) || EN.test(t) || PRODUCT.test(t)) return true;
  const y = YEAR.exec(t);
  return !!y && Number(y[1] ?? y[2]) >= now.getFullYear() - 1;
}
