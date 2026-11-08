# Unit pricing

Keeps each item's **usual price per unit** and checks whether a different pack is better value. Prices can be per item (a roll, a bag, a tea bag), per its pack (a box of 80, from the item's **Comes in**), or by weight or volume (per 100 g, per kg, per 100 ml, per litre).

- **Data:** `product.fields.pricing` → `{ usualUnitPrice, priceUnit, basedOn, updatedAt, itemSize, showPer }`.
  - `usualUnitPrice` is per `priceUnit`, which is normally the item's own unit. It's only a weight or volume when that was given for an item of unknown size.
  - `itemSize` moved to the item in 0.10.0 (core `product.size`, "Weighs" on its Edit page), so how fast it's used can be said by weight too. When the module starts it moves any it kept to the item and clears its own; until then it's read from here. It's needed to go between per item and per weight. Things counted in g, kg, ml or l don't need it.
  - 0.8.2's `measures` are dropped when the module starts (0.9.0): "1 pack = 5 items" is now the item's pack in the core (counted in items, comes in packs of 5), and the weight was always `itemSize` too. The log names each item that had a count measure.
  - `showPer` is the unit the price card shows: `"100g"`, `"kg"`, `"100ml"`, `"l"`, the item's own unit or its pack. It defaults to the item's own unit, or per 100 g / 100 ml for things counted in g or ml.
- **Units** (`units.ts`): one place for conversions. `priceFactor(from, to, itemUnit, itemSize, pack)` (pack: the item's `product.pack`, so a box is so many of its own unit) turns a price per one unit into a price per another, or returns null when they can't be compared, with `whyNot` saying why in words. Unit names are forgiving: "100 g", "per kg", "Litres", "bags", "teabags" (`unitKey` compares them; `unitName` says them, "tea bag").
- **Routes** (under `/api/v1/modules/pricing`):
  - `POST /check` `{ productId, quantity, unit?, price }` → the pack's price and the usual one in the shown unit, a verdict (`cheaper`, `dearer`, `same`, `no_usual_price`) and a sentence to read out. Within 2% counts as the same. A shelf price "£3.50/kg" is `{ quantity: 1, unit: 'kg', price: 3.5 }`.
  - `GET /view/:productId` → what the price card shows: the usual price in each unit it can be shown in, and which need the item's size first.
  - `PUT /display` `{ productId, showPer?, itemSize? }` chooses the shown unit and records the size (on the item).
  - `PUT /usual` `{ productId, unitPrice, unit? }` or `{ productId, quantity, unit?, price }` sets the usual price.
  - `GET /history/:productId` lists prices paid.
- **Events:** listens to `shopping.purchased`. When a price is given at the till it is recorded, and the first one becomes the usual price. On `product.recounted` (2 boxes became 40 tea bags) it divides the usual price (when it was per the old unit) and the prices paid by how many a box holds (the core divides the size of one), and multiplies the quantities paid for.
- **Collections:** `prices` (one document per price paid).
- **AI tools:**
  - `check_price` and `set_usual_price` take the pack's unit.
  - `convert_price` gives "£3.50 a kg is £0.35 per 100 g" (with an item, between its own unit and a weight).
  - `set_item_size` is a core tool since 0.10.0, as the size is the item's.
  - `get_price` gives the usual price in every unit it can be shown in.
- **Demo:** usual prices for toilet roll, baby spinach (with its 200 g size) and mature cheddar.
- **UI:**
  - A price panel on the product page shows the usual price with a choice of unit, the weight of one ("One bag holds 200 g · Change"), and a pack checker that takes a size and unit.
  - The same checker appears on the shopping list.
- **Example** (with the card showing per 100 g): "Spinach is £4.40 a kg at Aldi, is that good?" → `check_price { item: 'spinach', quantity: 1, unit: 'kg', price: 4.4 }` → "That's £0.44 per 100 g against the usual £0.55: 20% cheaper, saving about £1.10 on this pack."
