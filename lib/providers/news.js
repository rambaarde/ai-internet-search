'use strict';
/**
 * Recent news from the public RSS and Atom feeds that outlets publish for
 * readers. Keyless, and no search API at all: each feed lists the outlet's
 * latest stories, and the caller filters them against the question.
 *
 * Why feeds and not a news search API:
 * - Bing News and Google News RSS search work without a key, but both feeds
 *   state they are for personal, non-commercial use in a feed reader only. An
 *   npm package other people run is not that, so neither is used.
 * - GDELT's DOC API is open data and keyless, but measured on 2026-10-16 it
 *   answered 429 (rate limited) with 6 s between calls and took 12-23 s, past
 *   the 8 s provider timeout. Too unreliable for a default path.
 *
 * The tradeoff: a feed covers only each outlet's latest 10-100 stories, so
 * this finds news from roughly the last few days to weeks, not an archive.
 * That is the gap it exists to close: the other key-free providers (Hacker
 * News, GitHub, Stack Exchange, Wikipedia, OpenAlex, DOAJ) index almost no
 * current reporting on games and consumer tech.
 *
 * Only the title, link and date of each story are used; nothing is
 * republished. The story itself is fetched later only if triage opens it.
 */

const { htmlToText } = require('../extract');

const UA = `ai-internet-search/${require('../../package.json').version} (+https://github.com/rambaarde/ai-internet-search)`;
const TIMEOUT_MS = 8000;
/** One fetch of every feed serves all queries for this long (the MCP server is long-lived). */
const CACHE_MS = 10 * 60 * 1000;

/**
 * Outlets with a working public feed, checked 2026-10-16. Tech and games,
 * because those are the questions the other providers miss. Dropped after
 * checking: The Register (302 to a page), Phoronix (403), PC Gamer (5 MB feed).
 * ponytail: a fixed list; make it configurable when someone needs another beat.
 */
const FEEDS = [
  { outlet: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
  { outlet: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
  { outlet: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
  { outlet: 'Engadget', url: 'https://www.engadget.com/rss.xml' },
  { outlet: '404 Media', url: 'https://www.404media.co/rss/' },
  { outlet: '9to5Mac', url: 'https://9to5mac.com/feed/' },
  { outlet: 'GamesRadar+', url: 'https://www.gamesradar.com/feeds.xml' },
  { outlet: 'Eurogamer', url: 'https://www.eurogamer.net/feed' },
  { outlet: 'Rock Paper Shotgun', url: 'https://www.rockpapershotgun.com/feed' },
  { outlet: 'Kotaku', url: 'https://kotaku.com/feed' },
  { outlet: 'Video Games Chronicle', url: 'https://www.videogameschronicle.com/feed/' },
  { outlet: 'Wccftech', url: 'https://wccftech.com/feed/' },
  { outlet: 'DSOGaming', url: 'https://www.dsogaming.com/feed/' },
  { outlet: 'Gematsu', url: 'https://www.gematsu.com/feed' },
  { outlet: 'Time Extension', url: 'https://www.timeextension.com/feeds/latest' },
  { outlet: 'Nintendo Life', url: 'https://www.nintendolife.com/feeds/latest' },
  { outlet: 'Push Square', url: 'https://www.pushsquare.com/feeds/latest' },
];

/** Hostnames of the feeds above, without "www.", for source grading. */
const NEWS_HOSTS = FEEDS.map((f) => new URL(f.url).hostname.replace(/^(www|feeds)\./, ''));

/** Text of an element's first occurrence, with CDATA unwrapped and entities decoded. */
function field(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';
  const inner = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
  return htmlToText(inner).trim();
}

/**
 * Parse an RSS 2.0 or Atom feed into stories.
 * Regex, not an XML parser: the tool has no runtime dependencies, and only
 * three fields of well-formed publisher feeds are needed.
 * @param {string} xml
 * @param {string} outlet
 * @returns {{url: string, title: string, via: string, date: string}[]}
 */
function parseFeed(xml, outlet) {
  const blocks = String(xml).match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) || [];
  return blocks
    .map((b) => {
      // RSS: <link>url</link>. Atom: <link rel="alternate" href="url"/>, where a
      // missing rel means alternate.
      const atomLink = b.match(/<link\b(?![^>]*rel="(?!alternate)[^"]*")[^>]*href="([^"]+)"/i);
      const url = (field(b, 'link') || (atomLink && atomLink[1]) || '').replace(/&amp;/g, '&').trim();
      const date = field(b, 'pubDate') || field(b, 'published') || field(b, 'updated') || field(b, 'dc:date');
      return { url, title: field(b, 'title'), via: `news:${outlet}`, date };
    })
    .filter((s) => /^https?:\/\//.test(s.url) && s.title);
}

/** Fetch one feed's text, failing on a non-2xx status or after TIMEOUT_MS. */
async function getText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

let cache = null;

/**
 * Every story from every feed, newest first, fetched in parallel and cached
 * for CACHE_MS. One failed feed is skipped; the call fails only when every
 * feed failed, so the provider is reported as failed rather than as empty.
 * @returns {Promise<{url: string, title: string, via: string, date: string}[]>}
 */
function newsStories() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.stories;
  const stories = Promise.allSettled(FEEDS.map(async (f) => parseFeed(await getText(f.url), f.outlet))).then((all) => {
    const ok = all.filter((r) => r.status === 'fulfilled');
    if (!ok.length) {
      cache = null;
      throw all[0].reason;
    }
    const time = (s) => Date.parse(s.date) || 0;
    return ok.flatMap((r) => r.value).sort((a, b) => time(b) - time(a));
  });
  cache = { at: Date.now(), stories };
  return stories;
}

module.exports = { FEEDS, NEWS_HOSTS, parseFeed, newsStories };
