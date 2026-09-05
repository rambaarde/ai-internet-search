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

// Wikimedia's User-Agent policy requires <client>/<version> (<contact>) and
// states that a generic or absent agent may be blocked without notice, which
// arrives as a 403 rather than as an empty result.
const { webSearchProvider } = require('./providers/websearch');

const UA = `ai-internet-search/${require('../package.json').version} (+https://github.com/rambaarde/ai-internet-search)`;
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
 * Which language editions to ask.
 *
 * The tool asked English Wikipedia and nothing else, so a question written in
 * Tagalog or Spanish was answered from a corpus that mostly does not discuss
 * it. Script ranges settle the non-Latin cases outright and cost one regex.
 *
 * Script alone cannot separate the Latin-script languages, since Spanish,
 * German and Tagalog all use the same alphabet, so those are decided by a
 * handful of function words instead. This is deliberately small: a wrong
 * guess only adds a second language edition to the query, and English is
 * always asked as well, so recall can never fall below what it was.
 */
const SCRIPTS = [
  // Kana before Han: Japanese text mixes both, and Han alone is Chinese.
  { lang: 'ja', re: /[\u3040-\u30ff]/ },
  { lang: 'ko', re: /[\uac00-\ud7af]/ },
  { lang: 'zh', re: /[\u4e00-\u9fff]/ },
  { lang: 'ru', re: /[\u0400-\u04ff]/ },
  { lang: 'ar', re: /[\u0600-\u06ff]/ },
  { lang: 'hi', re: /[\u0900-\u097f]/ },
  { lang: 'th', re: /[\u0e00-\u0e7f]/ },
  { lang: 'el', re: /[\u0370-\u03ff]/ },
  { lang: 'he', re: /[\u0590-\u05ff]/ },
];

/** Function words, not vocabulary: they appear in almost any real sentence. */
const LATIN_HINTS = {
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'por', 'para', 'como', 'cuanto', 'cual', 'es'],
  tl: ['ang', 'ng', 'sa', 'mga', 'ay', 'para', 'kung', 'ano', 'paano', 'bakit', 'ba'],
  de: ['der', 'die', 'das', 'und', 'ist', 'wie', 'was', 'fur', 'nicht', 'mit', 'ein'],
  fr: ['le', 'la', 'les', 'des', 'est', 'une', 'pour', 'comment', 'quoi', 'avec', 'pas'],
  pt: ['os', 'as', 'do', 'da', 'dos', 'uma', 'para', 'como', 'que', 'nao', 'com'],
  id: ['yang', 'dan', 'di', 'untuk', 'dengan', 'adalah', 'apa', 'bagaimana', 'tidak'],
  it: ['il', 'lo', 'gli', 'del', 'della', 'che', 'per', 'come', 'non', 'con', 'una'],
  vi: ['va', 'cua', 'trong', 'khong', 'duoc', 'nhu', 'the', 'nao', 'gi'],
};

/**
 * @param {string} q
 * @returns {string[]} language codes, most likely first, always including 'en'
 */
function languagesFor(q) {
  const text = String(q);
  const found = [];
  for (const { lang, re } of SCRIPTS) {
    if (re.test(text)) found.push(lang);
  }
  if (!found.length) {
    const words = new Set((text.toLowerCase().match(/[a-z]+/g) || []));
    let best = null;
    let bestHits = 0;
    for (const [lang, hints] of Object.entries(LATIN_HINTS)) {
      const hits = hints.filter((w) => words.has(w)).length;
      // Two function words is the floor. One is a coincidence: "de" and "la"
      // both appear in English text often enough to matter.
      if (hits >= 2 && hits > bestHits) {
        best = lang;
        bestHits = hits;
      }
    }
    if (best) found.push(best);
  }
  // English is always asked, so adding a language can only raise recall.
  if (!found.includes('en')) found.push('en');
  return found;
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
    async run(q, opts = {}) {
      // A question in Spanish should reach Spanish-language literature, not
      // only whatever English work happens to match the same keywords.
      const other = (opts.langs || []).find((l) => l !== 'en');
      const filter = other ? `&filter=language:${other}` : '';
      const j = await getJson('https://api.openalex.org/works?per-page=8' + filter + '&search=' + encodeURIComponent(q));
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
    // Every language edition is the same API behind a different subdomain, so
    // covering a question asked in Tagalog or Japanese costs one more request
    // rather than a different provider.
    async run(q, opts = {}) {
      const langs = (opts.langs || ['en']).slice(0, 2);
      const perLang = await Promise.all(
        langs.map(async (lang) => {
          const j = await getJson(
            `https://${lang}.wikipedia.org/w/rest.php/v1/search/page?limit=3&q=` + encodeURIComponent(q)
          );
          return (j?.pages || []).map((r) => ({
            url: `https://${lang}.wikipedia.org/wiki/` + encodeURIComponent(r.key),
            title: r.title || r.key,
            via: lang === 'en' ? 'wikipedia' : `wikipedia:${lang}`,
          }));
        })
      );
      return perLang.flat();
    },
  },
  {
    name: 'doaj',
    kinds: ['academic'],
    // Open-access journals from outside the English-speaking world, which the
    // other providers under-represent. Key-free, and the full text is usually
    // reachable rather than paywalled.
    async run(q) {
      const j = await getJson('https://doaj.org/api/search/articles/' + encodeURIComponent(q) + '?pageSize=6');
      return (j?.results || [])
        .map((r) => {
          const b = r.bibjson || {};
          const link = (b.link || []).find((l) => l.url) || {};
          const doi = (b.identifier || []).find((i) => i.type === 'doi');
          return {
            url: doi ? 'https://doi.org/' + doi.id : link.url,
            title: b.title || '',
            via: 'doaj',
          };
        })
        .filter((c) => c.url && c.title);
    },
  },
  // Optional keyed general-web search (Brave / Tavily / Serper). Eligible for
  // every kind, and a no-op when no key is configured, so it adds general-web
  // recall the four key-free providers cannot -- without ever becoming required.
  webSearchProvider,
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

/**
 * Question framing, per language.
 *
 * The stopword list above is English only, which broke every non-English
 * question in a way that looked like a recall problem and was not: asking
 * Tagalog Wikipedia for "ano ang pagbabago klima pilipinas" returned
 * Daigdig, Asya and Ferdinand Marcos, because "ano" and "ang" are noise and
 * the engine matched the noise. Removing them returns the article on climate
 * change, which is what the question asked for.
 *
 * These are function words and interrogatives only. Vocabulary stays.
 */
const STOP_BY_LANG = {
  tl: ['ano', 'ang', 'ng', 'mga', 'sa', 'ay', 'kung', 'paano', 'bakit', 'saan', 'kailan', 'sino', 'ba', 'para', 'may', 'ito', 'iyon'],
  es: ['que', 'cual', 'cuales', 'como', 'donde', 'cuando', 'quien', 'por', 'para', 'los', 'las', 'del', 'una', 'unos', 'unas', 'con', 'sus'],
  de: ['was', 'wie', 'warum', 'wann', 'wer', 'welche', 'der', 'die', 'das', 'und', 'ist', 'sind', 'ein', 'eine', 'nicht', 'mit', 'fur'],
  fr: ['que', 'quoi', 'comment', 'pourquoi', 'quand', 'qui', 'quel', 'quelle', 'les', 'des', 'une', 'est', 'sont', 'pour', 'avec', 'pas'],
  pt: ['que', 'qual', 'como', 'onde', 'quando', 'quem', 'por', 'para', 'dos', 'das', 'uma', 'com', 'nao', 'sao'],
  it: ['che', 'cosa', 'come', 'dove', 'quando', 'chi', 'quale', 'per', 'con', 'del', 'della', 'gli', 'una', 'non', 'sono'],
  id: ['apa', 'bagaimana', 'mengapa', 'kapan', 'siapa', 'yang', 'dan', 'untuk', 'dengan', 'adalah', 'tidak', 'itu'],
  vi: ['gi', 'nao', 'sao', 'khi', 'ai', 'cua', 'trong', 'khong', 'duoc', 'nhu', 'the', 'la'],
};

/**
 * CJK has no spaces, so its question framing cannot be removed by dropping
 * tokens: it has to be cut out of the string. Left in, the whole query is one
 * token that no article title contains, and a real question returns nothing.
 * Segmenting properly would need a dictionary; removing the interrogative
 * suffix is enough to make the noun searchable.
 */
const CJK_FRAMING = /(とは何ですか|とは何か|とは何|とは|ですか|って何|なぜ|どうやって|どのように|이란 무엇인가|란 무엇인가|은 무엇인가요|는 무엇인가요|은 무엇인가|는 무엇인가|이란 무엇|란 무엇|무엇인가요|무엇인가|무엇|이란|어떻게|왜|是什么意思|是什么|什么是|什麼是|如何|为什么|為什麼|怎么|怎麼)/g;

function keywords(q, langs) {
  const stop = new Set(STOP);
  for (const lang of langs || languagesFor(q)) {
    for (const w of STOP_BY_LANG[lang] || []) stop.add(w);
  }
  // Keep letters from any script, not just a-z, or a question written in
  // Japanese or Cyrillic reduces to nothing at all.
  const stripped = String(q).replace(CJK_FRAMING, ' ');
  const words = stripped.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._+-]*/gu) || [];
  // A CJK question carries meaning in two-character words, so the length
  // floor that suits Latin scripts would discard the whole query.
  const cjk = /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/;
  const minLen = cjk.test(stripped) ? 1 : 2;
  const kept = words.filter((w) => w.length > minLen && !stop.has(w));
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
/**
 * Strip diacritics before comparing.
 *
 * A person types "cambio climatico" and the article is "Cambio climático".
 * Without folding, `includes` says no, the correct result is discarded, and
 * the tool reports that nothing was found: a false empty, which is the worst
 * answer this tool can give. Wikipedia's own search is already
 * accent-tolerant, so only this filter was rejecting it.
 */
const fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

function looksRelevant(title, terms) {
  const t = fold(title);
  const hits = terms.filter((w) => t.includes(fold(w))).length;
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
  // Everything else asks which of two things to use, or how something behaves.
  // Those questions have a literature, and gating the citation index on the
  // word "paper" or "benchmark" hid it: "should password hashing use argon2id
  // or bcrypt" reached only Hacker News and Wikipedia, both of which returned
  // nothing relevant, while OpenAlex held three on-topic tier-2 papers that
  // were never requested. Ordering still states the preference; the tier sort
  // in triage() decides what actually gets opened.
  return ['engineering', 'definition', 'academic'];
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
  // Language first: it decides which function words are noise, and therefore
  // what the query even is.
  const langs = opts.langs || languagesFor(question);
  const query = keywords(question, langs);
  const terms = query.split(' ').filter(Boolean);
  const chosen = PROVIDERS.filter((p) => p.kinds.some((k) => kinds.includes(k)));
  const settled = await Promise.all(
    chosen.map(async (p) => {
      try {
        const out = await p.run(query, { langs });
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
    languages: langs,
    providers: settled.filter((s) => s.out && s.out.length).map((s) => s.name),
    failed: settled.filter((s) => !s.out).map((s) => s.name),
  };
}

module.exports = { findCandidates, kindsFor, keywords, looksRelevant, languagesFor, fold, PROVIDERS };
