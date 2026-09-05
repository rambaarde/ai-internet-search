'use strict';
/**
 * Optional keyed web-search providers -- the general-web recall the four
 * key-free providers (Wikipedia, OpenAlex, DOAJ, HackerNews) structurally
 * cannot give. They answer reference / academic / practitioner questions; they
 * have no coverage of general-web "how do I..." topics.
 *
 * Keyless SERP scraping was tried and does not work from a program:
 * html.duckduckgo.com answers a server-side request with a 202 challenge and
 * Mojeek with a CAPTCHA. The engines that answer a program are the ones with an
 * API and a key. This wires the common ones. Each lights up ONLY when its key
 * is in the environment, and the whole provider is a no-op -- today's behaviour,
 * the key-free providers alone -- when none is set. It is never a required key.
 *
 * Results feed the SAME source-tier ranking as every other provider: the API
 * gives recall (which URLs exist), the tier grading gives credibility (which to
 * trust). The count-based "consensus" ranking some aggregators use is never
 * applied here -- counting is the failure this tool exists to prevent.
 */

const UA = `ai-internet-search/${require('../../package.json').version} (+https://github.com/rambaarde/ai-internet-search)`;
const TIMEOUT_MS = 10000;

/** fetch JSON with a timeout; never throws into the caller. */
async function fetchJson(url, { method = 'GET', headers = {}, body } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'user-agent': UA, accept: 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Brave Search API — GET, key in the X-Subscription-Token header. */
async function brave(q, key) {
  const j = await fetchJson(
    'https://api.search.brave.com/res/v1/web/search?count=10&q=' + encodeURIComponent(q),
    { headers: { 'X-Subscription-Token': key } },
  );
  return (j?.web?.results || []).map((r) => ({ url: r.url, title: r.title || '', via: 'brave' }));
}

/** Tavily — POST JSON, key in the body. */
async function tavily(q, key) {
  const j = await fetchJson('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { api_key: key, query: q, max_results: 10 },
  });
  return (j?.results || []).map((r) => ({ url: r.url, title: r.title || '', via: 'tavily' }));
}

/** Serper (Google results as JSON) — POST, key in the X-API-KEY header. */
async function serper(q, key) {
  const j = await fetchJson('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-KEY': key },
    body: { q, num: 10 },
  });
  return (j?.organic || []).map((r) => ({ url: r.link, title: r.title || '', via: 'serper' }));
}

/**
 * The configured web-search adapter, or null. First key present wins, so a
 * user with several keys gets a deterministic choice they can predict.
 *
 * @param {object} [env]  defaults to process.env; injectable for tests
 */
function pick(env = process.env) {
  const braveKey = env.BRAVE_SEARCH_API_KEY || env.BRAVE_API_KEY;
  if (braveKey) return { engine: 'brave', key: braveKey, run: brave };
  if (env.TAVILY_API_KEY) return { engine: 'tavily', key: env.TAVILY_API_KEY, run: tavily };
  if (env.SERPER_API_KEY) return { engine: 'serper', key: env.SERPER_API_KEY, run: serper };
  return null;
}

/** The env vars this provider reads, for the empty-state hint to name them. */
const KEYS = ['BRAVE_API_KEY', 'TAVILY_API_KEY', 'SERPER_API_KEY'];

/**
 * The provider object, shaped like the key-free ones in search.js. It is
 * eligible for every question kind because general-web recall helps them all;
 * with no key configured it returns nothing and drops out of the run.
 */
const webSearchProvider = {
  name: 'web',
  kinds: ['definition', 'engineering', 'academic'],
  async run(q) {
    const p = pick();
    if (!p) return [];
    try {
      return (await p.run(q, p.key)).filter((c) => c.url && c.title);
    } catch {
      return [];
    }
  },
};

module.exports = { webSearchProvider, pick, brave, tavily, serper, KEYS };
