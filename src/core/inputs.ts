/**
 * Request payloads accepted by core services. The REST API validates bodies
 * against these, so they also document the API.
 */
import { z } from 'zod';
import { Category, Charge, ExpectedInfo, Id, IsoDate, Place, Product, Shop, Variant } from './model';

/**
 * A partial version of an object schema for PATCH requests, with defaults
 * removed so missing fields stay missing instead of being reset.
 */
export function patchOf<S extends z.ZodRawShape>(schema: z.ZodObject<S>) {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, value] of Object.entries(schema.shape)) {
    const inner = value instanceof z.ZodDefault ? (value.unwrap() as z.ZodType) : (value as z.ZodType);
    shape[key] = inner.optional();
  }
  return z.object(shape) as unknown as z.ZodType<Partial<z.output<z.ZodObject<S>>>>;
}

export const CategoryCreate = Category.omit({ id: true });
export const CategoryPatch = patchOf(CategoryCreate);

export const ShopCreate = Shop.omit({ id: true });
export const ShopPatch = patchOf(ShopCreate);

export const PlaceCreate = Place.omit({ id: true, createdAt: true, updatedAt: true });
export const PlacePatch = patchOf(PlaceCreate);

export const GridCreate = z.object({
  /** The place the storage sits in, e.g. Garage. */
  parentId: Id.nullable().default(null),
  name: z.string().min(1).max(80),
  /** Code prefix, e.g. "G" gives G1-1, G1-2… */
  prefix: z
    .string()
    .min(1)
    .max(4)
    .regex(/^[A-Za-z0-9]+$/, 'Use letters and numbers only'),
  rows: z.number().int().min(1).max(20),
  columns: z.number().int().min(1).max(20),
  /** Whether shelf 1 is the top or bottom shelf (affects order only). */
  firstRow: z.enum(['top', 'bottom']).default('top'),
  rowLabel: z.string().min(1).max(20).default('Shelf'),
  columnLabel: z.string().min(1).max(20).default('box'),
});
export type GridCreate = z.input<typeof GridCreate>;

export const ProductCreate = Product.omit({ id: true, createdAt: true, updatedAt: true });
export type ProductCreate = z.input<typeof ProductCreate>;
export const ProductPatch = patchOf(ProductCreate);

export const VariantCreate = Variant.omit({ id: true, productId: true, createdAt: true });
export const VariantPatch = patchOf(VariantCreate);

export const ProductFilter = z.object({
  status: z.enum(['all', 'low', 'expiring', 'out_of_place', 'expected', 'wish', 'in_stock']).default('all'),
  categoryId: Id.optional(),
  placeId: Id.optional(),
});
export type ProductFilter = z.input<typeof ProductFilter>;

export const StockAdd = z.object({
  productId: Id,
  quantity: z.number().positive(),
  /** Defaults to the product's default place, then wherever most of it already is. */
  placeId: Id.nullable().optional(),
  /** Defaults to today plus the product's shelf life. */
  expiresOn: IsoDate.nullable().optional(),
  variantId: Id.nullable().optional(),
  /** Rechargeables only. Defaults to charged. */
  charge: Charge.optional(),
  note: z.string().max(200).optional(),
});
export type StockAdd = z.input<typeof StockAdd>;

export const StockUse = z.object({
  productId: Id,
  quantity: z.number().positive(),
  /** Only use stock from this place (usual or current). */
  placeId: Id.optional(),
  note: z.string().max(200).optional(),
});
export type StockUse = z.input<typeof StockUse>;

export const StockMove = z.object({
  productId: Id,
  toPlaceId: Id,
  /** Defaults to everything (in the from place, if given). */
  quantity: z.number().positive().optional(),
  fromPlaceId: Id.optional(),
  /**
   * "temporary": it's out of place for now and should go back (drill taken to the kitchen).
   * "permanent": its usual place changes.
   */
  mode: z.enum(['temporary', 'permanent']).default('temporary'),
});
export type StockMove = z.input<typeof StockMove>;

export const StockReturn = z.object({
  productId: Id,
  entryId: Id.optional(),
});
export type StockReturn = z.input<typeof StockReturn>;

export const StockEntryPatch = z.object({
  quantity: z.number().min(0).optional(),
  expiresOn: IsoDate.nullable().optional(),
  placeId: Id.nullable().optional(),
  currentPlaceId: Id.nullable().optional(),
  charge: Charge.nullable().optional(),
});
export type StockEntryPatch = z.input<typeof StockEntryPatch>;

export const StockExpect = z.object({
  productId: Id,
  quantity: z.number().positive(),
  source: ExpectedInfo.shape.source,
  reference: z.string().max(80).nullable().optional(),
  eta: IsoDate.nullable().optional(),
  placeId: Id.nullable().optional(),
});
export type StockExpect = z.input<typeof StockExpect>;

export const StockArrive = z
  .object({
    /** Everything from this delivery, e.g. "Tesco delivery". */
    source: z.string().optional(),
    /** Or specific expected entries. */
    entryIds: z.array(Id).optional(),
    /** Or this much of one product (e.g. scanning items as you unpack). */
    productId: Id.optional(),
    quantity: z.number().positive().optional(),
  })
  .refine((v) => v.source || v.entryIds?.length || v.productId, 'Say which delivery, entries or product arrived');
export type StockArrive = z.input<typeof StockArrive>;

export const StockCharge = z.object({
  productId: Id,
  quantity: z.number().positive(),
});
export type StockCharge = z.input<typeof StockCharge>;

export const PurchaseItem = z.object({
  productId: Id,
  quantity: z.number().positive(),
  placeId: Id.nullable().optional(),
  /** Price paid for the whole line, in the household currency. */
  price: z.number().min(0).optional(),
});
export const Purchase = z.object({
  shopId: Id.nullable().optional(),
  items: z.array(PurchaseItem).min(1),
});
export type Purchase = z.input<typeof Purchase>;

export const Remember = z
  .object({
    barcode: z.string().min(1).max(64),
    /** Add the barcode to this existing product… */
    productId: Id.optional(),
    /** …or create a new product. */
    create: ProductCreate.optional(),
    /** Brand or pack name for the new variant, e.g. "Aldi chopped tomatoes 400 g". */
    variantName: z.string().min(1).max(160).optional(),
    imageUrl: z.string().max(2000).nullable().optional(),
    source: z.string().max(60).optional(),
  })
  .refine((v) => v.productId || v.create, 'Choose an existing product or describe a new one');
export type Remember = z.input<typeof Remember>;
