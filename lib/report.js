'use strict';
/**
 * Standalone HTML report.
 *
 * The default output is TOON because the reader is usually an agent. This is
 * for the other reader — the developer deciding whether to act on the answer.
 * The three things that make this tool different are all visual and TOON
 * flattens them: a tier is a rank, a conflict is two things side by side, and
 * certainty is a judgement you should see before you read anything.
 *
 * Written to a FILE, never to stdout. An agent that piped a few thousand
 * tokens of markup back into its own context would be paying exactly the cost
 * this tool exists to avoid; it prints a path instead.
 *
 * Standalone by construction: no CDN, no script, no dependency. It renders the
 * same in lavish-axi, a browser, an email attachment, or a printer, and it
 * will still render in ten years.
 */

const TIER_LABEL = {
  1: 'primary — the thing itself',
  2: 'authoritative — built or studied it',
  3: 'secondhand — read the primary',
  4: 'aggregator — read the secondhand',
};

/**
 * How fast a claim rots.
 *
 * Cached research that has quietly gone wrong is worse than no cache: it is
 * fast, wrong, and wears the authority of something verified once. Industry
 * surveys put freshness — not retrieval quality — behind most RAG deployments
 * that fail after a working proof of concept, so the report says which claims
 * are the perishable ones rather than presenting all of them as timeless.
 */
function volatility(text) {
  const t = String(text).toLowerCase();
  if (/\b(latest|currently|as of|now|new|recent|price|pricing|version \d|v\d+\.\d|deprecat|beta|preview)\b/.test(t)) {
    return { class: 'fast', revalidate: 'weeks' };
  }
  if (/\b(api|endpoint|flag|option|config|default|release|library|package|supports?)\b/.test(t)) {
    return { class: 'slow', revalidate: 'months' };
  }
  return { class: 'static', revalidate: 'rarely' };
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {object} data question, query, certainty, sources, conflicts, gaps
 * @returns {string} a complete HTML document
 */
function renderReport(data) {
  const { question, query, certainty, sources = [], conflicts = [], gaps = {}, providers = [] } = data;
  const read = sources.filter((s) => s.read);
  const unread = sources.filter((s) => !s.read);
  const claimCount = read.reduce((n, s) => n + (s.claims || []).length, 0);
  const kb = Math.round(sources.reduce((n, s) => n + (s.bytes || 0), 0) / 1024);
  const best = read.length ? Math.min(...read.map((s) => s.tier)) : null;

  const claims = read
    .slice()
    .sort((a, b) => a.tier - b.tier)
    .map(
      (s) => `
      <section class="src t${s.tier}">
        <header>
          <span class="tier">tier ${s.tier}</span>
          <a class="host" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.host)}</a>
          <span class="why">${esc(s.why)}</span>
        </header>
        <ul>${(s.claims || [])
          .map((c) => {
            const v = volatility(c.text);
            return `<li>${esc(c.text)}${
              v.class === 'static' ? '' : ` <span class="vol v-${v.class}" title="recheck in ${v.revalidate}">${v.class}</span>`
            }</li>`;
          })
          .join('')}</ul>
      </section>`
    )
    .join('');

  // The hero element. Averaging two disagreeing sources into one confident
  // sentence is the failure this tool exists to prevent, so the disagreement
  // is given the most visual weight on the page.
  const conflictBlock = conflicts.length
    ? `<h2>Disagreements <span class="count">${conflicts.length}</span></h2>
       <p class="note">Both sides are shown. The more authoritative source is marked; neither is silently dropped.</p>
       ${conflicts
         .map(
           (c) => `
       <div class="conflict">
         <div class="kind">${esc(c.kind)}</div>
         <div class="sides">
           <div class="side t${c.a.tier} ${c.prefer && c.prefer.host === c.a.host ? 'preferred' : ''}">
             <span class="tier">tier ${c.a.tier}</span>
             <a href="${esc(c.a.url)}" target="_blank" rel="noopener">${esc(c.a.host)}</a>
             <p>${esc(c.a.text)}</p>
           </div>
           <div class="side t${c.b.tier} ${c.prefer && c.prefer.host === c.b.host ? 'preferred' : ''}">
             <span class="tier">tier ${c.b.tier}</span>
             <a href="${esc(c.b.url)}" target="_blank" rel="noopener">${esc(c.b.host)}</a>
             <p>${esc(c.b.text)}</p>
           </div>
         </div>
         <div class="verdict">${
           c.prefer
             ? `Prefer <strong>${esc(c.prefer.host)}</strong> — tier ${c.prefer.tier}, more authoritative. Not because more pages agree with it.`
             : `Same tier. Both stand; this needs a human decision.`
         }</div>
       </div>`
         )
         .join('')}`
    : '';

  // A gap is only useful if it tells you what to run next. "nothing addressed
  // pgbouncer" is a dead end; the command that would address it is not.
  const gapItems = [
    ...unread.map((s) => `<li><code>${esc(s.host)}</code> — ${esc(s.reason)}</li>`),
    ...(gaps.missingTerms && gaps.missingTerms.length
      ? gaps.missingTerms.map(
          (t) =>
            `<li>nothing read addressed <code>${esc(t)}</code>
             <div class="next">ai-internet-search "${esc(query)} ${esc(t)}"</div></li>`
        )
      : []),
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(question)} — ai-internet-search</title>
<style>
:root {
  --bg:#fbfaf8; --surface:#fff; --line:#e6e2db; --ink:#1c1b19; --ink-2:#55514b; --ink-3:#8a857d;
  --t1:#0d7a5f; --t2:#2563eb; --t3:#8a857d; --t4:#b45309; --warn:#b45309;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
}
@media (prefers-color-scheme: dark){:root:not([data-theme=light]){
  --bg:#16151a; --surface:#1d1c22; --line:#2c2a33; --ink:#ecebe8; --ink-2:#a8a49d; --ink-3:#736f68;
  --t1:#34d399; --t2:#60a5fa; --t3:#9ca3af; --t4:#f59e0b; --warn:#f59e0b;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
main{max-width:820px;margin:0 auto;padding:40px 20px 80px}
h1{font-size:23px;line-height:1.3;margin:0 0 6px;letter-spacing:-.02em}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3);margin:36px 0 12px;font-weight:600}
.count{background:var(--warn);color:#fff;border-radius:999px;padding:1px 8px;font-size:12px;letter-spacing:0}
.q{font:12px/1.5 var(--mono);color:var(--ink-3);margin:0 0 24px}
.note{color:var(--ink-3);font-size:13px;margin:-6px 0 14px}

/* Certainty leads, because it changes how everything below should be read. */
.certainty{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;
  padding:14px 16px;border:1px solid var(--line);border-left:4px solid var(--grade);
  border-radius:8px;background:var(--surface);margin-bottom:8px}
.certainty b{font-size:17px;letter-spacing:-.01em;color:var(--grade)}
.certainty span{color:var(--ink-2);font-size:13.5px}

.src{border:1px solid var(--line);border-left:3px solid var(--tier);border-radius:8px;
  background:var(--surface);padding:12px 16px;margin-bottom:10px}
.src header{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.tier{font:11px var(--mono);color:#fff;background:var(--tier);padding:1px 7px;border-radius:4px}
.host{font:12.5px var(--mono);color:var(--ink);text-decoration:none;border-bottom:1px solid var(--line)}
.host:hover{border-color:var(--ink-3)}
.why{font-size:12px;color:var(--ink-3)}
.src ul{margin:0;padding-left:18px}
.src li{margin-bottom:6px;color:var(--ink-2)}
.t1{--tier:var(--t1)} .t2{--tier:var(--t2)} .t3{--tier:var(--t3)} .t4{--tier:var(--t4)}

.conflict{border:1px solid var(--warn);border-radius:8px;background:var(--surface);margin-bottom:14px;overflow:hidden}
.kind{background:var(--warn);color:#fff;font:11px var(--mono);padding:4px 12px;letter-spacing:.04em}
.sides{display:grid;grid-template-columns:1fr 1fr}
.side{padding:12px 16px;border-left:3px solid var(--tier)}
.side+.side{border-top:0;box-shadow:inset 1px 0 0 var(--line)}
.side p{margin:6px 0 0;color:var(--ink-2);font-size:14px}
.side.preferred{background:color-mix(in srgb,var(--tier) 7%,transparent)}
.side a{font:12.5px var(--mono);color:var(--ink);text-decoration:none}
.verdict{padding:10px 16px;border-top:1px solid var(--line);font-size:13.5px;color:var(--ink-2)}

.gaps{border:1px dashed var(--line);border-radius:8px;padding:12px 16px;background:var(--surface)}
.gaps ul{margin:0;padding-left:18px} .gaps li{color:var(--ink-2);margin-bottom:4px}
code{font:12.5px var(--mono);background:var(--bg);border:1px solid var(--line);padding:1px 5px;border-radius:4px}
.vol{font:10px var(--mono);padding:1px 5px;border-radius:3px;vertical-align:1px;letter-spacing:.03em}
.v-fast{background:var(--t4);color:#fff}
.v-slow{background:var(--line);color:var(--ink-2)}
.next{font:12.5px/1.7 var(--mono);background:var(--bg);border:1px solid var(--line);
  border-radius:6px;padding:8px 12px;margin-top:6px;color:var(--ink);user-select:all;overflow-x:auto}
.repro{border:1px solid var(--line);border-radius:8px;background:var(--surface);padding:12px 16px}
.repro .note{margin:10px 0 0}

footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);
  font:12px/1.7 var(--mono);color:var(--ink-3)}
footer a{color:inherit}
@media (max-width:640px){.sides{grid-template-columns:1fr}.side+.side{box-shadow:inset 0 1px 0 var(--line)}}
@media print{body{background:#fff}.src,.conflict,.certainty{break-inside:avoid}}
</style>
</head>
<body>
<main>
  <h1>${esc(question)}</h1>
  <p class="q">searched: <code>${esc(query)}</code> · providers: ${esc(providers.join(', ') || 'none')}</p>

  <div class="certainty" style="--grade:${
    { high: 'var(--t1)', moderate: 'var(--t2)', low: 'var(--t4)', 'very low': 'var(--t4)', none: 'var(--t4)' }[
      certainty.level
    ] || 'var(--t3)'
  }">
    <b>${esc(certainty.level)} certainty</b>
    <span>${esc(certainty.why)}</span>
  </div>

  ${conflictBlock}

  <h2>Claims by source credibility</h2>
  <p class="note">Ordered by tier, never by how many pages agree. ${
    best === 1 ? 'A primary source was read.' : 'No primary source was read — treat this as secondhand.'
  }</p>
  ${claims || '<p class="note">Nothing could be read.</p>'}

  ${
    gapItems.length
      ? `<h2>Could not establish</h2>
         <div class="gaps"><ul>${gapItems.join('')}</ul></div>`
      : ''
  }

  <h2>Reproduce or extend</h2>
  <div class="repro">
    <div class="next">${esc(data.command || `ai-internet-search --report "${question}"`)}</div>
    <p class="note">Re-run to refresh. Claims marked <span class="vol v-fast">fast</span> or
    <span class="vol v-slow">slow</span> above are the ones that go out of date.</p>
  </div>

  <footer>
    ${sources.length} source(s) opened · ${claimCount} claim(s) · ${kb}kb read<br>
    tier 1 ${TIER_LABEL[1]} · tier 2 ${TIER_LABEL[2]} · tier 3 ${TIER_LABEL[3]} · tier 4 ${TIER_LABEL[4]}<br>
    generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} by
    <a href="https://github.com/rambaarde/ai-internet-search">ai-internet-search</a>
  </footer>
</main>
</body>
</html>`;
}

module.exports = { renderReport };
