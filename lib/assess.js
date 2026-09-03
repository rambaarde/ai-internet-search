'use strict';
/**
 * Conflict detection and certainty grading — the reason this tool exists.
 *
 * Two documented failures are being corrected here.
 *
 * Models "favor the majority viewpoint among retrieved contexts, even when
 * opposing evidence is more credible" (arxiv 2505.17762). So certainty is
 * never a vote. A single tier-1 source outranks any number of tier-4 ones,
 * and agreement only raises certainty when it comes from independent sources.
 *
 * Models "can detect conflicts but struggle to localize them"
 * (arxiv 2506.08500). So a conflict is never smoothed into prose. When two
 * sources disagree, both are printed with their tier, and the disagreement is
 * named rather than resolved silently.
 *
 * Everything here is arithmetic on strings. No model, no embeddings, no
 * dependency: a heuristic that a reader can audit beats a black box that
 * cannot be argued with.
 */

/** Numbers with their units, which is what sources usually disagree about. */
function figures(text) {
  const out = [];
  const re = /(\d[\d,]*\.?\d*)\s*(%|ms|s\b|kb|mb|gb|x\b|connections?|cores?|threads?|seconds?|minutes?|hours?|days?)?/gi;
  let m;
  while ((m = re.exec(text))) {
    const value = Number(String(m[1]).replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    // Years and other bare large integers are rarely the disputed quantity.
    if (!m[2] && (value > 1900 && value < 2100)) continue;
    out.push({ value, unit: (m[2] || '').toLowerCase().replace(/s$/, '') });
  }
  return out;
}

/** Polarity: two sentences that say opposite things about the same subject. */
const NEGATIVE = /\b(not|never|avoid|don'?t|do not|cannot|can'?t|without|no longer|instead of|rather than|worse|slower|unsafe)\b/i;
const POSITIVE = /\b(should|must|always|use|prefer|recommend|better|faster|safe|correct)\b/i;

function polarity(text) {
  const neg = NEGATIVE.test(text);
  const pos = POSITIVE.test(text);
  if (neg && !pos) return -1;
  if (pos && !neg) return 1;
  return 0;
}

// "connection" vs "connections" is the same word to a reader; without this a
// singular claim and a plural one about the same thing can fall under the
// overlap threshold and a real conflict goes undetected.
const singular = (w) => (w.length > 4 && /[a-z]s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w);

/** Shared distinctive words, so only claims about the same thing are compared. */
function overlap(a, b) {
  const words = (s) =>
    new Set(
      (String(s).toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || []).map(singular)
    );
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

/**
 * Find claims that disagree.
 *
 * Two ways a disagreement is detectable without understanding the text: the
 * claims are about the same thing but state different numbers for the same
 * unit, or they are about the same thing with opposite polarity.
 *
 * Deliberately conservative. A missed conflict costs the reader nothing they
 * did not already have; a fabricated one destroys trust in every conflict the
 * tool reports.
 */
function findConflicts(sources) {
  const claims = [];
  for (const s of sources) {
    for (const c of s.claims || []) {
      claims.push({ text: c.text, tier: s.tier, host: s.host, url: s.url });
    }
  }

  const conflicts = [];
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i];
      const b = claims[j];
      if (a.host === b.host) continue;           // a page disagreeing with itself is not news
      if (overlap(a.text, b.text) < 0.35) continue; // not about the same thing

      const fa = figures(a.text);
      const fb = figures(b.text);
      const numeric = fa.some((x) =>
        fb.some((y) => x.unit && x.unit === y.unit && x.value !== y.value &&
          Math.max(x.value, y.value) / Math.max(1, Math.min(x.value, y.value)) >= 1.5)
      );
      const pa = polarity(a.text);
      const pb = polarity(b.text);
      const opposed = pa !== 0 && pb !== 0 && pa !== pb;

      if (!numeric && !opposed) continue;
      conflicts.push({
        kind: numeric ? 'figures differ' : 'opposite advice',
        a,
        b,
        // Named, never resolved by counting. The reader is told which source
        // is more credible and left to decide.
        prefer: a.tier === b.tier ? null : a.tier < b.tier ? a : b,
      });
    }
  }
  return conflicts;
}

/**
 * Grade certainty, after GRADE's four-level scale.
 *
 * Downgraded for the things that actually make an answer unsafe to act on:
 * nothing authoritative was read, only one source said it, or sources
 * disagree. Upgraded only for independent corroboration — agreement between
 * two pages of the same tier from different hosts — never for volume.
 */
function grade(sources, conflicts) {
  const read = sources.filter((s) => s.read && s.claims.length);
  if (!read.length) {
    return { level: 'none', why: 'no source could be read and understood' };
  }

  const best = Math.min(...read.map((s) => s.tier));
  const hosts = new Set(read.map((s) => s.host)).size;
  const corroborated = read.filter((s) => s.tier <= 2).length >= 2;

  let level;
  let why;
  if (best === 1 && corroborated) {
    level = 'high';
    why = 'a primary source, corroborated by another authoritative source';
  } else if (best === 1) {
    level = 'moderate';
    why = 'a primary source, but only one';
  } else if (best === 2 && hosts >= 2) {
    level = 'moderate';
    why = 'authoritative but secondary sources, independently agreeing';
  } else if (best <= 3) {
    level = 'low';
    why = 'no primary source was read. This is secondhand';
  } else {
    level = 'very low';
    why = 'only aggregator-tier sources were available';
  }

  // A live disagreement outranks any of the above. An answer with a known
  // contradiction in it is not "high certainty" whatever its sources.
  if (conflicts.length) {
    const order = ['none', 'very low', 'low', 'moderate', 'high'];
    const dropped = order[Math.max(0, order.indexOf(level) - 1)];
    return {
      level: dropped,
      why: `${why}; downgraded because ${conflicts.length} source disagreement(s) were found`,
    };
  }
  return { level, why };
}

/**
 * What the search could not settle. Reported explicitly, because a silent gap
 * is indistinguishable from a gap that does not exist.
 */
function gaps(sources, terms) {
  const covered = new Set();
  for (const s of sources) {
    for (const c of s.claims || []) {
      for (const t of terms) if (c.text.toLowerCase().includes(t)) covered.add(t);
    }
  }
  const missing = terms.filter((t) => !covered.has(t));
  const unread = sources.filter((s) => !s.read).map((s) => `${s.host} (${s.reason})`);
  return { missingTerms: missing, unread };
}

module.exports = { findConflicts, grade, gaps, figures, polarity, overlap };
