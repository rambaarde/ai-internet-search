'use strict';
/**
 * Standalone HTML report — styled as a research brief, not a dashboard.
 *
 * The default output is TOON because the reader is usually an agent. This is
 * for the other reader — the human deciding whether to act on the answer —
 * and a human evaluating evidence reads faster in the register evidence
 * usually comes in: a stated certainty up front, numbered findings, cited
 * sources, a bibliography. Three things TOON flattens get their own section
 * here: a tier is a rank, a conflict is two things placed side by side, and
 * certainty is a judgement stated before any finding, not implied by one.
 *
 * Written to a FILE, never to stdout. An agent that piped a few thousand
 * tokens of markup back into its own context would be paying exactly the
 * cost this tool exists to avoid; it prints a path instead.
 *
 * Standalone by construction: no CDN, no script, no dependency. It renders
 * the same in lavish-axi, a browser, an email attachment, or a printer, and
 * it will still render in ten years. That rules out Mermaid or Excalidraw as
 * literally embedded — both need either a CDN script or a bundled runtime.
 * The "Evidence map" below draws the same idea (sources ranked, disagreements
 * connected) as static, hand-generated SVG instead: no library, nothing that
 * can go stale, nothing a print or an email client has to execute.
 */

const TIER_LABEL = {
  1: 'primary. The thing itself',
  2: 'authoritative. Built it or studied it',
  3: 'secondhand. Read the primary source',
  4: 'aggregator. Read the secondhand source',
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
 * A static SVG diagram — sources ranked left to right by credibility, with a
 * curved line joining any two that disagree. Only drawn when there is
 * something to show: one source alone has no ranking to visualize, and no
 * disagreement has nothing to connect. This is the "if it wants
 * visualization, add one" rule, decided from the data rather than a flag.
 *
 * @param {object[]} ranked read sources, already sorted by tier
 * @param {object[]} conflicts
 * @param {Map<object, number>} refOf
 */
function evidenceMap(ranked, conflicts, refOf) {
  if (!conflicts.length && ranked.length < 2) return '';

  const boxW = 152;
  const boxH = 46;
  const gapX = 26;
  const top = 30;
  const nodes = ranked.slice(0, 6); // legible cap; the bibliography carries the rest
  const xFor = (i) => i * (boxW + gapX);
  const totalW = Math.max(420, nodes.length * (boxW + gapX) - gapX);
  const shortHost = (h) => (h.length > 20 ? h.slice(0, 19) + '…' : h);

  const boxes = nodes
    .map(
      (s, i) => `
    <g transform="translate(${xFor(i)},${top})">
      <rect width="${boxW}" height="${boxH}" rx="2" class="t${s.tier}"/>
      <text x="${boxW / 2}" y="18" text-anchor="middle" class="ref">[${refOf.get(s)}] tier ${s.tier}</text>
      <text x="${boxW / 2}" y="34" text-anchor="middle" class="host">${esc(shortHost(s.host))}</text>
    </g>`
    )
    .join('');

  const idxByHost = new Map(nodes.map((s, i) => [s.host, i]));
  const rowY = top + boxH;
  const links = conflicts
    .map((c) => {
      const ia = idxByHost.get(c.a.host);
      const ib = idxByHost.get(c.b.host);
      if (ia == null || ib == null || ia === ib) return '';
      const x1 = xFor(Math.min(ia, ib)) + boxW / 2;
      const x2 = xFor(Math.max(ia, ib)) + boxW / 2;
      const midY = rowY + 34;
      return `
      <path d="M${x1},${rowY} C${x1},${midY} ${x2},${midY} ${x2},${rowY}" class="dispute"/>
      <text x="${(x1 + x2) / 2}" y="${midY + 13}" text-anchor="middle" class="dispute-label">${esc(c.kind)}</text>`;
    })
    .join('');

  const height = rowY + (conflicts.length ? 58 : 12);
  return `
  <figure class="map">
    <svg width="${totalW}" height="${height}" viewBox="0 0 ${totalW} ${height}" role="img" aria-label="Sources ranked by credibility, with any disagreement between them marked.">
      ${boxes}${links}
    </svg>
    <figcaption>Figure 1. Sources in rank order. The most credible source is on the left. A broken line joins two sources that disagree.</figcaption>
  </figure>`;
}

/**
 * @param {object} data question, query, certainty, sources, conflicts, gaps
 * @returns {string} a complete HTML document
 */
function renderReport(data) {
  const { question, query, certainty, sources = [], conflicts = [], gaps = {}, providers = [],
          candidatesFound = null, skipped = [] } = data;
  const read = sources.filter((s) => s.read);
  const unread = sources.filter((s) => !s.read);
  const claimCount = read.reduce((n, s) => n + (s.claims || []).length, 0);
  const kb = Math.round(sources.reduce((n, s) => n + (s.bytes || 0), 0) / 1024);
  const best = read.length ? Math.min(...read.map((s) => s.tier)) : null;

  // Citation numbers, assigned in the order sources are actually discussed:
  // ranked findings first, then anything unread that only appears in the
  // bibliography and the open-questions list.
  const ranked = read.slice().sort((a, b) => a.tier - b.tier);
  const refOf = new Map([...ranked, ...unread].map((s, i) => [s, i + 1]));

  let sectionNo = 0;
  const numbered = (title) => `<h2>${++sectionNo}. ${title}</h2>`;

  const findings = ranked
    .map(
      (s) => `
      <div class="finding">
        <p class="cite">[${refOf.get(s)}]
          <a class="host" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.host)}</a>
          <span class="tlabel t${s.tier}">tier ${s.tier}, ${esc(TIER_LABEL[s.tier] || '')}</span>
        </p>
        <ul>${(s.claims || [])
          .map((c) => {
            const v = volatility(c.text);
            return `<li>${esc(c.text)}${
              v.class === 'static' ? '' : ` <span class="vol v-${v.class}" title="recheck in ${v.revalidate}">${v.class}</span>`
            }</li>`;
          })
          .join('')}</ul>
      </div>`
    )
    .join('');

  // The hero element. Averaging two disagreeing sources into one confident
  // sentence is the failure this tool exists to prevent, so the disagreement
  // gets its own numbered section, before the findings it qualifies.
  const conflictBlock = conflicts.length
    ? `${numbered('Disagreements')}
       <p class="lede">Both sides appear below. The report marks the more authoritative source. It does not drop either side.</p>
       ${conflicts
         .map(
           (c) => `
       <div class="conflict">
         <p class="kind">${esc(c.kind)}</p>
         <div class="sides">
           <div class="side ${c.prefer && c.prefer.host === c.a.host ? 'preferred' : ''}">
             <p class="cite">tier ${c.a.tier} · <a href="${esc(c.a.url)}" target="_blank" rel="noopener">${esc(c.a.host)}</a></p>
             <p>${esc(c.a.text)}</p>
           </div>
           <div class="side ${c.prefer && c.prefer.host === c.b.host ? 'preferred' : ''}">
             <p class="cite">tier ${c.b.tier} · <a href="${esc(c.b.url)}" target="_blank" rel="noopener">${esc(c.b.host)}</a></p>
             <p>${esc(c.b.text)}</p>
           </div>
         </div>
         <p class="verdict">${
           c.prefer
             ? `Prefer <strong>${esc(c.prefer.host)}</strong>. It is tier ${c.prefer.tier} and more authoritative. The number of pages that agree does not decide this.`
             : `Both sources are the same tier. Both claims stand. A person must decide.`
         }</p>
       </div>`
         )
         .join('')}`
    : '';

  const findingsBlock = `${numbered('Findings, ranked by source credibility')}
    <p class="lede">Ordered by tier, never by how many pages agree. ${
      best === 1 ? 'A primary source was read.' : 'No primary source was read. Treat this as secondhand.'
    }</p>
    ${findings || '<p class="lede">Nothing could be read.</p>'}`;

  // A gap is only useful if it says what to run next. "nothing addressed
  // pgbouncer" is a dead end; the command that would address it is not.
  const gapItems = [
    ...unread.map((s) => `<li>[${refOf.get(s)}] <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.host)}</a>. Not read. ${esc(s.reason)}.</li>`),
    ...(gaps.missingTerms && gaps.missingTerms.length
      ? gaps.missingTerms.map(
          (t) =>
            `<li>Nothing that was read addressed <code>${esc(t)}</code>. Run this to look for it:
             <div class="next">ai-internet-search "${esc(query)} ${esc(t)}"</div></li>`
        )
      : []),
  ];
  const gapsBlock = gapItems.length
    ? `${numbered('Open questions')}
       <ul class="gaps">${gapItems.join('')}</ul>`
    : '';

  // Why a reader can check this rather than trust it.
  //
  // A developer's real question about an automated report is not "what did it
  // find" but "can I believe it". That is answered by what the report can
  // SHOW, not by an assurance: the exact search, the candidates that were
  // discarded and their rank, the fact that every claim is a quotation rather
  // than a summary, and the limits that still apply. A report that states its
  // own limits is more checkable than one that does not, which is the point.
  const skippedList = skipped.length
    ? `<ul class="gaps">${skipped
        .slice(0, 12)
        .map(
          (c) =>
            `<li>tier ${c.tier}, ${esc(c.host)}. Ranked below the sources above, or a second page from a host already used. Reason: ${esc(
              c.why
            )}.</li>`
        )
        .join('')}${skipped.length > 12 ? `<li>and ${skipped.length - 12} more.</li>` : ''}</ul>`
    : '';

  const mapSvgEarly = evidenceMap(ranked, conflicts, refOf);
  const mapBlockOrdered = mapSvgEarly ? `${numbered('Evidence Map')}${mapSvgEarly}` : '';

  const methodBlock = `${numbered('Method, and How to Check It')}
    <p class="para">The search term was “${esc(query)}”. ${
      providers.length ? `The providers were ${esc(providers.join(' and '))}.` : 'No provider returned a result.'
    }${
      candidatesFound != null
        ? ` They returned ${candidatesFound} candidate${candidatesFound === 1 ? '' : 's'}. The report opened ${sources.length}.`
        : ''
    } Each source was ranked by its web address before any page was fetched. The rank does not change when more pages agree.</p>
    <p class="para">Every claim above is a sentence copied from the page word for word. No claim is a summary, and no claim is rewritten. Each one carries a link to the page it came from, so you can open the source and find the same sentence there. This is the check that matters most: a report that rewrites its sources can drift from them, and this one cannot.</p>
    ${skippedList ? `<p class="para">These candidates were found and not opened:</p>${skippedList}` : ''}
    <p class="para">Three limits apply to this report. The providers are free and need no account, so they miss pages that a paid search index would find. The rank comes from the shape of a web address, so a page built to look like documentation can rank higher than it deserves. The tool reads text only, so a figure or a chart on a page is named but not read.</p>`;

  const bibliography = [...ranked, ...unread]
    .map((s) => {
      const status = s.read ? '' : `. <em>Not accessed. ${esc(s.reason || 'unread')}</em>`;
      return `<li id="ref-${refOf.get(s)}">[${refOf.get(s)}] <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.host)}</a>. ${esc(
        TIER_LABEL[s.tier] || ''
      )}${status}</li>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(question)} — ai-internet-search</title>
<style>
/* A typed paper, not a web page: white sheet, black ink, one serif face
   throughout, centered headings with no rules, and an indented first line on
   every paragraph. Color, boxes, and badges are all absent on purpose. They
   read as interface, and an interface invites skimming. A paper asks to be
   read. Rank and disagreement are carried by italics, indentation, and
   position instead, which also survive a black-and-white print. */
:root{
  /* Not pure black on pure white. That pairing maximizes contrast but is a
     documented cause of halation and eye strain over a long read. This keeps
     roughly 17:1, far above the 4.5:1 minimum. */
  --paper:#fdfdfc; --ink:#1a1a1a; --ink-2:#3d3d3a; --rule:#1a1a1a;
  --serif:"Times New Roman",Times,"Liberation Serif",Georgia,serif;
  --mono:"Courier New",Courier,monospace;
}
/* Pure white on pure black halates worst of all, so the dark sheet is an
   off-black with de-emphasized ink, about 11:1. */
@media (prefers-color-scheme: dark){:root:not([data-theme=light]){
  --paper:#16161a; --ink:#d8d8d4; --ink-2:#a5a5a0; --rule:#57575a;
}}
:root[data-theme=dark]{--paper:#16161a; --ink:#d8d8d4; --ink-2:#a5a5a0; --rule:#57575a;}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
  font:19px/1.55 var(--serif);text-rendering:optimizeLegibility;
  text-align:left;hyphens:none}
main{max-width:34em;margin:0 auto;padding:72px 32px 96px}
p{margin:0;orphans:2;widows:2}

/* Title block, centered, exactly as a paper puts it. */
.titleblock{text-align:center;margin-bottom:2.4em}
.titleblock h1{font-size:19px;font-weight:700;line-height:1.5;margin:0 0 .4em}
.titleblock .byline{font-size:17px;font-weight:400;line-height:1.6;margin:0}

/* Centered, bold, no rule, same size as the body. */
h2{font-size:19px;font-weight:700;text-align:center;margin:2.2em 0 .6em}

.abstract{margin:0 0 1.6em;text-indent:0}
.lede{margin:0 0 .6em;text-indent:0}
.para{text-indent:1.5em;margin:0}
h2 + .para,h2 + .abstract{text-indent:0}

.finding{margin:0 0 1.1em}
.cite{margin:0;text-indent:0}
.cite .host{color:inherit;text-decoration:none;border-bottom:1px solid currentColor}
.tlabel{font-style:italic}
.finding ul{margin:.15em 0 0;padding-left:2em;list-style:none}
.finding li{margin:0 0 .15em;text-indent:-1.1em;padding-left:1.1em}
.finding li::before{content:"— ";}

/* A perishable claim is named in words, not marked with a colored chip. */
.vol{font-style:italic;font-size:15px}
.vol::before{content:"("}
.vol::after{content:")"}
.v-fast,.v-slow{background:none;color:inherit}

/* Two disagreeing sources are set as indented quotations, one after the
   other, the way a paper quotes two conflicting authorities. */
.conflict{margin:0 0 1.3em}
.conflict .kind{font-style:italic;text-indent:0;margin:0 0 .3em}
.side{margin:0 0 .5em;padding-left:2.6em}
.side .cite{font-size:15px;font-style:italic}
.side p:last-child{margin:0}
.side.preferred .cite::after{content:" [preferred]";font-style:normal}
.verdict{text-indent:1.5em;margin:.4em 0 0}

.gaps{margin:0;padding-left:2em;list-style:none}
.gaps li{margin:0 0 .5em;text-indent:-1.1em;padding-left:1.1em}
.gaps li::before{content:"— ";}
code{font:15px var(--mono)}
.next{font:15px/1.8 var(--mono);margin:.2em 0 0 1.1em;user-select:all;overflow-x:auto;text-indent:0}

/* Figure: black line art with a numbered caption, like a paper's plate.
   It scrolls rather than scaling down, because shrinking it to fit a phone
   makes the labels unreadable, and that is worse than asking for a swipe. */
.map{margin:0;overflow-x:auto}
.map svg{display:block;max-width:100%;height:auto;margin:0 auto;font-family:var(--serif)}
@media (max-width:560px){.map svg{max-width:none}}
.map svg rect{fill:none;stroke:var(--ink);stroke-width:1}
.map svg .ref{font:12px var(--serif);fill:var(--ink)}
.map svg .host{font:italic 12px var(--serif);fill:var(--ink)}
.map svg .dispute{fill:none;stroke:var(--ink);stroke-width:1;stroke-dasharray:3 3}
.map svg .dispute-label{font:italic 12px var(--serif);fill:var(--ink)}
.map figcaption{font-size:15px;text-align:center;margin-top:.6em}

/* Hanging indent, as a reference list is always set. */
ol.bib{padding:0;margin:0;list-style:none}
ol.bib li{margin:0 0 .45em;padding-left:2.2em;text-indent:-2.2em}
ol.bib a{color:inherit;text-decoration:none;border-bottom:1px solid currentColor}

footer{margin-top:3em;padding-top:.8em;border-top:1px solid var(--rule);
  font-size:15px;color:var(--ink-2);text-align:center}
footer a{color:inherit}

@media print{
  @page{margin:1in}
  body{background:#fff;color:#000;font-size:12pt}
  main{max-width:none;padding:0}
  .conflict,.finding,.map{break-inside:avoid}
}
</style>
</head>
<body>
<main>
  <div class="titleblock">
    <h1>${esc(question)}</h1>
    <p class="byline">Automated Research Brief<br>
      ai-internet-search<br>
      ${new Date().toISOString().slice(0, 10)}</p>
  </div>

  <h2>Abstract</h2>
  <p class="abstract">This report answers the question above from ${sources.length} source${
    sources.length === 1 ? '' : 's'
  } found by ${esc(providers.join(' and ') || 'no provider')}. The search term was
  “${esc(query)}”. The certainty is <strong>${esc(certainty.level)} certainty</strong>, because ${esc(certainty.why)}.
  Sources are ranked by credibility before they are read. The count of pages that agree does not change the rank.</p>

  ${conflictBlock}
  ${findingsBlock}
  ${gapsBlock}
  ${mapBlockOrdered}
  ${methodBlock}

  <h2>References</h2>
  <ol class="bib">${bibliography || '<li>No source was consulted.</li>'}</ol>

  <h2>How to Repeat This</h2>
  <p class="para">Run the command below to make this report again.</p>
  <div class="next">${esc(data.command || `ai-internet-search --report "${question}"`)}</div>

  <footer>
    ${claimCount} claim${claimCount === 1 ? '' : 's'} from ${read.length} source${
      read.length === 1 ? '' : 's'
    }. ${kb}kb read.
    Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} by
    <a href="https://github.com/rambaarde/ai-internet-search">ai-internet-search</a>.
  </footer>
</main>
</body>
</html>`;
}

module.exports = { renderReport };
