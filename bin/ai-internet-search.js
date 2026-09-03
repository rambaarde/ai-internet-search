#!/usr/bin/env node
'use strict';
/**
 * ai-internet-search — internet research for AI agents that is defensible.
 *
 * The failure this exists to prevent is documented, not hypothetical. Research
 * agents resolve disagreement by counting: models "favor the majority
 * viewpoint among retrieved contexts, even when opposing evidence is more
 * credible" (arxiv 2505.17762), and they "consistently favored SEO-optimized
 * content farms over authoritative sources" (Anthropic). Content farms exist
 * to produce volume, so the majority view is the farm's view.
 *
 * So this ranks sources by credibility BEFORE reading them, opens few, and
 * reports what it could not establish rather than filling the gap with prose.
 *
 * Output follows AXI conventions for agent-called CLIs: TOON rather than JSON,
 * a definitive empty state, next-step hints, errors on stdout, and exit codes
 * 0 success / 1 error / 2 bad usage.
 */

const { findCandidates, keywords, kindsFor } = require('../lib/search');
const { triage } = require('../lib/sources');
const { readSources } = require('../lib/extract');
const { findConflicts, grade, gaps } = require('../lib/assess');
const { renderReport } = require('../lib/report');
const { writeFileSync, statSync } = require('node:fs');
const { join } = require('node:path');

const VERSION = require('../package.json').version;

/** TOON: a header naming count and columns, then bare comma-joined rows. */
function toon(name, columns, rows) {
  const head = `${name}[${rows.length}]{${columns.join(',')}}:`;
  if (!rows.length) return head;
  const body = rows
    .map((r) => '  ' + columns.map((c) => String(r[c] ?? '').replace(/[\n,]/g, ' ')).join(','))
    .join('\n');
  return head + '\n' + body;
}

const HELP = `ai-internet-search v${VERSION}
Internet research for AI agents. Ranks sources by credibility rather than
counting them, and states what it could not establish.

usage:
  ai-internet-search <question>            research a question
  ai-internet-search --plan <question>     show the queries and sources, fetch nothing
  ai-internet-search --limit N <question>  open at most N sources (default 3)

flags:
  --plan          triage only; never opens a source
  --limit N       maximum sources to open (default 3)
  --per-host N    maximum sources per host (default 1)
  --json          emit JSON instead of TOON
  --report [path] also write a standalone HTML report and print its path
  --help          this text
  --version       print version

exit codes:
  0 success   1 error   2 bad usage`;

function parseArgs(argv) {
  const opts = { limit: 3, perHost: 1, plan: false, json: false, report: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--version' || a === '-V') return { version: true };
    else if (a === '--plan') opts.plan = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--report') {
      // Optional path. `--report` alone picks a filename; `--report x.html` names one.
      const next = argv[i + 1];
      opts.report = next && !next.startsWith('--') ? argv[++i] : '';
    }
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--per-host') opts.perHost = Number(argv[++i]);
    // AXI: an unknown flag fails loudly rather than being swallowed as text.
    else if (a.startsWith('--')) return { badFlag: a };
    else rest.push(a);
  }
  opts.question = rest.join(' ').trim();
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) return out(HELP, 0);
  if (opts.version) return out(VERSION, 0);
  if (opts.badFlag) {
    return out(`error: unknown flag ${opts.badFlag}\nhelp[1]:\n  ai-internet-search --help`, 2);
  }
  // AXI content-first: with no arguments, say what this is and what to run,
  // rather than printing a wall of help.
  if (!opts.question) {
    return out(
      `ai-internet-search v${VERSION} — internet research for AI agents, ranked by source credibility.\n` +
        `help[2]:\n` +
        `  ai-internet-search "<your question>"\n` +
        `  ai-internet-search --plan "<your question>"   # see the plan, fetch nothing`,
      0
    );
  }

  const query = keywords(opts.question);
  const terms = query.split(' ').filter(Boolean);
  const found = await findCandidates(opts.question);
  const chosen = triage(found.candidates, { limit: opts.limit, perHost: opts.perHost });

  // --plan stops before any page is fetched. Useful for seeing what would be
  // read, and for costing a question before paying for it.
  const opened = opts.plan ? chosen.map((c) => ({ ...c, read: false, reason: 'not fetched (--plan)', claims: [] }))
                           : await readSources(chosen, terms);
  const conflicts = opts.plan ? [] : findConflicts(opened);
  const certainty = opts.plan ? { level: 'n/a', why: 'planning only' } : grade(opened, conflicts);
  const missing = gaps(opened, terms);

  // A file, never stdout. An agent piping markup back into its own context
  // would pay exactly the cost this tool exists to avoid, so it gets a path.
  let reportPath = '';
  if (opts.report !== null && !opts.plan) {
    const slug = query.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'research';
    reportPath = opts.report || join(process.cwd(), `${slug}.html`);
    try {
      // The command as actually run, flags included -- a reproduce line that
      // omits --limit 5 does not reproduce anything.
      const flags = [
        opts.limit !== 3 ? `--limit ${opts.limit}` : '',
        opts.perHost !== 1 ? `--per-host ${opts.perHost}` : '',
        '--report',
      ].filter(Boolean).join(' ');
      writeFileSync(reportPath, renderReport({ question: opts.question, query, certainty,
        sources: opened, conflicts, gaps: missing, providers: found.providers,
        command: `ai-internet-search ${flags} "${opts.question}"` }));
    } catch (e) {
      reportPath = '';
      process.stdout.write(`warning: could not write the report (${e.message})\n`);
    }
  }

  if (opts.json) {
    return out(JSON.stringify({ question: opts.question, query, kinds: kindsFor(opts.question),
      providers: found.providers, failed: found.failed, candidates: found.candidates.length,
      certainty, conflicts, gaps: missing, sources: opened }, null, 2), 0);
  }

  const lines = [];
  lines.push(`question: ${opts.question}`);
  lines.push(`query: ${query}`);
  lines.push(`providers: ${found.providers.join(',') || 'none'}${found.failed.length ? `  unreachable: ${found.failed.join(',')}` : ''}`);
  lines.push('');

  // AXI: a definitive empty state. Silence is indistinguishable from a crash,
  // and a confident guess is worse than either.
  if (!opened.length) {
    lines.push(`sources[0]{tier,host,title}:`);
    lines.push('');
    lines.push(`could_not_establish: no source above the noise floor answered this.`);
    lines.push(`  ${found.candidates.length} candidate(s) were found and none were relevant enough to open.`);
    lines.push('');
    lines.push('help[2]:');
    lines.push(`  ai-internet-search "<fewer, more distinctive words>"`);
    lines.push(`  key-less providers have limited recall; a search API can be plugged in for better coverage`);
    return out(lines.join('\n'), 0);
  }

  // Certainty first: it changes how everything below should be read.
  lines.push(`certainty: ${certainty.level} — ${certainty.why}`);
  lines.push('');

  const claimRows = [];
  for (const s of opened) {
    for (const c of s.claims) claimRows.push({ tier: s.tier, host: s.host, claim: c.text });
  }
  lines.push(toon('claims', ['tier', 'host', 'claim'], claimRows));
  lines.push('');

  // Localised, never averaged. Models are documented to detect conflict but
  // fail to place it, so it is placed for them.
  if (conflicts.length) {
    lines.push(`conflicts[${conflicts.length}]:`);
    for (const c of conflicts) {
      lines.push(`  ${c.kind}`);
      lines.push(`    tier ${c.a.tier}  ${c.a.host}: ${c.a.text}`);
      lines.push(`    tier ${c.b.tier}  ${c.b.host}: ${c.b.text}`);
      lines.push(`    prefer: ${c.prefer ? `${c.prefer.host} (tier ${c.prefer.tier}, more authoritative)` : 'neither — same tier, both stand'}`);
    }
    lines.push('');
  }

  // Visuals are listed separately and never described, because this tool
  // cannot see them. A model with vision can open the url; a model without one
  // at least knows the page's argument partly lives in a picture.
  const visuals = [];
  for (const s of opened) for (const v of s.visuals || []) visuals.push({ tier: s.tier, host: s.host, why: v.why, url: v.url });
  if (visuals.length) {
    lines.push(toon('visuals', ['tier', 'host', 'why', 'url'], visuals));
    const ptr = opened.flatMap((s) => s.visualPointers || []);
    if (ptr.length) {
      lines.push(`  the page points at them:`);
      for (const p of ptr.slice(0, 2)) lines.push(`    ${p}`);
    }
    lines.push('');
  }

  const unread = opened.filter((s) => !s.read);
  if (unread.length || missing.missingTerms.length) {
    lines.push('could_not_establish:');
    for (const u of unread) lines.push(`  ${u.host} — ${u.reason}`);
    if (missing.missingTerms.length) {
      lines.push(`  nothing read addressed: ${missing.missingTerms.join(', ')}`);
    }
    lines.push('');
  }

  lines.push(`sources[${opened.length}]{tier,host,why,url}:`);
  for (const c of opened) lines.push(`  ${c.tier},${c.host},${c.why},${c.url}`);
  lines.push('');
  const kb = Math.round(opened.reduce((n, s) => n + (s.bytes || 0), 0) / 1024);
  lines.push(`triaged: ${found.candidates.length} found, ${opened.length} opened, ${found.candidates.length - opened.length} skipped before fetching${kb ? ` (${kb}kb read → ${claimRows.length} claims)` : ''}`);
  lines.push('');
  if (reportPath) {
    lines.push(`report: ${reportPath}`);
    // lavish-axi opens agent-written HTML with an annotation layer. Named only
    // if it is actually installed -- suggesting a tool the reader does not
    // have is noise, and the file opens in any browser regardless.
    // Resolved by walking PATH rather than shelling out: `shell: true` with
    // arguments emits a Node deprecation warning straight into the output an
    // agent reads, and a warning in a machine-read stream is a defect.
    const hasLavish = ['lavish-axi'].some((cmd) =>
      (process.env.PATH || '').split(':').some((dir) => {
        try {
          return dir && statSync(join(dir, cmd)).isFile();
        } catch {
          return false;
        }
      })
    );
    lines.push(hasLavish ? `  open with: lavish-axi ${reportPath}` : `  open it in any browser`);
    lines.push('');
  }

  lines.push('help[2]:');
  lines.push('  a tier-1 source outranks any number of tier-3+ ones; never settle a disagreement by counting');
  lines.push(`  ai-internet-search --report "<question>"   # standalone HTML for a human to read`);
  return out(lines.join('\n'), 0);
}

/** AXI: everything on stdout, including errors, so one stream is enough. */
function out(text, code) {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  process.exitCode = code;
}

main().catch((e) => {
  out(`error: ${e && e.message ? e.message : String(e)}\nhelp[1]:\n  ai-internet-search --help`, 1);
});
