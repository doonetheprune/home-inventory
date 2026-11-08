# Plan: Bought in, Contains, Weight (0.10.0)

Agreed with the owner on 8 November 2026. This file is the source of truth for the work: where the code or older docs disagree with it, this wins. Read `AGENTS.md` first. If the code contradicts this plan, or it doesn't cover a case, ask the owner rather than guessing.

## Why

Two chats in the Claude app, through the Larder connector, showed that the unit model is too complicated:

- Asked to record that a box of Twinings Sleep holds 20 tea bags, the assistant followed 0.9.0's rule ("count the single thing that's used") and counted 80 tea bags. The owner wanted to keep counting boxes, so the assistant undid it and wrote "20 tea bags per box" in the notes. It never got as far as how many are used a day.
- Asked to set a 400 g jar of decaf to "four grams a day", it could only set "1 jar every 100 days". A usage had to be in what the item is counted in, and the jar's weight was only on the price card.

0.10.0 as first built (PR #36, held, never released) added a weight and a usage unit on top of that. An item now has four overlapping ideas (Counted in, Comes in, Weighs, a usage unit), plus "count them again", which rescales stock and makes five modules rescale their own numbers. Unit words and conversions live in six places. This plan replaces all of it with three clear ideas.

## The model

| Idea | Meaning | App | Assistants | Code |
|---|---|---|---|---|
| **Bought in** | What you buy and count it in, from the unit list: bag, box, jar, roll, each… or, for things bought loose, g or ml. Stock, minimums, stock-up amounts, orders and history are always in this. | **Bought in** | `bought_in` | `product.unit` |
| **Contains** | What one holds, as printed on the pack. Optional. Either a number of something from the list (a box contains 20 tea bags, a roll contains 200 sheets) or an amount by weight or volume (a bag contains 1 kg, a bottle contains 4 pints). | **Each box contains** | `contains: { amount, unit }` | `product.contents` |
| **Weight** | How much one weighs in grams, or holds in millilitres for liquids. Optional, and can be given for anything (a box of Sleep weighs 30 g). Filled in from Contains when Contains is an amount. **The only thing used for any sum in g or ml.** | **Weight** | `weight: { amount, unit }` | `product.weight` |
| **We use** | How fast it goes: in what it's bought in, in what it contains (when that's a count), or in any weight or volume once it has a Weight. Kept as said. | **We use** | `uses: { amount, every_days, unit }` | `product.usage` |
| **Unit list** | The long, fixed list of unit words. Each is a count (bag, tea bag), a weight (g, kg) or a volume (ml, L, pint), with its singular and plural. The household can add count words. There is never a free-text "other". | Settings → **Units** | `list_units`, `add_unit` | `units.ts` |

Examples:

| Item | Bought in | Contains | Weight | Shows as |
|---|---|---|---|---|
| Sugar | bag | 1 kg | 1000 g (from Contains) | 2 bags |
| Decaf | jar | 400 g | 400 g (from Contains) | about ¾ jar |
| Twinings Sleep | box | 20 tea bags | 30 g, if given | 4 boxes |
| Whole milk | bottle | 4 pints | 2273 ml (from Contains) | 2 bottles |
| Toilet roll | roll | 200 sheets | none | 9 rolls |
| Loose cheddar | g | none | none | 350 g |
| Cordless drill | each | none | 1600 g, if given | 1 |

### What the owner decided

Quote these in `docs/DECISIONS.md`.

1. **Stock is counted in what you buy.** Using one at a time out of a pack isn't a feature: "it would be up to the user and how they create them". Toilet rolls are bought in rolls, containing 200 sheets.
   - The daily counter can take out part of a box.
   - A count can be corrected in what it contains ("I've got 3 boxes left and I've used 5 from the box"), "only to readjust the daily counter".
2. **One size per item:** "you tend to just buy one size of something". There are no sizes per brand or barcode. A different size is adjusted by hand, or kept as its own item.
3. **No multipacks:** a 6-pack of beans is 6 tins added.
4. **Weight** "should always be the size in grams. So even if I say it's a kilogram, it always goes back down to grams" (millilitres for liquids).
   - It's "never mandatory, but could always be filled in, even for sleep tea bags".
   - It is "the only column used for calculations": recipes, prices per 100 g or per kg, usage by weight.
   - "If we get the code to look at all three columns in those scenarios, we'll have major tech debt."
5. **Units** come from "a fixed list, but it needs to be an extensive list and we should never have other, but we should have the ability to add a new [unit]. That also needs to be on the MCP."
6. **Moving old data over** doesn't have to be perfect, "as long as they're cleanly flagged in the interface" so the owner can fix them.
7. **The word is "Bought in".** "Bought from" would mean the shop.

## Rules for the code

These keep the model from turning into debt again. Check every change against them.

1. **Only `src/core/services/units.ts` knows about units:** the list, singulars and plurals, kinds, factors to g and ml, and the converter. No other file in the core, the modules, the server or the app has a unit table, unit aliases or a guess at plurals. The app imports the same functions from `@larder/core` (`src/web/vite.config.ts` already aliases it to the core's source).
2. **Only the converter turns an amount into what the item is bought in.** Everything calls it: stock, usage, shopping, recipes, prices, online shopping, receipts, order emails, assistants, Home Assistant actions and the app.
3. **The converter has three cases, and each reads one field.** Anything else is an error that says what the item can be given in.
   1. In what it's bought in: as it is.
   2. In what it contains, when Contains is a count (tea bags): divided by `contents.amount`.
   3. In g, kg, ml, L or pint: converted to g or ml, then through `weight` only. A weight asked of something with a volume, or the other way round, can't be done.

   **Nothing reads `contents` to get grams or millilitres**, even when it says 1 kg.
4. **`weight` is written in one place, the product service.**
   - When Contains is an amount, the Weight comes from it, always, so the two can't disagree. A Weight given alongside a Contains amount is refused.
   - When Contains stops being an amount, the Weight it set is cleared.
   - Otherwise the Weight is as given.
   - It's always stored as g or ml: 1 kg is stored as 1000 g, and 4 pints as 2273 ml.
   - Things bought in g or ml have no `weight`.
5. **Things bought loose are stored in g or ml**, never kg or L. kg and L are only for showing ("1.6 kg") and for typing.
6. **A usage is stored as said** (an amount and a unit key) and converted when it's used.
7. **Unit words are stored as keys from the list** (the singular in lower case, e.g. `tea bag`), never as typed text.

## The unit list

- **Built in**, in `units.ts`, each with its singular, plural and kind. Start from this and extend it; the owner wants it extensive.
  - **Count:**
    - `each`, shown as a bare number ("3").
    - bag, bar, battery, block, bottle, box, bucket, bulb, bunch, can, capsule, carton, cartridge, case, crate, cylinder.
    - filter, jar, jug, lens, loaf, log, metre, nappy, net, pack, packet, pad, pair, piece, pod, portion, pot, pouch, punnet.
    - refill, reel, roll, sachet, sack, sensor, set, sheet, slice, spray, stick, tablet, tea bag, tin, tray, tub, tube, wipe.
  - **Weight:** g (what's stored) and kg (1000 g).
  - **Volume:** ml (what's stored), L (1000 ml) and pint (568.261 ml).
- **Household additions:**
  - Count words only, kept under their own settings key (`ctx.storage.settings` with key `units`, as `instanceId` is), so the storage port and the household settings form don't change.
  - A word that clashes with a built-in one is refused.
  - One can be removed only when no item's Bought in, Contains or usage uses it.
- **API:** `GET /api/v1/units` (built-in and household), `POST /api/v1/units` and `DELETE /api/v1/units/{key}`.
- **Assistants:**
  - `list_units`, `add_unit` and `remove_unit`.
  - `add_unit` only after the person agrees, as with `new_shop` on `add_item`.
  - Every tool that takes a unit refuses one that isn't on the list: `Larder doesn't have the unit "sleeve". Ask whether to add it (add_unit), then try again.`
- **App:**
  - Settings → Units lists them, and adds one (singular and plural).
  - The pickers for Bought in and Contains show the list with a search box, and "Add a unit" opens the same small form.

## Starting point: PR #36

Work on a new branch taken from `used-by-weight` (PR #36). It's 0.10.0 and was never released, so its fields need no upgrade path. From it:

- **Keep:**
  - The weight on the item, and the pricing module's start-up move of its `itemSize` onto the item. Rename `size` to `weight` and store only g or ml.
  - Usage by weight, with Larder taking a little out each day and `periodsPerTake` rounding.
  - A plain Use of something used by weight takes a whole one and doesn't start a period.
  - The input-shaped patch type on `products.update`.
- **Replace** with the unit list and converter: `size` (g, kg, ml or l), `usage.unit` limited to measures, `measurePerOne`, `ownUsage`, `measureText` and `oneLastsText`.
- **Remove:**
  - `set_item_size`, which #36 moved into the core. Weight is set with `change_item`.
  - The Weighs row and the g choice in We use as built; they're rebuilt in the new form.
  - 0.9.2's `assertPackFits` and the "keep the boxes" replies in `change_item`, since Comes in is gone.

## Data model changes

These are in `src/core/model.ts` and `src/core/inputs.ts`.

- **`product.unit`** keeps its name, because it's still what stock is counted in, but is now a key from the unit list. It's validated on every write. Old values that aren't on the list are kept and flagged (see the upgrade).
- **`product.contents`**, new: `{ amount, unit } | null`.
  - `unit` is a count key other than `each` and other than `product.unit`, or a weight or volume key.
  - Not allowed when the item is bought in g or ml.
- **`product.weight`**: `{ amount, unit: "g" | "ml" } | null`. It replaces #36's `product.size`.
- **`product.usage.unit`**: `string | null`. Null means what it's bought in; otherwise it's the Contains count key, or a weight or volume key. Validated against the converter's three cases.
- **`product.needsCheck`**, new: `string | null`, why the upgrade wants the owner to look at the item. Cleared when the item is saved from Edit, or with "Looks right".
- **`product.pack`**: removed. The upgrade moves it into Bought in and Contains.
- **`ShoppingItem.packs`**: always null from now on, since the list is already in whole bought-in units. Keep the field until 1.0, as 0.9.0 did with `status.runningOut`.
- **The `Recount` input and `POST /products/{id}/recount`**: removed. Nothing outside the web app calls the route (`custom_components` doesn't). List them under "Changed or gone".

## Upgrading stored data

Extend the start-up upgrade, `products.upgradeStored()` in `src/core/services/products.ts`.
- It must be idempotent: running it twice changes nothing.
- It must run **after `modules.start(core)`** in `src/core/core.ts`. Today it runs before, but it publishes `product.recounted`, and the modules must be listening to rescale their own numbers.
- The pricing module's start-up move of `itemSize` (step 5) must finish first, or read the current product inside the write queue, so a weight can't be rescaled twice or missed.

For each item:

1. **Unit word becomes a key.** Match the list by singular, case and common spellings (`kgs`, `litre`, `pkt`). `each` and an empty unit stay `each`.
2. **kg becomes g, and L or litre becomes ml.**
   - Multiply everything by 1000: stock, orders, minimum, stock-up amount, and the usage when it's in what it's bought in.
   - Publish `product.recounted` with factor 1000, so the modules rescale.
3. **A pack is turned round.** `unit: "tea bag", pack: { name: "box", holds: 20 }` becomes Bought in `box`, Contains `20 tea bag`.
   - Divide by 20 (factor 1/20): stock, orders, minimum and stock-up amount.
   - Multiply `weight` by 20, since it was per tea bag.
   - A usage in tea bags stays "1 tea bag a day", with `usage.unit: "tea bag"`.
   - Publish `product.recounted` with the factor.
   - Set `needsCheck`: `Now counted in boxes of 20 tea bags. If you count them one by one instead, change Bought in and correct the count.`
4. **A unit not on the list** (the owner's milk is in `4 pint bottle`) stays as it is, with `needsCheck` set: `"4 pint bottle" isn't on the unit list. Pick what it's bought in, and what one contains.` The item still works, but editing it requires a listed unit.
5. **Pricing's `itemSize` becomes `weight`** (in g or ml). The pricing module does this at start-up, as #36 does, then clears its own copy.

Flagged items appear:
- in Stock → **To tidy**, with the reason;
- as a banner on the item page, where "Looks right" clears it;
- in `get_item` and `list_items` (`to_tidy`), for assistants.

## What to change

### Core

- **`src/core/services/packs.ts` becomes `units.ts`**, holding:
  - The list: keys, plurals, kinds and factors.
  - The converter. Suggested names are `toBoughtIn(product, amount, unit)` and `fromBoughtIn` (for showing an amount in another unit, e.g. "79 tea bags"). It throws a `ValidationError` that names the units the item can be given in.
  - Text helpers: "4 boxes", "about ¾ jar", "350 g", "1.6 kg", "1 tea bag a day", "a box lasts 20 days".
  - `periodsPerTake`, kept from #36.

  Remove `inOwnUnit`, `measurePerOne`, `ownUsage`, `measureText`, `oneLastsText`, `assertPackFits` and the `MEASURES` set in `src/core/util.ts`. `amount()` uses the list instead.
- **`products.ts`:**
  - Validation of the unit, Contains, Weight (from Contains) and the usage unit.
  - The upgrade and `needsCheck`.
  - `to_tidy` includes flagged items.
- **`stock.ts`:**
  - Every amount goes through the converter.
  - `takeDue` takes the usage converted to what it's bought in: a little at a time, with `periodsPerTake`.
  - `recount` is removed as an operation, keeping a private `rescale` for the upgrade.
- **`world.ts`:** run-out dates through the converter. Partial stock reads "about 3¾ boxes".
- **`shopping.ts`:** buy whole bought-in units (rounded up); `packs` is null.
- **`automation.ts`:** actions take a `unit` (anything the converter accepts), and sensors give the unit's plural.
- **`assistant.ts`, `assistant-manage.ts` and `assistant-browse.ts`:** the tools and instructions below.
- **`src/core/index.ts`:** export the unit list and the converter, for modules and the app.

### Assistant tools

These are in `src/core/services/assistant*.ts`.

- **`add_item` and `change_item`:**
  - `bought_in` replaces `unit`, and `contains` replaces `comes_in`.
  - `weight` replaces #36's `weighs`. It takes g, kg, ml, L or pint, and is stored as g or ml.
  - `uses: { amount, every_days, unit? }` and `takes_out_automatically` stay.
  - Remove `recount`.
  - Changing `bought_in` on an item with stock keeps the numbers, and the reply says so ("2 packs is now 2 rolls: correct the count if that's wrong").
- **Remove `set_item_size`.** Weight is set with `change_item`.
- **New:** `list_units`, `add_unit` and `remove_unit`.
- **Stock tools** (`add_stock`, `use_stock`, `correct_stock`, `add_expected`, `mark_arrived`, `move_item`, `bought` and the rest): `unit` is anything the converter accepts ("2 boxes", "5 tea bags", "100 g").
- **`get_item`:**
  - Text: "Bought in boxes. Each box contains 20 tea bags. Weight: 30 g.", then the usage line ("Uses 1 tea bag a day: a box lasts 20 days. Enough until …").
  - Data: `bought_in`, `contains`, `weight`, `uses` and `needs_check`.
- **`ASSISTANT_INSTRUCTIONS`:** replace the unit sentences with four short ones:
  - Every item is bought in a unit from Larder's list (bag, box, jar, roll, each…), or loose in g or ml, and stock is counted in it.
  - Contains is what one holds, as on the pack: a number of something (a box contains 20 tea bags) or an amount (a bag contains 1 kg).
  - Weight is the grams (or ml) in one. It's set from Contains when that's an amount, can be given for anything, and is the only thing Larder uses to work in g or ml (recipes, prices per kg, usage in grams). Without it Larder can't work in g or ml, and says so.
  - Units must be on the list (`list_units`); if one isn't, ask whether to add it (`add_unit`).

### Modules

- **pricing:**
  - Rebuild the conversions in `units.ts` on the core converter: per bought-in unit, per contained count, and per 100 g, kg, 100 ml or L through Weight.
  - Keep the `PriceView` fields its web panel uses, and add `weight`.
  - Its `product.recounted` handler rescales its prices, and `itemSize` if it's still there.
  - Drop its unit table and aliases, except price-label words ("100g", "per kg"), which must map onto core units.
- **recipes:**
  - Its kitchen measures (tsp, tbsp, cups, oz…) stay, for reading recipes.
  - Turning an ingredient into stock goes through the core converter. A recipe's g or ml needs the item's Weight; without one the ingredient isn't taken out, and it says why.
  - Remove its own count-unit and plural handling where the core list covers it.
- **online-shopping:** remove the `MEASURES` table in `items.ts`. A listing's pack size ("500 g", "4 x 400 g", "9 rolls") becomes how many of what the item is bought in, through the converter.
- **purchases:** unchanged, apart from the upgrade's `product.recounted`.
- **ai:**
  - The barcode and photo reading asks for `bought_in` (from the list, passed in the prompt) and `contains` (`{ amount, unit }`). These replace `unit`, `pack` and `pack_holds`.
  - `size` stays, as printed, for the brand name.
  - Receipt and order-line quantities are in what the item is bought in.
- **email:** an order line's count is in what the item is bought in. Remove the `× pack.holds`.

### The app (`src/web/src`)

- **Edit and Add** (`components/ProductForm.tsx`, `screens/ProductEdit.tsx`, `screens/AddItem.tsx`):
  - **Bought in**: a picker from the list ("What you buy and count it in"), with "Add a unit".
  - **Each [box] contains**: an amount and a unit picker (counts, weights and volumes). Optional. Hint: "What's in one, as on the pack".
  - **Weight**: an amount and g, kg, ml, L or pint. Optional, and hidden when Contains is an amount, since it's filled from that. Hint: "Only needed to work out recipes and prices by weight".
  - **We use**: an amount, then a choice of what it's bought in, what it contains, and g or ml when there's a Weight; every so many days or weeks; Take them out of stock for me; Counting from.
  - Remove Counted in (free text), Comes in, Weighs, and the "Count them as 40 tea bags" dialog.
- **Item page** (`screens/Product.tsx`):
  - Stock is shown in what it's bought in: "4 boxes", "about ¾ jar", "350 g".
  - Details show Bought in, Contains, Weight (only when it was given by hand) and We use.
  - The `needsCheck` banner, with "Looks right".
  - The Use sheet uses whole bought-in units. Correcting a count can be done in what it contains when that's a count ("79 tea bags").
- **Scanner card** (`screens/Scan.tsx`):
  - Bought in as chips: box, bag, jar, bottle, carton, tin, pack, each, and More….
  - Contains filled in from the AI or Open Food Facts ("400 g", "20 tea bags"). That's the owner's "is it a box or a weight?" check.
  - Add adds whole bought-in units.
- **Settings → Units:** the list, and Add.
- **Stock → To tidy:** shows flagged items with their reason.
- **`format.ts`:** remove the unit tables and plural guesses, and use the core's helpers.
- **Shopping list, wish list and search's quick add** (`components/GlobalSearch.tsx`): whole bought-in units, with no pack wording.

### Home Assistant

Actions share the stock tools' inputs, so run `npm run ha:services` afterwards. Sensors that list items give the unit's plural.

### Example household

This is `src/server/demo.ts` and the modules' `demo` hooks. Update every example to the new shape, for example:
- breakfast tea: bought in boxes containing 80 tea bags, 2 tea bags a day, taken out by Larder;
- decaf: jars containing 200 g, 4 g a day;
- baby spinach: bags containing 200 g;
- frozen peas: loose, 1600 g.

## Tests

- **Converter** (`tests/core`):
  - Each of the three cases.
  - kg, L and pint normalised.
  - A weight asked of something with a volume.
  - No Weight.
  - A unit not on the list.
  - Setting Contains to an amount sets the Weight; a Weight alongside it is refused; changing Contains to a count clears the Weight it set.
- **Validation:** the Contains rules, no Weight for items bought in g or ml, and the usage units.
- **Upgrade:**
  - kg to g, and L to ml.
  - A pack turned round, with stock, orders, minimum, usage and weight rescaled, and pricing, purchases, online shopping, recipes and the AI's receipt names rescaled through `product.recounted`.
  - An unlisted unit flagged.
  - Running it twice changes nothing.
- **Daily take-out:** tea bags from boxes of 20 and of 80, and grams from a jar. Keep #36's rounding tests.
- **Assistant tools:**
  - Replay the two owner chats: Sleep in boxes containing 20 tea bags, 1 a day, taken out by Larder; decaf in jars containing 400 g, 4 g a day.
  - Units refused and added, `list_units`, and the instructions.
  - Update the tool lists in `tests/api/mcp.test.ts`.
- **API:** the units routes and product payloads.
- **Modules:** pricing per tea bag and per 100 g; a recipe's 500 ml of milk taken from bottles containing 4 pints; an item without a Weight refused.
- **e2e** (`tests/e2e/smoke.spec.ts`):
  - Rewrite the "counts what is inside a box" and "says what a jar weighs" tests for the new form.
  - The scanner card's Bought in chips.
  - Adding a unit in Settings → Units.
  - A flagged item in To tidy.

## Docs and release notes

- **`docs/DECISIONS.md`:** replace #36's "Used by weight" entry with this design and the owner's decisions above. Mark 0.9.0's "Counted in the single thing that's used", "Several measures of an item" and decision 44 as replaced.
- **Other docs:**
  - `docs/mcp.md`, `docs/api.md` and `docs/modules.md`.
  - `AGENTS.md`: add a rule that units go only through the core's unit list and converter.
  - The SPECs of pricing, recipes, online-shopping, ai and email.
- **`addon/CHANGELOG.md`:** rewrite the 0.10.0 entry for this design (0.10.0 was never released). Under **Changed or gone**:
  - Counted in and Comes in became Bought in and Contains.
  - Counting again is gone.
  - `set_item_size`, `comes_in` and `recount` are gone from assistants.
  - `POST /products/{id}/recount` is gone.
  - What the upgrade converts, and what it flags.
- The version stays 0.10.0, which is already set on the branch.

## Order of work

Commit after each step, with `npm run typecheck && npm test` passing.

1. `units.ts`: the list and the converter, with their tests. Nothing uses them yet.
2. The data model, validation and the upgrade (with the start-up order fixed), with tests.
3. Core services and Home Assistant actions on the converter.
4. Assistant tools and instructions.
5. Modules: pricing, recipes, online-shopping, ai and email.
6. The app: the form, item page, scanner card, Settings → Units, To tidy, and `format.ts` cleared of unit logic.
7. The example household, docs and changelog. Then `npm run openapi`, `npm run ha:services` and `npm run test:e2e`.

## Done when

- A search finds no unit table, unit alias list or plural guess outside `units.ts`. The exceptions are recipes' kitchen measures and pricing's price labels, and both map onto core units.
- Nothing reads `product.contents` for grams or millilitres, and only the converter reads `product.weight`.
- The two owner chats work end to end through the assistant tools, and tests replay them.
- All the checks pass, and a draft PR that replaces #36 is open.

## Don't

- Don't merge, release, or close PR #36: the owner decides.
- Don't add sizes per brand or barcode, multipacks, or a free-text unit.
- Don't keep a compatibility path that reads `pack` or `size` after the upgrade.
