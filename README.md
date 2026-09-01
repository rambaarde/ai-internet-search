# ai-internet-search

**Internet research for AI agents that is defensible, not just cheap.**

Ranks sources by credibility instead of counting them, shows disagreement
instead of averaging it, and says what it could not establish.

```sh
npx ai-internet-search "what is a connection pool"
```

```
certainty: moderate — a primary source, but only one

claims[5]{tier,host,claim}:
  1,github.com,Your little 4-Core i7 server with one hard disk should be running a connection pool of:
  1,github.com,Reducing the connection pool size alone decreased response times from ~100ms to ~2ms.
  3,pgdog.dev,One of its features is connection pooling  which allows many clients to share a database.
  3,sudhir.io,A pool is an object that maintains a set of connections internally.

conflicts[1]:
  figures differ
    tier 1  postgresql.org: set the pool to around 10 connections for this workload
    tier 4  top10devblogs.com: always set the pool to 100 connections
    prefer: postgresql.org (tier 1, more authoritative)

could_not_establish:
  nothing read addressed: pgbouncer

sources[3]{tier,host,why,url}:
  1,github.com,source code or changelog,https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing
  3,pgdog.dev,unclassified,https://pgdog.dev/blog/why-yet-another-connection-pooler
  3,sudhir.io,unclassified,https://sudhir.io/understanding-connections-pools/

triaged: 10 found, 3 opened, 7 skipped before fetching (323kb read → 9 claims)
```

No API key. No account. Zero dependencies.

## The problem

Give an agent a question and it searches, gets ten results, and believes
whichever answer appears most often.

That is not a hunch. It is measured:

> **"Models tend to favor the majority viewpoint among retrieved contexts,
> even when opposing evidence is more credible."**
> — [Resolving Conflicting Evidence in Automated Fact-Checking](https://arxiv.org/pdf/2505.17762)

> Research agents **"consistently favored SEO-optimized content farms over
> authoritative sources."**
> — [Anthropic, on building a multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)

Those two compound. Content farms exist to produce volume, so *the majority
view is the farm's view*. Nine blog posts copied from one original outvote the
official documentation, every time.

Counting sources is not research. It is an echo with citations.

## What this does instead

**Credibility is decided before anything is read**, from the URL alone.

| tier | source | why |
|---|---|---|
| 1 | official docs, specs, RFCs, source, changelogs, registries | the thing itself |
| 2 | papers, issue threads, vendor engineering blogs | the people who built or study it |
| 3 | practitioner Q&A, reference encyclopedias, forums | someone who read tier 1 |
| 4 | content aggregators, SEO listicles | someone who read tier 3 |

An unrecognised host is tier 3, not 4 — unproven is not the same as junk, and
the alternative buries small authoritative sites under large mediocre ones.

Then: **at most one source per host, at most three opened.** Five pages from
one site say one thing five times.

**This is why it is cheap.** Not reading seven of ten results is simultaneously
the accuracy mechanism and the largest token saving. You are not trading
correctness for cost — the same action buys both.

## It does the rigor, it does not just recommend it

**Conflicts are found and placed.** Models are documented to detect
disagreement but fail to *localise* it, so the tool localises it: both claims,
both tiers, and which source is more authoritative. Never averaged into one
confident sentence that silently picks a side.

**Certainty is graded, never voted on.** After
[GRADE](https://www.cdc.gov/acip-grade-handbook/hcp/chapter-6-systemic-review-overview/index.html):

| grade | when |
|---|---|
| `high` | a primary source, independently corroborated |
| `moderate` | a primary source, but only one |
| `low` | no primary source read, or sources disagree |
| `very low` | aggregator-tier only |
| `none` | nothing could be read |

A live disagreement always downgrades. An answer with a known contradiction in
it is not high certainty whatever its sources.

**Gaps are stated.** Terms nothing addressed, and sources that could not be
read with the reason — `http 403`, `timed out`, `too large`. "I could not open
this" and "I read it and it said nothing" are different answers.

## Empty results are answers

```
sources[0]{tier,host,title}:

could_not_establish: no source above the noise floor answered this.
  4 candidate(s) were found and none were relevant enough to open.
```

Silence is indistinguishable from a crash, and a confident guess is worse than
either. Finding nothing exits `0` — it is an answer, not a failure.

## Usage

```sh
ai-internet-search "<question>"              research a question
ai-internet-search --plan "<question>"       triage only, fetch nothing
ai-internet-search --limit 5 "<question>"    open more sources
ai-internet-search --json "<question>"       JSON instead of TOON
```

| exit | meaning |
|---|---|
| `0` | success, including "found nothing" |
| `1` | error |
| `2` | unknown flag or bad usage |

## Works in the terminal and in GUI clients

Terminal agents call the CLI. GUI clients — Claude Desktop, the Cursor app —
have no shell, so an MCP server ships alongside:

```json
{
  "mcpServers": {
    "ai-internet-search": { "command": "ai-internet-search-mcp" }
  }
}
```

Two tools, `research` and `plan_research`. The MCP `instructions` field carries
the rules with the result, because a result whose conflicts get averaged back
into one confident paragraph has lost everything the tool was for.

**Do not register the MCP server for a terminal agent.** It has a shell; MCP
would add a layer that can only go out of date, and AXI measures MCP at 185k
tokens per task against 79k for a CLI.

## Built for agents to call

Follows [AXI](https://axi.md/) conventions for agent-ergonomic CLIs:

- **TOON output** rather than JSON — same information, fewer tokens
- **Definitive empty states** — never silence
- **Structured errors on stdout**, exit `0`/`1`/`2`
- **No interactive prompts** — every parameter is a flag
- **`help[]` next-step hints** appended to output
- **Content-first** — running it bare says what it is, not a help dump

## Cost

| | tokens |
|---|---|
| an answer with three sources | **~200** |
| an empty result | **~100** |

For comparison, [Anthropic measured](https://www.anthropic.com/engineering/multi-agent-research-system)
agents at ~4× a chat turn and multi-agent research at ~15×. This is a single
pass that opens at most three pages.

## Sources

Key-less by default: Hacker News, Wikipedia, OpenAlex. No signup between an
agent and its first useful answer.

The trade is **recall** — key-less providers miss things a paid index would
find, and the tool tells you when that happens rather than inventing an answer.
The provider layer is swappable; a search API buys better coverage, not a
different pipeline.

## Install

```sh
npm install -g ai-internet-search
# or
npx ai-internet-search "<question>"
```

Node 18+. Nothing else.

## Tests

```sh
npm test
```

No framework, no mocks for the unit tests, and the network tests skip cleanly
when offline so a red CI means a real failure.

## License

MIT
