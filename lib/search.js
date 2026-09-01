'use strict';
/**
 * Candidate discovery over key-less sources.
 *
 * No API key, because requiring one puts a signup between an agent and its
 * first useful answer. Node 18+ ships fetch, so this needs no dependency
 * either — the whole tool stays installable with one command and runnable
 * offline of any account.
 *
 * These return CANDIDATES: a url and a title, nothing more. Nothing is
 * fetched here. Deciding what not to read is the point, and it happens in
 * sources.triage() using the url alone.
 *
 * A paid search API (Exa, Tavily, Brave) can be swapped in later behind the
 * same interface; it buys better recall, not a different pipeline.
 */

const UA = 'ai-internet-search (+https://github.com/rambaarde/ai-internet-search)';
const TIMEOUT_MS = 8000;

/** fetch with a timeout and a JSON parse that never throws into the caller. */
async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Each provider is best at a different question, and asking all of them for
 * everything is how you get an Inception-v4 paper back for a question about
 * connection pools. `kinds` says what a provider is FOR; the caller picks.
 */
const PROVIDERS = [
  {
    name: 'hackernews',
    kinds: ['engineering'],
    // Ranks by what practitioners actually surfaced and argued about, which is
    // a better prior for engineering questions than citation count.
    async run(q) {
      const j = await getJson('https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=12&query=' + encodeURIComponent(q));
      return (j?.hits || [])
        .filter((h) => h.url)
        .map((h) => ({ url: h.url, title: h.title || '', via: 'hackernews' }));
    },
  },
  {
    name: 'openalex',
    kinds: ['academic'],
    async run(q) {
      const j = await getJson('https://api.openalex.org/works?per-page=8&search=' + encodeURIComponent(q));
      return (j?.results || [])
        .map((w) => ({
          url: w.doi ? 'https://doi.org/' + String(w.doi).replace(/^https?:\/\/doi\.org\//, '') : w.id,
          title: w.title || '',
          via: 'openalex',
        }))
        .filter((c) => c.url && c.title);
    },
  },
  {
    name: 'wikipedia',
    kinds: ['definition'],
    async run(q) {
      const j = await getJson('https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=' + encodeURIComponent(q));
      return (j?.query?.search || []).map((r) => ({
        url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(r.title.replace(/ /g, '_')),
        title: r.title,
        via: 'wikipedia',
      }));
    },
  },
];

/**
 * Reduce a question to the words worth searching.
 *
 * These APIs are keyword engines, not question answerers. Handing them a
 * sentence measurably fails: "what is a connection pool" returned Show HN
 * posts about MCP servers and on-call tooling, because almost every word in
 * the sentence is noise and the engine matched the noise.
 *
 * This is the same rule the vault's own search layer arrived at from the
 * other direction — search one distinctive word, not a sentence. Stopwords
 * out, question framing out, what is left is what the corpus can match.
 */
const STOP = new Set(('a an the is are was were be been being do does did how what which who whom whose when where why ' +
  'should would could can may might must will shall i my me we our you your it its this that these those of in on at ' +
  'to for from by with about as if then than so and or but not no nor too very just also more most much many big ' +
  'small good bad best better use using used make makes made get gets got have has had').split(' '));

function keywords(q) {
  const words = String(q).toLowerCase().match(/[a-z0-9][a-z0-9._+-]*/g) || [];
  const kept = words.filter((w) => w.length > 2 && !STOP.has(w));
  // Keep original order: "postgres connection pool" reads as a phrase to a
  // keyword engine, where a reordered bag of words does not.
  return (kept.length ? kept : words).join(' ');
}

/**
 * Does a candidate plausibly answer the question at all?
 *
 * A keyword engine returns its best effort even when that is nothing, so
 * results have to be checked against the question rather than trusted. This
 * is the empty-state discipline again: returning junk confidently is worse
 * than returning nothing, because the caller cannot tell them apart.
 */
function looksRelevant(title, terms) {
  const t = String(title).toLowerCase();
  const hits = terms.filter((w) => t.includes(w)).length;
  return hits >= Math.min(2, terms.length);
}

/**
 * Classify the question to pick providers, so an engineering question is not
 * answered from a citation index.
 * @param {string} q
 * @returns {string[]} provider kinds, most relevant first
 */
function kindsFor(q) {
  const s = q.toLowerCase();
  if (/\b(what is|what are|definition|meaning of|stands for)\b/.test(s)) {
    return ['definition', 'engineering'];
  }
  if (/\b(paper|study|benchmark|research|evaluation|state of the art)\b/.test(s)) {
    return ['academic', 'engineering'];
  }
  return ['engineering', 'definition'];
}

/**
 * Gather candidates for a question. Providers run in parallel and a provider
 * that fails is skipped rather than failing the search — a partial answer with
 * its sources named beats no answer.
 *
 * @param {string} question
 * @param {{kinds?: string[]}} [opts]
 * @returns {Promise<{candidates: object[], providers: string[], failed: string[]}>}
 */
async function findCandidates(question, opts = {}) {
  const kinds = opts.kinds || kindsFor(question);
  const query = keywords(question);
  const terms = query.split(' ').filter(Boolean);
  const chosen = PROVIDERS.filter((p) => p.kinds.some((k) => kinds.includes(k)));
  const settled = await Promise.all(
    chosen.map(async (p) => {
      try {
        const out = await p.run(query);
        return { name: p.name, out: out.filter((c) => looksRelevant(c.title, terms)) };
      } catch {
        return { name: p.name, out: null };
      }
    })
  );

  const seen = new Set();
  const candidates = [];
  for (const s of settled) {
    for (const c of s.out || []) {
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      candidates.push(c);
    }
  }
  return {
    candidates,
    providers: settled.filter((s) => s.out && s.out.length).map((s) => s.name),
    failed: settled.filter((s) => !s.out).map((s) => s.name),
  };
}

module.exports = { findCandidates, kindsFor, keywords, looksRelevant, PROVIDERS };
