#!/usr/bin/env node
'use strict';
/**
 * MCP server — the same pipeline, for clients that have no shell.
 *
 * A terminal agent should call the CLI directly; wrapping a command an agent
 * can already run adds a layer that can only go out of date, and AXI's own
 * measurement puts MCP at 185k tokens per task against 79k for a CLI. This
 * exists for Claude Desktop, the Cursor GUI and anything else where there is
 * no shell to call.
 *
 * JSON-RPC 2.0 over stdio, hand-rolled on node builtins so the package keeps
 * its zero dependencies.
 */

const readline = require('node:readline');
const { findCandidates, keywords, kindsFor } = require('../lib/search');
const { triage } = require('../lib/sources');
const { readSources } = require('../lib/extract');
const { findConflicts, grade, gaps } = require('../lib/assess');

const VERSION = require('../package.json').version;

/**
 * Ambient guidance, surfaced by the client before the first turn.
 *
 * Without it a model has no reason to prefer this over its own web search, and
 * no reason to respect the tiering once it has the result. The rules matter
 * more than the tool: a result whose conflicts get averaged back into one
 * confident paragraph has lost everything the tool was for.
 */
const INSTRUCTIONS = [
  'Research a question against the live web with source credibility ranked ahead of source count.',
  '',
  'When you use this, three rules travel with the result:',
  '- A tier-1 source (official docs, specs, source code) outranks any number of tier-3 or tier-4 ones. Never settle a disagreement by counting how many pages say something.',
  '- If it reports conflicts, present both sides and say which source is more authoritative. Do not average them into one confident sentence.',
  '- If it reports could_not_establish, say so to the user. An honest gap is worth more than a fluent guess.',
  '',
  'The certainty level is about the evidence, not about your confidence. Report it.',
].join('\n');

const TOOLS = [
  {
    name: 'research',
    description:
      'Research a question on the web. Ranks sources by credibility, reads at most a few, ' +
      'returns claims with their tier, names any disagreements, and states what it could not establish.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, in plain words.' },
        limit: { type: 'number', description: 'Maximum sources to open. Default 3.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'plan_research',
    description:
      'Show which sources would be read for a question, and their credibility tiers, without fetching any of them. ' +
      'Use to cost a question, or to check whether anything authoritative exists before spending tokens.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
    },
  },
];

/** Run the pipeline and render it as text, since MCP content is text. */
async function research(question, { limit = 3, plan = false } = {}) {
  const query = keywords(question);
  const terms = query.split(' ').filter(Boolean);
  const found = await findCandidates(question);
  const chosen = triage(found.candidates, { limit, perHost: 1 });

  if (!chosen.length) {
    return (
      `could_not_establish: nothing above the noise floor answered this.\n` +
      `${found.candidates.length} candidate(s) found, none relevant enough to open.\n` +
      `Try fewer, more distinctive words.`
    );
  }
  if (plan) {
    return (
      `would_read[${chosen.length}]{tier,host,why,url}:\n` +
      chosen.map((c) => `  ${c.tier},${c.host},${c.why},${c.url}`).join('\n') +
      `\n\nnothing was fetched. ${found.candidates.length} found, ${chosen.length} would be opened.`
    );
  }

  const opened = await readSources(chosen, terms);
  const conflicts = findConflicts(opened);
  const certainty = grade(opened, conflicts);
  const missing = gaps(opened, terms);

  const out = [`certainty: ${certainty.level} — ${certainty.why}`, ''];
  const rows = [];
  for (const s of opened) for (const c of s.claims) rows.push(`  ${s.tier},${s.host},${c.text.replace(/[\n,]/g, ' ')}`);
  out.push(`claims[${rows.length}]{tier,host,claim}:`, ...rows, '');

  if (conflicts.length) {
    out.push(`conflicts[${conflicts.length}]:`);
    for (const c of conflicts) {
      out.push(`  ${c.kind}`);
      out.push(`    tier ${c.a.tier}  ${c.a.host}: ${c.a.text}`);
      out.push(`    tier ${c.b.tier}  ${c.b.host}: ${c.b.text}`);
      out.push(`    prefer: ${c.prefer ? `${c.prefer.host} (tier ${c.prefer.tier})` : 'neither — same tier'}`);
    }
    out.push('');
  }

  const unread = opened.filter((s) => !s.read);
  if (unread.length || missing.missingTerms.length) {
    out.push('could_not_establish:');
    for (const u of unread) out.push(`  ${u.host} — ${u.reason}`);
    if (missing.missingTerms.length) out.push(`  nothing read addressed: ${missing.missingTerms.join(', ')}`);
    out.push('');
  }

  out.push(`sources[${opened.length}]{tier,host,url}:`);
  for (const s of opened) out.push(`  ${s.tier},${s.host},${s.url}`);
  return out.join('\n');
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(req) {
  const { id, method, params } = req;
  if (id === undefined) return; // a notification is never answered

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        // Echo the client's version; hardcoding one gets the server rejected
        // outright by a client speaking another.
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'ai-internet-search', version: VERSION },
        instructions: INSTRUCTIONS,
      },
    });
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      if (name === 'research') {
        const text = await research(String(args.question || ''), { limit: Number(args.limit) || 3 });
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
      }
      if (name === 'plan_research') {
        const text = await research(String(args.question || ''), { plan: true });
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
      }
      // An unknown tool is tool content, not a transport fault: the model
      // should read it and correct itself.
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true } });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${e && e.message}` }], isError: true } });
    }
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  handle(req).catch((e) => {
    if (req.id !== undefined) send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: String(e && e.message) } });
  });
});
