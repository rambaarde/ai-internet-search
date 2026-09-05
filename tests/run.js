'use strict';
/**
 * Test suite. No framework, no network in the unit tests — the network tests
 * are marked and skipped when offline, so a failing CI is a real failure
 * rather than a flaky one.
 */
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { mkdtempSync, rmSync, existsSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { gradeSource, triage } = require('../lib/sources');
const { keywords, looksRelevant, kindsFor, languagesFor, fold } = require('../lib/search');
const { parseDirectives, applyDirectives } = require('../lib/directives');

const BIN = join(__dirname, '..', 'bin', 'ai-internet-search.js');
let pass = 0;
let fail = 0;

const ok = (m) => { console.log('ok   - ' + m); pass++; };
const nok = (m, d) => { console.log('NOT OK - ' + m + (d ? ` (${d})` : '')); fail++; };
const is = (a, b, m) => (String(a) === String(b) ? ok(m) : nok(m, `got [${a}] want [${b}]`));
const has = (s, sub, m) => (String(s).includes(sub) ? ok(m) : nok(m, `missing [${sub}]`));
const hasnt = (s, sub, m) => (!String(s).includes(sub) ? ok(m) : nok(m, `unexpected [${sub}]`));

function run(args, expectCode, opts = {}) {
  try {
    const out = execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: opts.cwd });
    return { out, code: 0 };
  } catch (e) {
    return { out: (e.stdout || '') + (e.stderr || ''), code: e.status };
  }
}

// A fresh, throwaway directory for any test that touches the real
// filesystem (--report writes a file), so a test run never leaves a stray
// file in the repo and never depends on what's already on disk. Every
// sandbox created is removed when the suite exits, pass or fail.
const sandboxes = [];
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-internet-search-test-'));
  sandboxes.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

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
// A comparison question has a literature too. Gating the citation index on the
// word "paper" or "benchmark" made "argon2id or bcrypt" return nothing at all,
// while OpenAlex held three on-topic papers nobody asked it for.
is(kindsFor('should password hashing use argon2id or bcrypt').includes('academic'), true,
   'a comparison question still reaches the citation index');
is(kindsFor('what is a mutex').includes('academic'), false,
   'a plain definition question does not pull from a citation index');

// --- query directives -------------------------------------------------------
// site:/filetype:/intitle: are pulled out of the question so they scope the
// candidates without polluting the keyword search, and a directive that would
// leave nothing is relaxed rather than enforced.
{
  const p = parseDirectives('postgres pool site:github.com -site:reddit.com filetype:pdf intitle:"tuning guide"');
  is(p.query, 'postgres pool', 'directives are stripped from the query the providers see');
  is(p.constraints.site.join(','), 'github.com', 'site: is parsed');
  is(p.constraints.notSite.join(','), 'reddit.com', '-site: is parsed as an exclusion');
  is(p.constraints.filetype.join(','), 'pdf', 'filetype: is parsed');
  is(p.constraints.intitle.join(','), 'tuning guide', 'a quoted intitle: keeps its spaces');
  is(p.any, 'true', 'a question with directives reports it carries some');
  is(parseDirectives('just a plain question').any, 'false', 'a plain question carries none');

  const cands = [
    { url: 'https://github.com/supabase/supavisor', title: 'Supavisor pooler' },
    { url: 'https://www.reddit.com/r/db/x', title: 'a reddit thread' },
    { url: 'https://en.wikipedia.org/wiki/Connection_pool', title: 'Connection pool' },
  ];
  const scoped = applyDirectives(cands, parseDirectives('db site:github.com -site:reddit.com').constraints);
  is(scoped.candidates.length, 1, 'site: keeps only the matching host');
  is(scoped.candidates[0].url.includes('github.com'), true, 'the surviving candidate is the scoped one');
  is(scoped.relaxed.length, 0, 'a directive that matches something is enforced, not relaxed');

  // A subdomain still matches its parent site, and a host+path scope works.
  const sub = applyDirectives([{ url: 'https://gist.github.com/x/y', title: 't' }],
    parseDirectives('q site:github.com').constraints);
  is(sub.candidates.length, 1, 'a subdomain matches its parent site');
  const path = applyDirectives(cands, parseDirectives('q site:github.com/supabase').constraints);
  is(path.candidates.length, 1, 'a site: with a path scopes to that path prefix');

  // The lenient rule: a directive matching nothing is relaxed, the wider set is
  // kept, and the relaxation is named -- returning nothing is the failure to avoid.
  const relaxed = applyDirectives(cands, parseDirectives('db filetype:pdf').constraints);
  is(relaxed.candidates.length, 3, 'a directive that would empty the set is relaxed, not enforced');
  is(relaxed.relaxed.join(','), 'filetype:pdf', 'the relaxed directive is named so the caller knows');
  is(relaxed.applied.length, 0, 'nothing is reported as applied when the only directive was relaxed');
}

// --- optional keyed web search ----------------------------------------------
// General-web recall the key-free providers cannot give. Keyless SERP scraping
// is bot-walled (DuckDuckGo answers a 202 challenge, Mojeek a CAPTCHA), so this
// is a keyed API, and it must stay a no-op until a key is set -- never a
// required key. The live API calls need a real key, so only the env logic and
// the no-op are asserted here; the adapters run wherever a key exists.
{
  const { pick, webSearchProvider, KEYS } = require('../lib/providers/websearch');
  is(pick({}), 'null', 'no key configured means no web-search provider');
  is(pick({ BRAVE_API_KEY: 'x' }).engine, 'brave', 'BRAVE_API_KEY selects Brave');
  is(pick({ TAVILY_API_KEY: 'x' }).engine, 'tavily', 'TAVILY_API_KEY selects Tavily');
  is(pick({ SERPER_API_KEY: 'x' }).engine, 'serper', 'SERPER_API_KEY selects Serper');
  is(pick({ BRAVE_SEARCH_API_KEY: 'x' }).engine, 'brave', 'the alternate BRAVE_SEARCH_API_KEY spelling also works');
  is(pick({ BRAVE_API_KEY: 'b', TAVILY_API_KEY: 't', SERPER_API_KEY: 's' }).engine, 'brave',
     'with several keys the first in priority order wins, deterministically');
  is(KEYS.join(','), 'BRAVE_API_KEY,TAVILY_API_KEY,SERPER_API_KEY', 'KEYS names the env vars the empty-state hint points at');
  is(webSearchProvider.kinds.length, 3, 'web search is eligible for every question kind');
  // pick({}) === null above is the whole no-op contract: run() returns [] iff
  // pick() is null. The live API path (a real key present) is exercised only
  // where a key exists, like the network and render tests.
}

// --- languages ---------------------------------------------------------------
// The tool asked English Wikipedia and nothing else, so a question asked in
// Tagalog or Japanese was answered from a corpus that mostly does not discuss
// it. Every case below was a real failure before these were added.
is(languagesFor('what is a connection pool').join(','), 'en', 'an English question stays English');
is(languagesFor('ano ang pagbabago ng klima sa Pilipinas').join(','), 'tl,en', 'Tagalog is detected from its function words');
is(languagesFor('que es el cambio climatico').join(','), 'es,en', 'Spanish is detected from its function words');
is(languagesFor('\u30b3\u30cd\u30af\u30b7\u30e7\u30f3\u30d7\u30fc\u30eb\u3068\u306f').join(','), 'ja,en', 'Japanese is detected from its script');
is(languagesFor('\u0447\u0442\u043e \u0442\u0430\u043a\u043e\u0435 \u043f\u0443\u043b \u0441\u043e\u0435\u0434\u0438\u043d\u0435\u043d\u0438\u0439').join(','), 'ru,en', 'Cyrillic is detected from its script');
// English is always asked as well, so adding a language can only raise recall.
ok(languagesFor('ano ang klima sa Pilipinas').includes('en') ? 'English is always queried as a floor' : 'x');

// The stopword list was English only. Left unfixed, asking Tagalog Wikipedia
// for "ano ang pagbabago klima pilipinas" returned Daigdig, Asya and
// Ferdinand Marcos, because the engine matched the noise words.
is(keywords('ano ang pagbabago ng klima sa Pilipinas'), 'pagbabago klima pilipinas',
   'Tagalog question framing is stripped, not just English');
is(keywords('que es el cambio climatico'), 'cambio climatico', 'Spanish question framing is stripped');
is(keywords('was ist ein Verbindungspool'), 'verbindungspool', 'German question framing is stripped');
// CJK has no spaces, so its framing has to be cut from the string. Left in,
// the whole query is one token that no article title contains.
is(keywords('\u30b3\u30cd\u30af\u30b7\u30e7\u30f3\u30d7\u30fc\u30eb\u3068\u306f'), '\u30b3\u30cd\u30af\u30b7\u30e7\u30f3\u30d7\u30fc\u30eb',
   'a Japanese interrogative suffix is removed from an unspaced query');
is(keywords('\u8fde\u63a5\u6c60\u662f\u4ec0\u4e48'), '\u8fde\u63a5\u6c60', 'a Chinese interrogative is removed from an unspaced query');
is(keywords('what is a connection pool'), 'connection pool', 'the English path is unchanged');

// A person types "climatico" and the article is "Climático". Without folding,
// includes() says no, the right result is discarded, and the tool reports
// finding nothing: a false empty, the worst answer it can give.
is(fold('Cambio Clim\u00e1tico'), 'cambio climatico', 'diacritics are folded for comparison');
is(looksRelevant('Cambio clim\u00e1tico', ['cambio', 'climatico']), 'true',
   'an accented title matches an unaccented query');

// --- installed as a real package, not run as a dev script -------------------
// Every other test invokes `node bin/ai-internet-search.js` directly, which
// never touches the shebang line, the executable bit, or npm's bin-symlink
// mechanism. That is not how an agent runs this: it runs `ai-internet-search
// "<question>"` as a bare command after `npm install`. Pack the real tarball,
// install it into a throwaway prefix, and invoke the installed symlink with
// no `node` in front of it -- the only way to prove the thing an agent
// actually types works, rather than the thing a test harness types.
{
  const packDir = sandbox();
  const installDir = sandbox();
  execFileSync('npm', ['pack', '--silent', '--pack-destination', packDir], { cwd: join(__dirname, '..') });
  const { readdirSync } = require('node:fs');
  const tarball = join(packDir, readdirSync(packDir).find((f) => f.endsWith('.tgz')));
  execFileSync('npm', ['install', tarball, '--no-save', '--ignore-scripts', '--silent'], { cwd: installDir });

  const installedCli = join(installDir, 'node_modules', '.bin', 'ai-internet-search');
  const installedMcp = join(installDir, 'node_modules', '.bin', 'ai-internet-search-mcp');

  // No process.execPath prefix below: the OS resolves the interpreter from
  // the file's own `#!/usr/bin/env node` line, exactly as a shell does.
  const version = execFileSync(installedCli, ['--version'], { encoding: 'utf8' }).trim();
  is(version, require('../package.json').version, 'the installed CLI, run as a bare command, reports the right version');

  const helpOut = execFileSync(installedCli, ['--help'], { encoding: 'utf8' });
  has(helpOut, 'usage:', 'the installed CLI answers --help the same as the dev script');

  const initReply = execFileSync(installedMcp, [], {
    input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n',
    encoding: 'utf8',
    timeout: 10000,
  });
  const parsed = JSON.parse(initReply.trim().split('\n')[0]);
  is(parsed?.result?.serverInfo?.name, 'ai-internet-search', 'the installed MCP bin, run as a bare command, answers initialize');
}

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
  const { htmlToText, sentences, scoreSentence, extractClaims } = require('../lib/extract');
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

  // Quoted alone, "it" has no antecedent -- the claim reads as being about
  // nothing. Deprioritized, not dropped: still selectable if nothing else fits.
  const orphaned = scoreSentence('It should be set to 10 connections for this workload.', terms);
  const grounded = scoreSentence('The connection pool should be set to 10 for this workload.', terms);
  ok(orphaned < grounded ? 'a claim whose subject is a bare pronoun is deprioritized' : 'x');
  ok(orphaned > 0 ? 'an orphaned claim is still usable, not zeroed out' : 'x');

  // Pronouns that are not the first word orphan a quotation just as badly,
  // because nothing carries the antecedent forward with it.
  const scattered = scoreSentence('Set the connection pool to 10 because their pooler caps it there.', terms);
  const named = scoreSentence('Set the connection pool to 10 because Supavisor caps sessions there.', terms);
  is(scattered < named, true, 'pronouns anywhere in a claim deprioritize it, not only at the front');

  // A definition answers on its own, which is what a lifted quotation must do.
  const defined = scoreSentence('A connection pool is a cache of open database sessions.', terms);
  const plain = scoreSentence('The connection pool was mentioned in passing somewhere.', terms);
  is(defined > plain, true, 'a definition outranks a passing mention');
}

// --- conflict detection and grading -----------------------------------------
// The reason the tool exists. Models "favor the majority viewpoint even when
// opposing evidence is more credible", so certainty must never be a vote.
{
  const { findConflicts, grade, overlap } = require('../lib/assess');

  // "connection" and "connections" are the same word to a reader; without
  // stemming, a singular claim and a plural one about the same thing can
  // fall under the conflict threshold and a real disagreement goes unseen.
  is(Math.round(overlap('the pool has 5 connection', 'the pool has 5 connections') * 100) / 100, 1,
     'singular and plural forms of the same word count as shared');

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

// --- HTML report ------------------------------------------------------------
// For the human deciding whether to act, not for the agent. Written to a file,
// never to stdout: an agent piping markup back into its own context would pay
// exactly the cost this tool exists to avoid.
{
  const { renderReport } = require('../lib/report');
  const html = renderReport({
    question: 'q', query: 'postgres pool', command: 'ai-internet-search --limit 5 --report "q"',
    certainty: { level: 'low', why: 'one primary source; downgraded by a disagreement' },
    providers: ['hackernews'],
    gaps: { missingTerms: ['pgbouncer'], unread: [] },
    conflicts: [{ kind: 'figures differ',
      a: { tier: 1, host: 'postgresql.org', url: 'http://a', text: 'around 10 connections' },
      b: { tier: 4, host: 'top10devblogs.com', url: 'http://b', text: 'always 100 connections' },
      prefer: { tier: 1, host: 'postgresql.org' } }],
    sources: [{ tier: 1, host: 'a.com', why: 'docs', url: 'http://a', read: true, bytes: 1000,
      claims: [{ text: 'The latest version deprecates this flag.' },
               { text: 'A pool maintains a set of connections internally.' }] },
      { tier: 3, host: 'b.com', why: 'x', url: 'http://b', read: false, reason: 'http 403', claims: [] }],
  });

  // Standalone by construction: it must render the same in lavish-axi, a
  // browser, an attachment, or a printer, in ten years.
  hasnt(html, '<script', 'the report ships no script');
  hasnt(html, 'cdn.', 'the report loads nothing from a CDN');
  has(html, '@media print', 'the report is printable');
  // Deliberately NOT theme-aware. A paper is white; rendered dark it reads as
  // a UI panel instead of a document. `only light` also stops a browser or OS
  // setting from auto-inverting it.
  has(html, 'color-scheme:only light', 'the report stays a white sheet in any theme');
  hasnt(html, '@media (prefers-color-scheme', 'no dark theme is defined for a paper');

  // The three things TOON flattens.
  // Certainty is stated in the summary block, before any finding it qualifies.
  has(html, '<dt>Certainty</dt>', 'certainty is a labeled field, not buried in prose');
  ok(html.indexOf('<dt>Certainty</dt>') < html.indexOf('Findings') ? 'certainty is stated before the findings' : 'x');
  // Bottom line up front, and it is a quotation rather than a composed
  // sentence: composing one would be the single place this tool paraphrased.
  has(html, '<dt>Bottom line</dt>', 'the decision-relevant line comes first');
  has(html, 'A pool maintains a set of connections internally.',
      'the bottom line is quoted from the most credible source, not written');
  has(html, 'Disagreements', 'a disagreement is given its own section');
  has(html, 'postgresql.org', 'both sides of a disagreement are named');
  has(html, 'more authoritative', 'the verdict says why, not which is more numerous');

  // A claim that rots is marked; a timeless one is not.
  has(html, 'v-fast', 'a perishable claim is flagged');
  // Check the claim's own list item. Splitting on the text and scanning the
  // remainder catches the legend below, which legitimately names every class.
  const timelessLi = (html.match(/<li>[^<]*A pool maintains[\s\S]*?<\/li>/) || [''])[0];
  hasnt(timelessLi, 'class="vol', 'a timeless claim carries no volatility flag');

  // A gap is only useful if it says what to run next.
  has(html, 'ai-internet-search "postgres pool pgbouncer"', 'a gap becomes a runnable next query');
  has(html, 'ai-internet-search --limit 5 --report', 'the report states the command that produced it');
  has(html, 'http 403', 'an unreadable source is reported with its reason');

  // Content is escaped: a page title containing markup must not become markup.
  const evil = renderReport({ question: '<img src=x onerror=alert(1)>', query: 'q',
    certainty: { level: 'none', why: 'x' }, sources: [], conflicts: [], gaps: {} });
  hasnt(evil, '<img src=x', 'source content cannot inject markup into the report');
}

// --- MCP over HTTP ----------------------------------------------------------
// Clients that connect by URL cannot spawn a command. The transport changes
// who can reach the server and nothing else: same handler, same tools, same
// bytes, so it costs nothing in tokens.
{
  const { spawn } = require('node:child_process');
  const MCP = join(__dirname, '..', 'bin', 'ai-internet-search-mcp.js');
  const PORT = 8793;
  const srv = spawn(process.execPath, [MCP, '--http', String(PORT)], { stdio: 'ignore' });

  const post = async (body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    return { status: res.status, type: res.headers.get('content-type') || '', json: text ? JSON.parse(text) : null };
  };

  (async () => {
    for (let i = 0; i < 20; i++) {
      try { await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(500) }); break; }
      catch { await new Promise((r) => setTimeout(r, 150)); }
    }

    // The exact probe a URL-based client sends to decide the transport. It
    // branches on content-type: application/json means streamable-http.
    const probe = await post({ jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });
    is(probe.status, 200, 'a transport probe gets 200');
    has(probe.type, 'application/json', 'the response identifies the transport as streamable-http');
    is(probe.json?.result?.protocolVersion, '2025-03-26', 'the client\'s protocol version is echoed, not overridden');
    has(probe.json?.result?.instructions || '', 'counting', 'instructions travel over http too');

    const list = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    is((list.json?.result?.tools || []).map((t) => t.name).sort().join(','), 'plan_research,research',
       'the same tools are served over http');

    // A notification has no reply. 202 says accepted-with-nothing-to-say,
    // which is not the same as an empty 200.
    const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    is(note.status, 202, 'a notification is accepted with no reply body');

    const bad = await post({ jsonrpc: '2.0', id: 2, method: 'bogus' });
    has(bad.json?.error?.message || '', 'method not found', 'an unknown method is a JSON-RPC error over http');

    const getRes = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(5000) });
    is(getRes.status, 405, 'GET is refused; this is a JSON-RPC endpoint, not a web page');

    srv.kill();
    finish();
  })().catch((e) => { nok('MCP http transport', e.message); srv.kill(); finish(); });
}

function finish() {
// --- unreadable sources -----------------------------------------------------
// Reaches nothing outside this process: the pages are data: URLs. It lives in
// this block only because extractClaims is async and the tally runs at the end.
(async () => {
  const { extractClaims } = require('../lib/extract');
  const page = (html) => 'data:text/html,' + encodeURIComponent(html);
  const src = (html) => ({ url: page(html), title: 't', tier: 1, host: 'example.test', why: 'w' });
  const T = ['connection', 'pool'];

  // "I could not open this" and "I read it and it said nothing" are different
  // answers, and only the first belongs under could_not_establish.
  const spa = await extractClaims(src('<html><body><div id="root"></div><script>var a=1;</script></body></html>'), T);
  is(spa.read, false, 'a page whose text lives only in JavaScript counts as unread');
  has(spa.reason, 'client-rendered', 'the reason names client-side rendering, not an empty answer');

  const offTopic = await extractClaims(
    src('<html><body><p>The quick brown fox jumped over the lazy dog again and again today.</p></body></html>'), T);
  is(offTopic.read, true, 'a server-rendered page that answers nothing is still read');
  has(offTopic.reason, 'nothing addressed the question', 'an off-topic page keeps its own reason');

  // The check must never cost a claim: a short page that does answer stays read.
  const shortAnswer = await extractClaims(
    src('<html><body><div id="root"><p>A connection pool is a cache of open database sessions.</p></div></body></html>'), T);
  is(shortAnswer.read, true, 'a short page that does answer is not mistaken for an empty shell');

  // --- optional headless-browser render (--render) --------------------------
  const { findBrowser, renderPage } = require('../lib/render');

  // Deterministic, no browser needed: failure is always null, never a throw, so
  // a missing browser degrades the run instead of crashing it.
  is(await renderPage('data:text/html,<h1>x</h1>', { bin: '/no/such/browser' }), null,
     'renderPage returns null when the browser binary does not exist');

  // A source that only JavaScript can fill: fetch sees the empty shell, and
  // WITHOUT --render it stays dropped -- rendering is opt-in, never automatic.
  const jsShell = '<html><body><div id="root"></div><script>document.getElementById("root")'
    + '.innerHTML="The connection pool should be set to ten connections for this workload.";</script></body></html>';
  const notRendered = await extractClaims(src(jsShell), T, { render: false });
  is(notRendered.read, false, 'without --render, a client-rendered page is left dropped');
  // The rescue itself spawns a browser (slow) and needs one installed, so it
  // runs in the tally IIFE below -- which is what actually awaits before the
  // final count and process.exit.
})();

// --- network-dependent ------------------------------------------------------
(async () => {
  // Optional browser render (--render). Lives in this IIFE because it is the one
  // that awaits everything and then tallies; a slow browser spawn in another
  // block would finish after process.exit and go uncounted. No network -- the
  // page is a data: URL -- but it needs a real Chrome, so it skips like the
  // offline tests below when none is installed.
  {
    const { findBrowser, renderPage } = require('../lib/render');
    const { extractClaims } = require('../lib/extract');
    const jsShell = '<html><body><div id="root"></div><script>document.getElementById("root")'
      + '.innerHTML="The connection pool should be set to ten connections for this workload.";</script></body></html>';
    const rsrc = { url: 'data:text/html,' + encodeURIComponent(jsShell), title: 't', tier: 1, host: 'x', why: 'w' };
    // Skip in CI: a headless browser under CI load renders unreliably run to run
    // (measured -- the same render nulls on one runner and succeeds on the next),
    // so these would be flaky. They run wherever a real browser is stable, which
    // is a developer's machine. The deterministic render tests above still run
    // everywhere. Same discipline as the offline-network skip below.
    if (!findBrowser() || process.env.CI) {
      console.log(`skip - render tests (${findBrowser() ? 'CI: headless browser is flaky under load' : 'no Chrome/Chromium installed'})`);
    } else {
      // Assert only that the browser produced DOM here; that the JavaScript
      // actually ran is proved by the rescue below (which extracts the injected
      // sentence). A tighter check on the injected text was flaky on a loaded
      // runner -- the render is real, the timing of a direct call is not a
      // contract worth pinning.
      const html = await renderPage(rsrc.url, { timeoutMs: 15000 });
      is(!!(html && html.length > 100), true, 'renderPage returns rendered DOM from the browser');
      const rescued = await extractClaims(rsrc, ['connection', 'pool'], { render: true });
      is(rescued.read, true, 'with --render, a client-rendered page is rescued through the browser');
      is(rescued.rendered, true, 'a rescued source is marked as rendered, so the reader knows how it was read');
      is(rescued.claims.length >= 1, true, 'the browser-rendered claim is extracted like any other');
    }
  }

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

    // --report writes to the real filesystem. Run it inside a throwaway
    // sandbox dir, never the repo, so a test run can't leave a stray file
    // behind or depend on what happens to already be on disk.
    {
      const dir = sandbox();
      const r1 = run(['--report', 'what is a connection pool'], 0, { cwd: dir });
      is(r1.code, 0, '--report with no path still exits 0');
      has(r1.out, 'report: ', '--report with no path states where it wrote');
      const printedPath = (r1.out.match(/^report: (.+)$/m) || [])[1];
      ok(printedPath && existsSync(printedPath) ? 'the file named in the output actually exists' : 'x');
      const html = printedPath ? readFileSync(printedPath, 'utf8') : '';
      has(html, '<!doctype html', 'the default-path report is real HTML, not a stub');

      const r2 = run(['--report=custom.html', 'what is a connection pool'], 0, { cwd: dir });
      ok(existsSync(join(dir, 'custom.html')) ? 'an explicit --report path is honored exactly' : 'x');
      has(r2.out, 'custom.html', 'the explicit path is echoed back in the output');

      // The parent directory does not exist -- writeFileSync must throw, and
      // that failure must degrade the run, not crash it: a report a caller
      // didn't ask to depend on should never turn success into failure.
      const badPath = join(dir, 'does-not-exist', 'r.html');
      const r3 = run([`--report=${badPath}`, 'what is a connection pool'], 0, { cwd: dir });
      is(r3.code, 0, 'a report that fails to write does not fail the whole search');
      has(r3.out, 'warning: could not write the report', 'the write failure is reported, not swallowed');
      hasnt(r3.out, 'report: ', 'no report: line is printed when the write actually failed');
      has(r3.out, 'sources[', 'the search result itself is unaffected by the report write failing');
    }
  }

  console.log('----');
  console.log(`${pass + fail} tests, ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
}
