/**
 * Larder's data model. These zod schemas are the single source of truth for
 * the shape of stored records and API payloads: the server derives its OpenAPI
 * spec from them and the web app imports the same types.
 *
 * Rules for changing this file (see AGENTS.md):
 * - Add fields as optional or with a default so existing data still parses.
 * - Never rename or remove a field without a migration in every storage adapter.
 * - Module-specific data goes in `fields[moduleId]`, not here.
 */
import { z } from 'zod';

export const Id = z.string().min(1).max(100);
/** Calendar date, e.g. 2026-10-28. */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
/** Timestamp in UTC, e.g. 2026-10-28T21:42:06.000Z. */
export const IsoDateTime = z.string().min(10);
/** Free-form data owned by modules, keyed by module id. */
export const ModuleFields = z.record(z.string(), z.unknown());

export const Category = z.object({
  id: Id,
  name: z.string().min(1).max(60),
  /** Icon key used by the web app, e.g. "apple", "wrench". */
  icon: z.string().max(30).default('box'),
  /** Days before expiry to warn. Null uses the household default. */
  warnDays: z.number().int().min(0).max(365).nullable().default(null),
  sortOrder: z.number().default(0),
});
export type Category = z.infer<typeof Category>;

export const Shop = z.object({
  id: Id,
  name: z.string().min(1).max(60),
  /** Category ids this shop sells. "Any shop" items only appear at shops that sell their category. */
  sells: z.array(Id).default([]),
  notes: z.string().max(2000).default(''),
  sortOrder: z.number().default(0),
});
export type Shop = z.infer<typeof Shop>;

export const Place = z.object({
  id: Id,
  name: z.string().min(1).max(80),
  parentId: Id.nullable().default(null),
  /** Short code printed on labels, e.g. G2-4. Unique when set. */
  code: z.string().max(20).nullable().default(null),
  notes: z.string().max(2000).default(''),
  photoFileId: Id.nullable().default(null),
  nfcTags: z.array(z.string().max(200)).default([]),
  sortOrder: z.number().default(0),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Place = z.infer<typeof Place>;

export const Link = z.object({
  url: z.string().url().max(2000),
  title: z.string().max(200).default(''),
});
export type Link = z.infer<typeof Link>;

export const Product = z.object({
  id: Id,
  name: z.string().min(1).max(120),
  /** Other names people use: "loo roll", "bog roll". Used by search and voice. */
  aliases: z.array(z.string().min(1).max(80)).default([]),
  categoryId: Id.nullable().default(null),
  /** What stock is counted in: "roll", "tin", "L", "kg", "each". */
  unit: z.string().min(1).max(20).default('each'),
  /** Days until expiry from the day stock is added. Renewals use the renewal period. */
  shelfLifeDays: z.number().int().min(1).max(36500).nullable().default(null),
  /** Below this (counting expected stock) the product is low. */
  minQuantity: z.number().min(0).nullable().default(null),
  /** Empty means it can come from any shop that sells its category. */
  preferredShopIds: z.array(Id).default([]),
  notes: z.string().max(5000).default(''),
  photoFileIds: z.array(Id).default([]),
  links: z.array(Link).default([]),
  /** Wish list item: wanted, not owned. Buying it clears the flag. */
  wish: z.boolean().default(false),
  /** Rechargeable batteries and similar: stock is split into charged and flat. */
  rechargeable: z.boolean().default(false),
  /** Put on the shopping list by hand even though it isn't low. Cleared when bought. */
  onShoppingList: z.boolean().default(false),
  /** Where new stock goes by default. */
  defaultPlaceId: Id.nullable().default(null),
  nfcTags: z.array(z.string().max(200)).default([]),
  /** Linked Home Assistant device ids (used from Phase 2). */
  haDeviceIds: z.array(z.string().max(200)).default([]),
  fields: ModuleFields.default({}),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Product = z.infer<typeof Product>;

export const ShopCode = z.object({ shopId: Id, code: z.string().min(1).max(60) });
export type ShopCode = z.infer<typeof ShopCode>;

/** A brand or pack under a generic product. All variants count towards the same stock. */
export const Variant = z.object({
  id: Id,
  productId: Id,
  name: z.string().min(1).max(160),
  barcodes: z.array(z.string().min(1).max(64)).default([]),
  /** Shop item numbers, e.g. a Toolstation code, for reordering and matching order emails. */
  shopCodes: z.array(ShopCode).default([]),
  imageUrl: z.string().max(2000).nullable().default(null),
  /** Where the details came from: a lookup provider id, or "local". */
  source: z.string().max(60).default('local'),
  fields: ModuleFields.default({}),
  createdAt: IsoDateTime,
});
export type Variant = z.infer<typeof Variant>;

export const ExpectedInfo = z.object({
  /** Who it's coming from, e.g. "Tesco delivery". Deliveries are grouped by this. */
  source: z.string().min(1).max(80),
  reference: z.string().max(80).nullable().default(null),
  eta: IsoDate.nullable().default(null),
});
export type ExpectedInfo = z.infer<typeof ExpectedInfo>;

export const StockStatus = z.enum(['in_stock', 'expected']);
export const Charge = z.enum(['charged', 'flat']);

/** A batch of a product in one place. */
export const StockEntry = z.object({
  id: Id,
  productId: Id,
  variantId: Id.nullable().default(null),
  quantity: z.number().min(0),
  /** The usual place this batch lives. */
  placeId: Id.nullable().default(null),
  /** Where it is right now if not in its usual place ("out of place"). */
  currentPlaceId: Id.nullable().default(null),
  movedAt: IsoDateTime.nullable().default(null),
  expiresOn: IsoDate.nullable().default(null),
  addedAt: IsoDateTime,
  status: StockStatus.default('in_stock'),
  expected: ExpectedInfo.nullable().default(null),
  /** Only for rechargeable products. */
  charge: Charge.nullable().default(null),
});
export type StockEntry = z.infer<typeof StockEntry>;

export const MovementKind = z.enum(['add', 'use', 'move', 'return', 'expect', 'arrive', 'adjust', 'remove', 'flat', 'charged']);
/** History of every stock change, kept for future usage-rate predictions. */
export const Movement = z.object({
  id: Id,
  productId: Id,
  entryId: Id.nullable().default(null),
  kind: MovementKind,
  quantity: z.number(),
  fromPlaceId: Id.nullable().default(null),
  toPlaceId: Id.nullable().default(null),
  note: z.string().max(200).default(''),
  userId: Id.nullable().default(null),
  at: IsoDateTime,
});
export type Movement = z.infer<typeof Movement>;

/** Cached answer from a barcode lookup provider (or a remembered miss). */
export const LookupRecord = z.object({
  barcode: z.string().min(1).max(64),
  found: z.boolean(),
  provider: z.string().max(60).nullable().default(null),
  name: z.string().max(200).nullable().default(null),
  brand: z.string().max(200).nullable().default(null),
  quantityText: z.string().max(60).nullable().default(null),
  imageUrl: z.string().max(2000).nullable().default(null),
  categories: z.array(z.string().max(120)).default([]),
  fetchedAt: IsoDateTime,
});
export type LookupRecord = z.infer<typeof LookupRecord>;

export const Role = z.enum(['admin', 'member']);
export const User = z.object({
  id: Id,
  username: z.string().min(1).max(60),
  displayName: z.string().max(80).default(''),
  passwordHash: z.string(),
  role: Role.default('member'),
  createdAt: IsoDateTime,
});
export type User = z.infer<typeof User>;

export const Session = z.object({
  id: Id,
  userId: Id,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type Session = z.infer<typeof Session>;

export const ApiToken = z.object({
  id: Id,
  name: z.string().min(1).max(80),
  tokenHash: z.string(),
  /** First characters of the token, shown so people can tell tokens apart. */
  prefix: z.string().max(20),
  userId: Id,
  createdAt: IsoDateTime,
  lastUsedAt: IsoDateTime.nullable().default(null),
});
export type ApiToken = z.infer<typeof ApiToken>;

/* ------------------------------------------------------------------ */
/* Computed views returned by core services (never stored).            */
/* ------------------------------------------------------------------ */

export const ProductStatus = z.object({
  low: z.boolean(),
  /** Has stock expiring within its warning window (or already expired). */
  expiringSoon: z.boolean(),
  expired: z.boolean(),
  outOfPlace: z.boolean(),
  hasExpected: z.boolean(),
});
export type ProductStatus = z.infer<typeof ProductStatus>;

export const PlaceRef = z.object({ id: Id, name: z.string(), path: z.string(), code: z.string().nullable() });
export type PlaceRef = z.infer<typeof PlaceRef>;

export const ProductSummary = z.object({
  product: Product,
  category: Category.nullable(),
  /** Stock in the house (charged + flat for rechargeables). */
  inStock: z.number(),
  expected: z.number(),
  charged: z.number().nullable(),
  flat: z.number().nullable(),
  nextExpiry: IsoDate.nullable(),
  /** Days from today until nextExpiry (negative when expired). */
  daysToExpiry: z.number().nullable(),
  status: ProductStatus,
  /** Usual places with stock, most stock first. */
  places: z.array(PlaceRef),
  /** Places where out-of-place stock is right now. */
  nowIn: z.array(PlaceRef),
});
export type ProductSummary = z.infer<typeof ProductSummary>;

export const StockEntryView = StockEntry.extend({
  place: PlaceRef.nullable(),
  currentPlace: PlaceRef.nullable(),
  variantName: z.string().nullable(),
});
export type StockEntryView = z.infer<typeof StockEntryView>;

export const ProductDetail = ProductSummary.extend({
  variants: z.array(Variant),
  entries: z.array(StockEntryView),
  shops: z.array(Shop),
  history: z.array(Movement),
});
export type ProductDetail = z.infer<typeof ProductDetail>;

export const PlaceNode: z.ZodType<PlaceNodeT> = z.lazy(() =>
  z.object({
    place: Place,
    path: z.string(),
    itemCount: z.number(),
    children: z.array(PlaceNode),
  }),
);
export interface PlaceNodeT {
  place: Place;
  path: string;
  itemCount: number;
  children: PlaceNodeT[];
}

export const PlaceContents = z.object({
  place: Place,
  path: z.string(),
  breadcrumbs: z.array(PlaceRef),
  children: z.array(PlaceRef.extend({ itemCount: z.number() })),
  /** Stock that lives here (including any that is out of place right now). */
  items: z.array(z.object({ summary: ProductSummary, quantity: z.number(), outOfPlace: z.boolean(), nowIn: PlaceRef.nullable() })),
  /** Stock from elsewhere that is here right now. */
  visitors: z.array(z.object({ summary: ProductSummary, quantity: z.number(), usualPlace: PlaceRef.nullable() })),
});
export type PlaceContents = z.infer<typeof PlaceContents>;

export const ShoppingItem = z.object({
  summary: ProductSummary,
  /** Suggested amount to buy. */
  quantity: z.number(),
  reason: z.enum(['low', 'out', 'manual']),
  /** True when the product has no preferred shop and is here because the shop sells its category. */
  anyShop: z.boolean(),
});
export type ShoppingItem = z.infer<typeof ShoppingItem>;

export const ShoppingList = z.object({
  shop: Shop,
  groups: z.array(z.object({ category: Category.nullable(), items: z.array(ShoppingItem) })),
  count: z.number(),
});
export type ShoppingList = z.infer<typeof ShoppingList>;

export const ShoppingSummary = z.object({
  shops: z.array(z.object({ shop: Shop, count: z.number() })),
  suggestedShopId: Id.nullable(),
  /** Low products that no shop on the list can supply. */
  unassigned: z.number(),
});
export type ShoppingSummary = z.infer<typeof ShoppingSummary>;

export const Delivery = z.object({
  source: z.string(),
  eta: IsoDate.nullable(),
  itemCount: z.number(),
  quantity: z.number(),
});
export type Delivery = z.infer<typeof Delivery>;

export const Dashboard = z.object({
  today: IsoDate,
  counts: z.object({ products: z.number(), low: z.number(), expiringSoon: z.number(), outOfPlace: z.number(), expected: z.number(), wish: z.number() }),
  expiringSoon: z.array(ProductSummary),
  low: z.array(ProductSummary),
  outOfPlace: z.array(ProductSummary),
  deliveries: z.array(Delivery),
  shopping: ShoppingSummary,
});
export type Dashboard = z.infer<typeof Dashboard>;

export const SearchResult = z.object({
  /** Result type, e.g. "product", "place", "shop", or a module's own type. */
  type: z.string(),
  id: z.string(),
  title: z.string(),
  subtitle: z.string().default(''),
  /** Web app route, e.g. "/products/abc". */
  href: z.string(),
  /** Present for stock results so the UI can show + and − buttons. */
  product: ProductSummary.optional(),
  /** Present for shopping list results. */
  shopIds: z.array(Id).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type SearchResult = z.infer<typeof SearchResult>;

export const SearchSectionResult = z.object({
  id: z.string(),
  title: z.string(),
  results: z.array(SearchResult),
});
export type SearchSectionResult = z.infer<typeof SearchSectionResult>;

export const LookupResult = z.object({
  provider: z.string(),
  barcode: z.string(),
  name: z.string(),
  brand: z.string().nullable(),
  quantityText: z.string().nullable(),
  imageUrl: z.string().nullable(),
  categories: z.array(z.string()),
});
export type LookupResult = z.infer<typeof LookupResult>;

/** What a scanned or typed code turned out to be. */
export const IdentifyResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('product'), code: z.string(), product: ProductSummary, variant: Variant.nullable() }),
  z.object({ kind: z.literal('place'), code: z.string(), place: Place, path: z.string() }),
  z.object({ kind: z.literal('external'), code: z.string(), result: LookupResult, suggestions: z.array(ProductSummary) }),
  z.object({
    kind: z.literal('unknown'),
    code: z.string(),
    /** Providers that answered "not found". */
    providersTried: z.array(z.string()),
    /** Providers that couldn't be reached or timed out (the answer isn't cached, so it's tried again next time). */
    providersFailed: z.array(z.string()).default([]),
  }),
]);
export type IdentifyResult = z.infer<typeof IdentifyResult>;
