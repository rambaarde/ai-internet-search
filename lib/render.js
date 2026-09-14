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
 *
 * The second path, `--browser <url>`, renders in the user's own running browser
 * over the DevTools Protocol instead (renderViaCdp below).
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
 * With `browserUrl`, the page is rendered in that already-running browser
 * instead (see renderViaCdp).
 *
 * Failure is always null, never a throw: the caller keeps whatever state it had
 * before it asked -- a dropped source stays dropped, never crashes the run.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, budgetMs?: number, bin?: string, browserUrl?: string }} [opts]
 * @returns {Promise<string|null>}
 */
async function renderPage(url, opts = {}) {
  if (opts.browserUrl) return renderViaCdp(url, opts.browserUrl, opts);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Why an ALREADY-RUNNING browser at `browserUrl` cannot be used, or '' if it
 * can. Lets the CLI say so once, instead of every source silently failing.
 *
 * @param {string} browserUrl  DevTools HTTP endpoint, e.g. http://127.0.0.1:9222
 * @returns {Promise<string>}
 */
async function cdpProblem(browserUrl) {
  if (typeof WebSocket !== 'function') return 'this Node has no built-in WebSocket (Node 22+ needed)';
  try {
    const res = await fetch(new URL('/json/version', browserUrl), { signal: AbortSignal.timeout(3000) });
    if (res.ok && (await res.json()).webSocketDebuggerUrl) return '';
  } catch { /* unreachable or not a URL; reported below */ }
  return `no DevTools endpoint at ${browserUrl}`;
}

/**
 * Render a URL in the user's own running browser over the Chrome DevTools
 * Protocol and return its DOM HTML, or null. Same contract as the headless
 * path: failure is null, never a throw.
 *
 * The page opens in a background tab, which is closed afterwards. It uses the
 * browser's cookies and sessions, which is the point (a page a bot is refused
 * may open for the user), and also the risk: only web pages are opened, never
 * file:, chrome: or javascript: URLs. Node's built-in WebSocket (Node 22+)
 * carries the protocol, so this adds no npm dependency.
 *
 * @param {string} url
 * @param {string} browserUrl  DevTools HTTP endpoint, e.g. http://127.0.0.1:9222
 * @param {{ timeoutMs?: number, budgetMs?: number }} [opts]
 * @returns {Promise<string|null>}
 */
async function renderViaCdp(url, browserUrl, opts = {}) {
  if (typeof WebSocket !== 'function' || !/^(https?|data):/i.test(url)) return null;
  const budget = opts.budgetMs ?? 5000;
  const timeout = opts.timeoutMs ?? 20000;
  const pending = new Map();
  let ws; let targetId; let seq = 0; let loaded;
  const load = new Promise((r) => { loaded = r; });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

  const work = async () => {
    const res = await fetch(new URL('/json/version', browserUrl), { signal: AbortSignal.timeout(3000) });
    const socket = new URL((await res.json()).webSocketDebuggerUrl);
    // The browser names its own host; the caller's host is the one that reaches it.
    socket.host = new URL(browserUrl).host;
    ws = new WebSocket(socket);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      else if (m.method === 'Page.loadEventFired') loaded();
    };
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ({ targetId } = await send('Target.createTarget', { url: 'about:blank', background: true }));
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    if ((await send('Page.navigate', { url }, sessionId)).errorText) return null;
    // A page with a slow asset may never fire load; the budget caps the wait,
    // then a short settle lets client-side rendering finish.
    await Promise.race([load, sleep(budget)]);
    await sleep(1000);
    const { result } = await send('Runtime.evaluate',
      { expression: 'document.documentElement.outerHTML', returnByValue: true }, sessionId);
    return typeof result.value === 'string' && result.value.length >= 40 ? result.value : null;
  };

  let timer;
  try {
    return await Promise.race([work().catch(() => null), new Promise((r) => { timer = setTimeout(() => r(null), timeout); })]);
  } finally {
    clearTimeout(timer);
    // Never leave a tab behind in the user's browser, even after a timeout.
    if (targetId && ws.readyState === 1) {
      await Promise.race([send('Target.closeTarget', { targetId }).catch(() => {}), sleep(2000)]);
    }
    try { ws?.close(); } catch { /* already closed */ }
  }
}

module.exports = { findBrowser, renderPage, cdpProblem, _resetBrowserCache };
