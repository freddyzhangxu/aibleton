/**
 * Live-network smoke test for src/websearch.ts.
 * Run: npx tsx scripts/test-websearch.ts
 * Uses the same proxy detection as the extension (AIBLETON_PROXY / HTTPS_PROXY
 * / macOS system proxy); Bing also answers directly, so it works either way.
 */
import { parseBing, parseDdg, webFetch, webSearch } from "../src/websearch.js";

let failed = false;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) failed = true;
};

// ---- parser fixtures (offline) — catch markup drift without depending on
// whichever engine happens to be reachable from this network ----
const bingFixture = `
<li class="b_algo" data-id iid=SERP.1><h2><a href="https://www.bing.com/ck/a?!&amp;p=xyz&amp;u=a1aHR0cHM6Ly93d3cuYWJsZXRvbi5jb20vZW4v&amp;ntb=1" target="_blank">Ableton — Creative tools</a></h2>
<p class="b_lineclamp2">Ableton makes <strong>software</strong> &amp; hardware.</p></li>
<li class="b_algo" data-id iid=SERP.2><h2><a href="https://example.com/direct" target="_blank">Direct link</a></h2><p>plain</p></li>`;
const bingHits = parseBing(bingFixture);
check(bingHits.length === 2, "parseBing: 2 hits from fixture");
check(bingHits[0]?.url === "https://www.ableton.com/en/", "parseBing: /ck/a redirect unwrapped");
check(bingHits[0]?.snippet === "Ableton makes software & hardware.", "parseBing: snippet stripped + entities");

const ddgFixture = `
<div class="result results_links results_links_deep web-result">
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.ableton.com%2Fen%2F&amp;rut=abc123">Ableton &amp; Music</a>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Make <b>music</b> with Live.</a></div>
<div class="result results_links web-result">
<a rel="nofollow" class="result__a" href="https://example.com/direct2">Second</a></div>`;
const ddgHits = parseDdg(ddgFixture);
check(ddgHits.length === 2, "parseDdg: 2 hits from fixture");
check(ddgHits[0]?.url === "https://www.ableton.com/en/", "parseDdg: uddg redirect unwrapped");
check(ddgHits[0]?.snippet === "Make music with Live.", "parseDdg: snippet stripped");

// An anti-bot challenge / JS-shell page must parse as ZERO hits (so the
// engine loop falls through instead of returning garbage).
check(parseBing("<html><title>Challenge</title></html>").length === 0, "parseBing: challenge page → 0 hits");
check(parseDdg("<html><title>DuckDuckGo</title></html>").length === 0, "parseDdg: challenge page → 0 hits");

// ---- web_search ----
const hits = await webSearch("ableton live 12 release notes");
console.log(`web_search → ${hits.length} hits`);
for (const h of hits.slice(0, 3)) console.log(`  ${h.title}\n  ${h.url}\n  ${h.snippet.slice(0, 120)}`);
check(hits.length > 0, "search returns hits");
check(hits.every((h) => /^https?:\/\//.test(h.url) && h.title.length > 0), "hits have http URLs + titles");
check(!hits.some((h) => h.url.includes("bing.com/ck/a")), "Bing redirect URLs unwrapped");

// ---- web_fetch ----
const page = await webFetch("https://example.com");
console.log(`web_fetch → "${page.title}" (${page.chars} chars)`);
check(page.text.includes("Example Domain"), "fetch extracts page text");

// ---- SSRF guard ----
const blocked = await webFetch("http://127.0.0.1:17666/api/health").then(
  () => false,
  () => true,
);
check(blocked, "localhost fetch rejected");

process.exit(failed ? 1 : 0);
