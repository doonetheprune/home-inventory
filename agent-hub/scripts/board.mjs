#!/usr/bin/env node
/**
 * Builds a project's BOARD.md from its briefs (ticked tasks), status files,
 * messages, decisions and contracts. No dependencies.
 *
 *   node scripts/board.mjs projects/<project>
 *
 * Front matter is read with a small YAML subset: `key: value`, `key: [a, b]`,
 * indented `- item` lists and one level of indented `key: value`.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const dir = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error('Usage: node scripts/board.mjs projects/<project>');
  process.exit(1);
}
const project = basename(dir);
const read = (p) => readFileSync(p, 'utf8');
const mdFiles = (sub) => {
  const d = join(dir, sub);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort().map((f) => join(d, f));
};

function clean(v) {
  return String(v).replace(/\s+#\s.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
}
function scalar(v) {
  const c = clean(v);
  if (c === '') return null;
  if (/^\[.*\]$/.test(c)) return c.slice(1, -1).split(',').map(clean).filter(Boolean);
  return c;
}
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const data = {};
  if (!m) return data;
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const top = /^([\w-]+):\s*(.*)$/.exec(line);
    const item = /^\s+-\s+(.*)$/.exec(line);
    const nested = /^\s+([\w-]+):\s*(.*)$/.exec(line);
    if (top) {
      key = top[1];
      data[key] = scalar(top[2]);
    } else if (key && item) {
      if (!Array.isArray(data[key])) data[key] = [];
      data[key].push(clean(item[1]));
    } else if (key && nested) {
      if (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key])) data[key] = {};
      data[key][nested[1]] = clean(nested[2]);
    }
  }
  return data;
}

/** Ticked and unticked tasks under each `### Now` / `### M<n>` / `### Later` heading of a brief. */
function tasks(text) {
  const out = {};
  let section = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const m = /^(M\d+|Now|Later)\b/i.exec(heading[1]);
      section = m ? (/^m/i.test(m[1]) ? m[1].toUpperCase() : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) : null;
      continue;
    }
    const task = /^\s*[-*]\s+\[( |x|X)\]\s+/.exec(line);
    if (section && task) {
      out[section] ??= { done: 0, total: 0 };
      out[section].total++;
      if (task[1] !== ' ') out[section].done++;
    }
  }
  return out;
}

/** `- [ ] **D1. Title.** …` lines in DECISIONS.md that are still unticked. */
function neededDecisions(text) {
  return text
    .split(/\r?\n/)
    .map((line) => /^\s*[-*]\s+\[ \]\s+\*\*(D\d+)\.?\s*(.+?)\*\*/.exec(line))
    .filter(Boolean)
    .map((m) => `${m[1]}. ${m[2].replace(/[.:]\s*$/, '')}`);
}

const cell = (v) => {
  const s = Array.isArray(v) ? v.join(', ') : v;
  return s === null || s === undefined || s === '' ? '–' : String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
};
const table = (head, rows) => (rows.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)] : ['None.']);

// Agents: everyone with a brief or a status file.
const briefs = new Map(mdFiles('agents').map((f) => [basename(f, '.md'), read(f)]));
const statuses = new Map(mdFiles('status').map((f) => [basename(f, '.md'), frontMatter(read(f))]));
const agents = [...new Set([...briefs.keys(), ...statuses.keys()])].sort();

// Messages: messages/<recipient>/<id>.md
const messages = [];
const inboxRoot = join(dir, 'messages');
if (existsSync(inboxRoot)) {
  for (const to of readdirSync(inboxRoot).sort()) {
    const inbox = join(inboxRoot, to);
    if (!statSync(inbox).isDirectory()) continue;
    for (const f of readdirSync(inbox).filter((x) => x.endsWith('.md')).sort()) {
      const m = frontMatter(read(join(inbox, f)));
      messages.push({ ...m, to: m.to ?? to, id: m.id ?? basename(f, '.md'), status: m.status ?? 'open' });
    }
  }
}
const open = messages.filter((m) => m.status === 'open');
const blocking = open.filter((m) => m.priority === 'blocking' || m.type === 'blocker');
const toOwner = open.filter((m) => m.to === 'owner');

const decisionsFile = join(dir, 'DECISIONS.md');
const decisions = existsSync(decisionsFile) ? neededDecisions(read(decisionsFile)) : [];

const contracts = mdFiles('contracts').map((f) => ({ name: basename(f, '.md'), ...frontMatter(read(f)) }));

// Milestone columns, in order: Now, M0, M1…, Later.
const progress = new Map([...briefs].map(([agent, text]) => [agent, tasks(text)]));
const order = (k) => (k === 'Now' ? -1 : k === 'Later' ? 1e6 : Number(k.slice(1)));
const columns = [...new Set([...progress.values()].flatMap((t) => Object.keys(t)))].sort((a, b) => order(a) - order(b));

const latest = [...statuses.values()].map((s) => s.updated).filter(Boolean).sort().at(-1);

const lines = [
  `# Board: ${project}`,
  '',
  "Built by `scripts/board.mjs` from the briefs, status files, messages, decisions and contracts. Don't edit it by hand.",
  '',
  ...(latest ? [`Latest status update: ${latest}.`, ''] : []),
  '## Waiting for the owner',
  '',
  ...(decisions.length ? ['Decisions (from `DECISIONS.md`):', '', ...decisions.map((d) => `- ${d}`), ''] : ['No decisions waiting.', '']),
  ...(toOwner.length ? ['Messages:', '', ...toOwner.map((m) => `- \`${m.id}\` from ${m.from ?? '?'} (${m.type ?? 'message'}): ${m.subject ?? ''}`), ''] : ['No messages waiting.', '']),
  '## Blocking',
  '',
  ...(blocking.length ? blocking.map((m) => `- \`${m.id}\`: ${m.from ?? '?'} → ${m.to}: ${m.subject ?? ''}`) : ['Nothing is blocked.']),
  '',
  '## Agents',
  '',
  ...table(
    ['Agent', 'State', 'Milestone', 'Now', 'Next', 'Updated', 'Blockers'],
    agents.map((a) => {
      const s = statuses.get(a) ?? {};
      return [`\`${a}\``, s.state ?? 'no status', s.milestone, s.now, s.next, s.updated, s.blockers];
    }),
  ),
  '',
  '## Progress',
  '',
  'Tasks ticked in each brief, by milestone.',
  '',
  ...table(
    ['Agent', ...columns],
    agents
      .filter((a) => briefs.has(a) && Object.keys(progress.get(a)).length > 0)
      .map((a) => [`\`${a}\``, ...columns.map((c) => {
        const t = progress.get(a)[c];
        return t ? `${t.done}/${t.total}${t.done === t.total ? ' ✓' : ''}` : '';
      })]),
  ),
  '',
  '## Open messages',
  '',
  ...table(
    ['To', 'From', 'Type', 'Subject', 'Since', 'Id'],
    open.map((m) => [m.to, m.from, m.type, m.subject, m.date, `\`${m.id}\``]),
  ),
  '',
  '## Contracts',
  '',
  ...table(
    ['Contract', 'Owner', 'Version', 'Status', 'Used by'],
    contracts.map((c) => [`[${c.name}](contracts/${c.name}.md)`, c.owner, c.version, c.status, c.consumers]),
  ),
  '',
];

writeFileSync(join(dir, 'BOARD.md'), lines.join('\n'));
console.log(`Wrote ${join(dir, 'BOARD.md')}: ${agents.length} agents, ${open.length} open messages, ${decisions.length} decisions waiting.`);
