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
// "It should be set to 10 connections" reads as a claim about nothing once
// quoted alone: the antecedent for "it" lived in the sentence before, which
// this tool does not carry forward. Deprioritized, not dropped -- still the
// best available claim if nothing else on the page addresses the question.
const ORPHANED_SUBJECT = /^(it|this|that|these|those|they|he|she)\b/i;

// The same problem, measured across the whole sentence rather than at its
// front. "Set it to 10 because their pooler caps there" carries its
// antecedents in the sentence before, which this tool does not carry forward,
// and none of its pronouns are the first word.
const PRONOUN = /\b(it|its|this|that|these|those|they|them|their|he|she|his|her)\b/gi;

// A definition names its own subject and states what it is, which is exactly
// what a quotation lifted out of its page has to do to still mean something.
const DEFINITION = /\b\w+\s+(?:is|are)\s+(?:a|an|the)\s|\brefers? to\b|\bdefined as\b/i;

function scoreSentence(sentence, terms) {
  // Folded, for the same reason the candidate filter folds: a Spanish page
  // writes "climático" and the query carries "climatico".
  const s = String(sentence).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const covered = terms.filter((t) => s.includes(String(t).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')));
  if (!covered.length) return 0;
  let score = covered.length / terms.length;
  // A sentence that states a number or a rule is usually the one worth having.
  if (/\d/.test(sentence)) score += 0.15;
  if (/\b(should|must|use|set|avoid|prefer|never|always|because)\b/i.test(sentence)) score += 0.1;
  if (DEFINITION.test(sentence)) score += 0.1;
  if (ORPHANED_SUBJECT.test(sentence.trim())) score -= 0.2;
  const words = sentence.split(/\s+/).filter(Boolean).length;
  const pronouns = (sentence.match(PRONOUN) || []).length;
  if (words && pronouns / words > 0.05) score -= 0.15;
  return score;
}

// A single-page app serves its framework's mount point and nothing else. The
// markup is large, the readable text is empty, and without this the page is
// reported as "read, but nothing addressed the question" -- which says the
// source was consulted and had no answer. It was never readable at all, and
// the caller has to be able to tell those apart.
const CLIENT_ROOT = /<div[^>]+id=["'](?:app|root|__next|__nuxt)["']/i;

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

    const raw = Buffer.from(buf).toString('utf8');
    const text = htmlToText(raw);
    const media = findVisuals(raw, terms, { limit: 2 });
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

    // Only when nothing was extracted anyway, so a short page that does answer
    // the question is never discarded by this check.
    if (!claims.length && text.length < 200 && CLIENT_ROOT.test(raw)) {
      return { ...source, read: false, reason: 'client-rendered, no server-side text', claims: [] };
    }

    return {
      ...source,
      read: true,
      reason: claims.length ? '' : 'read, but nothing addressed the question',
      bytes: buf.byteLength,
      claims: claims.map(({ text, score }) => ({ text, score })),
      // Surfaced, not interpreted. The caller has vision; this does not.
      visuals: media.visuals,
      visualPointers: media.pointers,
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

/**
 * Find the visuals on a page that carry information.
 *
 * Alt text does not work for this, and the measurement is not close: across
 * three real technical pages, two had no usable alt at all and Wikipedia's
 * "descriptive" alts were "The Free Encyclopedia" and "Wikimedia Foundation".
 * Building on alt text would surface logos.
 *
 * Two signals do work. The filename is written by whoever made the image, so
 * Postgres_Chart.png announces itself where avatar-093da3e6.svg does too. And
 * the prose points at what matters: "you can see from the chart that reducing
 * the pool size..." is the page telling you the visual carries the argument.
 *
 * The tool cannot see the image and does not try. It surfaces the URL and the
 * sentence that points at it; the model calling this has vision and can look.
 * Discrimination here, understanding there.
 */
const CHROME = /avatar|icon|logo|badge|spacer|emoji|favicon|sprite|pixel|tracking|button|arrow|bullet|placeholder|profile|banner-ad/i;

function findVisuals(html, terms, opts = {}) {
  const want = opts.limit ?? 3;
  const urls = [...html.matchAll(/(?:src|href)="([^"]+\.(?:png|jpe?g|gif|svg|webp))"/gi)]
    .map((m) => m[1])
    .filter((u) => !CHROME.test(u));

  // Sentences that tell you a visual carries part of the argument.
  const text = htmlToText(html);
  const pointers = (text.match(/[^.!?]*\b(chart|graph|diagram|figure|video|screenshot|image|plot|benchmark)\b[^.!?]*[.!?]/gi) || [])
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 300)
    .filter((s) => terms.some((t) => s.toLowerCase().includes(t)));

  const seen = new Set();
  const visuals = [];
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const name = decodeURIComponent(url.split('/').pop() || '').replace(/\.\w+$/, '').toLowerCase();
    // The filename earns its place: it must mention the question, or say it is
    // the kind of image that carries data.
    const named = terms.some((t) => name.includes(t));
    const kind = /chart|graph|diagram|figure|plot|benchmark|architecture|flow/.test(name);
    if (!named && !kind) continue;
    visuals.push({ url, name, why: named ? 'filename matches the question' : 'filename says it carries data' });
    if (visuals.length >= want) break;
  }
  return { visuals, pointers: pointers.slice(0, 2) };
}

module.exports.findVisuals = findVisuals;
