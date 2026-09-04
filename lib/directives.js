'use strict';
/**
 * Google-style query directives, parsed out of the question and applied as a
 * lenient post-filter on the candidates a provider already returned. The idea
 * is borrowed from oh-my-pi's query.ts; two rules keep it in line with the rest
 * of this tool:
 *
 *  - Filtering is on the URL and title the provider ALREADY returned. No new
 *    request, so a directive costs nothing and cannot fail on its own.
 *  - A directive that would eliminate EVERY remaining candidate is relaxed, not
 *    enforced, and the relaxation is reported. Returning nothing because the
 *    scope was too tight is the exact failure this tool exists to avoid --
 *    the same reason it prints `could_not_establish` instead of a blank.
 *
 * Supported: site:/-site:, inurl:/-inurl:, intitle:/-intitle:, filetype:.
 * after:/before: are deliberately absent: a candidate carries no publish date,
 * so a date filter could only ever be parsed and then relaxed, which is noise.
 * Recency is a real gap, but it belongs with the source-reading path, not here.
 */

/** Host of a URL, `www.` stripped, lowercased. '' if unparseable. */
function host(u) {
  try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

/** host+path of a URL, lowercased -- so `site:github.com/torvalds` can scope. */
function hostPath(u) {
  try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname).toLowerCase(); }
  catch { return String(u).toLowerCase(); }
}

/** A site value matches a URL if it is the host, a parent of the host, or a host+path prefix. */
function siteMatches(value, url) {
  const h = host(url);
  return h === value || h.endsWith('.' + value) || hostPath(url).startsWith(value);
}

/**
 * Pull `[-]key:value` directives out of a question and return the cleaned
 * question plus the parsed constraints. `value` may be a "quoted phrase".
 *
 * @param {string} question
 * @returns {{ query: string, constraints: object, any: boolean }}
 */
function parseDirectives(question) {
  const c = { site: [], notSite: [], inurl: [], notInurl: [], intitle: [], notIntitle: [], filetype: [] };
  const re = /(-?)(site|domain|host|inurl|url|intitle|title|filetype|ext)\s*:\s*(?:"([^"]+)"|(\S+))/gi;
  const cleaned = String(question).replace(re, (_m, neg, key, quoted, bare) => {
    const val = String(quoted ?? bare ?? '').trim().toLowerCase();
    if (!val) return ' ';
    const k = key.toLowerCase();
    if (k === 'site' || k === 'domain' || k === 'host') {
      (neg ? c.notSite : c.site).push(val.replace(/^https?:\/\//, '').replace(/\/+$/, ''));
    } else if (k === 'inurl' || k === 'url') {
      (neg ? c.notInurl : c.inurl).push(val);
    } else if (k === 'intitle' || k === 'title') {
      (neg ? c.notIntitle : c.intitle).push(val);
    } else if (k === 'filetype' || k === 'ext') {
      c.filetype.push(val.replace(/^\./, '')); // filetype has no negative form: a page is one type
    }
    return ' ';
  }).replace(/\s+/g, ' ').trim();

  const any = Object.values(c).some((a) => a.length);
  // If the question was ONLY directives, keep the original so keyword search
  // still has something -- an empty query returns nothing from every provider.
  return { query: cleaned || question, constraints: c, any };
}

/**
 * Apply the constraints to candidates, one dimension at a time. A dimension
 * that would empty the set is relaxed and named; every other dimension narrows.
 *
 * @param {{url: string, title?: string}[]} candidates
 * @param {object} constraints  from parseDirectives
 * @returns {{ candidates: object[], applied: string[], relaxed: string[] }}
 */
function applyDirectives(candidates, constraints) {
  const c = constraints;
  const url = (x) => String(x.url || '').toLowerCase();
  const title = (x) => String(x.title || '').toLowerCase();
  const dims = [
    c.site.length && { label: c.site.map((s) => `site:${s}`).join(' '), test: (x) => c.site.some((s) => siteMatches(s, x.url)) },
    c.notSite.length && { label: c.notSite.map((s) => `-site:${s}`).join(' '), test: (x) => !c.notSite.some((s) => siteMatches(s, x.url)) },
    c.inurl.length && { label: c.inurl.map((s) => `inurl:${s}`).join(' '), test: (x) => c.inurl.every((s) => url(x).includes(s)) },
    c.notInurl.length && { label: c.notInurl.map((s) => `-inurl:${s}`).join(' '), test: (x) => !c.notInurl.some((s) => url(x).includes(s)) },
    c.intitle.length && { label: c.intitle.map((s) => `intitle:${s}`).join(' '), test: (x) => c.intitle.every((s) => title(x).includes(s)) },
    c.notIntitle.length && { label: c.notIntitle.map((s) => `-intitle:${s}`).join(' '), test: (x) => !c.notIntitle.some((s) => title(x).includes(s)) },
    c.filetype.length && { label: c.filetype.map((s) => `filetype:${s}`).join(' '), test: (x) => c.filetype.some((s) => hostPath(x.url).endsWith(`.${s}`)) },
  ].filter(Boolean);

  let kept = candidates.slice();
  const applied = [];
  const relaxed = [];
  for (const d of dims) {
    const next = kept.filter(d.test);
    if (next.length) { kept = next; applied.push(d.label); }
    else relaxed.push(d.label); // would have left nothing -- keep the wider set
  }
  return { candidates: kept, applied, relaxed };
}

module.exports = { parseDirectives, applyDirectives, siteMatches };
