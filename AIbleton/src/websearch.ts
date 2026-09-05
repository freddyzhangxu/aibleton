/**
 * Web access for the chat assistant: web_search + web_fetch (page → text).
 *
 * Keyless by design — no API keys. All traffic goes through http.ts's
 * proxy-aware transport (CONNECT tunnel), the same as the audio generators.
 *
 * Engines (probed 2026-09): Bing's www.bing.com/search returns parseable
 * results even from China-direct and flagged proxy exits, so it goes first;
 * DuckDuckGo's html endpoint is challenge-walled from datacenter exits and
 * unreachable from China, but works for most global residential users, so it
 * is the automatic fallback. Google serves a JS-only shell to plain HTTP
 * clients everywhere — not scrapable at all (its only usable path is the
 * keyed Custom Search API).
 *
 * Both engines wrap result links in redirects: Bing /ck/a carries the target
 * as base64url in `u` (with an "a1" prefix), DDG /l/ carries it URL-encoded
 * in `uddg`. Search locale follows the UI language (users are global).
 */

import { URL } from "node:url";
import { Buffer } from "node:buffer";
import { detectProxy, rawGet, readAll } from "./http.js";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface FetchResult {
  url: string;
  title: string;
  chars: number;
  text: string;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

interface Deadline {
  signal: AbortSignal;
  /** true when OUR timer (not the chat stop button) aborted the request. */
  timedOut: () => boolean;
  dispose: () => void;
}

/**
 * Chat-stop abort + a hard per-call ceiling, whichever fires first.
 * Hand-rolled because the Extension Host sandbox only guarantees the globals
 * the existing code already relies on (AbortController, setTimeout — proven
 * by server.ts's abortCtl and audiogen.ts's sleep). AbortSignal.timeout/any
 * are off-limits: the original version crashed there with
 * "AbortSignal is not defined".
 */
function withDeadline(signal: AbortSignal | undefined, ms: number): Deadline {
  const ctl = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    ctl.abort();
  }, ms);
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ctl.signal,
    timedOut: () => fired,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

// ---------- HTML → text helpers (hand-rolled, no deps) ----------

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  copy: "©",
  reg: "®",
  trade: "™",
  laquo: "«",
  raquo: "»",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Readable text from an HTML document: drop boilerplate blocks, keep line structure. */
function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? stripTags(titleMatch[1]) : "";
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, " ");
  // Block-level boundaries become newlines before the remaining tags go.
  s = s.replace(
    /<\/?(p|div|br|li|ul|ol|tr|table|h[1-6]|section|article|header|footer|nav|aside|main|figure|figcaption|blockquote|pre|dl|dt|dd|hr|form|fieldset)\b[^>]*>/gi,
    "\n",
  );
  s = decodeEntities(s.replace(/<[^>]+>/g, ""));
  const text = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

// ---------- SSRF guard ----------

/**
 * The model picks the URLs — keep it away from the machine's own services
 * (including this extension's server on 127.0.0.1:17666). Re-checked on every
 * redirect hop.
 */
function assertPublicHttp(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`只支持 http/https 链接，收到: ${url.protocol}//`);
  }
  const h = url.hostname.toLowerCase();
  if (
    h === "localhost" ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h === "0.0.0.0" ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h === "::1" ||
    h.startsWith("fe80:") ||
    h.startsWith("fc") ||
    h.startsWith("fd")
  ) {
    throw new Error(`不允许访问内网/本机地址: ${h}`);
  }
}

// ---------- web_search (Bing primary, DuckDuckGo fallback — both keyless) ----------

/**
 * Search locale follows the UI language (the chat is localized to Live's 7
 * languages; users are global, so nothing here is hardcoded to one region).
 *   al  = Accept-Language header
 *   mkt = Bing market param
 *   kl  = DuckDuckGo region param
 */
const SEARCH_LOCALES: Record<string, { al: string; mkt: string; kl: string }> = {
  en: { al: "en-US,en;q=0.9", mkt: "en-US", kl: "us-en" },
  zh: { al: "zh-CN,zh;q=0.9,en;q=0.8", mkt: "zh-CN", kl: "cn-zh" },
  de: { al: "de-DE,de;q=0.9,en;q=0.8", mkt: "de-DE", kl: "de-de" },
  fr: { al: "fr-FR,fr;q=0.9,en;q=0.8", mkt: "fr-FR", kl: "fr-fr" },
  ja: { al: "ja-JP,ja;q=0.9,en;q=0.8", mkt: "ja-JP", kl: "jp-jp" },
  es: { al: "es-ES,es;q=0.9,en;q=0.8", mkt: "es-ES", kl: "es-es" },
  it: { al: "it-IT,it;q=0.9,en;q=0.8", mkt: "it-IT", kl: "it-it" },
};

function searchLocale(language?: string): { al: string; mkt: string; kl: string } {
  return SEARCH_LOCALES[language ?? ""] ?? SEARCH_LOCALES.en;
}

/** Unwrap Bing's /ck/a redirect link to the real target (best effort). */
function unwrapBingUrl(href: string): string {
  const m = /[?&]u=a1([^&]+)/.exec(href);
  if (!m) return href;
  try {
    return Buffer.from(m[1], "base64url").toString("utf8");
  } catch {
    return href;
  }
}

/** Unwrap DuckDuckGo's /l/?uddg= redirect link to the real target. */
function unwrapDdgUrl(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (!m) return href;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return href;
  }
}

/** Parse Bing's results page (structure probed 2026-09; exported for fixture tests). */
export function parseBing(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const block of html.split(/<li class="b_algo"/).slice(1)) {
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    const url = unwrapBingUrl(decodeEntities(a[1]));
    const title = stripTags(a[2]);
    if (!title || !/^https?:\/\//.test(url)) continue;
    const p =
      /<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block) ?? /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    hits.push({ title, url, snippet: p ? stripTags(p[1]) : "" });
    if (hits.length >= 8) break;
  }
  return hits;
}

/** Parse DuckDuckGo's HTML endpoint (html.duckduckgo.com/html/; exported for fixture tests). */
export function parseDdg(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const anchorRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let a: RegExpExecArray | null;
  while ((a = anchorRe.exec(html)) !== null) {
    const url = unwrapDdgUrl(decodeEntities(a[1]));
    const title = stripTags(a[2]);
    if (!title || !/^https?:\/\//.test(url)) continue;
    // The snippet follows the anchor within the same result block.
    const near = html.slice(a.index, a.index + 3000);
    const p = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(near);
    hits.push({ title, url, snippet: p ? stripTags(p[1]) : "" });
    if (hits.length >= 8) break;
  }
  return hits;
}

interface Engine {
  name: string;
  url: (q: string, kl: string, mkt: string) => URL;
  parse: (html: string) => SearchHit[];
}

const ENGINES: Engine[] = [
  {
    // Verified reachable even from China-direct and flagged proxy exits
    // (2026-09), so it goes first.
    name: "Bing",
    url: (q, _kl, mkt) => {
      const u = new URL("https://www.bing.com/search");
      u.searchParams.set("q", q);
      u.searchParams.set("count", "12");
      u.searchParams.set("setlang", mkt.split("-")[0]);
      u.searchParams.set("mkt", mkt);
      return u;
    },
    parse: parseBing,
  },
  {
    // Blocked in China and challenge-walled from many datacenter exits, but
    // fine for most global residential users — a keyless second chance.
    name: "DuckDuckGo",
    url: (q, kl) => {
      const u = new URL("https://html.duckduckgo.com/html/");
      u.searchParams.set("q", q);
      u.searchParams.set("kl", kl);
      return u;
    },
    parse: parseDdg,
  },
];

export async function webSearch(
  query: string,
  signal?: AbortSignal,
  language?: string,
): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) throw new Error("query 不能为空");
  const loc = searchLocale(language);
  const dl = withDeadline(signal, 20_000); // one budget for all engine attempts
  const failures: string[] = [];
  try {
    for (const engine of ENGINES) {
      try {
        const res = await rawGet(engine.url(q, loc.kl, loc.mkt), {
          headers: {
            "user-agent": UA,
            accept: "text/html,application/xhtml+xml",
            "accept-language": loc.al,
          },
          proxy: detectProxy(),
          signal: dl.signal,
        });
        if (res.status < 200 || res.status >= 300) {
          failures.push(`${engine.name}: HTTP ${res.status}`);
          await readAll(res.stream).catch(() => "");
          continue;
        }
        const html = await readAll(res.stream);
        const hits = engine.parse(html);
        if (!hits.length) {
          // Also DDG's 202 anti-bot challenge page (parses as zero results).
          failures.push(`${engine.name}: 没有解析到结果（页面结构变化或被反爬拦截）`);
          continue;
        }
        return hits;
      } catch (err) {
        if (dl.timedOut()) throw new Error("搜索超时（20s）— 检查网络或代理");
        failures.push(`${engine.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    dl.dispose();
  }
  throw new Error(`搜索失败 — ${failures.join("；")}。稍后重试或换个关键词`);
}

// ---------- web_fetch ----------

const MAX_CHARS = 4500;

export async function webFetch(
  rawUrl: string,
  signal?: AbortSignal,
  language?: string,
): Promise<FetchResult> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error(`URL 无效: ${rawUrl}`);
  }
  const loc = searchLocale(language);
  const dl = withDeadline(signal, 25_000);
  try {
    // Follow redirects manually — rawRequest doesn't, and the SSRF guard must
    // re-check every hop's target anyway.
    for (let hop = 0; hop <= 3; hop++) {
      assertPublicHttp(url);
      const res = await rawGet(url, {
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
          "accept-language": loc.al,
        },
        proxy: detectProxy(),
        signal: dl.signal,
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.location;
        // Drain the body so the socket can close cleanly.
        await readAll(res.stream).catch(() => "");
        if (!loc) throw new Error(`重定向 (HTTP ${res.status}) 但没有 location 头`);
        url = new URL(decodeEntities(loc), url);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`抓取失败 (HTTP ${res.status}): ${url.href}`);
      }
      const ctype = String(res.headers["content-type"] ?? "").toLowerCase();
      const body = await readAll(res.stream);
      if (ctype.includes("text/plain")) {
        const text = body.trim();
        return {
          url: url.href,
          title: "",
          chars: text.length,
          text: text.slice(0, MAX_CHARS) + (text.length > MAX_CHARS ? "\n…（正文过长已截断）" : ""),
        };
      }
      if (ctype && !ctype.includes("text/html") && !ctype.includes("application/xhtml")) {
        throw new Error(`该链接不是网页 (content-type: ${ctype.split(";")[0]}) — 只能读取 HTML/纯文本页面`);
      }
      const { title, text } = htmlToText(body);
      if (!text) throw new Error("页面没有可提取的文本（可能需要 JS 渲染）");
      return {
        url: url.href,
        title,
        chars: text.length,
        text: text.slice(0, MAX_CHARS) + (text.length > MAX_CHARS ? "\n…（正文过长已截断）" : ""),
      };
    }
    throw new Error("重定向次数过多（>3），已放弃");
  } catch (err) {
    if (dl.timedOut()) throw new Error("抓取超时（25s）— 检查网络或代理");
    throw err;
  } finally {
    dl.dispose();
  }
}
