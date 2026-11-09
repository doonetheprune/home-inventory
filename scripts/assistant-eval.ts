/**
 * Asks a real Claude model to do what the household asks, through Larder's assistant tools and
 * the instructions an assistant gets on connecting, then checks what ended up in Larder. The
 * replays in tests/core/assistant-units.test.ts check the tools do the right thing when they're
 * called correctly; this checks an assistant calls them correctly from what people say, which is
 * what went wrong in the owner's chats (docs/plans/units.md). It costs money, so it isn't part of
 * `npm test`.
 *
 *   ANTHROPIC_API_KEY=… npm run eval:assistant -- [--model claude-opus-5-5] [--runs 3] [--case sleep] [--verbose]
 *   npm run eval:assistant -- --dry    (no model: makes each case's right calls, to check the grading)
 *
 * Grading reads Larder's state, never the assistant's words, so it works on any wording of the
 * tools. It reads Pack size as `packSize`, or `contents` before that was renamed.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { AmbiguousError, ASSISTANT_INSTRUCTIONS, LarderError, usageInBoughtIn, type Product, type ProductSummary, type UnitAmount } from '@larder/core';
import { modules } from '../modules';
import { category, makeCore, type TestCore } from '../tests/helpers';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const MODEL = flag('model') ?? 'claude-opus-5-5';
const RUNS = Number(flag('runs') ?? 3);
const ONLY = flag('case');
const VERBOSE = args.includes('--verbose');
const DRY = args.includes('--dry');

/** Dollars per million tokens: input, output, cache write, cache read. */
const PRICES: Record<string, [number, number, number, number]> = {
  'claude-opus-5-5': [4, 20, 5, 0.2],
  'claude-sonnet-5-5': [2, 10, 2.5, 0.2],
  'claude-haiku-5-5': [0.1, 0.5, 0.125, 0.01],
};

/** Stands in for the chat app around the connector, which adds its own instructions to Larder's. */
const SYSTEM = [
  'You are Claude, chatting with someone at home. They have connected Larder, their household inventory, and these are its instructions:',
  ASSISTANT_INSTRUCTIONS,
  'Do what they ask with Larder\'s tools, and keep replies short.',
].join('\n\n');

interface Case {
  id: string;
  /** What it checks, in a few words. */
  about: string;
  setup?: (core: TestCore) => Promise<void>;
  /** What the person says, one message per turn, whatever the assistant replied. */
  says: string[];
  /** The calls a good assistant makes (for `--dry`), in the current tools' words. */
  right: Array<[string, Record<string, unknown>]>;
  /** What's wrong with Larder afterwards; empty when it's right. */
  check: (core: TestCore) => Promise<string[]>;
}

const packOf = (p: Product): UnitAmount | null => ((p as Product & { packSize?: UnitAmount | null }).packSize ?? (p as Product & { contents?: UnitAmount | null }).contents ?? null);
const near = (a: number, b: number) => Math.abs(a - b) < 0.0011;

async function item(core: TestCore, name: RegExp): Promise<ProductSummary | null> {
  return (await core.products.list({ status: 'all' })).find((s) => name.test(s.product.name)) ?? null;
}

/** Things everyone expects of an item: what it's bought in, its pack size, how many there are. */
function expect(s: ProductSummary | null, want: { unit?: string; pack?: [number, string] | null; inStock?: number; minimum?: number }): string[] {
  if (!s) return ['the item is missing'];
  const p = s.product;
  const wrong: string[] = [];
  if (want.unit !== undefined && p.unit !== want.unit) wrong.push(`bought in "${p.unit}", not "${want.unit}"`);
  const pack = packOf(p);
  if (want.pack === null && pack) wrong.push(`has a pack size of ${pack.amount} ${pack.unit}, wanted none`);
  if (want.pack && (!pack || !near(pack.amount, want.pack[0]) || pack.unit !== want.pack[1])) wrong.push(`pack size ${pack ? `${pack.amount} ${pack.unit}` : 'not set'}, not ${want.pack[0]} ${want.pack[1]}`);
  if (want.inStock !== undefined && !near(s.inStock, want.inStock)) wrong.push(`${s.inStock} in stock, not ${want.inStock}`);
  if (want.minimum !== undefined && !near(p.minQuantity ?? -1, want.minimum)) wrong.push(`low below ${p.minQuantity}, not ${want.minimum}`);
  return wrong;
}

/** How much a day is used, in what it's bought in, and whether Larder takes it out. */
async function usage(core: TestCore, s: ProductSummary | null, perDay: number, auto: boolean): Promise<string[]> {
  if (!s) return [];
  const per = usageInBoughtIn(await core.units.list(), s.product);
  if (!per) return ['no usage set'];
  const wrong: string[] = [];
  if (!near(per.amount / per.everyDays, perDay)) wrong.push(`uses ${per.amount / per.everyDays} ${s.product.unit} a day, not ${perDay}`);
  if (!!s.product.usage?.auto !== auto) wrong.push(auto ? 'Larder doesn\'t take them out' : 'Larder takes them out, unasked');
  return wrong;
}

async function add(core: TestCore, product: Record<string, unknown>, quantity: number) {
  const food = await category(core, 'Food');
  const p = await core.products.create({ categoryId: food.id, ...product } as never);
  if (quantity) await core.stock.add({ productId: p.id, quantity });
}

const CASES: Case[] = [
  {
    id: 'sleep',
    about: 'a box holds 20 tea bags, keep counting boxes (the first chat)',
    setup: (core) => add(core, { name: 'Twinings Sleep', unit: 'box' }, 4),
    says: ['There are 20 tea bags in a box of Twinings Sleep.', 'I have one every night. Can Larder take them out for me as I go?'],
    right: [['change_item', { item: 'twinings sleep', pack_size: { amount: 20, unit: 'tea bag' }, uses: { amount: 1, every_days: 1, unit: 'tea bag' }, takes_out_automatically: true }]],
    async check(core) {
      const s = await item(core, /sleep/i);
      return [...expect(s, { unit: 'box', pack: [20, 'tea bag'], inStock: 4 }), ...(await usage(core, s, 0.05, true)), ...(/20 tea bags/i.test(s?.product.notes ?? '') ? ['wrote the pack size in the notes'] : [])];
    },
  },
  {
    id: 'decaf',
    about: '4 g a day from a 400 g jar (the second chat)',
    setup: (core) => add(core, { name: 'Decaf coffee', unit: 'jar' }, 1),
    says: ['Can you set decaf coffee to four grams a day? It\'s a 400 g jar.', 'Yes, take it out automatically.'],
    right: [['change_item', { item: 'decaf coffee', pack_size: { amount: 400, unit: 'g' }, uses: { amount: 4, every_days: 1, unit: 'g' }, takes_out_automatically: true }]],
    async check(core) {
      const s = await item(core, /decaf/i);
      return [...expect(s, { unit: 'jar', pack: [400, 'g'], inStock: 1 }), ...(await usage(core, s, 0.01, true))];
    },
  },
  {
    id: 'eggs',
    about: 'a new item bought in boxes of 6',
    setup: async (core) => void (await core.places.create({ name: 'Fridge' } as never)),
    says: ['Add eggs to Larder: we buy them in boxes of 6, and there are 2 boxes in the fridge.'],
    right: [['add_item', { name: 'Eggs', category: 'Food', bought_in: 'box', pack_size: { amount: 6, unit: 'egg' }, usual_place: 'fridge' }], ['add_stock', { item: 'eggs', quantity: 2 }]],
    check: async (core) => expect(await item(core, /egg/i), { unit: 'box', pack: [6, 'egg'], inStock: 2 }),
  },
  {
    id: 'nutella',
    about: 'ingredients aren\'t the pack size',
    says: ['Add a jar of Nutella to Larder. It\'s 400 g, and it contains hazelnuts and milk.'],
    right: [['add_item', { name: 'Nutella', category: 'Food', bought_in: 'jar', pack_size: { amount: 400, unit: 'g' }, notes: 'Contains hazelnuts and milk.' }], ['add_stock', { item: 'nutella', quantity: 1 }]],
    check: async (core) => expect(await item(core, /nutella|hazelnut/i), { unit: 'jar', pack: [400, 'g'] }),
  },
  {
    id: 'dog-food',
    about: 'bought loose by weight, said in kg',
    says: ['Add dog food. We buy it loose by weight: there\'s about 2 kg left, and it\'s running low below 1 kg.'],
    right: [['add_item', { name: 'Dog food', category: 'Pets', bought_in: 'kg', minimum: 1 }], ['add_stock', { item: 'dog food', quantity: 2, unit: 'kg' }]],
    check: async (core) => expect(await item(core, /dog/i), { unit: 'g', pack: null, inStock: 2000, minimum: 1000 }),
  },
  {
    id: 'used-some',
    about: 'tea bags taken out of a box',
    setup: (core) => add(core, { name: 'Twinings Sleep', unit: 'box', contents: { amount: 20, unit: 'tea bag' }, packSize: { amount: 20, unit: 'tea bag' } }, 4),
    says: ['I just used 3 Twinings Sleep tea bags.'],
    right: [['use_stock', { item: 'twinings sleep', quantity: 3, unit: 'tea bag' }]],
    check: async (core) => expect(await item(core, /sleep/i), { unit: 'box', pack: [20, 'tea bag'], inStock: 3.85 }),
  },
  {
    id: 'sleeves',
    about: 'a unit Larder doesn\'t have, added once asked',
    says: ['Add paper cups to Larder. They come in sleeves of 50.', 'Yes, add it.'],
    right: [['add_unit', { one: 'sleeve', many: 'sleeves' }], ['add_item', { name: 'Paper cups', category: 'Household', bought_in: 'sleeve', pack_size: { amount: 50, unit: 'piece' } }]],
    async check(core) {
      const s = await item(core, /cup/i);
      const wrong = expect(s, { unit: 'sleeve' });
      if (s && !near(packOf(s.product)?.amount ?? 0, 50)) wrong.push('pack size isn\'t 50');
      return wrong;
    },
  },
];

const client = DRY ? (null as unknown as Anthropic) : new Anthropic();
const spent = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

/** One conversation: the person's messages, and the assistant's tool calls until it replies. */
async function converse(c: Case): Promise<{ wrong: string[]; transcript: string[] }> {
  const core = await makeCore({ modules: modules.filter((m) => m.id !== 'template') });
  for (const m of modules) if (m.id !== 'template') await core.modules.setEnabled(m.id, true).catch(() => undefined);
  await c.setup?.(core);
  const listed = core.assistant.list();
  const tools: Anthropic.Tool[] = listed.map((t) => ({ name: t.name, description: t.description, input_schema: z.toJSONSchema(t.input, { io: 'input' }) as Anthropic.Tool.InputSchema }));
  const messages: Anthropic.MessageParam[] = [];
  const transcript: string[] = [];
  if (DRY) {
    for (const [name, input] of c.right) transcript.push(`  ${name} ${JSON.stringify(input)}`, `    → ${(await core.assistant.call(name, input)).text}`);
    return { wrong: await c.check(core), transcript };
  }
  for (const said of c.says) {
    messages.push({ role: 'user', content: said });
    transcript.push(`Person: ${said}`);
    for (let step = 0; step < 12; step++) {
      const res = await client.messages.create({ model: MODEL, max_tokens: 16000, system: SYSTEM, tools, messages, cache_control: { type: 'ephemeral' } });
      spent.input += res.usage.input_tokens;
      spent.output += res.usage.output_tokens;
      spent.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;
      spent.cacheRead += res.usage.cache_read_input_tokens ?? 0;
      messages.push({ role: 'assistant', content: res.content });
      for (const b of res.content) if (b.type === 'text' && b.text.trim()) transcript.push(`Assistant: ${b.text.trim()}`);
      const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || !calls.length) break;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        transcript.push(`  ${call.name} ${JSON.stringify(call.input)}`);
        try {
          const r = await core.assistant.call(call.name, call.input);
          results.push({ type: 'tool_result', tool_use_id: call.id, content: r.text });
          transcript.push(`    → ${r.text}`);
        } catch (err) {
          // As the MCP server answers: the assistant gets the sentence, so it can ask or try again.
          const text = err instanceof AmbiguousError ? `${err.message} Candidates: ${err.candidates.join('; ')}.` : err instanceof LarderError ? err.message : String(err);
          results.push({ type: 'tool_result', tool_use_id: call.id, content: text, is_error: true });
          transcript.push(`    ✗ ${text}`);
        }
      }
      messages.push({ role: 'user', content: results });
    }
  }
  return { wrong: await c.check(core), transcript };
}

const cases = CASES.filter((c) => !ONLY || c.id === ONLY);
if (!cases.length) throw new Error(`No case "${ONLY}". Cases: ${CASES.map((c) => c.id).join(', ')}`);
const runs = DRY ? 1 : RUNS;
console.log(DRY ? 'Dry run: each case\'s right calls, no model\n' : `${MODEL}, ${RUNS} run${RUNS === 1 ? '' : 's'} of each case\n`);
let passed = 0;
for (const c of cases) {
  const outcomes = [];
  for (let run = 0; run < runs; run++) outcomes.push(await converse(c));
  const good = outcomes.filter((o) => !o.wrong.length).length;
  passed += good;
  console.log(`${good === runs ? '✓' : '✗'} ${c.id}: ${good}/${runs}  (${c.about})`);
  outcomes.forEach((o, i) => {
    if (o.wrong.length) console.log(`    run ${i + 1}: ${o.wrong.join('; ')}`);
    if (VERBOSE || o.wrong.length) console.log(o.transcript.map((l) => `      ${l}`).join('\n'));
  });
}
const price = PRICES[MODEL];
const cost = price ? (spent.input * price[0] + spent.output * price[1] + spent.cacheWrite * price[2] + spent.cacheRead * price[3]) / 1e6 : null;
console.log(`\n${passed}/${cases.length * runs} passed. Tokens: ${spent.input} in, ${spent.cacheWrite} cached, ${spent.cacheRead} from cache, ${spent.output} out${cost === null ? '' : `, about $${cost.toFixed(2)}`}.`);
process.exitCode = passed === cases.length * runs ? 0 : 1;
