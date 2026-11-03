import { describe, expect, it } from 'vitest';
import type { Deal, QuoteLine } from './contract';
import { cheapestMix, cost, dailyUse, plan, priced, type Candidate, type PlanOptions } from './plan';

const options: PlanOptions = { deliveryDate: '2026-11-06', loyalty: true, multibuyOver: 0.25 };

function quote(id: string, price: number, extra: Partial<QuoteLine> = {}): QuoteLine {
  return { listing_id: id, available: true, error: null, name: id, pack_size: null, price, loyalty_price: null, loyalty_price_valid: null, price_per_unit: null, deal: null, ...extra };
}
const quotes = (...q: QuoteLine[]) => new Map(q.map((x) => [x.listing_id, x]));

function item(extra: Partial<Candidate> = {}): Candidate {
  return {
    productId: 'loo', name: 'Toilet roll', unit: 'roll', inStock: 3, expected: 0, minimum: 4, stockUpTo: 12, offerStockUpTo: 36, targetPrice: 0.32,
    manual: false, shelfLifeDays: null, dailyUse: null, packRule: 'cheapest', fixedListingId: null,
    listings: [{ listingId: 'nine', name: '9 rolls', packQuantity: 9 }, { listingId: 'big', name: '24 rolls', packQuantity: 24 }],
    ...extra,
  };
}
// The spec's loo roll: a 9-pack at £4.50 and a 24-pack at £9.00 (£7.50 with Clubcard).
const looQuotes = () => quotes(quote('nine', 4.5), quote('big', 9, { loyalty_price: 7.5 }));

describe('order logic', () => {
  it('worked example: low and on offer, so it tops up to 36 with the cheapest cover (24 + 9)', () => {
    const p = plan([item()], looQuotes(), options);
    expect(p.items).toHaveLength(1);
    const loo = p.items[0]!;
    expect(loo).toMatchObject({ reason: 'offer', have: 3, level: 36, needed: 33, quantity: 33, cost: 12, unitPrice: 0.3125 });
    expect(loo.lines.map((l) => [l.listingId, l.packs])).toEqual([['nine', 1], ['big', 1]]);
    expect(p.lines).toEqual([{ listing_id: 'nine', quantity: 1 }, { listing_id: 'big', quantity: 1 }]);
    expect(p.total).toBe(12);
  });

  it('worked example: not low (15), so it is only bought on offer', () => {
    const onOffer = plan([item({ inStock: 15 })], looQuotes(), options);
    expect(onOffer.items[0]).toMatchObject({ reason: 'offer', needed: 21, quantity: 24, cost: 7.5 });
    expect(onOffer.items[0]!.lines.map((l) => [l.listingId, l.packs])).toEqual([['big', 1]]);

    const noClubcard = plan([item({ inStock: 15 })], looQuotes(), { ...options, loyalty: false });
    expect(noClubcard.items).toEqual([]);
    expect(noClubcard.skipped).toEqual([{ productId: 'loo', name: 'Toilet roll', why: 'not low and not on offer' }]);
  });

  it('tops up to the normal amount when low but not on offer', () => {
    const p = plan([item({ targetPrice: 0.2 })], looQuotes(), options);
    expect(p.items[0]).toMatchObject({ reason: 'low', level: 12, needed: 9 });
    expect(p.items[0]!.lines.map((l) => [l.listingId, l.packs])).toEqual([['nine', 1]]);
  });

  it('does not ask about items that are fine and have no target price', () => {
    const p = plan([item({ inStock: 15, targetPrice: null })], looQuotes(), options);
    expect(p).toMatchObject({ items: [], skipped: [] });
  });

  it('a fixed pack always buys that listing', () => {
    const p = plan([item({ packRule: 'fixed', fixedListingId: 'nine', targetPrice: null })], looQuotes(), options);
    expect(p.items[0]!.lines.map((l) => [l.listingId, l.packs])).toEqual([['nine', 1]]);
    const out = plan([item({ packRule: 'fixed', fixedListingId: 'nine' })], quotes(quote('nine', 4.5, { available: false, error: 'out_of_stock' }), quote('big', 7.5)), options);
    expect(out.items).toEqual([]);
    expect(out.unavailable).toEqual([{ productId: 'loo', name: 'Toilet roll', why: 'out of stock' }]);
  });

  it('flags gone listings for relinking and buys from the others', () => {
    const p = plan([item({ targetPrice: null })], quotes(quote('nine', 4.5), { ...quote('big', 0), available: false, error: 'listing_dead', price: null }), options);
    expect(p.relink).toEqual([{ productId: 'loo', name: 'Toilet roll', listingId: 'big', listingName: '24 rolls' }]);
    expect(p.items[0]!.lines.map((l) => [l.listingId, l.packs])).toEqual([['nine', 1]]);
  });

  it('only counts offers and loyalty prices valid on the delivery day', () => {
    const later = { from: '2026-11-10', until: null };
    const p = plan([item({ inStock: 15 })], quotes(quote('nine', 4.5), quote('big', 9, { loyalty_price: 7.5, loyalty_price_valid: later })), options);
    expect(p.items).toEqual([]);
    const q = plan([item({ inStock: 15 })], quotes(quote('nine', 4.5), quote('big', 9, { loyalty_price: 7.5, loyalty_price_valid: later })), { ...options, deliveryDate: '2026-11-12' });
    expect(q.items[0]?.reason).toBe('offer');
  });

  describe('multibuys', () => {
    const beans = (deal: Deal, extra: Partial<Candidate> = {}) => ({
      c: item({ productId: 'beans', name: 'Baked beans', unit: 'tin', inStock: 2, minimum: 4, stockUpTo: 6, offerStockUpTo: null, targetPrice: null, listings: [{ listingId: 'tin', name: 'Heinz 415g', packQuantity: 1 }], ...extra }),
      q: quotes(quote('tin', 1.4, { deal })),
    });

    it('prices "3 for £2", "buy 2 get 1 free" and "25% off 6 or more"', () => {
      const p = (deal: Deal) => priced({ listingId: 'x', name: 'x', packQuantity: 1 }, quote('x', 1, { deal }), options)!;
      expect(cost(p({ type: 'multibuy_fixed', text: '3 for £2', quantity: 3, price: 2, loyalty_only: false, valid: null }), 4)).toBe(3);
      expect(cost(p({ type: 'multibuy_free', text: 'Buy 2 get 1 free', buy: 2, free: 1, loyalty_only: false, valid: null }), 5)).toBe(4);
      expect(cost(p({ type: 'percent_off', text: 'Buy 6 save 25%', percent: 25, min_quantity: 6, loyalty_only: false, valid: null }), 5)).toBe(5);
      expect(cost(p({ type: 'percent_off', text: 'Buy 6 save 25%', percent: 25, min_quantity: 6, loyalty_only: false, valid: null }), 6)).toBe(4.5);
    });

    it('rounds up to complete the deal when it stays within the allowance', () => {
      const { c, q } = beans({ type: 'multibuy_fixed', text: '3 for £3', quantity: 3, price: 3, loyalty_only: false, valid: null });
      const p = plan([c], q, options);
      // Needs 4 (2 → 6); 6 is a whole number of deals already.
      expect(p.items[0]!.lines[0]).toMatchObject({ packs: 4, roundedForDeal: false });
      const five = plan([{ ...c, stockUpTo: 5 }], q, options);
      // Needs 3 (2 → 5) = one deal exactly.
      expect(five.items[0]!.lines[0]).toMatchObject({ packs: 3, cost: 3, deal: '3 for £3' });
      const seven = plan([{ ...c, stockUpTo: 7, inStock: 3 }], q, options);
      // Needs 4 (3 → 7). Completing two deals would make 9, more than 25% over 7, so it stays at 4.
      expect(seven.items[0]!.lines[0]).toMatchObject({ packs: 4, roundedForDeal: false });
      const loose = plan([{ ...c, stockUpTo: 7, inStock: 3 }], q, { ...options, multibuyOver: 0.3 });
      expect(loose.items[0]!.lines[0]).toMatchObject({ packs: 6, roundedForDeal: true, cost: 6 });
    });

    it('ignores loyalty-only deals without the card, and other deals except in the summary', () => {
      const { c, q } = beans({ type: 'multibuy_fixed', text: 'Any 3 for £2 Clubcard Price', quantity: 3, price: 2, loyalty_only: true, valid: null });
      expect(plan([c], q, { ...options, loyalty: false }).items[0]!.lines[0]).toMatchObject({ packs: 4, cost: 5.6, deal: null });
      const other = beans({ type: 'other', text: 'Meal deal for £3.50', loyalty_only: false, valid: null });
      const p = plan([other.c], other.q, options);
      expect(p.otherDeals).toEqual([{ productId: 'beans', name: 'Baked beans', listingName: 'Heinz 415g', text: 'Meal deal for £3.50' }]);
      expect(p.items[0]!.lines[0]!.deal).toBeNull();
    });
  });

  it('chooses two small packs when the large one costs more per unit', () => {
    const small = priced({ listingId: 'small', name: '250 g', packQuantity: 250 }, quote('small', 1), options)!;
    const large = priced({ listingId: 'large', name: '500 g', packQuantity: 500 }, quote('large', 2.5), options)!;
    expect(cheapestMix(500, [large, small])).toMatchObject({ counts: [0, 2], cost: 2 });
    // The large pack wins when it's cheaper per gram.
    const cheapLarge = priced({ listingId: 'large', name: '500 g', packQuantity: 500 }, quote('large', 1.8), options)!;
    expect(cheapestMix(400, [cheapLarge, small])).toMatchObject({ counts: [1, 0], cost: 1.8 });
  });

  describe('perishables', () => {
    const milk = (extra: Partial<Candidate>) => item({
      productId: 'milk', name: 'Milk', unit: 'bottle', inStock: 0, minimum: 1, stockUpTo: 4, offerStockUpTo: 10, targetPrice: 1.5, shelfLifeDays: 7,
      listings: [{ listingId: 'pint4', name: '4 pints', packQuantity: 1 }], ...extra,
    });
    const q = quotes(quote('pint4', 1.45));

    it('buys no more than gets used before it goes off', () => {
      const p = plan([milk({ dailyUse: 2 / 7 })], q, options);
      expect(p.items[0]).toMatchObject({ reason: 'offer', level: 2, quantity: 2, capped: 'it keeps 7 days and you use about 2 a week' });
    });

    it('with no history, only tops up to the normal amount on offer', () => {
      const p = plan([milk({})], q, options);
      expect(p.items[0]).toMatchObject({ level: 4, capped: 'it keeps 7 days and there\'s no usage history yet, so not stocking up on offer' });
      // Things that keep a long time aren't held back.
      expect(plan([milk({ shelfLifeDays: 365 })], q, options).items[0]).toMatchObject({ level: 10, capped: null });
    });
  });

  it('works out daily use from stock taken out over recent weeks', () => {
    const at = (d: string) => `${d}T12:00:00.000Z`;
    const moves = [
      { kind: 'use', quantity: -2, at: at('2026-11-01') },
      { kind: 'add', quantity: 6, at: at('2026-10-25') },
      { kind: 'use', quantity: -1, at: at('2026-10-20') },
      { kind: 'add', quantity: 4, at: at('2026-10-08') },
    ];
    // 3 used between noon on 8 October and the end of 6 November: 29.5 days.
    expect(dailyUse(moves, '2026-11-06')).toBeCloseTo(3 / 29.5, 5);
    expect(dailyUse(moves.slice(0, 1), '2026-11-06')).toBeNull();
    expect(dailyUse([{ kind: 'add', quantity: 4, at: at('2026-09-01') }], '2026-11-06')).toBeNull();
  });
});
