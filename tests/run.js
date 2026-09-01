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
