/**
 * The Larder shopping provider contract, version 1.x, as Larder reads it.
 * The source of truth is `src/contract/index.ts` in the provider template
 * (larder-provider-tesco), with CONTRACT.md beside it. Keep this in step:
 * a new minor version only adds, so older Larders still read newer providers.
 *
 * Larder is lenient where the contract may grow (error codes, capabilities),
 * so a provider on 1.4 still works here.
 */
import { z } from 'zod';

/** The major version this Larder understands. */
export const CONTRACT_MAJOR = 1;

export const Unit = z.enum(['kg', 'l', 'each']);
export type Unit = z.infer<typeof Unit>;

export const PackSize = z.object({ amount: z.number().positive(), unit: Unit });
export type PackSize = z.infer<typeof PackSize>;

const Money = z.number().min(0);

/** When an offer applies, by delivery date. Either end may be unknown. */
export const Validity = z.object({ from: z.string().nullable(), until: z.string().nullable() });
export type Validity = z.infer<typeof Validity>;

const DealBase = {
  text: z.string(),
  loyalty_only: z.boolean().default(false),
  valid: Validity.nullable().default(null),
};

export const Deal = z.discriminatedUnion('type', [
  z.object({ type: z.literal('multibuy_fixed'), ...DealBase, quantity: z.number().int().min(2), price: Money }),
  z.object({ type: z.literal('multibuy_free'), ...DealBase, buy: z.number().int().min(1), free: z.number().int().min(1) }),
  z.object({ type: z.literal('percent_off'), ...DealBase, percent: z.number().gt(0).max(100), min_quantity: z.number().int().min(1).default(1) }),
  z.object({ type: z.literal('other'), ...DealBase }),
]);
export type Deal = z.infer<typeof Deal>;

export const Product = z.object({
  listing_id: z.string().min(1),
  name: z.string(),
  pack_size: PackSize.nullable(),
  price: Money.nullable(),
  loyalty_price: Money.nullable(),
  loyalty_price_valid: Validity.nullable().default(null),
  link: z.string(),
  image_urls: z.array(z.string()).default([]),
});
export type Product = z.infer<typeof Product>;

export const Manifest = z.object({
  provider: z.string(),
  name: z.string(),
  version: z.string(),
  currency: z.string(),
  /** loyalty_prices, multibuys, slot_booking, favourites, add_favourites, product_images, substitution_prefs, search, and later more. */
  capabilities: z.array(z.string()),
  /** The machine it runs on, for Wake-on-LAN (1.3). */
  host: z.object({ mac: z.string().nullable(), address: z.string().nullable() }).nullable().default(null),
});
export type Manifest = z.infer<typeof Manifest>;

export const Health = z.object({
  ok: z.boolean(),
  logged_in: z.boolean(),
  session_valid: z.boolean(),
  busy: z.boolean(),
  message: z.string().nullable(),
});
export type Health = z.infer<typeof Health>;

export const Slot = z.object({ id: z.string(), start: z.string(), end: z.string(), price: Money, available: z.boolean() });
export type Slot = z.infer<typeof Slot>;
export const SlotList = z.object({
  date: z.string(),
  described: z.string().default(''),
  window: z.object({ from: z.string().nullable(), until: z.string().nullable() }).nullable().default(null),
  slots: z.array(Slot),
});
export type SlotList = z.infer<typeof SlotList>;

export const Booking = z.object({ slot_id: z.string(), booking_reference: z.string().nullable(), reserved_until: z.string().nullable() });
export type Booking = z.infer<typeof Booking>;

export const QuoteLine = z.object({
  listing_id: z.string(),
  available: z.boolean(),
  error: z.string().nullable(),
  name: z.string().nullable(),
  pack_size: PackSize.nullable(),
  price: Money.nullable(),
  loyalty_price: Money.nullable(),
  loyalty_price_valid: Validity.nullable().default(null),
  price_per_unit: z.object({ price: Money, unit: Unit }).nullable(),
  deal: Deal.nullable(),
});
export type QuoteLine = z.infer<typeof QuoteLine>;
export const Quote = z.object({ quotes: z.array(QuoteLine) });

export const ErrorBody = z.object({ code: z.string(), message: z.string() });

export const FavouriteList = z.object({
  fetched_at: z.string().nullable(),
  stale: z.boolean(),
  stale_reason: ErrorBody.nullable(),
  favourites: z.array(Product),
});
export type FavouriteList = z.infer<typeof FavouriteList>;

export const BasketLine = z.object({ listing_id: z.string(), quantity: z.number().int().min(1).max(99) });
export type BasketLine = z.infer<typeof BasketLine>;
export const BasketAddResult = z.object({
  added: z.array(BasketLine),
  failed: z.array(z.object({ listing_id: z.string(), quantity: z.number(), error: z.string(), message: z.string() })),
});
export type BasketAddResult = z.infer<typeof BasketAddResult>;

export const Basket = z.object({
  lines: z.array(z.object({ listing_id: z.string(), name: z.string(), quantity: z.number(), price: Money })),
  total: Money,
});
export type Basket = z.infer<typeof Basket>;

export const Job = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  created_at: z.string(),
  finished_at: z.string().nullable(),
  result: z.unknown().nullable(),
  error: ErrorBody.nullable(),
});
export type Job = z.infer<typeof Job>;
