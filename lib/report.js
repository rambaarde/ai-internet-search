'use strict';
/**
 * Standalone HTML report, set as a "Systems Data" page from an Apollo-era
 * operations handbook (the 1969 AOH genre, after the nasa-handbook skill at
 * github.com/R44VC0RP/skills).
 *
 * The default output is TOON because the reader is usually an agent. This is
 * for the other reader: the human deciding whether to act on the answer. The
 * handbook suits that reader because its structure is the trust signal, not
 * its decoration: numbered paragraphs that can be cited, a data table with
 * exact values, one NOTE or CAUTION that cannot be missed, and a checklist
 * card that says what to run next. Three things TOON flattens get their own
 * place here: a tier is a rank (figure 2.1-1 and the order of the findings),
 * a conflict is two things placed side by side, and certainty is stated in
 * the introduction, before any finding it qualifies.
 *
 * Written to a FILE, never to stdout. An agent that piped a few thousand
 * tokens of markup back into its own context would be paying exactly the
 * cost this tool exists to avoid; it prints a path instead.
 *
 * Standalone by construction: no CDN, no script, no font file, no dependency.
 * It renders the same in lavish-axi, a browser, an email attachment, or a
 * printer, and it will still render in ten years. The handbook typefaces are
 * named first in each font stack and fall back to system faces, so a report
 * stays one small file. Ink is pure black on white: a printer halftones any
 * grey or tint into a visible dot pattern.
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

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Figure 2.1-1: a functional block diagram in handbook drafting style. Sources
 * sit left to right in rank order, each tier inside its own dashed panel, and a
 * dashed wire joins any two that disagree, with its arrow on the preferred
 * source. Units are millimetres on paper: 180 units fill the text column.
 *
 * Only drawn when there is something to show: one source alone has no ranking
 * to visualize, and no disagreement has nothing to connect. Static SVG, built
 * here: no library, nothing a print or an email client has to execute.
 *
 * @param {object[]} ranked read sources, already sorted by tier
 * @param {object[]} conflicts
 * @param {Map<object, number>} refOf citation number of each source
 * @returns {string} a <figure>, or '' when there is nothing to draw
 */
function evidenceMap(ranked, conflicts, refOf) {
  if (!conflicts.length && ranked.length < 2) return '';

  const nodes = ranked.slice(0, 6); // legible cap; the references carry the rest
  const boxW = 27;
  const boxH = 11;
  const pad = 2; // room inside a tier panel
  const boxTop = 6.4;
  const panelBottom = boxTop + boxH + pad;
  const shortHost = (h) => (h.length > 12 ? h.slice(0, 11) + '…' : h);

  // Lay boxes out left to right; a tier change opens a new panel, so it needs
  // the extra room of two panel walls.
  let x = 1 + pad;
  const xs = nodes.map((s, i) => {
    if (i > 0) x += boxW + (s.tier === nodes[i - 1].tier ? 3 : 2 * pad + 3);
    return x;
  });
  const W = Math.max(180, x + boxW + pad + 1);

  const panels = [];
  nodes.forEach((s, i) => {
    const last = panels[panels.length - 1];
    if (last && last.tier === s.tier) last.end = i;
    else panels.push({ tier: s.tier, start: i, end: i });
  });

  const panelSvg = panels
    .map((p) => {
      const px = xs[p.start] - pad;
      const pw = xs[p.end] + boxW + pad - px;
      return `<rect class="panel" x="${px}" y="1" width="${pw}" height="${panelBottom - 1}"/>
      <text class="lbl-s" x="${px + 1.4}" y="4.6">TIER ${p.tier}</text>`;
    })
    .join('');

  const boxSvg = nodes
    .map(
      (s, i) => `<rect class="box" x="${xs[i]}" y="${boxTop}" width="${boxW}" height="${boxH}"/>
      <text class="lbl" x="${xs[i] + boxW / 2}" y="${boxTop + 4.6}" text-anchor="middle">[${refOf.get(s)}]</text>
      <text class="lbl-h" x="${xs[i] + boxW / 2}" y="${boxTop + 8.8}" text-anchor="middle">${esc(shortHost(s.host))}</text>`
    )
    .join('');

  // A disagreement is a wire below the row: down from one source, across,
  // and up into the other. Each wire runs on its own level so two never share
  // a line, and labels go last with a paper halo so no line crosses a word.
  const idxByHost = new Map(nodes.map((s, i) => [s.host, i]));
  const pairs = conflicts
    .map((c) => ({ c, ia: idxByHost.get(c.a.host), ib: idxByHost.get(c.b.host) }))
    .filter((p) => p.ia != null && p.ib != null && p.ia !== p.ib);
  const rowY = boxTop + boxH;
  const levelY = (k) => panelBottom + 4 + k * 7;

  const wires = pairs
    .map(({ c, ia, ib }, k) => {
      const preferB = c.prefer && c.prefer.host === c.b.host;
      const [from, to] = preferB ? [ia, ib] : [ib, ia]; // the arrow lands on the preferred side
      const x1 = xs[from] + boxW / 2;
      const x2 = xs[to] + boxW / 2;
      return `<path class="${c.prefer ? 'dispute wa' : 'dispute'}" d="M${x1},${rowY} V${levelY(k)} H${x2} V${rowY + 0.2}"/>`;
    })
    .join('');
  const wireLabels = pairs
    .map(({ c, ia, ib }, k) => {
      const mid = (xs[ia] + xs[ib]) / 2 + boxW / 2;
      const prefer = c.prefer ? ` · PREFER [${refOf.get(nodes[c.prefer.host === c.a.host ? ia : ib])}]` : '';
      return `<text class="lbl-s halo" x="${mid}" y="${levelY(k) + 3.3}" text-anchor="middle">${esc(String(c.kind).toUpperCase())}${prefer}</text>`;
    })
    .join('');

  const H = (pairs.length ? levelY(pairs.length - 1) + 5 : panelBottom + 2) + 3.4;
  return `
  <figure>
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Sources ranked by credibility, with any disagreement between them marked.">
      <defs><marker id="nh-arrow" viewBox="0 0 6 4" refX="5.6" refY="2" markerWidth="2.4" markerHeight="1.3" markerUnits="userSpaceOnUse" orient="auto" preserveAspectRatio="none"><path d="M0,0 L6,2 L0,4 Z" fill="#000"/></marker></defs>
      ${panelSvg}${boxSvg}${wires}${wireLabels}
      <text class="code" x="${W - 1.4}" y="${H - 0.6}" text-anchor="end">AIS-501A</text>
    </svg>
    <figcaption><span class="n">Figure 2.1-1.</span>Sources in Rank Order, Most Credible at Left.${
      pairs.length ? ' A Dashed Line Joins Two Sources That Disagree; Its Arrow Points at the Preferred Source.' : ''
    }</figcaption>
  </figure>`;
}

/**
 * Render the research result as one handbook section (2.1), split across as
 * many printed pages as it needs.
 *
 * @param {object} data question, query, certainty, sources, conflicts, gaps,
 *   providers, candidatesFound, skipped, languages, command
 * @returns {string} a complete HTML document
 */
function renderReport(data) {
  const { question, query, certainty, sources = [], conflicts = [], gaps = {}, providers = [],
          candidatesFound = null, skipped = [], languages = [] } = data;
  const read = sources.filter((s) => s.read);
  const unread = sources.filter((s) => !s.read);
  const claimCount = read.reduce((n, s) => n + (s.claims || []).length, 0);
  const kb = Math.round(sources.reduce((n, s) => n + (s.bytes || 0), 0) / 1024);
  const best = read.length ? Math.min(...read.map((s) => s.tier)) : null;
  const now = new Date().toISOString();

  // Citation numbers, assigned in the order sources are actually discussed:
  // ranked findings first, then anything unread that only appears in the
  // references and the open-questions list.
  const ranked = read.slice().sort((a, b) => a.tier - b.tier);
  const refOf = new Map([...ranked, ...unread].map((s, i) => [s, i + 1]));

  // Paragraph numbers run 2.1.1, 2.1.2 … through the section, so a reader can
  // cite "2.1.3" the way a crew cited the AOH.
  let paraNo = 0;
  const para = (title, body, extra = '') => `
  <section class="para"${extra}>
    <div class="num">2.1.${++paraNo}</div>
    <div>
      <h2>${title}.</h2>
      ${body}
    </div>
  </section>`;
  const subPara = (no, title, body) => `
  <section class="para sub">
    <div class="num">2.1.${paraNo}.${no}</div>
    <div>
      <h3>${title}</h3>
      ${body}
    </div>
  </section>`;

  // Bottom line up front. This is the highest-ranked claim from the most
  // credible source that could be read, quoted, never composed: writing a
  // summary sentence would be the one place this tool paraphrased, and
  // paraphrase is where a citation drifts from its source.
  const topClaim = ranked.find((x) => (x.claims || []).length);
  const bottomLine = topClaim
    ? `The bottom line is quoted, not written, from the most credible source that could be read [${refOf.get(topClaim)}]: “${esc(topClaim.claims[0].text)}”`
    : 'Nothing could be established. No source above the noise floor answered this.';

  const intro = para(
    'Introduction',
    `<p>${bottomLine}</p>
      <p>Certainty is <strong class="caps">${esc(certainty.level)}</strong>, because ${esc(certainty.why)}.</p>`
  );

  // One notice, as the handbook allows one per page. A disagreement outranks
  // a missing primary source: averaging two disagreeing sources into one
  // confident sentence is the failure this tool exists to prevent.
  const conflictParaNo = conflicts.length ? paraNo + 1 : null; // disagreements follow the introduction
  const notice = conflicts.length
    ? { tag: 'CAUTION', text: `Sources disagree on ${plural(conflicts.length, 'point')}. Read paragraph 2.1.${conflictParaNo} before acting on any finding. The number of pages that agree does not decide.` }
    : !read.length
      ? { tag: 'NOTE', text: 'No source could be read. Nothing on this page is established.' }
      : best !== 1
        ? { tag: 'NOTE', text: 'No primary source was read. Treat every finding as secondhand.' }
        : null;

  const conflictBlock = conflicts.length
    ? para(
        'Disagreements',
        `<p>Both sides appear below. The page marks the more authoritative source. It does not drop either side.</p>`
      ) +
      conflicts
        .map((c, i) => {
          const side = (s) => `
        <blockquote class="side">
          <p class="cite">Tier ${s.tier}, <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.host)}</a>${
            c.prefer && c.prefer.host === s.host ? ' [preferred]' : ''
          }</p>
          <p>${esc(s.text)}</p>
        </blockquote>`;
          return subPara(
            i + 1,
            `${esc(c.kind)}.`,
            `<div class="conflict">${side(c.a)}${side(c.b)}
        <p class="flush">${
          c.prefer
            ? `Prefer ${esc(c.prefer.host)}. It is tier ${c.prefer.tier} and more authoritative. The number of pages that agree does not decide this.`
            : 'Both sources are the same tier. Both claims stand. A person must decide.'
        }</p></div>`
          );
        })
        .join('')
    : '';

  const findingsBlock =
    para(
      'Findings, Ranked by Source Credibility',
      `<p>Ordered by tier, never by how many pages agree. ${
        best === 1 ? 'A primary source was read.' : 'No primary source was read. Treat this as secondhand.'
      }</p>${ranked.length ? '' : '<p class="flush">Nothing could be read.</p>'}`
    ) +
    ranked
      .map((s, i) =>
        subPara(
          i + 1,
          `[${refOf.get(s)}] <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.host)}</a>, tier ${s.tier}, ${esc(TIER_LABEL[s.tier] || '')}.`,
          `<ul class="dash claims">${(s.claims || [])
            .map((c) => {
              const v = volatility(c.text);
              return `<li>${esc(c.text)}${
                v.class === 'static' ? '' : ` <span class="vol v-${v.class}" title="recheck in ${v.revalidate}">${v.class}</span>`
              }</li>`;
            })
            .join('')}</ul>`
        )
      )
      .join('');

  // A gap is only useful if it says what to run next. "nothing addressed
  // pgbouncer" is a dead end; the command that would address it is not. The
  // commands go on the checklist card, in the order to run them.
  const steps = [];
  const missing = (gaps.missingTerms || []).map((t, i) => {
    const next = gaps.next && gaps.next[i];
    if (!next) return `<li>Nothing that was read addressed “${esc(t)}”.</li>`;
    steps.push({ action: 'RUN', cmd: `ai-internet-search "${esc(next)}"`, verify: `${esc(t)} - addressed` });
    return `<li>Nothing that was read addressed “${esc(t)}”. Card step ${steps.length} searches for it.</li>`;
  });
  steps.push({ action: 'REPEAT', cmd: esc(data.command || `ai-internet-search --report "${question}"`) });

  const gapItems = [
    ...unread.map((s) => `<li>[${refOf.get(s)}] <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.host)}</a>. Not read. ${esc(s.reason)}.</li>`),
    ...missing,
  ];
  const gapsBlock = gapItems.length ? para('Open Questions', `<ul class="dash">${gapItems.join('')}</ul>`) : '';

  const card = `
      <div class="card">
        <div class="bar"><span>FOLLOW-UP PROCEDURE</span><span>OPERATOR</span></div>
        <ol>${steps
          .map(
            (s, i) =>
              `<li><span>${i + 1}</span><span>${s.action} - <span class="cmd">${s.cmd}</span></span></li>${
                s.verify ? `<li><span></span><span>  √ ${s.verify}</span></li>` : ''
              }`
          )
          .join('')}</ol>
      </div>`;

  const row = (k, v) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`;
  const lower = `
  <div class="lower">
    <div>
      <div class="tcap">Table 2.1-1. Search Data</div>
      <table>
        <thead><tr><th>Parameter</th><th>Value</th></tr></thead>
        <tbody>
          ${row('Search term', `“${esc(query)}”${languages && languages.length > 1 ? `, in ${esc(languages.join(', '))}` : ''}`)}
          ${row('Providers', esc(providers.join(', ') || 'none'))}
          ${candidatesFound != null ? row('Candidates found', candidatesFound) : ''}
          ${row('Sources opened', sources.length)}
          ${row('Sources read', read.length)}
          ${row('Claims quoted', claimCount)}
          ${row('Disagreements', conflicts.length)}
          ${row('Best tier read', best ? `${best}, ${esc(TIER_LABEL[best].split('.')[0])}` : 'none')}
          ${row('Text read', `${kb} kb`)}
        </tbody>
      </table>
    </div>
    <div>${notice ? `
      <div class="notice">
        <span class="tag">${notice.tag}</span>
        <p>${notice.text}</p>
      </div>` : ''}${card}
    </div>
  </div>`;

  // Why a reader can check this rather than trust it.
  //
  // A developer's real question about an automated report is not "what did it
  // find" but "can I believe it". That is answered by what the report can
  // SHOW, not by an assurance: the exact search, the candidates that were
  // discarded and their rank, the fact that every claim is a quotation rather
  // than a summary, and the limits that still apply. A report that states its
  // own limits is more checkable than one that does not, which is the point.
  const skippedList = skipped.length
    ? `<ul class="dash">${skipped
        .slice(0, 12)
        .map(
          (c) =>
            `<li>Tier ${c.tier}, ${esc(c.host)}. Ranked below the sources above, or a second page from a host already used. Reason: ${esc(
              c.why
            )}.</li>`
        )
        .join('')}${skipped.length > 12 ? `<li>And ${skipped.length - 12} more.</li>` : ''}</ul>`
    : '';

  const methodBlock = para(
    'Method, and How to Check It',
    `<p>The search term was “${esc(query)}”. ${
      providers.length ? `The providers were ${esc(providers.join(' and '))}.` : 'No provider returned a result.'
    }${
      candidatesFound != null
        ? ` They returned ${plural(candidatesFound, 'candidate')}. The report opened ${sources.length}.`
        : ''
    } Each source was ranked by its web address before any page was fetched. The rank does not change when more pages agree.</p>
      <p>Every claim above is a sentence copied from the page word for word. No claim is a summary, and no claim is rewritten. Each one carries a link to the page it came from, so the reader can open the source and find the same sentence there. A report that rewrites its sources can drift from them, and this one cannot.</p>
      ${skippedList ? `<p>These candidates were found and not opened:</p>${skippedList}` : ''}
      <p>Three limits apply. The providers are free and need no account, so they miss pages that a paid search index would find. The rank comes from the shape of a web address, so a page built to look like documentation can rank higher than it deserves. The tool reads text only, so a figure or a chart on a page is named but not read.</p>`
  );

  const references = [...ranked, ...unread]
    .map((s) => {
      const status = s.read ? '' : `. <em>Not accessed. ${esc(s.reason || 'unread')}</em>`;
      return `<li id="ref-${refOf.get(s)}">[${refOf.get(s)}] <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.host)}</a>. ${esc(
        TIER_LABEL[s.tier] || ''
      )}${status}</li>`;
    })
    .join('');
  const referencesBlock = para('References', `<ol class="refs">${references || '<li>No source was consulted.</li>'}</ol>`);

  // Order: the decision first (introduction, then the data band with its
  // notice and next steps), then the evidence that supports it.
  const body = [intro, lower, evidenceMap(ranked, conflicts, refOf), conflictBlock, findingsBlock, gapsBlock, methodBlock, referencesBlock].join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(question)} — ai-internet-search</title>
<style>
/* An operations-handbook page, not a web page. The genre is carried by
   structure: running head, numbered paragraphs, a figure with a figure code,
   a ruled data table, one notice, a checklist card, a thumb tab and a dated
   footer. No texture, no logos, no colour. */
:root{color-scheme:only light;
  --ink:#000;--paper:#fbfaf5;
  /* IBM Selectric body text, Leroy-lettered drawings, Letter Gothic for the
     checklist only, so that face always means "procedure". Each handbook face
     is used when installed and falls back to a system face. */
  --type:"Iowan Old Style","Iowan",Georgia,"Times New Roman",serif;
  --leroy:"Routed Gothic Narrow","Routed Gothic","Helvetica Neue",Helvetica,Arial,sans-serif;
  --selectric:"Letter Gothic","Letter Gothic Std","Courier New",Courier,monospace}
/* Must come after :root. A printed off-white tint is halftoned into dots. */
@media print{:root{--paper:#fff}}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#8a8a86}
body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
a{color:inherit;text-decoration:underline;text-decoration-thickness:.5pt;text-underline-offset:1.6pt}

.page{position:relative;max-width:210mm;min-height:297mm;margin:6mm auto;padding:9mm 15mm 10mm 16mm;
  background:var(--paper);color:var(--ink);font:10.5pt/1.42 var(--type);letter-spacing:.04em;
  text-align:left;hyphens:none}
.caps{text-transform:uppercase;letter-spacing:.08em}

/* Running head and dated footer. */
.head{text-align:center;line-height:1.3}
.head .doc,.head .title{font-weight:700;letter-spacing:.07em}
.head .part{margin-top:2mm;letter-spacing:.1em}
.rule{border-top:1.5pt solid var(--ink);margin:1.4mm -2mm 0}
.foot{margin-top:10mm}
.foot .rule{margin:0 -2mm 1.6mm}
.foot .sub{text-align:center;letter-spacing:.1em}
.foot .line{display:flex;flex-wrap:wrap;gap:1.5mm 5mm;justify-content:space-between;margin-top:2.2mm}
.foot .fill{display:inline-block;min-width:16mm;border-bottom:.6pt solid var(--ink);text-align:center;padding:0 1mm}

/* Black thumb tab, bleeding off the trim edge. */
.tab{position:absolute;right:0;top:40mm;width:8.5mm;height:17mm;background:var(--ink);color:var(--paper);
  font:8pt var(--leroy);letter-spacing:.08em;display:flex;align-items:center;justify-content:center}

.opener{text-align:center;letter-spacing:.12em;margin:4mm 0 3mm;line-height:1.6}
.opener .q{text-transform:uppercase}

/* Numbered paragraphs: the number in a left column, then the text. */
.para{display:grid;grid-template-columns:20mm 1fr;margin:0 0 1.6mm}
.para .num{letter-spacing:.08em}
.para h2,.para h3{margin:0 0 .8mm;font:inherit;font-weight:400}
.para h2{text-transform:uppercase;letter-spacing:.08em}
.para h3{text-decoration:underline;text-underline-offset:1.6pt;text-decoration-thickness:.5pt;letter-spacing:.05em}
.para h3 a{text-decoration:none}
.para p{margin:0 0 1.2mm;text-indent:9mm}
.para p.flush,.para .sub p,.para li p{text-indent:0}
.sub{margin-top:1mm}

ul.dash{margin:0 0 1.2mm;padding:0;list-style:none}
ul.dash li{margin:0 0 .6mm;padding-left:5mm;text-indent:-5mm}
ul.dash li::before{content:"— "}
/* A perishable claim is named in words, not marked with a coloured chip. */
.vol{font-style:italic;font-size:.88em}
.vol::before{content:"("}
.vol::after{content:")"}

/* Two disagreeing sources, quoted one after the other. */
.side{margin:0 0 1.2mm 6mm}
.side p{text-indent:0;margin:0}
.side .cite{font-style:italic}

ol.refs{margin:0;padding:0;list-style:none}
ol.refs li{margin:0 0 .6mm;padding-left:9mm;text-indent:-9mm}

/* Figure: Leroy-lettered line art, millimetres on paper. */
figure{margin:3mm 0 3mm;overflow-x:auto}
figure svg{display:block;width:100%;height:auto}
figcaption{text-align:center;margin-top:1mm;letter-spacing:.06em}
figcaption .n{margin-right:3mm}
svg text{font-family:var(--leroy);fill:var(--ink);text-transform:uppercase}
svg .box{fill:var(--paper);stroke:var(--ink);stroke-width:.45}
svg .panel{fill:none;stroke:var(--ink);stroke-width:.3;stroke-dasharray:2 1}
svg .dispute{fill:none;stroke:var(--ink);stroke-width:.3;stroke-dasharray:1.3 .7}
svg .wa{marker-end:url(#nh-arrow)}
svg .lbl{font-size:2.9px}
svg .lbl-s{font-size:2.5px}
svg .lbl-h{font-size:2.3px}
svg .code{font-size:2.4px}
svg .halo{paint-order:stroke;stroke:var(--paper);stroke-width:1.4;stroke-linejoin:round}

/* Data band: the table on the left, the notice and checklist card on the right. */
.lower{display:grid;grid-template-columns:1fr 72mm;column-gap:6mm;margin:3mm 0 3mm}
.tcap{text-align:center;letter-spacing:.07em;margin:0 0 1mm}
table{width:100%;border-collapse:collapse;font-size:.92em;line-height:1.3}
th,td{border:.6pt solid var(--ink);padding:.5mm 1.6mm;text-align:left;vertical-align:top;font-weight:400}
thead th{text-align:center;letter-spacing:.1em}
th[scope=row]{white-space:nowrap}

.notice{margin:0 0 2.4mm}
.notice .tag{display:block;text-align:center;letter-spacing:.18em;font-weight:700;
  text-decoration:underline;text-underline-offset:1.6pt;text-decoration-thickness:.6pt;margin-bottom:.8mm}
.notice p{margin:0;font-size:.94em}

.card{border:.8pt solid var(--ink);font:9pt/1.35 var(--selectric);letter-spacing:0}
.card .bar{background:var(--ink);color:var(--paper);font-weight:700;padding:.6mm 1.8mm;display:flex;justify-content:space-between;gap:2mm}
.card ol{list-style:none;margin:0;padding:1mm 1.8mm 1.2mm}
.card li{display:grid;grid-template-columns:4.5mm 1fr;white-space:pre-wrap;overflow-wrap:anywhere}
.card .cmd{user-select:all}

/* A phone gets the same sheet without the desk around it. */
@media (max-width:640px){
  html,body{background:var(--paper)}
  .page{margin:0;min-height:0;padding:5mm 4.5mm 6mm}
  .tab{display:none}
  .para{display:block}
  .para .num{float:left;margin-right:2.5mm}
  .lower{grid-template-columns:1fr;row-gap:3mm}
  figure svg{min-width:150mm}
}

@media print{
  /* No right page margin: the thumb tab bleeds to the trim edge, so the
     margin moves into padding. Fixed, so it repeats on every printed page. */
  @page{size:A4;margin:12mm 0 14mm 16mm;
    @bottom-right{content:"Page 2.1-" counter(page);font:8pt Georgia,serif;padding-right:15mm}}
  html,body{background:none}
  .page{max-width:none;min-height:0;margin:0;padding:0 15mm 0 0;font-size:9pt}
  .tab{position:fixed;right:0;top:28mm}
  .para,figure,table,.card,.notice,.side,ul.dash li{break-inside:avoid}
  h2,h3{break-after:avoid}
}
</style>
</head>
<body>
<div class="page">
  <header class="head">
    <div class="doc">AIS2A-03-BLOCK I-(1)</div>
    <div class="title">AI-INTERNET-SEARCH OPERATIONS HANDBOOK</div>
    <div class="part">RESEARCH DATA</div>
    <div class="rule"></div>
  </header>

  <div class="tab">AIS</div>

  <div class="opener">
    SECTION 2 &nbsp;&middot;&nbsp; SUBSECTION 2.1<br>
    <span class="q">${esc(question)}</span>
  </div>
${body}

  <footer class="foot">
    <div class="rule"></div>
    <div class="sub">RESEARCH DATA · <a href="https://github.com/rambaarde/ai-internet-search">AI-INTERNET-SEARCH</a></div>
    <div class="line">
      <span>Sources <span class="fill">${read.length}</span></span>
      <span>Claims <span class="fill">${claimCount}</span></span>
      <span>Text Read <span class="fill">${kb} kb</span></span>
      <span>Basic Date <span class="fill">${now.slice(0, 16).replace('T', ' ')}</span></span>
    </div>
  </footer>
</div>
</body>
</html>`;
}

module.exports = { renderReport };
