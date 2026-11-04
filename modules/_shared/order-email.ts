/**
 * Reading a shop's order confirmation email. The AI module offers a reader as
 * "ai.order-reader" (ctx.offer) and the email module uses it (ctx.offered), so
 * neither module imports the other. Only the shapes live here.
 */

/** An order confirmation, as the email module found it. */
export interface OrderEmail {
  /** The household's shop it's from (the email rule that matched it says which). */
  shopId: string | null;
  shopName: string;
  subject: string;
  /** The email as plain text. */
  text: string;
  /** When it was sent (ISO). */
  sentAt: string;
}

export interface OrderEmailLine {
  /** The line as the email words it. */
  text: string;
  /** How many were ordered. */
  count: number;
  /** The household's item, or null when none is. */
  item: { id: string; name: string; unit: string } | null;
  /** How much of the item's unit it is in all (two 9-roll packs: 18 rolls). */
  quantity: number;
  /** learnt: matched the same way before at this shop. sure / guess: the AI's match. none: not an item in Larder. */
  match: 'learnt' | 'sure' | 'guess' | 'none';
  /** coming (a substitute too), or unavailable (it won't come). */
  status: 'coming' | 'unavailable';
  /** When this line comes, as YYYY-MM-DD, when it isn't with the rest of the order. */
  date: string | null;
  /** The price for the line, when the email gives one. */
  price: number | null;
}

export interface OrderEmailReading {
  /** False when it isn't an order the AI could read. */
  readable: boolean;
  /** The order number. */
  reference: string | null;
  /** When the order comes: YYYY-MM-DD, and HH:MM from and to when the email gives a slot. */
  delivery: { date: string | null; from: string | null; to: string | null };
  lines: OrderEmailLine[];
  /** Which AI read it. */
  provider: string;
  model: string;
}

export interface OrderReader {
  /** Whether an AI is switched on with a key, so emails can be read. */
  ready(): Promise<boolean>;
  read(email: OrderEmail): Promise<OrderEmailReading>;
  /** Remember that this line at this shop is this item, `each` of its unit for each one ordered (as a receipt match is). */
  remember(shopId: string | null, text: string, productId: string, each: number): Promise<void>;
}
