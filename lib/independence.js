'use strict';
/**
 * Independence audit: a copied page is not a second source.
 *
 * Certainty rises when two authoritative hosts agree (lib/assess.js). A wire
 * story that five outlets republish is one source on five hosts, and counted
 * per host it reads as corroboration it is not. This module finds such copies
 * among the pages that were read and marks each one with the page it copies.
 *
 * Two pages are the same source when one of these is true:
 *   - url:  their canonical URLs match (no www., trailing slash, or tracking
 *           parameters).
 *   - wire: both open with the same wire-service text. Outlets retitle wire
 *           copy and wrap it in their own site chrome, but the story text
 *           after "(Reuters) -" starts with the same words.
 *   - body: most word 5-shingles of the smaller page also occur in the other
 *           page. This is containment, not Jaccard: an outlet that adds its
 *           own chrome around a copy lowers the Jaccard score but not the
 *           containment of the copy in the original.
 *
 * Ported to JavaScript from hyperresearch core/independence.py, which uses
 * Jaccard on 3-shingles over extracted article bodies.
 * Copyright (c) 2026 Jordan Gibbs, MIT License.
 * https://github.com/jordan-gibbs/hyperresearch
 */

const TRACKING = /^(utm_|fbclid$|gclid$|ref$|source$)/;

/** Wire-service markers. Each one marks where the syndicated text starts. */
const WIRE_MARKERS = [
  'prnewswire', 'pr newswire', 'business wire', 'businesswire', 'globe newswire',
  'globenewswire', '(reuters)', '(ap)', 'associated press', 'accesswire', 'newsfile corp',
];

/** Shingle length in words. Independent pages rarely share 5 words in a row. */
const SHINGLE = 5;
/** Pages with fewer shingles than this are too short to call a copy. */
const MIN_SHINGLES = 30;
/** Fraction of the smaller page's shingles that must occur in the other page. */
const CONTAINMENT = 0.7;

/**
 * Normalize a URL so mirrors of one page compare equal.
 * Unparseable input is returned unchanged, so it still compares to itself.
 * @param {string} url
 * @returns {string}
 */
function canonicalUrl(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { return String(url); }
  const query = [...u.searchParams].filter(([k]) => !TRACKING.test(k.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const q = new URLSearchParams(query).toString();
  return `https://${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${q ? `?${q}` : ''}`;
}

/** @param {string} text @returns {Set<string>} word 5-grams, lowercased */
function shingles(text) {
  const words = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const out = new Set();
  for (let i = 0; i + SHINGLE <= words.length; i++) out.add(words.slice(i, i + SHINGLE).join(' '));
  return out;
}

/** Share of the smaller set that is also in the larger set; 0 for short pages. */
function containment(a, b) {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size < MIN_SHINGLES) return 0;
  let shared = 0;
  for (const s of small) if (big.has(s)) shared++;
  return shared / small.size;
}

/**
 * The marker plus the first ten words after it, or null when the opening
 * 1500 characters name no wire service.
 * @param {string} text
 * @returns {string|null}
 */
function wireSignature(text) {
  const head = String(text || '').slice(0, 1500).toLowerCase();
  for (const m of WIRE_MARKERS) {
    const at = head.indexOf(m);
    if (at < 0) continue;
    const words = (head.slice(at + m.length).match(/[\p{L}\p{N}]{4,}/gu) || []).slice(0, 10);
    if (words.length === 10) return `${m}|${words.join(' ')}`;
  }
  return null;
}

/**
 * Mark each read page that copies another read page.
 *
 * A copy gets `copyOf` (the URL of the page it copies) and `copyKind` (url,
 * wire, or body). Within a group of copies the root is the most authoritative
 * page (lowest tier), and the earliest in the given order on a tie. The root
 * gets no mark. Pages without `text` are skipped. Mutates and returns `sources`.
 *
 * @param {{url: string, tier: number, read?: boolean, text?: string}[]} sources
 * @returns {typeof sources}
 */
function markCopies(sources) {
  const pages = sources.filter((s) => s.read && s.text);
  const parent = pages.map((_, i) => i);
  const kind = new Map();
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const union = (a, b, k) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    parent[rb] = ra;
    kind.set(b, kind.get(b) || k);
    kind.set(a, kind.get(a) || k);
  };

  const keys = pages.map((p) => ({ url: canonicalUrl(p.url), wire: wireSignature(p.text), sh: shingles(p.text) }));
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      if (find(i) === find(j)) continue;
      if (keys[i].url === keys[j].url) union(i, j, 'url');
      else if (keys[i].wire && keys[i].wire === keys[j].wire) union(i, j, 'wire');
      else if (containment(keys[i].sh, keys[j].sh) >= CONTAINMENT) union(i, j, 'body');
    }
  }

  const groups = new Map();
  pages.forEach((_, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) || []), i]);
  });
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    // ponytail: pairwise O(n^2) over pages read in one run (single digits).
    const root = members.reduce((best, i) => (pages[i].tier < pages[best].tier ? i : best));
    for (const i of members) {
      if (i === root) continue;
      pages[i].copyOf = pages[root].url;
      pages[i].copyKind = kind.get(i);
    }
  }
  return sources;
}

module.exports = { canonicalUrl, wireSignature, markCopies };
