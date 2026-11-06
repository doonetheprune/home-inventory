# Unit pricing

Keeps each item's **usual price per unit** and checks whether a different pack is better value. Prices can be per item (a roll, a bag, a tin), or by weight or volume (per 100 g, per kg, per 100 ml, per litre).

- **Data:** `product.fields.pricing` → `{ usualUnitPrice, priceUnit, basedOn, updatedAt, itemSize, showPer, measures }`.
  - `usualUnitPrice` is per `priceUnit`, which is normally the item's own unit. It's only a weight or volume when that was given for an item of unknown size.
  - `itemSize` is how much one of the item holds (`{ amount: 200, unit: 'g' }` for a 200 g bag). It's needed to go between per item and per weight. Things counted in g, kg, ml or l don't need it.
  - `measures` are other measures of one of the item, `{ unit, amount, price }`: at most one weight or volume (g, kg, ml or l, kept in step with `itemSize`, which older records have alone) and any other ways of counting it ("1 pack = 5 items" is `{ unit: 'item', amount: 5 }`). `price` is the usual price per one `unit` when it's bought that way, or null to work it out from the usual price. A pack checked in a measure with a price is compared with that price.
  - `showPer` is the unit the price card shows: `"100g"`, `"kg"`, `"100ml"`, `"l"` or the item's own unit. It defaults to the item's own unit, or per 100 g / 100 ml for things counted in g or ml.
- **Units** (`units.ts`): one place for conversions. `priceFactor(from, to, itemUnit, itemSize, counts)` (counts: the other ways of counting it; units with nothing in common go through the item's own unit) turns a price per one unit into a price per another, or returns null when they can't be compared, with `whyNot` saying why in words. Unit names are forgiving: "100 g", "per kg", "Litres", "bags".
- **Routes** (under `/api/v1/modules/pricing`):
  - `POST /check` `{ productId, quantity, unit?, price }` → the pack's price and the usual one in the shown unit, a verdict (`cheaper`, `dearer`, `same`, `no_usual_price`) and a sentence to read out. Within 2% counts as the same. A shelf price "£3.50/kg" is `{ quantity: 1, unit: 'kg', price: 3.5 }`.
  - `GET /view/:productId` → what the price card shows: the usual price in each unit it can be shown in, and which need the item's size first.
  - `PUT /display` `{ productId, showPer?, itemSize? }` chooses the shown unit and records the size.
  - `PUT /usual` `{ productId, unitPrice, unit? }` or `{ productId, quantity, unit?, price }` sets the usual price.
  - `PUT /measures` `{ productId, measures: [{ unit, amount, price? }] }` replaces the measures (the view lists each with its price, recorded or worked out).
  - `GET /history/:productId` lists prices paid.
- **Events:** listens to `shopping.purchased`. When a price is given at the till it is recorded, and the first one becomes the usual price.
- **Collections:** `prices` (one document per price paid).
- **AI tools:**
  - `check_price` and `set_usual_price` take the pack's unit.
  - `convert_price` gives "£3.50 a kg is £0.35 per 100 g" (with an item, between its own unit and a weight).
  - `set_item_size` records "1 bag = 200 g".
  - `get_price` gives the usual price in every unit, and the measures with theirs.
  - `set_measure` records one measure (with its price if given); `remove_measure` forgets one.
- **Demo:** usual prices for toilet roll, baby spinach (with its 200 g size) and mature cheddar.
- **UI:**
  - A price panel on the product page shows the usual price with a choice of unit, the item's measures (add and remove them, each with a price), and a pack checker that takes a size and unit.
  - The same checker appears on the shopping list.
- **Example** (with the card showing per 100 g): "Spinach is £4.40 a kg at Aldi, is that good?" → `check_price { item: 'spinach', quantity: 1, unit: 'kg', price: 4.4 }` → "That's £0.44 per 100 g against the usual £0.55: 20% cheaper, saving about £1.10 on this pack."
