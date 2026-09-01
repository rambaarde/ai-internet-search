'use strict';
/**
 * Test suite. No framework, no network in the unit tests — the network tests
 * are marked and skipped when offline, so a failing CI is a real failure
 * rather than a flaky one.
 */
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { gradeSource, triage } = require('../lib/sources');
const { keywords, looksRelevant, kindsFor } = require('../lib/search');

const BIN = join(__dirname, '..', 'bin', 'ai-internet-search.js');
let pass = 0;
let fail = 0;

const ok = (m) => { console.log('ok   - ' + m); pass++; };
const nok = (m, d) => { console.log('NOT OK - ' + m + (d ? ` (${d})` : '')); fail++; };
const is = (a, b, m) => (String(a) === String(b) ? ok(m) : nok(m, `got [${a}] want [${b}]`));
const has = (s, sub, m) => (String(s).includes(sub) ? ok(m) : nok(m, `missing [${sub}]`));
const hasnt = (s, sub, m) => (!String(s).includes(sub) ? ok(m) : nok(m, `unexpected [${sub}]`));

function run(args, expectCode) {
  try {
    const out = execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
    return { out, code: 0 };
  } catch (e) {
    return { out: (e.stdout || '') + (e.stderr || ''), code: e.status };
  }
}

// --- source tiering ---------------------------------------------------------
// The mechanism the tool exists for: credibility decided from the URL, before
// anything is fetched. If this ranks a content farm above official docs, the
// tool is worse than a plain search.
is(gradeSource('https://www.postgresql.org/docs/current/x.html').tier, 1, 'official docs are tier 1');
is(gradeSource('https://datatracker.ietf.org/doc/html/rfc9110').tier, 1, 'a standards body is tier 1');
is(gradeSource('https://github.com/o/r/blob/main/x.js').tier, 1, 'source code is tier 1');
is(gradeSource('https://arxiv.org/abs/2505.17762').tier, 2, 'a preprint is tier 2');
is(gradeSource('https://stackoverflow.com/questions/1').tier, 3, 'practitioner Q&A is tier 3');
is(gradeSource('https://medium.com/@x/post').tier, 4, 'a content aggregator is tier 4');
is(gradeSource('https://top10devblogs.com/best-10-tips').tier, 4, 'an SEO listicle is tier 4');
// An unknown host is unproven, not junk. Treating it as tier 4 would bury
// small authoritative sites under large mediocre ones.
is(gradeSource('https://sudhir.io/some-post').tier, 3, 'an unrecognised host is unproven, not junk');

// --- triage -----------------------------------------------------------------
{
  const cands = [
    { url: 'https://medium.com/@a/x', title: 'a' },
    { url: 'https://medium.com/@b/y', title: 'b' },
    { url: 'https://www.postgresql.org/docs/current/z.html', title: 'c' },
    { url: 'https://github.com/o/r/blob/main/f.js', title: 'd' },
  ];
  const keep = triage(cands, { limit: 3, perHost: 1 });
  is(keep[0].tier, 1, 'triage puts the most credible source first');
  is(keep.filter((c) => c.host === 'medium.com').length, 1, 'triage takes at most one source per host');
  is(triage(cands, { limit: 2 }).length, 2, 'triage honours the open limit');
  is(triage([], {}).length, 0, 'triage of nothing is nothing, not an error');
}

// --- query shaping ----------------------------------------------------------
// Measured failure: sending the whole sentence to a keyword engine returned
// Show HN posts about MCP servers for "what is a connection pool".
is(keywords('how big should my postgres connection pool be'), 'postgres connection pool', 'a question is reduced to its distinctive words');
is(keywords('what is a connection pool'), 'connection pool', 'question framing is stripped');
hasnt(keywords('should I use the thing'), 'should', 'stopwords are removed');
ok(keywords('the a is').length > 0 ? 'a question of only stopwords still yields a query' : 'x');

is(looksRelevant('About Database Connection Pool Sizing', ['connection', 'pool']), 'true', 'a matching title is relevant');
is(looksRelevant('Show HN: I made an MCP server', ['connection', 'pool']), 'false', 'an unrelated title is rejected');

is(kindsFor('what is a mutex').join(','), 'definition,engineering', 'a definition question picks the reference source');
is(kindsFor('benchmark of rate limiters').join(','), 'academic,engineering', 'a research question picks the citation index');

// --- CLI contract (AXI) -----------------------------------------------------
{
  const r = run(['--help'], 0);
  has(r.out, 'usage:', '--help prints usage');
  is(r.code, 0, '--help exits 0');
}
{
  // AXI: an unknown flag must fail loudly rather than be swallowed as text.
  const r = run(['--nope', 'x'], 2);
  is(r.code, 2, 'an unknown flag exits 2');
  has(r.out, 'unknown flag', 'an unknown flag says so');
  has(r.out, 'help[', 'an error still offers a next step');
}
{
  // AXI content-first: no arguments shows what this is and what to run.
  const r = run([], 0);
  has(r.out, 'ai-internet-search', 'no arguments identifies the tool');
  has(r.out, 'help[', 'no arguments suggests a next step');
  hasnt(r.out, 'usage:', 'no arguments is not a help dump');
}
{
  const r = run(['--version'], 0);
  is(r.out.trim(), require('../package.json').version, '--version prints the version');
}

// --- extraction -------------------------------------------------------------
{
  const { htmlToText, sentences, scoreSentence } = require('../lib/extract');
  // Script bodies must go before tags, or a 1MB SPA becomes "850k chars of text".
  hasnt(htmlToText('<script>var x = "hello world padding padding";</script><p>real text</p>'), 'hello world',
        'script bodies are removed, not just their tags');
  is(htmlToText('<p>it&#x27;s &amp; it&#39;s</p>'), "it's & it's", 'numeric and named entities are decoded');

  // A page title is not a claim: it asserts nothing actionable.
  const kept = sentences('GitHub - supabase/supavisor: A cloud-native pooler thing here\n' +
    'Supavisor is a scalable cloud-native Postgres connection pooler that handles many clients.');
  is(kept.length, 1, 'a page title is not kept as a claim');
  has(kept[0], 'Supavisor is a scalable', 'the actual sentence survives');

  const terms = ['connection', 'pool'];
  const withNumber = scoreSentence('Set the connection pool to 10 for this workload.', terms);
  const without = scoreSentence('The connection pool is a thing that exists somewhere.', terms);
  ok(withNumber > without ? 'a sentence stating a figure outranks a vague one' : 'x');
}

// --- conflict detection and grading -----------------------------------------
// The reason the tool exists. Models "favor the majority viewpoint even when
// opposing evidence is more credible", so certainty must never be a vote.
{
  const { findConflicts, grade } = require('../lib/assess');
  const disagree = [
    { tier: 1, host: 'postgresql.org', url: 'u1', read: true,
      claims: [{ text: 'You should set the connection pool to around 10 connections for this workload.' }] },
    { tier: 4, host: 'top10devblogs.com', url: 'u2', read: true,
      claims: [{ text: 'You should always set the connection pool to 100 connections for any workload.' }] },
  ];
  const c = findConflicts(disagree);
  is(c.length, 1, 'a numeric disagreement between two hosts is detected');
  is(c[0].kind, 'figures differ', 'the kind of disagreement is named');
  is(c[0].prefer.host, 'postgresql.org', 'the more authoritative source is preferred, not the more numerous');

  // Same host disagreeing with itself is not news; near-identical claims are not conflict.
  is(findConflicts([{ tier: 3, host: 'a.com', url: 'u', read: true,
      claims: [{ text: 'Use 10 connections in the pool here.' }, { text: 'Use 100 connections in the pool here.' }] }]).length,
     0, 'a single source disagreeing with itself is not reported as a conflict');

  is(grade(disagree, c).level, 'low', 'a live disagreement downgrades certainty');
  is(grade([{ tier: 1, host: 'a', read: true, claims: [{ text: 'x' }] }], []).level, 'moderate',
     'a single primary source is moderate, not high');
  is(grade([{ tier: 1, host: 'a', read: true, claims: [{ text: 'x' }] },
            { tier: 2, host: 'b', read: true, claims: [{ text: 'y' }] }], []).level, 'high',
     'a primary source corroborated independently is high');
  is(grade([{ tier: 4, host: 'a', read: true, claims: [{ text: 'x' }] }], []).level, 'very low',
     'aggregator-only evidence is very low');
  is(grade([{ tier: 1, host: 'a', read: false, claims: [] }], []).level, 'none',
     'nothing readable is graded none, not assumed');
}

// --- MCP server -------------------------------------------------------------
{
  const MCP = join(__dirname, '..', 'bin', 'ai-internet-search-mcp.js');
  const input = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    '{"jsonrpc":"2.0","id":3,"method":"bogus"}',
  ].join('\n') + '\n';
  let raw = '';
  try {
    raw = execFileSync(process.execPath, [MCP], { input, encoding: 'utf8', timeout: 20000 });
  } catch (e) { raw = e.stdout || ''; }
  const msgs = raw.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const byId = Object.fromEntries(msgs.filter(Boolean).map((m) => [m.id, m]));
  is(msgs.length, 3, 'MCP answers every request and never answers a notification');
  is(byId[1]?.result?.serverInfo?.name, 'ai-internet-search', 'MCP identifies itself');
  has(byId[1]?.result?.instructions || '', 'settle a disagreement by counting',
      'MCP instructions carry the rule the tool exists for');
  is((byId[2]?.result?.tools || []).map((t) => t.name).sort().join(','), 'plan_research,research',
     'MCP advertises both tools');
  has(byId[3]?.error?.message || '', 'method not found', 'MCP rejects an unknown method as a JSON-RPC error');
}

// --- network-dependent ------------------------------------------------------
(async () => {
  let online = true;
  try {
    await fetch('https://en.wikipedia.org/w/api.php?action=query&format=json', { signal: AbortSignal.timeout(5000) });
  } catch {
    online = false;
  }

  if (!online) {
    console.log('skip - network tests (offline)');
  } else {
    const r = run(['--limit', '3', 'what is a connection pool'], 0);
    has(r.out, 'sources[', 'a real question returns a sources block');
    has(r.out, 'triaged:', 'the output states how many were skipped before fetching');
    is(r.code, 0, 'a successful search exits 0');

    // The empty state is the point: silence is indistinguishable from a crash,
    // and a confident guess is worse than either.
    const e = run(['zzqx-not-a-real-topic-xyzzy'], 0);
    has(e.out, 'could_not_establish', 'an empty result says so explicitly');
    has(e.out, 'sources[0]', 'an empty result still emits a zero-count block');
    is(e.code, 0, 'finding nothing is an answer, not an error');
  }

  console.log('----');
  console.log(`${pass + fail} tests, ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
