'use strict';
/**
 * Optional Jev (System One) evaluator.
 *
 * decisions.js calls itself "the open-source analogue of a System One
 * interface", and its choice/score/noul primitives are exactly the three
 * question types TypeSafe's Jev answers. This wires the real model in behind
 * that seam, and nowhere else. Jev never fetches a page and never ranks a
 * source by credibility: tiering stays deterministic and auditable, because a
 * reader who can argue with a rule is the whole reason this tool exists. Jev
 * refines the fuzzy judgements — which kind of question this is, which
 * candidates are worth opening, whether two claims disagree, how strong the
 * evidence is — where a learned model reads meaning that a regex cannot.
 *
 * The contract is the one the rest of the tool already keeps: degrade, never
 * fail. Jev is on only when TYPESAFE_API_KEY is set, exactly as a search key
 * turns a web provider on. A missing key, a non-200, a timeout, a malformed
 * reply, or an answer below the confidence floor all return the deterministic
 * result unchanged. So the tool installs and runs offline of any account just
 * as before, and turning Jev on can improve a decision but never break one.
 *
 * Confidence is gated deliberately. TypeSafe is explicit that Jev's confidence
 * "is a margin, not a probability that the answer is right", so a low-margin
 * answer is treated as no answer and the heuristic stands. Tune the floor from
 * your own labelled workload, not from this default.
 *
 * No dependency: the API is plain JSON over the fetch that ships with Node 18,
 * the same way every provider here already talks to the network. The wire
 * shape follows TypeSafe's documented /v1/systemone contract; a reply that is
 * not that shape parses to null and the heuristic takes over, so an API change
 * degrades the feature rather than crashing the tool.
 */

const { choice, planForKind } = require('./decisions');
const { overlap } = require('./assess');

const DEFAULTS = {
  url: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-latest',
  timeoutMs: 4000,
  // A margin, not a probability of correctness. 0.55 keeps only answers Jev is
  // meaningfully sure of; below it the auditable heuristic is the safer bet.
  minConfidence: 0.55,
};

// --- helpers ---------------------------------------------------------------

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const clamp01 = (n) => Math.max(0, Math.min(1, n));
const trim = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function topKey(obj) {
  if (!obj || typeof obj !== 'object') return undefined;
  return Object.entries(obj).sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0];
}

/**
 * Resolve Jev configuration from flags and environment. `enabled` is the whole
 * opt-in: the key must be present, and --no-jev (force === false) turns it off
 * even when it is. --jev (force === true) is an explicit affirmation that also
 * lets the CLI say so when the key is missing, instead of silently doing
 * nothing — the same "say it plainly when an opt-in cannot happen" the
 * --render path already keeps.
 *
 * @param {{jev?: boolean, plan?: boolean}} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 */
function config(opts = {}, env = process.env) {
  const key = env.TYPESAFE_API_KEY || '';
  const force = opts.jev; // true | false | undefined
  // --plan promises to fetch nothing and cost nothing, so a paid Jev call has
  // no business running under it: the plan is the deterministic preview.
  const enabled = force !== false && !opts.plan && !!key;
  return {
    enabled,
    requested: force === true,
    key,
    url: env.TYPESAFE_API_URL || DEFAULTS.url,
    model: env.JEV_MODEL || DEFAULTS.model,
    timeoutMs: num(env.JEV_TIMEOUT_MS) || DEFAULTS.timeoutMs,
    minConfidence: num(env.JEV_MIN_CONFIDENCE) ?? DEFAULTS.minConfidence,
    // Zero data retention is available per request on TypeSafe's paid plans;
    // asking for it is free where it is not honoured, so it is the default.
    retention: env.JEV_RETAIN !== '0',
  };
}

/**
 * One call to Jev: state in, typed answers out. Returns a map of answers keyed
 * by question id, or null on any failure — a missing key, a non-200, a
 * timeout, or a body that is not the shape we asked for. Null always means
 * "fall back to the heuristic".
 *
 * @param {string|object} state
 * @param {Record<string, object>} questions  Jev question specs, keyed by id
 * @param {ReturnType<typeof config>} cfg
 * @param {{fetchImpl?: Function}} [io]  test seam: inject fetch so no network
 * @returns {Promise<Record<string, {value: any, probabilities: object|null, confidence: number}>|null>}
 */
async function ask(state, questions, cfg, io = {}) {
  if (!cfg || !cfg.enabled || !cfg.key) return null;
  const doFetch = io.fetchImpl || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` };
    if (cfg.retention) headers['x-typesafe-no-retention'] = '1';
    const res = await doFetch(cfg.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: cfg.model, state, questions }),
      signal: ctrl.signal,
    });
    if (!res || !res.ok) return null;
    const body = await res.json();
    const answers = body && body.answers;
    if (!answers || typeof answers !== 'object') return null;
    const out = {};
    for (const [id, a] of Object.entries(answers)) {
      const parsed = readAnswer(a);
      if (parsed) out[id] = parsed;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read one Jev answer into a common shape, tolerant of how the field is named
 * across the three question types. Anything missing its essentials returns
 * null, so a reply we did not expect degrades to the heuristic rather than
 * crashing — the same "failure is null" contract as the browser render.
 */
function readAnswer(a) {
  if (!a || typeof a !== 'object') return null;
  const confidence = num(a.confidence ?? a.margin ?? a.certainty) ?? 0;
  // choice: a named value, usually with a probability distribution.
  if (a.choice !== undefined || a.probabilities) {
    const value = a.choice ?? a.value ?? topKey(a.probabilities);
    if (value === undefined || value === null) return null;
    return { value: String(value), probabilities: a.probabilities || null, confidence };
  }
  // noul: a single probability in [0, 1].
  const p = num(a.probability ?? a.value ?? a.yes);
  if (p !== null) return { value: clamp01(p), probabilities: null, confidence };
  // score: a level and/or a normalised value.
  const lvl = a.level ?? a.value;
  if (lvl !== undefined && lvl !== null) return { value: lvl, probabilities: null, confidence };
  return null;
}

/** Whether a parsed answer clears the confidence floor and should be trusted. */
function trust(cfg, parsed) {
  return !!parsed && Number(parsed.confidence) >= cfg.minConfidence;
}

// --- refiners: each returns the deterministic value untouched on fallback ---

const QUERY_KINDS = {
  definition: 'The question asks what something is, or for a definition or meaning.',
  engineering: 'The question is about building, debugging, configuring, or how something behaves in practice.',
  academic: 'The question compares approaches or asks what research, benchmarks, or studies show.',
};

/**
 * Replace the regex-weighted query kind (decisions.decideQuery) with Jev's
 * classification when it is confident. The heuristic is English-only and
 * misroutes a question asked in another language; Jev reads the meaning. The
 * downstream shape is rebuilt through the same planForKind() the heuristic
 * uses, so the provider fan-out and every caller are unchanged — only who
 * chose the value, and the stamped method, differ.
 *
 * @returns {Promise<object>} a decideQuery-shaped decision
 */
async function refineQuery(question, deterministic, cfg, io) {
  if (!cfg.enabled) return deterministic;
  const answers = await ask(String(question), { query_kind: { type: 'choice', criteria: QUERY_KINDS } }, cfg, io);
  const a = answers && answers.query_kind;
  if (!trust(cfg, a) || !QUERY_KINDS[a.value]) return deterministic;
  const probs = a.probabilities || peak(a.value, Object.keys(QUERY_KINDS), a.confidence);
  return planForKind(a.value, probs, Number(a.confidence.toFixed(3)), 'jev');
}

/** A peaked distribution over labels, for when Jev returns only the winner. */
function peak(winner, labels, confidence) {
  const rest = (1 - confidence) / Math.max(1, labels.length - 1);
  return Object.fromEntries(labels.map((l) => [l, Number((l === winner ? confidence : rest).toFixed(3))]));
}

/**
 * Ask Jev how relevant each candidate is to the question, in one batched call,
 * BEFORE any page is fetched — the point in the pipeline where a better "do
 * not open this" saves the most tokens. Returns a Map url -> relevance in
 * [0, 1] for the confident answers only, or null to leave triage's title-match
 * heuristic in place. Only titles and hosts are sent, never page bodies:
 * nothing is fetched here, and Jev degrades on oversized, noisy state.
 *
 * @returns {Promise<Map<string, number>|null>}
 */
async function relevance(question, candidates, cfg, io) {
  if (!cfg.enabled || !Array.isArray(candidates) || !candidates.length) return null;
  const list = candidates.slice(0, 30); // bound the state and the bill
  const questions = {};
  const urlFor = new Map();
  list.forEach((c, i) => {
    const id = `rel_${i}`;
    urlFor.set(id, c.url);
    questions[id] = {
      type: 'noul',
      instructions: `Does this source likely answer the question? Title: "${trim(c.title, 160)}" — host: ${hostOf(c.url)}.`,
    };
  });
  const answers = await ask({ question: String(question) }, questions, cfg, io);
  if (!answers) return null;
  const map = new Map();
  for (const [id, a] of Object.entries(answers)) {
    const url = urlFor.get(id);
    if (url && trust(cfg, a) && typeof a.value === 'number') map.set(url, a.value);
  }
  return map.size ? map : null;
}

/**
 * Add the disagreements the string heuristic structurally cannot see.
 *
 * assess.findConflicts is deliberately literal: it fires on differing figures
 * or opposite polarity words. Two claims can contradict with neither — "safe
 * to share across threads" versus "must never be shared between threads" — and
 * the arxiv work this tool cites finds models detect a conflict well even when
 * they cannot localise it. So Jev is used ONLY as an extra detector, over the
 * topically-related pairs the heuristic left unflagged, and every hit it adds
 * is labelled model-flagged so a reader weighs it apart from the auditable
 * ones. It never removes or overrides a heuristic conflict.
 *
 * @returns {Promise<object[]>} existing conflicts, possibly with model-flagged ones appended
 */
async function augmentConflicts(sources, existing, cfg, io) {
  if (!cfg.enabled) return existing;
  const claims = [];
  for (const s of sources || []) {
    for (const c of s.claims || []) claims.push({ text: c.text, tier: s.tier, host: s.host, url: s.url });
  }
  // The heuristic already owns these pairs; do not pay to re-check them.
  const already = new Set(existing.map((c) => pairKey(c.a, c.b)));
  const pairs = [];
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i];
      const b = claims[j];
      if (a.host === b.host) continue;              // a page disagreeing with itself is not news
      if (overlap(a.text, b.text) < 0.35) continue; // not about the same thing
      if (already.has(pairKey(a, b))) continue;
      pairs.push({ a, b });
      if (pairs.length >= 8) break;                 // bound the state and the bill
    }
    if (pairs.length >= 8) break;
  }
  if (!pairs.length) return existing;

  const questions = {};
  pairs.forEach((p, i) => {
    questions[`cf_${i}`] = {
      type: 'noul',
      instructions: `Do these two statements disagree about the same thing? A: "${trim(p.a.text, 220)}" B: "${trim(p.b.text, 220)}"`,
    };
  });
  const answers = await ask({ task: 'contradiction detection' }, questions, cfg, io);
  if (!answers) return existing;

  const added = [];
  pairs.forEach((p, i) => {
    const a = answers[`cf_${i}`];
    if (trust(cfg, a) && typeof a.value === 'number' && a.value > 0.5) {
      added.push({
        kind: 'semantic disagreement (model-flagged)',
        method: 'jev',
        confidence: Number(a.confidence.toFixed(3)),
        a: p.a,
        b: p.b,
        prefer: p.a.tier === p.b.tier ? null : p.a.tier < p.b.tier ? p.a : p.b,
      });
    }
  });
  return added.length ? existing.concat(added) : existing;
}

const pairKey = (a, b) => [`${a.host}:${trim(a.text, 40)}`, `${b.host}:${trim(b.text, 40)}`].sort().join('||');

const CERTAINTY_LEVELS = {
  high: 'A primary source, corroborated by another authoritative source.',
  moderate: 'Authoritative but secondary, or a single primary source.',
  low: 'No primary source was read; the evidence is secondhand.',
  'very low': 'Only aggregator-tier sources were available.',
  none: 'Nothing could be read and understood.',
};
const NEXT_ACTIONS = {
  answer: 'The evidence is strong and complete enough to answer.',
  search_more: 'Too little or too weak; the workflow should search more.',
  escalate_uncertainty: 'Enough to report, but with conflicts or gaps that need a caveat.',
  inspect_plan: 'Planning only; nothing was fetched.',
};

/**
 * Refine the certainty grade and the next workflow action together, in one
 * batched call. Both are trust-critical, so Jev only ever overrides a
 * confident answer, the override is stamped method 'jev', and its reason is
 * Jev-authored rather than the heuristic's — a level and a why that contradict
 * each other would be worse than either alone. The evidence summary sent is
 * small by construction (tiers, hosts, counts), never page text.
 *
 * @param {object} state  { opened, conflicts, missing }
 * @param {{certainty: object, decision: object}} det  the deterministic results
 * @returns {Promise<{certainty: object, decision: object}>}
 */
async function refineAssessment(state, det, cfg, io) {
  if (!cfg.enabled) return det;
  const opened = state.opened || [];
  const summary = {
    read: opened.filter((s) => s.read).map((s) => ({ tier: s.tier, host: s.host, claims: (s.claims || []).length })),
    unreadable: opened.filter((s) => !s.read).length,
    conflicts: (state.conflicts || []).length,
    uncovered_terms: (state.missing?.missingTerms || []).length,
  };
  const answers = await ask(summary, {
    certainty: { type: 'choice', criteria: CERTAINTY_LEVELS },
    next_action: { type: 'choice', criteria: NEXT_ACTIONS },
  }, cfg, io);
  if (!answers) return det;

  let certainty = det.certainty;
  const cA = answers.certainty;
  if (trust(cfg, cA) && CERTAINTY_LEVELS[cA.value]) {
    certainty = { level: cA.value, why: `jev graded this ${cA.value} (confidence ${cA.confidence.toFixed(2)})`, method: 'jev' };
  }
  let decision = det.decision;
  const nA = answers.next_action;
  if (trust(cfg, nA) && NEXT_ACTIONS[nA.value]) {
    decision = {
      ...det.decision,
      nextAction: { ...choice('next_action', nA.value, nA.probabilities || peak(nA.value, Object.keys(NEXT_ACTIONS), nA.confidence), Number(nA.confidence.toFixed(3))), method: 'jev', why: `jev chose ${nA.value} (confidence ${nA.confidence.toFixed(2)})` },
    };
  }
  return { certainty, decision };
}

module.exports = { config, ask, readAnswer, trust, refineQuery, relevance, augmentConflicts, refineAssessment };
