# Unit pricing

Keeps each item's **usual price per unit** and checks whether a different pack is better value. Prices can be per what the item is **bought in** (a box, a bag, a roll), per what one **contains** when that's a count (a tea bag, from a box containing 80), or by weight or volume (per 100 g, per kg, per 100 ml, per litre) through the item's **Weight**.

- **Data:** `product.fields.pricing` → `{ usualUnitPrice, priceUnit, basedOn, updatedAt, showPer }`.
  - `usualUnitPrice` is per `priceUnit`, which is normally null: per one of what the item is bought in. It's only a weight or volume when that was given for an item with no Weight yet.
  - `itemSize` (the weight of one, kept here before 0.10.0) is the item's **Weight** since 0.10.0 (core `product.weight`, in g or ml), so the converter, how fast it's used and recipes use it too. When the module starts it moves any it kept to the item (unless the item already has one) and clears its own, before the core's upgrade to 0.10.0's units runs.
  - 0.8.2's `measures` are dropped when the module starts (0.9.0): "1 pack = 5 items" became the item's pack in the core, and since 0.10.0 it's bought in packs, containing 5 pieces. The weight was always `itemSize` too. The log names each item that had a count measure.
  - `showPer` is the unit the price card shows: `"100g"`, `"kg"`, `"100ml"`, `"l"`, what it's bought in or what one contains. It defaults to what it's bought in, or per 100 g / 100 ml for things bought loose in g or ml.
- **Units** (`units.ts`): price units only. Every conversion goes through the core's converter (`toBoughtIn`), which reads what it's bought in, Contains when that's a count, and the Weight for any g or ml. The only words kept here are the price labels ("100 g", "kg", "100 ml", "litre", each so many of a core unit) and the words for one of it on a price ("each", "an item"). `priceFactor(units, item, from, to)` turns a price per one unit into a price per another and throws, saying why, when they can't be compared; `factorOrNull` gives null instead (the price card shows that it needs a Weight). Unit names are forgiving because the core's list is: "100 g", "per kg", "Litres", "bags", "teabags".
- **Routes** (under `/api/v1/modules/pricing`):
  - `POST /check` `{ productId, quantity, unit?, price }` → the pack's price and the usual one in the shown unit, a verdict (`cheaper`, `dearer`, `same`, `no_usual_price`) and a sentence to read out. Within 2% counts as the same. A shelf price "£3.50/kg" is `{ quantity: 1, unit: 'kg', price: 3.5 }`.
  - `GET /view/:productId` → what the price card shows: the usual price in each unit it can be shown in, the item's `weight`, whether it can be changed here (`weightEditable`: not when it's worked out from Contains, or for things bought loose), and which units need a Weight first.
  - `PUT /display` `{ productId, showPer?, weight? }` chooses the shown unit and sets the item's Weight (`itemSize` is still read, for older apps). The product service checks it, so it's refused when Contains is an amount or the item is bought loose.
  - `PUT /usual` `{ productId, unitPrice, unit? }` or `{ productId, quantity, unit?, price }` sets the usual price.
  - `GET /history/:productId` lists prices paid.
- **Events:** listens to `shopping.purchased`. When a price is given at the till it is recorded, and the first one becomes the usual price. On `product.recounted` (the upgrade to 0.10.0: kg to g with factor 1000, or bought in tea bags turned round into boxes containing 20 with factor 1/20) it divides the usual price (when it was per the old unit) and the prices paid by the factor, and multiplies the quantities paid for.
- **Collections:** `prices` (one document per price paid).
- **AI tools:**
  - `check_price` and `set_usual_price` take the pack's unit: what it's bought in, what one contains, or a weight or volume.
  - `convert_price` gives "£3.50 a kg is £0.35 per 100 g" (with an item, between what it's bought in or contains and a weight, through its Weight).
  - `get_price` gives the usual price in every unit it can be shown in (per box, per tea bag, per 100 g…).
  - The Weight is set with the core's `change_item` (`weight`); 0.10.0 as first built had `set_item_size`, which is gone.
- **Demo:** usual prices for toilet roll, baby spinach (bought in bags containing 200 g, so by weight too) and mature cheddar (bought loose, in g).
- **UI:**
  - A price panel on the product page shows the usual price with a choice of unit, the Weight of one ("One bag weighs 200 g, from what it contains", or "· Change" when it can be set here), and a pack checker that takes a size and unit.
  - The same checker appears on the shopping list.
- **Example** (with the card showing per 100 g): "Spinach is £4.40 a kg at Aldi, is that good?" → `check_price { item: 'spinach', quantity: 1, unit: 'kg', price: 4.4 }` → "That's £0.44 per 100 g against the usual £0.55: 20% cheaper, saving about £1.10 on this pack."
