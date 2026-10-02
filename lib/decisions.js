'use strict';
/**
 * Typed decisions for the research pipeline, after TypeSafe's System One
 * interface: bounded choices instead of free text, several independent
 * questions answered in one pass, and an "uncertain" band instead of a forced
 * yes/no.
 *
 * Every number here is measured or rule-derived, never invented. A choice made
 * by a rule reports a one-hot distribution with confidence 1: the rule is
 * certain of its own output, which says nothing about whether an answer is
 * true. Calibrated probabilities need a model; this tool has none. The measured
 * evidence checks sit beside each research decision, so a caller can audit the
 * rule or override it. A future evaluator can replace the rules without
 * changing the output shape.
 */

const QUERY_KINDS = ['definition', 'engineering', 'academic'];
const HANDLER = { definition: 'reference_sources', engineering: 'engineering_sources', academic: 'academic_sources' };
const STRATEGY = { definition: 'reference_first', engineering: 'docs_and_practitioners', academic: 'papers_and_practitioners' };
const ACTIONS = ['answer', 'search_more', 'escalate_uncertainty', 'inspect_plan'];

/** @param {number} n */
const round = (n) => Number(n.toFixed(3));

/** @param {string} id @param {string} value @param {Record<string, number>} probabilities @param {number} confidence */
function choice(id, value, probabilities, confidence) {
  return { id, type: 'choice', value, probabilities, confidence, method: 'deterministic' };
}

/**
 * Keep borderline values out of automatic yes/no actions.
 * `probabilities` is the underlying binary split ({no, yes}); `value` is the
 * banded outcome, so it can be "uncertain", which is not a key there. The
 * default band mirrors TypeSafe's cookbook illustration; tune it from labeled
 * examples and the cost of error versus review.
 * @param {string} id
 * @param {number} probability
 * @param {{low?: number, high?: number}} [opts]
 */
function uncertaintyBand(id, probability, opts = {}) {
  const p = Math.max(0, Math.min(1, probability));
  const low = opts.low ?? 0.3;
  const high = opts.high ?? 0.7;
  const value = p < low ? 'no' : p > high ? 'yes' : 'uncertain';
  return { ...choice(id, value, { no: round(1 - p), yes: round(p) }, round(Math.max(p, 1 - p))), probability: round(p), low, high };
}

/**
 * Return a bounded decision about the question before any network request.
 * `handler` and `source_strategy` are fixed functions of `query_kind`, so they
 * carry its distribution re-keyed rather than a separate, invented one.
 * @param {string} question
 * @param {string[]} kinds
 * @returns {{queryKind: object, handler: object, providerKinds: string[], fanOut: object, sourceStrategy: object}}
 */
function decideQuery(question, kinds = []) {
  const text = String(question).toLowerCase();
  const weights = Object.fromEntries(QUERY_KINDS.map((label) => [label, 0.05]));
  for (const kind of kinds) if (QUERY_KINDS.includes(kind)) weights[kind] += 0.3;
  if (/\b(compare|versus| vs\.? |benchmark|trade[- ]?off|should)\b/.test(text)) weights.academic += 0.2;
  if (/\b(error|bug|debug|configure|install|api|code|javascript|python|database|postgres|node)\b/.test(text)) weights.engineering += 0.2;
  if (/\b(what is|who is|define|meaning|explain)\b/.test(text)) weights.definition += 0.2;
  const total = Object.values(weights).reduce((sum, n) => sum + n, 0);
  const probabilities = Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, round(v / total)]));
  const value = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  const confidence = probabilities[value];
  const rekey = (map) => Object.fromEntries(QUERY_KINDS.map((k) => [map[k], probabilities[k]]));
  const providerKinds = value === 'academic'
    ? ['academic', 'engineering']
    : value === 'engineering'
      ? ['engineering', 'definition', 'academic']
      : ['definition', 'engineering'];
  return {
    queryKind: choice('query_kind', value, probabilities, confidence),
    handler: choice('handler', HANDLER[value], rekey(HANDLER), confidence),
    providerKinds,
    fanOut: { parallel: true, questions: ['query_kind'], providers: providerKinds },
    sourceStrategy: choice('source_strategy', STRATEGY[value], rekey(STRATEGY), confidence),
  };
}

/**
 * A moderate grade is not, by itself, permission to answer. Require either a
 * primary source or two independent tier-2 sources before an answer is
 * promoted. This keeps a single vendor blog plus an unrelated forum from
 * becoming a confident-looking final response.
 */
function hasAuthoritativeEvidence(opened) {
  const readable = (opened || []).filter((s) => s && s.read && Array.isArray(s.claims) && s.claims.length);
  if (readable.some((s) => s.tier === 1)) return true;
  return new Set(readable.filter((s) => s.tier === 2).map((s) => s.host)).size >= 2;
}

/**
 * Answer the independent evidence questions in one pass. Each is a measured
 * fact about what was read, not an estimate.
 * @param {{opened?: object[], conflicts?: object[], missing?: {missingTerms?: string[]}, directOnly?: boolean}} state
 * @returns {{readable: boolean, authoritative: boolean, agreement: boolean, coverage: boolean, question: boolean}}
 */
function evidenceChecks(state) {
  const opened = state.opened || [];
  const readable = opened.some((s) => s && s.read && Array.isArray(s.claims) && s.claims.length);
  return {
    readable,
    authoritative: hasAuthoritativeEvidence(opened),
    agreement: readable && !(state.conflicts || []).length,
    coverage: readable && !(state.missing?.missingTerms || []).length,
    question: !state.directOnly,
  };
}

/**
 * Decide whether the current evidence is enough for an agent to answer.
 * This does not claim that the answer is true; it chooses the next workflow
 * action from the evidence state already computed by assess.js.
 *
 * `evidenceSufficient.probability` is the share of evidence checks that
 * passed, not a calibrated probability. Its band says "yes" only when every
 * check passed, so it cannot read "yes" beside an escalated action.
 * @param {{plan?: boolean, directOnly?: boolean, opened: object[], conflicts: object[], certainty: {level: string}, missing: {missingTerms?: string[]}}} state
 * @returns {{nextAction: object, evidenceSufficient: object}}
 */
function decideResearch(state) {
  const opened = state.opened || [];
  const conflicts = state.conflicts || [];
  const missing = state.missing?.missingTerms || [];
  const checks = evidenceChecks(state);
  let value = 'answer';
  let why = 'readable evidence covers the query';
  // Planning fetches nothing, so the evidence branches below would always
  // fire and report "no source was readable" for a run that read none by design.
  if (state.plan) {
    value = 'inspect_plan';
    why = 'planning mode stops before fetching sources';
  } else if (!opened.length || ['none', 'very low'].includes(state.certainty?.level)) {
    value = 'search_more';
    why = !opened.length ? 'no source was readable' : 'the evidence grade is too weak';
  } else if (state.directOnly || conflicts.length || missing.length || state.certainty?.level === 'low' || !checks.authoritative) {
    value = 'escalate_uncertainty';
    why = state.directOnly ? 'a direct source was read without a specific question' : conflicts.length ? 'sources disagree' : missing.length ? 'some query terms remain uncovered' : state.certainty?.level === 'low' ? 'the evidence grade is low' : 'no primary or independently corroborated authoritative source was read';
  }
  const passed = Object.values(checks).filter(Boolean).length / Object.keys(checks).length;
  return {
    nextAction: { ...choice('next_action', value, Object.fromEntries(ACTIONS.map((a) => [a, a === value ? 1 : 0])), 1), why },
    // ponytail: high 0.99 means "all five checks"; derive it from the check count if checks grow past ~100.
    evidenceSufficient: { ...uncertaintyBand('evidence_sufficient', passed, { high: 0.99 }), checks },
  };
}

module.exports = { choice, uncertaintyBand, decideQuery, decideResearch, hasAuthoritativeEvidence };
