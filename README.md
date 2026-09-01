# ai-internet-search

**Internet research for AI agents that is defensible, not just cheap.**

Ranks sources by credibility instead of counting them, shows disagreement
instead of averaging it, and says what it could not establish.

```sh
npx ai-internet-search "what is a connection pool"
```

```
question: what is a connection pool
query: connection pool
providers: hackernews,wikipedia

sources[3]{tier,host,why,title}:
  1,github.com,source code or changelog,About Database Connection Pool Sizing
  3,pgdog.dev,unclassified,Why we built yet another Postgres connection pooler
  3,sudhir.io,unclassified,Understanding Connections and Pools

read_next[3]{url}:
  https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing
  https://pgdog.dev/blog/why-yet-another-connection-pooler
  https://sudhir.io/understanding-connections-pools/

triaged: 10 found, 3 worth opening, 7 skipped before fetching
```

No API key. No account. Zero dependencies. ~200 tokens.

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

## Rules for the agent reading the output

Printed with every answer, because they are the point:

- **A tier-1 source outranks any number of tier-3+ ones.** Never resolve a
  disagreement by counting.
- **When sources disagree, report both and name which is which.** Never average
  them into one confident paragraph that silently picks a side. Models are
  documented to be poor at localising conflict, so localise it for them.
- **Say what you could not establish.** An honest gap beats a fluent guess.

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
