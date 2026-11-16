---
name: ai-internet-search
description: >
  Research a question against the live web with source credibility ranked
  ahead of source count. Use whenever the task needs facts from the internet
  and being WRONG would cost something: choosing a library, checking whether
  an API still works the way you remember, diagnosing a client problem,
  settling a disagreement about how something behaves, or gathering evidence
  before building. Also use when the answer must be defensible to someone
  else, when sources are likely to disagree, or when it matters that a claim
  is quoted rather than paraphrased. Trigger: /ai-internet-search, "research
  this", "check the docs", "what do the sources say", "is this still true".
license: MIT
compatibility: >
  Any agent with a shell (Claude Code, Codex, Gemini CLI, OpenCode, Cursor,
  Copilot). Needs Node.js 18+ and the ai-internet-search CLI on PATH
  (npm install -g ai-internet-search).
metadata:
  version: "1.2.0"
---

# ai-internet-search

A CLI on PATH. Run it directly from your shell; there is nothing to register.
This guide applies to every agent, not one model vendor.

```sh
ai-internet-search "<question>"                 research a question
ai-internet-search --plan "<question>"          triage only, fetch nothing
ai-internet-search --limit 5 "<question>"       open more sources (default 3)
ai-internet-search --claims 6 "<question>"      quote more claims per source (default 3)
ai-internet-search "<url> <question>"           read one known page for this question
ai-internet-search --report "<question>"        also write a standalone HTML report
```

## Research loop: deep, but token-efficient

The tool does one pass per call. You run the loop. Keep each call small and
make more calls, not one large call.

1. Start with a short, broad question (3 to 5 distinctive words). Long, specific
   queries return fewer results.
2. Read `certainty`, `conflicts`, and `could_not_establish`.
3. If `next_queries` is present, run those queries next. Each query is short and
   targets one gap. Run independent queries in parallel.
4. If you know the primary page (docs, paper, vendor post), give its URL plus
   the question. This reads that page only and scores its claims against your
   question.
5. Use `--claims 6` or more only for a page that you must read in depth. The
   default of 3 is enough to triage.
6. Stop when `decision: answer` shows, or when the gaps stay the same after one
   follow-up. Then report the gaps.

## Use this tool and your agent's own web search together

For each research task, run this tool AND your agent's built-in web search for
the same question, if the agent has one. The two sources do different jobs.

This tool gives the **authoritative core**. It ranks sources by authority
before it reads them, shows disagreements instead of averaging them, and says
what it could not establish.

The built-in web search gives **breadth**: developer blogs, vendor docs, older
news, verbatim error strings, and obscure pages. By default this tool uses
key-free providers: Wikipedia (any language), OpenAlex, DOAJ, Hacker News,
GitHub issues, Stack Overflow, the news feeds of 17 tech and games outlets, and
(version 0.11.0 and later) You.com keyless web search, 100 queries a day per IP
address. Its recall is still lower than a full web index. An empty result from
it does not mean the answer does not exist. If `unreachable:` lists `youcom`,
the daily cap may have been reached.

For recent events (version 0.9.0 and later), put a news cue in the question:
a year (`2026`), or a word such as `latest`, `announced`, `released`,
`criticism`, `DMCA`, or `shut down`. The news feeds hold only the latest stories
of each outlet, so they cover approximately the last days or weeks. For older
news, use the built-in web search.

If a source shows `http 403 (blocked by the site ...)`, the site refused the
fetch. Run the query again with `--browser` or `--render` if the user agrees.

If the two sources disagree, show both and grade each source by its tier. Tell
the user which facts came from each source. If one source is not available,
use the other source and tell the user.

## Three rules that travel with the result

- **A tier-1 source outranks any number of tier-3 or tier-4 ones.** Never
  settle a disagreement by counting how many pages say something.
- **If it reports conflicts, present both sides** and say which source is
  more authoritative. Do not average them into one confident sentence.
- **If it reports `could_not_establish`, say so to the user.** An honest gap
  is worth more than a fluent guess.

Report the certainty level. It describes the evidence, not your confidence.

## Reading the output

`certainty:` grades the evidence (high / moderate / low / very low / none).
A disagreement always downgrades it.

`claims[]` are **verbatim quotations**, never summaries, each with its tier
and host. Quote them as they are. Rewriting a claim is the one way to make it
stop matching its source.

`conflicts[]` names both sides and which is more authoritative.

`could_not_establish:` lists what nothing addressed and which sources could
not be read, with the reason.

`next_queries[]` gives one short follow-up search for each gap. Run these
queries. Do not make the original question longer.

`widened:` shows that a provider found nothing for the full question, and
that the tool then asked it again with only the first three words. Those
results matched every word of the question. Tell the user that the search
was widened.

`tier 1 ... vendor on its own product` means that a vendor's engineering blog
is about the vendor's own product. Treat it as a primary source for that
product only.

`visuals[]` points at charts and figures. The tool has no vision model, so it
names them rather than reading them. Fetch one yourself if the answer depends
on it.

## Notes

- Finding nothing exits `0`. It is an answer, not a failure.
- The question can be in any language. It detects the language and searches
  that Wikipedia edition as well as English.
- `--report` writes an HTML file for a human to read and prints the path.
  Never pipe the HTML into your own context; hand over the path.
- Do **not** register the MCP server (`ai-internet-search-mcp`) for a
  terminal agent. You have a shell, and MCP costs measurably more tokens.
