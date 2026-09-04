'use strict';
/**
 * Optional headless-browser render, for the pages fetch() cannot read.
 *
 * A client-rendered SPA sends its mount point and no text, so fetch() gets an
 * empty shell and the extractor drops it. A real browser runs the page's
 * JavaScript and produces the DOM. This shells out to an ALREADY-INSTALLED
 * browser, so it adds no npm dependency and simply does nothing when no browser
 * is present -- the same "degrade, never fail" contract as the rest of the tool.
 *
 * `--headless --dump-dom` prints the rendered DOM to stdout in one shot: no CDP,
 * no WebSocket, no library. `--virtual-time-budget` lets the page's JavaScript
 * run before the DOM is dumped. It is invoked ONLY for a source fetch() already
 * dropped, and only when the caller asked for rendering (the CLI's --render).
 */

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { existsSync } = require('node:fs');

const run = promisify(execFile);

// Candidate browsers, most specific first. macOS app bundles are checked by
// path; bare names resolve on PATH (Linux, or a Homebrew-linked binary).
const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'microsoft-edge',
];

let cached; // undefined = not probed, null = none found, string = binary to use

/**
 * The first usable browser binary, or null. Probed once and cached.
 *
 * An app-bundle path is confirmed with existsSync -- instant, no process. A
 * bare name is confirmed with a short `--version`, which is cheap and only runs
 * when no app bundle was found.
 */
function findBrowser() {
  if (cached !== undefined) return cached;
  const { spawnSync } = require('node:child_process');
  for (const c of CANDIDATES) {
    if (c.startsWith('/')) {
      if (existsSync(c)) return (cached = c);
      continue;
    }
    try {
      const r = spawnSync(c, ['--version'], { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (!r.error && r.status === 0) return (cached = c);
    } catch { /* not on PATH; try the next */ }
  }
  return (cached = null);
}

/** Test seam: reset the cached probe so a test can force a different browser. */
function _resetBrowserCache() { cached = undefined; }

/**
 * Render a URL through the headless browser and return its DOM HTML, or null if
 * no browser is available or the render failed, timed out, or produced nothing.
 *
 * Failure is always null, never a throw: the caller keeps whatever state it had
 * before it asked -- a dropped source stays dropped, never crashes the run.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, budgetMs?: number, bin?: string }} [opts]
 * @returns {Promise<string|null>}
 */
async function renderPage(url, opts = {}) {
  const bin = opts.bin ?? findBrowser();
  if (!bin) return null;
  const budget = opts.budgetMs ?? 5000;
  const timeout = opts.timeoutMs ?? 20000;
  try {
    const { stdout } = await run(bin, [
      '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--disable-dev-shm-usage', `--virtual-time-budget=${budget}`, '--dump-dom', url,
    ], { timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
    return stdout && stdout.length >= 40 ? stdout : null;
  } catch (e) {
    // A timeout kills the process but may leave partial DOM on e.stdout; keep it
    // if it is substantial, otherwise report nothing.
    const partial = e && typeof e.stdout === 'string' ? e.stdout : '';
    return partial.length >= 200 ? partial : null;
  }
}

module.exports = { findBrowser, renderPage, _resetBrowserCache };
