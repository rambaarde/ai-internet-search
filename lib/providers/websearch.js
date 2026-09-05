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
 * Google Programmable Search (Custom Search JSON API) — the free-forever option:
 * 100 queries/day at no cost and no card, real Google results. Needs both a key
 * and a search-engine id (cx); the pick() below requires both before choosing it.
 */
async function googleCse(q, keyAndCx) {
  const { key, cx } = keyAndCx;
  const j = await fetchJson(
    'https://www.googleapis.com/customsearch/v1?num=10&key=' + encodeURIComponent(key)
      + '&cx=' + encodeURIComponent(cx) + '&q=' + encodeURIComponent(q),
  );
  return (j?.items || []).map((r) => ({ url: r.link, title: r.title || '', via: 'google' }));
}

/**
 * Marginalia — a keyless, free-forever independent index. Zero setup (the shared
 * `public` key ships in the request), so it is the no-account option. Its index
 * is small and indie-web, and the public key shares a rate limit, so it is
 * OPT-IN (set MARGINALIA=1) rather than always-on: it would otherwise add its
 * latency to every search, including the reference questions it cannot help.
 */
async function marginalia(q) {
  const j = await fetchJson(
    'https://api.marginalia-search.com/public/search/' + encodeURIComponent(q) + '?key=public&count=10',
  );
  return (j?.results || []).map((r) => ({ url: r.url, title: r.title || '', via: 'marginalia' }));
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
  // Google needs BOTH a key and a search-engine id; only choose it with both.
  if (env.GOOGLE_SEARCH_API_KEY && env.GOOGLE_SEARCH_CX) {
    return { engine: 'google', key: { key: env.GOOGLE_SEARCH_API_KEY, cx: env.GOOGLE_SEARCH_CX }, run: googleCse };
  }
  return null;
}

/** The env vars the keyed picker reads, for the empty-state hint to name them. */
const KEYS = ['BRAVE_API_KEY', 'TAVILY_API_KEY', 'SERPER_API_KEY', 'GOOGLE_SEARCH_API_KEY+GOOGLE_SEARCH_CX'];

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

/**
 * The keyless Marginalia provider. Eligible for every kind, but OPT-IN: it runs
 * only when MARGINALIA is set, so it never taxes the default fast path. Free
 * forever, no account, no key -- the zero-setup general-web option.
 */
const marginaliaProvider = {
  name: 'marginalia',
  kinds: ['definition', 'engineering', 'academic'],
  async run(q) {
    if (!process.env.MARGINALIA) return [];
    try {
      return (await marginalia(q)).filter((c) => c.url && c.title);
    } catch {
      return [];
    }
  },
};

module.exports = { webSearchProvider, marginaliaProvider, pick, brave, tavily, serper, googleCse, marginalia, KEYS };
