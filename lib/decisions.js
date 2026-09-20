'use strict';
/**
 * Small, typed decision primitives for the research pipeline.
 *
 * This is the open-source analogue of a System One interface: the evaluator
 * may be heuristic today, but its output shape is bounded and composable.
 * Keeping the shape separate from the evaluator lets a future local or remote
 * model replace these heuristics without changing callers or output formats.
 */

/** @param {string} id @param {string} value @param {Record<string, number>} probabilities @param {number} confidence */
function choice(id, value, probabilities, confidence) {
  return { id, type: 'choice', value, probabilities, confidence, method: 'deterministic' };
}

/** @param {string} id @param {number} value @param {number} min @param {number} max @param {number} confidence */
function score(id, value, min = 0, max = 1, confidence = 1) {
  return { id, type: 'score', value: Math.max(min, Math.min(max, value)), min, max, confidence, method: 'deterministic' };
}

/** @param {string} id @param {number} probability @param {number} confidence */
function noul(id, probability, confidence = 1) {
  return { id, type: 'noul', value: Math.max(0, Math.min(1, probability)), confidence, method: 'deterministic' };
}

/**
 * Keep borderline probabilities out of automatic yes/no actions.
 * The default band mirrors TypeSafe's cookbook illustration; production users
 * should tune it from labeled examples and the cost of error versus review.
 * @param {string} id
 * @param {number} probability
 * @param {{low?: number, high?: number}} [opts]
 */
function uncertaintyBand(id, probability, opts = {}) {
  const low = opts.low ?? 0.3;
  const high = opts.high ?? 0.7;
  const value = probability < low ? 'no' : probability > high ? 'yes' : 'uncertain';
  return {
    ...choice(id, value, { no: Number((1 - probability).toFixed(3)), uncertain: value === 'uncertain' ? 1 : 0, yes: Number(probability.toFixed(3)) }, Math.max(probability, 1 - probability)),
    probability: Math.max(0, Math.min(1, probability)),
    low,
    high,
  };
}

/**
 * Return a bounded decision about the question before any network request.
 * @param {string} question
 * @param {string[]} kinds
 * @returns {{queryKind: object, sourceStrategy: object}}
 */
function decideQuery(question, kinds = []) {
  const text = String(question).toLowerCase();
  const labels = ['definition', 'engineering', 'academic'];
  const weights = Object.fromEntries(labels.map((label) => [label, 0.05]));
  for (const kind of kinds) if (labels.includes(kind)) weights[kind] += 0.3;
  if (/\b(compare|versus| vs\.? |benchmark|trade[- ]?off|should)\b/.test(text)) weights.academic += 0.2;
  if (/\b(error|bug|debug|configure|install|api|code|javascript|python|database|postgres|node)\b/.test(text)) weights.engineering += 0.2;
  if (/\b(what is|who is|define|meaning|explain)\b/.test(text)) weights.definition += 0.2;
  const total = Object.values(weights).reduce((sum, n) => sum + n, 0);
  const probabilities = Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, Number((v / total).toFixed(3))]));
  const value = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  const confidence = probabilities[value];
  const providerKinds = value === 'academic'
    ? ['academic', 'engineering']
    : value === 'engineering'
      ? ['engineering', 'definition', 'academic']
      : ['definition', 'engineering'];
  const handler = value === 'academic' ? 'academic_sources' : value === 'engineering' ? 'engineering_sources' : 'reference_sources';
  return {
    queryKind: choice('query_kind', value, probabilities, confidence),
    handler: choice('handler', handler, { reference_sources: handler === 'reference_sources' ? 0.8 : 0.1, engineering_sources: handler === 'engineering_sources' ? 0.8 : 0.1, academic_sources: handler === 'academic_sources' ? 0.8 : 0.1 }, 0.8),
    providerKinds,
    fanOut: { parallel: true, questions: ['query_kind', 'handler'], providers: providerKinds },
    sourceStrategy: choice('source_strategy', value === 'academic' ? 'papers_and_practitioners' : value === 'engineering' ? 'docs_and_practitioners' : 'reference_first', {
      reference_first: value === 'definition' ? 0.8 : 0.1,
      'docs_and_practitioners': value === 'engineering' ? 0.8 : 0.1,
      papers_and_practitioners: value === 'academic' ? 0.8 : 0.1,
    }, 0.8),
  };
}

/**
 * Summarize repeated outputs without forcing an unstable answer.
 * @param {Array<string|number>} samples
 * @param {{kind?: 'choice'|'noul', threshold?: number}} [opts]
 * @returns {{stable: boolean, agreement: number, mean?: number, spread?: number, value?: string|number}}
 */
function consistencyCheck(samples, opts = {}) {
  const values = Array.isArray(samples) ? samples.filter((v) => v !== null && v !== undefined) : [];
  if (!values.length) return { stable: false, agreement: 0 };
  const threshold = opts.threshold ?? (opts.kind === 'choice' ? 0.6 : 0.4);
  if (opts.kind === 'choice') {
    const counts = new Map(values.map((v) => [v, 0]));
    for (const value of values) counts.set(value, counts.get(value) + 1);
    const [value, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const agreement = count / values.length;
    return { stable: agreement >= threshold, agreement, value };
  }
  const numbers = values.map(Number).filter(Number.isFinite);
  if (!numbers.length) return { stable: false, agreement: 0 };
  const mean = numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
  const spread = Math.max(...numbers) - Math.min(...numbers);
  return { stable: spread <= threshold, agreement: Number((1 - Math.min(1, spread)).toFixed(3)), mean: Number(mean.toFixed(3)), spread: Number(spread.toFixed(3)), value: mean };
}

/**
 * Decide whether the current evidence is enough for an agent to answer.
 * This does not claim that the answer is true; it chooses the next workflow
 * action from the evidence state already computed by assess.js.
 * @param {{plan?: boolean, opened: object[], conflicts: object[], certainty: {level: string}, missing: {missingTerms?: string[]}}} state
 * @returns {{nextAction: object, evidenceSufficient: object}}
 */
function decideResearch(state) {
  const opened = state.opened || [];
  const conflicts = state.conflicts || [];
  const missing = state.missing?.missingTerms || [];
  let value = 'answer';
  let why = 'readable evidence covers the query';
  if (state.plan) {
    value = 'inspect_plan';
    why = 'planning mode stops before fetching sources';
  }
  let sufficiencyProbability = 0.85;
  if (!opened.length || ['none', 'very low'].includes(state.certainty?.level)) {
    sufficiencyProbability = 0.05;
    value = 'search_more';
    why = !opened.length ? 'no source was readable' : 'the evidence grade is too weak';
  } else if (conflicts.length || missing.length || state.certainty?.level === 'low') {
    sufficiencyProbability = conflicts.length ? 0.45 : 0.55;
    value = 'escalate_uncertainty';
    why = conflicts.length ? 'sources disagree' : missing.length ? 'some query terms remain uncovered' : 'the evidence grade is low';
  }
  const probabilities = { answer: value === 'answer' ? 0.9 : 0.05, search_more: value === 'search_more' ? 0.9 : 0.05, escalate_uncertainty: value === 'escalate_uncertainty' ? 0.9 : 0.05, inspect_plan: value === 'inspect_plan' ? 0.9 : 0.05 };
  return {
    nextAction: { ...choice('next_action', value, probabilities, 0.9), why },
    evidenceSufficient: uncertaintyBand('evidence_sufficient', state.plan ? 0.5 : sufficiencyProbability),
  };
}

module.exports = { choice, score, noul, uncertaintyBand, decideQuery, decideResearch, consistencyCheck };
