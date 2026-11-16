#!/usr/bin/env node
'use strict';
/**
 * Recall eval: does the tool find, and then open, the source a careful human
 * would cite? Live network, so it is NOT part of `npm test` and not in CI.
 *
 * Each case names the primary source(s) by URL pattern. For every case the
 * eval records:
 *   found   - a candidate URL matched (search recall, after the relevance filter)
 *   opened  - the triage top 3 (what the CLI reads) held a match
 * and, per provider, how many cases it matched and how many ONLY it matched.
 * The "only" column is the question a new provider must answer: does it find
 * something the others do not?
 *
 * Usage:  GITHUB_TOKEN=$(gh auth token) node eval/recall.js [--json]
 * Cost:   about 20-40 You.com keyless queries (cap: 100 a day per IP), plus
 *         one query per configured keyed engine per case.
 */

const { findCandidates, keywords, languagesFor, PROVIDERS } = require('../lib/search');
const { triage } = require('../lib/sources');

// Categories follow the weak areas recorded in past runs: practitioner docs,
// verbatim error strings, named industry reports, market statistics and
// current vendor facts. `reference` is the control the tool already handles.
const CASES = [
  ['docs', 'nextjs app router caching revalidate', /nextjs\.org/],
  ['docs', 'nestjs dependency injection scopes', /docs\.nestjs\.com/],
  ['docs', 'pgbouncer transaction pooling mode', /pgbouncer\.org|postgresql\.org/],
  ['docs', 'react useEffect cleanup function', /react\.dev/],
  ['docs', 'AbortSignal.timeout fetch', /developer\.mozilla\.org|nodejs\.org/],
  ['docs', 'tailwind container queries', /tailwindcss\.com/],
  ['docs', 'docker compose healthcheck depends_on condition', /docs\.docker\.com/],
  ['error', 'ERR_REQUIRE_ESM require of ES module not supported', /nodejs\.org|github\.com|stackoverflow\.com/],
  ['error', 'Hydration failed because the initial UI does not match', /nextjs\.org|react\.dev|github\.com\/vercel/],
  ['error', "prisma P1001 can't reach database server", /prisma\.io|github\.com\/prisma|stackoverflow\.com/],
  ['report', 'DORA state of devops report', /dora\.dev|cloud\.google\.com/],
  ['report', 'METR AI developer productivity randomized trial', /metr\.org|arxiv\.org/],
  ['report', 'Stack Overflow developer survey', /survey\.stackoverflow\.co/],
  ['stats', 'Gartner agentic AI prediction', /gartner\.com/],
  ['stats', 'GitHub Octoverse report', /github\.blog|octoverse\.github\.com/],
  ['vendor', 'Custom Search JSON API closed to new customers', /developers\.google\.com/],
  ['vendor', 'Gemini API grounding Google Search pricing', /ai\.google\.dev/],
  ['vendor', 'Anthropic multi-agent research system', /anthropic\.com/],
  ['reference', 'CAP theorem', /wikipedia\.org/],
  ['reference', 'connection pool', /wikipedia\.org/],
];

/** Record each provider's raw output for the current case, in process. */
const raw = new Map();
for (const p of PROVIDERS) {
  const run = p.run;
  p.run = async (q, o) => {
    const out = await run.call(p, q, o);
    raw.set(p.name, [...(raw.get(p.name) || []), ...out.map((c) => c.url)]);
    return out;
  };
}

async function main() {
  const rows = [];
  for (const [category, question, expect] of CASES) {
    raw.clear();
    const d = await findCandidates(question);
    const kept = new Set(d.candidates.map((c) => c.url));
    const terms = keywords(question, languagesFor(question)).split(' ').filter(Boolean);
    const opened = triage(d.candidates, { terms }).map((c) => c.url);
    const by = [...raw].filter(([, urls]) => urls.some((u) => kept.has(u) && expect.test(u))).map(([n]) => n);
    rows.push({
      category, question,
      found: d.candidates.some((c) => expect.test(c.url)),
      opened: opened.some((u) => expect.test(u)),
      by, failed: d.failed,
    });
  }
  if (process.argv.includes('--json')) return console.log(JSON.stringify(rows, null, 2));

  const pct = (n, of) => `${n}/${of}`;
  console.log('case results (found = a candidate matched, opened = triage top 3 matched):');
  for (const r of rows) {
    console.log(`  ${r.opened ? 'OPEN ' : r.found ? 'found' : 'MISS '}  ${r.category.padEnd(9)} ${r.question}`
      + `${r.by.length ? `  [${r.by.join(',')}]` : ''}${r.failed.length ? `  unreachable: ${r.failed.join(',')}` : ''}`);
  }
  console.log('\nby category (found / opened):');
  for (const c of [...new Set(rows.map((r) => r.category))]) {
    const rs = rows.filter((r) => r.category === c);
    console.log(`  ${c.padEnd(9)} ${pct(rs.filter((r) => r.found).length, rs.length)} / ${pct(rs.filter((r) => r.opened).length, rs.length)}`);
  }
  console.log(`  ${'total'.padEnd(9)} ${pct(rows.filter((r) => r.found).length, rows.length)} / ${pct(rows.filter((r) => r.opened).length, rows.length)}`);
  console.log('\nby provider (cases matched / matched by this provider only):');
  const names = [...new Set(rows.flatMap((r) => r.by))].sort();
  for (const n of names) {
    const hit = rows.filter((r) => r.by.includes(n)).length;
    const only = rows.filter((r) => r.by.length === 1 && r.by[0] === n).length;
    console.log(`  ${n.padEnd(14)} ${hit} / ${only}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
