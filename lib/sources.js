'use strict';
/**
 * Source tiering — the mechanism the whole tool exists for.
 *
 * Research agents fail in a specific, documented way: they resolve
 * disagreement by counting sources. Models "favor the majority viewpoint among
 * retrieved contexts, even when opposing evidence is more credible"
 * (arxiv 2505.17762), and research systems "consistently favored
 * SEO-optimized content farms over authoritative sources" (Anthropic).
 *
 * Those two compound into one failure: content farms exist to produce volume,
 * so the majority view IS the farm's view. Counting is not research.
 *
 * So credibility is assigned before anything is read, from the URL alone —
 * which is free, happens before a single page is fetched, and is therefore
 * both the accuracy mechanism and the largest token saving in the tool.
 */

/** Highest tier wins; first match in this list decides. */
const RULES = [
  // Tier 1 — the thing itself. Specs, official docs, source, changelogs.
  { tier: 1, why: 'official documentation', test: (h, u) =>
      /(^|\.)docs?\./.test(h) || /\/docs?\//.test(u) || /(^|\.)developer\./.test(h) ||
      /readthedocs\.io$/.test(h) || /\.dev$/.test(h) && /\/docs/.test(u) },
  { tier: 1, why: 'standards body', test: (h) =>
      /(^|\.)(ietf|rfc-editor|w3|whatwg|iso|ecma-international|unicode)\.org$/.test(h) ||
      /(^|\.)tc39\.es$/.test(h) },
  { tier: 1, why: 'source code or changelog', test: (h, u) =>
      (/(^|\.)github\.com$/.test(h) && /\/(blob|tree|releases|wiki)\//.test(u)) ||
      /(^|\.)(gitlab|codeberg|sr\.ht)\./.test(h) },
  { tier: 1, why: 'package registry', test: (h) =>
      /(^|\.)(npmjs|pypi|crates|rubygems|pkg\.go)\.(com|org|io|dev)$/.test(h) },

  // Tier 2 — the people who built or study it.
  { tier: 2, why: 'peer-reviewed or preprint', test: (h) =>
      /(^|\.)(arxiv|acm|ieee|springer|nature|science|plos|jstor|biorxiv|ssrn)\.(org|com)$/.test(h) ||
      /(^|\.)(ncbi\.nlm\.nih|pubmed|semanticscholar|openalex|crossref)\.(gov|org)$/.test(h) },
  { tier: 2, why: 'project repository', test: (h, u) =>
      /(^|\.)github\.com$/.test(h) && /^\/[^/]+\/[^/]+\/?$/.test(u.split('?')[0]) },
  { tier: 2, why: 'issue tracker or mailing list', test: (h, u) =>
      (/(^|\.)github\.com$/.test(h) && /\/(issues|pull|discussions)\//.test(u)) ||
      /(^|\.)(bugzilla|lists\.)/.test(h) },
  { tier: 2, why: 'vendor engineering blog', test: (h, u) =>
      /(^|\.)(anthropic|openai|google|cloudflare|stripe|netflix|uber|airbnb|shopify|postgresql|mozilla)\.(com|org)$/.test(h)
      && /(blog|engineering|research)/.test(u) },

  // Tier 3 — someone competent who read tier 1.
  { tier: 3, why: 'practitioner Q&A', test: (h) =>
      /(^|\.)(stackoverflow|serverfault|superuser|stackexchange)\.com$/.test(h) },
  { tier: 3, why: 'reference encyclopedia', test: (h) =>
      /(^|\.)wikipedia\.org$/.test(h) },
  { tier: 3, why: 'community discussion', test: (h) =>
      /(^|\.)(news\.ycombinator|lobste\.rs|reddit)\.(com|rs)$/.test(h) },

  // Tier 4 — volume-optimised. Read only if nothing better exists.
  { tier: 4, why: 'content aggregator or SEO listicle', test: (h, u) =>
      /(^|\.)(medium|dev\.to|hashnode|substack|linkedin)\.(com|to|dev)$/.test(h) ||
      /\b(top|best)-?\d+\b/.test(u) || /\b\d{4}-(guide|tutorial|tips)\b/.test(u) },
];

/**
 * Grade a URL before fetching it.
 * @param {string} url
 * @returns {{tier: number, why: string, host: string}}
 */
function gradeSource(url) {
  let host = '';
  let path = url;
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, '');
    path = u.pathname + u.search;
  } catch {
    return { tier: 4, why: 'unparseable url', host: '' };
  }
  for (const r of RULES) {
    if (r.test(host, path)) return { tier: r.tier, why: r.why, host };
  }
  // Unknown is tier 3, not 4: an unrecognised host is unproven, not junk, and
  // treating it as junk would quietly bury small authoritative sites.
  return { tier: 3, why: 'unclassified', host };
}

/**
 * Score a candidate on independent dimensions after tiering it.
 * Tier remains the hard primary ordering; the composite score breaks ties and
 * makes the reason for a choice inspectable instead of hiding it in sorting.
 *
 * `opts.relevance`, when supplied, is a Map url -> [0,1] from the optional Jev
 * evaluator: it reads the candidate's meaning where the title-substring match
 * below only counts word overlap. It is used only when present for this url,
 * so the default, key-free path is unchanged. Tier is never touched by it —
 * credibility stays deterministic and auditable.
 * @param {{url: string, title?: string, tier?: number}} candidate
 * @param {string[]} [terms]
 * @param {{relevance?: Map<string, number>}} [opts]
 * @returns {{score: number, breakdown: {authority: number, relevance: number, freshness: number, relevanceBy: string}}}
 */
function scoreSource(candidate, terms = [], opts = {}) {
  const tier = candidate.tier ?? gradeSource(candidate.url).tier;
  const title = String(candidate.title || '').toLowerCase();
  const normalizedTerms = terms.map((t) => String(t).toLowerCase()).filter(Boolean);
  const hits = normalizedTerms.filter((t) => title.includes(t)).length;
  const modelRelevance = opts.relevance instanceof Map ? opts.relevance.get(candidate.url) : undefined;
  const relevanceBy = typeof modelRelevance === 'number' ? 'jev' : 'title';
  const relevance = typeof modelRelevance === 'number'
    ? modelRelevance
    : (normalizedTerms.length ? hits / normalizedTerms.length : 0.5);
  const authority = (5 - tier) / 4;
  const year = String(candidate.url).match(/(?:^|[/-])(20\d{2})(?:[/-]|$)/)?.[1];
  const age = year ? Math.max(0, Math.min(1, (Number(year) - 2000) / 30)) : 0.5;
  const score = Number((0.60 * authority + 0.30 * relevance + 0.10 * age).toFixed(3));
  return { score, breakdown: { authority: Number(authority.toFixed(3)), relevance: Number(relevance.toFixed(3)), freshness: Number(age.toFixed(3)), relevanceBy } };
}

/**
 * Order candidates for reading, and decide which to open at all.
 *
 * Two caps, both of which save tokens and improve the answer at the same time:
 * one per host (five pages from one site say one thing five times), and a hard
 * ceiling on how many are opened at all.
 *
 * @param {{url: string, title: string}[]} candidates
 * @param {{limit?: number, perHost?: number, terms?: string[], relevance?: Map<string, number>}} [opts]
 */
function triage(candidates, opts = {}) {
  const limit = opts.limit ?? 3;
  const perHost = opts.perHost ?? 1;
  const terms = opts.terms || [];
  const relevance = opts.relevance;
  const seen = new Map();
  return candidates
    .map((c) => ({ ...c, ...gradeSource(c.url), ...scoreSource({ ...c, ...gradeSource(c.url) }, terms, { relevance }) }))
    .sort((a, b) => a.tier - b.tier || b.score - a.score)
    .filter((c) => {
      const n = seen.get(c.host) || 0;
      if (n >= perHost) return false;
      seen.set(c.host, n + 1);
      return true;
    })
    .slice(0, limit);
}

module.exports = { gradeSource, scoreSource, triage };
