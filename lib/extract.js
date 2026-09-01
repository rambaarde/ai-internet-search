'use strict';
/**
 * Fetch a page and reduce it to claims.
 *
 * A page is never carried forward whole. Firecrawl's own figure for
 * HTML-to-markdown conversion is a 67% token reduction; going further, to
 * sentences that actually bear on the question, is closer to 95%. A 1 MB
 * article becomes a handful of lines.
 *
 * No dependency. An HTML parser would be the first one, and the job here is
 * not to render a page faithfully — it is to strip markup and keep sentences.
 * Being crude is acceptable; being wrong about which sentences matter is not,
 * so relevance is decided against the question rather than by position.
 */

const UA = 'ai-internet-search (+https://github.com/rambaarde/ai-internet-search)';
const TIMEOUT_MS = 10000;
const MAX_BYTES = 2_000_000;

/**
 * Strip a document to readable prose.
 *
 * Order matters: script and style contents must go before tags are removed, or
 * their bodies survive as text. That is how a 1 MB single-page app turns into
 * "850k characters of text" instead of nothing.
 */
function htmlToText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Numeric entities, decimal and hex. Pages that escape their apostrophes
    // as &#x27; are common, and leaving them raw puts literal markup in a claim.
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Split prose into sentences without a tokeniser. Crude, and sufficient. */
function sentences(text) {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z(])/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 400)
    // Drop navigation and boilerplate, which survive tag-stripping and read
    // like prose to a length filter.
    .filter((s) => !/^(cookie|privacy|subscribe|sign in|log in|menu|skip to|copyright|all rights)/i.test(s))
    .filter((s) => (s.match(/ /g) || []).length >= 6)
    // A page title is not a claim. Titles survive tag-stripping, are the right
    // length, and read like prose -- but "GitHub - supabase/supavisor: A
    // cloud-native pooler" asserts nothing the reader can act on. Separator
    // punctuation and a missing terminator are what distinguishes them.
    .filter((s) => !/\s[-|·—]\s/.test(s) || /[.!?]$/.test(s))
    .filter((s) => !/^(GitHub|GitLab)\s*[-:]/i.test(s));
}

/**
 * Score a sentence against the question's terms.
 *
 * Rewards covering distinct terms rather than repeating one — the same
 * relevance-minus-redundancy idea that governs which sources get opened,
 * applied inside a page.
 */
function scoreSentence(sentence, terms) {
  const s = sentence.toLowerCase();
  const covered = terms.filter((t) => s.includes(t));
  if (!covered.length) return 0;
  let score = covered.length / terms.length;
  // A sentence that states a number or a rule is usually the one worth having.
  if (/\d/.test(sentence)) score += 0.15;
  if (/\b(should|must|use|set|avoid|prefer|never|always|because)\b/i.test(sentence)) score += 0.1;
  return score;
}

/**
 * Fetch one source and return the claims it makes about the question.
 *
 * Failure is a result, not an exception: a source that cannot be read is
 * reported as unread with its reason, because "I could not open this" and "I
 * read it and it said nothing" are different answers and the caller must be
 * able to tell them apart.
 *
 * @param {{url: string, title: string, tier: number, host: string, why: string}} source
 * @param {string[]} terms
 * @param {{claims?: number}} [opts]
 */
async function extractClaims(source, terms, opts = {}) {
  const want = opts.claims ?? 3;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(source.url, {
      headers: { 'user-agent': UA, accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return { ...source, read: false, reason: `http ${res.status}`, claims: [] };

    const type = res.headers.get('content-type') || '';
    if (!/text\/html|text\/plain|application\/xhtml/.test(type)) {
      return { ...source, read: false, reason: `not readable (${type.split(';')[0] || 'unknown'})`, claims: [] };
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return { ...source, read: false, reason: `too large (${Math.round(buf.byteLength / 1024)}kb)`, claims: [] };
    }

    const text = htmlToText(Buffer.from(buf).toString('utf8'));
    const scored = sentences(text)
      .map((s) => ({ text: s, score: scoreSentence(s, terms) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);

    // Near-duplicate sentences are common on a page that restates its own
    // headline; keep the first of each.
    const claims = [];
    for (const c of scored) {
      const key = c.text.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 60);
      if (claims.some((k) => k.key === key)) continue;
      claims.push({ key, text: c.text, score: Number(c.score.toFixed(2)) });
      if (claims.length >= want) break;
    }

    return {
      ...source,
      read: true,
      reason: claims.length ? '' : 'read, but nothing addressed the question',
      bytes: buf.byteLength,
      claims: claims.map(({ text, score }) => ({ text, score })),
    };
  } catch (e) {
    const reason = e && e.name === 'AbortError' ? 'timed out' : `unreachable (${e && e.message ? e.message.slice(0, 40) : 'error'})`;
    return { ...source, read: false, reason, claims: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** Read several sources at once; one failure never sinks the others. */
async function readSources(sources, terms, opts = {}) {
  return Promise.all(sources.map((s) => extractClaims(s, terms, opts)));
}

module.exports = { htmlToText, sentences, scoreSentence, extractClaims, readSources };
