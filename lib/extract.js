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

const { createHash } = require('node:crypto');
const { renderPage } = require('./render');

const UA = 'ai-internet-search (+https://github.com/rambaarde/ai-internet-search)';
const TIMEOUT_MS = 10000;
// Technical documents can be large (RFC 9110 is several megabytes), but an
// unbounded fetch is still an easy way to turn one search into a memory spike.
// Keep a generous bounded ceiling and report anything larger as unread.
const MAX_BYTES = 8_000_000;

/** Return a stable audit fingerprint for the exact bytes that were read. */
function contentHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

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
    // <title> is metadata, not prose, and with no block tag after it the
    // title glues onto the first heading as one long pseudo-sentence.
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|title)\b[\s\S]*?<\/\1>/gi, ' ')
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
    .filter((s) => !/^(cookie|privacy|subscribe|sign in|log in|menu|skip to|copyright|all rights|you signed in|you signed out|you switched accounts|you must be signed in)/i.test(s))
    .filter((s) => (s.match(/ /g) || []).length >= 6)
    // A page title is not a claim. Titles survive tag-stripping, are the right
    // length, and read like prose -- but "GitHub - supabase/supavisor: A
    // cloud-native pooler" asserts nothing the reader can act on. Separator
    // punctuation and a missing terminator are what distinguishes them.
    .filter((s) => !/\s[-|·—]\s/.test(s) || /[.!?]$/.test(s))
    .filter((s) => !/^(GitHub|GitLab)\s*[-:]/i.test(s))
    .filter(claimLike);
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

// Search pages frequently expose metadata as prose: keywords, version tables,
// and SEO fields are long enough to look like claims but do not answer a
// question. They are never useful evidence when quoted on their own.
const METADATA = /^(?:target keyword|keywords?|tags?|categories?|authors?|published|updated|added in|history version changes|table of contents|email spam detection)\b/i;
const PROMOTIONAL = /^(?:get early access|why .+\b(?:could be|will be) the future)\b|\b(?:industry-wide interest|positioning the discovery as a potential solution)\b/i;
// A post announcing what it is about to do ("In this post, we'll explore...")
// states no finding. Narrow on purpose: "In this paper, we show X" is a claim.
const SIGNPOST = /^in this (?:post|article|guide|tutorial|section),? we(?:['’]ll| will)\b/i;
// Source code that survived tag-stripping. `Jt. title("…").use();` shared
// words with a real claim, read as advice through "use", and was reported
// as "opposite advice". Statement terminators and arrows only: prose with
// inline code ("Call connect() before query().") ends in a full stop.
const CODE = /[;{}]\s*$|=>|^(?:const|let|var|import|export|return|function|def|class)\s/;
const CLAIM_VERB = /\b(?:is|are|was|were|means|refers? to|defines?|describes?|provides?|supports?|allows?|enables?|helps?|requires?|uses?|should|must|can|cannot|shows?|introduces?)\b/i;

function claimLike(sentence) {
  if (METADATA.test(sentence) || PROMOTIONAL.test(sentence) || SIGNPOST.test(sentence) || CODE.test(sentence)) return false;
  // A lower-case fragment ending in a comma is usually a table or DOM text
  // split in the middle (for example, a Node.js API signature), not a claim.
  if (/^[a-z]/.test(sentence) && !/[.!?]$/.test(sentence)) return false;
  // Keep complete prose, and a small set of imperative/definition sentences
  // whose source omitted terminal punctuation.
  return /[.!?]$/.test(sentence) || CLAIM_VERB.test(sentence);
}

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

/** Lower-case, punctuation to spaces, collapsed: for comparing a line to the page title. */
const flat = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Reduce one page's raw HTML to the claims it makes about the question.
 *
 * Factored out so the fetched page and, when it fails, the browser-rendered
 * page go through exactly the same scoring -- a rendered claim is scored no
 * differently from a fetched one.
 */
function harvest(raw, terms, want, opts = {}) {
  const text = htmlToText(raw);
  const media = findVisuals(raw, terms, { limit: 2 });
  // Page chrome that reads like prose, dropped before scoring because it
  // matches every query term and so outranks the findings it names:
  // - the page's own <title>, repeated as a heading ("[2307.03172] Lost in the
  //   Middle: ...") or a labelled line ("Title: Lost in the Middle: ...");
  // - the title wrapped in words that assert nothing ("View a PDF of the paper
  //   titled Lost in the Middle: ..., by Nelson F.");
  // - an unpunctuated heading ("Why context engineering is important to
  //   building capable agents"). A heading that is a full sentence stays.
  const rawTitle = htmlToText((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw) || [])[1] || '');
  const title = flat(rawTitle);
  // Without the arXiv-style "[id]" prefix and a " | Site" / " - Site" suffix.
  const core = flat(rawTitle.replace(/^\s*\[[^\]]*\]\s*/, '').split(/\s[|–—-]\s/)[0]);
  const headings = new Set([...raw.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)].map((m) => flat(htmlToText(m[1]))));
  const chrome = (s) => {
    const f = flat(s.replace(/^[\p{L} ]{1,20}:\s*/u, ''));
    if (title && (title.includes(f) || core.includes(f))) return true;
    if (core.length >= 20 && f.includes(core) && !CLAIM_VERB.test(f.replace(core, ' '))) return true;
    return !/[.!?]$/.test(s) && headings.has(flat(s));
  };
  const scored = sentences(text)
    .filter((s) => !chrome(s))
    .map((s, index) => ({
      text: s,
      // A source-only URL has no semantic question to score against. Prefer
      // the document's opening definitions and stated scope instead of
      // ranking arbitrary later references that happen to repeat its slug.
      score: opts.directOnly
        ? (1 / (index + 1)) + (DEFINITION.test(s) ? 1 : 0) + (/\b(?:describes?|protocol|api)\b/i.test(s) ? 0.2 : 0)
        : scoreSentence(s, terms),
    }))
    .filter((c) => c.score > 0)
    // One incidental word from a long query is not enough to quote a page.
    // Short questions still allow a single distinctive term; longer queries
    // need either two covered terms or a very strong sentence score.
    .filter((c) => opts.directOnly || terms.length <= 3 || c.score >= 0.5 || terms.filter((t) =>
      c.text.toLowerCase().includes(String(t).toLowerCase())).length >= 2)
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
  return { text, claims: claims.map(({ text, score }) => ({ text, score })), visuals: media.visuals, pointers: media.pointers };
}

/**
 * Last-resort escalation for a source fetch() could not read: render it in a
 * headless browser and harvest the DOM. Returns a read source only if the
 * render actually produced claims; otherwise null, so the caller keeps the
 * original "could not read" state. Off unless the caller asked (--render), and
 * a no-op when no browser is installed. With opts.browser it renders in that
 * already-running browser instead of a headless one.
 */
async function tryRender(source, terms, want, opts) {
  if (!opts.render) return null;
  const html = await renderPage(source.url, { timeoutMs: opts.renderTimeoutMs, browserUrl: opts.browser });
  if (!html) return null;
  const h = harvest(html, terms, want, opts);
  if (!h.claims.length) return null;
  return {
    ...source, read: true, rendered: true, reason: '',
    bytes: Buffer.byteLength(html), contentHash: contentHash(html), claims: h.claims,
    visuals: h.visuals, visualPointers: h.pointers,
  };
}

/**
 * Stack Overflow answers a plain fetch of a question page with a 403 bot wall,
 * but its public API returns the same answers, keyless. Returns the API URL
 * for a question page, or null for any other URL.
 */
function stackOverflowApi(url) {
  const m = /^https:\/\/stackoverflow\.com\/questions\/(\d+)/.exec(url);
  return m && `https://api.stackexchange.com/2.3/questions/${m[1]}/answers?filter=withbody&sort=votes&pagesize=5&site=stackoverflow`;
}

/**
 * Fetch one source and return the claims it makes about the question.
 *
 * Failure is a result, not an exception: a source that cannot be read is
 * reported as unread with its reason, because "I could not open this" and "I
 * read it and it said nothing" are different answers and the caller must be
 * able to tell them apart. A source dropped as client-rendered or 403 is, when
 * --render is on and a browser is present, retried through the browser first.
 *
 * @param {{url: string, title: string, tier: number, host: string, why: string}} source
 * @param {string[]} terms
 * @param {{claims?: number, render?: boolean, browser?: string, renderTimeoutMs?: number}} [opts]
 */
async function extractClaims(source, terms, opts = {}) {
  const want = opts.claims ?? 3;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const api = stackOverflowApi(source.url);
  try {
    const res = await fetch(api || source.url, {
      headers: { 'user-agent': UA, accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) {
      // A 403 is often anti-bot rather than a real absence; a real browser may
      // get the page a bare fetch cannot. Other statuses (404, 500) are genuine
      // and rendering would not change them.
      if (res.status === 403) { const r = await tryRender(source, terms, want, opts); if (r) return r; }
      return { ...source, read: false, reason: `http ${res.status}`, claims: [] };
    }

    const type = res.headers.get('content-type') || '';
    if (!api && !/text\/html|text\/plain|application\/xhtml/.test(type)) {
      return { ...source, read: false, reason: `not readable (${type.split(';')[0] || 'unknown'})`, claims: [] };
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return { ...source, read: false, reason: `too large (${Math.round(buf.byteLength / 1024)}kb)`, claims: [] };
    }

    const hash = contentHash(Buffer.from(buf));

    let raw = Buffer.from(buf).toString('utf8');
    // Answer bodies are HTML, so they go through the same harvest as a page.
    if (api) raw = (JSON.parse(raw).items || []).map((a) => `<div>${a.body}</div>`).join('');
    const h = harvest(raw, terms, want, opts);

    // Only when nothing was extracted anyway, so a short page that does answer
    // the question is never discarded by this check.
    if (!h.claims.length && h.text.length < 200 && CLIENT_ROOT.test(raw)) {
      const r = await tryRender(source, terms, want, opts);
      if (r) return r;
      return { ...source, read: false, reason: 'client-rendered, no server-side text', claims: [] };
    }

    return {
      ...source,
      read: true,
      reason: h.claims.length ? '' : 'read, but nothing addressed the question',
      bytes: buf.byteLength,
      contentHash: hash,
      claims: h.claims,
      // Surfaced, not interpreted. The caller has vision; this does not.
      visuals: h.visuals,
      visualPointers: h.pointers,
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

module.exports = { htmlToText, sentences, scoreSentence, contentHash, extractClaims, readSources, stackOverflowApi };

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
