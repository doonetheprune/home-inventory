# Modules

Everything that isn't the stable core is a module: barcode lookup providers, pricing, and later scenarios, printing, recipes, battery linking, MQTT. A module:

- lives in its own folder under `modules/` with a `SPEC.md` and tests;
- uses only `@larder/core` (types, schemas, `defineModule`) and the context it's given;
- can be switched on and off in Settings → Modules (or forced off with `LARDER_MODULES_DISABLED`);
- keeps its data in its own collections or in `product.fields[moduleId]`, so it works with any storage adapter.

Start from `modules/_template` (step-by-step in [AGENTS.md](../AGENTS.md#adding-a-feature-module-step-by-step)).

## Server side: `index.ts`

```ts
import { z } from 'zod';
import { defineModule } from '@larder/core';

export default defineModule({
  id: 'my-feature',              // same as the folder name
  name: 'My feature',
  description: 'One sentence shown in Settings.',
  version: '1.0.0',
  defaultEnabled: true,
  productFields: z.object({ ... }),   // optional: data in product.fields['my-feature']
  setup(ctx) { ... },
});
```

### The context (`ctx`)

| Hook | Use it to |
|---|---|
| `ctx.core` | Call the public core API: `products`, `stock`, `places`, `shops`, `categories`, `shopping`, `search`, `lookup` (including `savePhotoFromLink(url, label)`, which saves a picture from a public https address as a Larder photo, and `forgetPhoto(fileId)`, which deletes one that no item, brand or place uses), `home`, `resolve` (find things by name or code), `products.brandNames()` (every item's brand and pack names, by item id), `automation`, `nfc`, `settings`, `history` (`recent()`, and `product(id)` for one item's stock changes), `today()`, `now()`. Before fetching an address someone gave, check it with `publicWebAddress(url)` from `@larder/core` (https, a real domain, not the home network) |
| `ctx.addRoute({ method, path, summary, body?, query?, params?, response?, admin?, handler })` | Add an HTTP route at `/api/v1/modules/<id><path>`. Zod schemas validate it and it appears in the OpenAPI spec. Returns 404 while the module is off. `admin: true` limits it to household admins (403 for members), for routes that change settings or another system such as Home Assistant |
| `ctx.on(type, handler)` | React to events. `type` can end in `*` (`'stock.*'`). Only runs while the module is on. Errors are logged, never thrown at the core |
| `ctx.collection<T>(name)` | Your own JSON documents: `get`, `list`, `put`, `remove`. Stored as `<id>:<name>` by whichever storage adapter is in use |
| `ctx.addLookupProvider({ id, name, lookup })` | Answer unknown barcodes (asked in `modules/index.ts` order, 4 second timeout each, results cached). Return `imageUrl` as an https address: when the barcode is saved, Larder downloads that photo into its own files. Optionally add `search({ name, brand })`, returning products of that brand (`{ name, brands, quantityText, imageUrl }`, best first), to find a photo for an item added by name and brand; Larder checks the brand and name again before using one |
| `ctx.addSearchSection({ id, title, order, documents?, results })` | Add a section to search everywhere. `documents()` feeds the shared fuzzy index (types must start with your section id); `results()` turns hits into rows. Core orders: stock 10, shopping 20, places 30, wish list 50, shops 60. Scenarios will use 40 and recipes 70 |
| `ctx.fetch` | Reach web services (maps, lookups). Use it rather than the global `fetch`, so tests can stand in for the internet |
| `ctx.core.homeAssistant` | Home Assistant, when Larder can reach it (the add-on always can; elsewhere `LARDER_HA_URL` and `LARDER_HA_TOKEN`), else `null`: home location, people and their phones, saving zones and automations, and running an action (`callService`, e.g. a wake-on-LAN packet). See `HomeAssistantPort` in `src/core/ports.ts`, and the shop locations and online shopping modules |
| `ctx.config` | Settings from `LARDER_MODULE_<ID>_<KEY>` environment variables (keys lower-cased) |
| `ctx.isEnabled()` | Whether the module is on right now |
| `ctx.addSensor({ id, name, description, icon?, unit?, read })` | A sensor for Home Assistant (and MQTT). `id` is snake_case and starts with your module id (`batteries_low` for `batteries`). `read()` returns `{ state, attributes? }`; keep attributes small. The integration creates the entity without any change on its side. Hidden while the module is off |
| `ctx.addAction({ id, name, description, input, run })` | An action for Home Assistant and Node-RED (`larder.<id>`). `input` is a `z.object` with snake_case fields and `.describe()`d fields (shown in Home Assistant). `run(input, { userId })` returns `{ message, ... }`. Use `ctx.core.resolve.product(name)` to accept names. Same id rule as sensors; run `npm run ha:services` afterwards |
| `ctx.addTool({ name, title, description, input, readOnly?, destructive?, run })` | A tool for AI assistants over MCP. Name it plainly (`check_price`): names are shared with the core and must be unique. Describe when to use it in a sentence (small models rely on it), take names via `ctx.core.resolve`, and return `{ text, data? }` with short readable text. Set `destructive` when it takes away or overwrites (clients may ask first). Hidden while the module is off |
| `ctx.core.resolve.among(what, ref, list)` | Find one of your own things (`{ name }`) by name with the core's strict rules: exact, or every word; anything looser is a "did you mean" error, never a guess |
| `ctx.core.products.updateField(id, key, change)` | Change your field on a product (`product.fields[key]`) from its current value. Use it rather than reading then `update`-ing, so two changes at once both count. `change` must not call Larder |
| `ctx.publish(type, data)` | Publish your own event, e.g. `batteries.low`. The type must start with your module id and a dot. It reaches the web app, other modules and Home Assistant (as `larder_batteries_low`) |
| `ctx.offer(name, value)`, `ctx.offered<T>(fullName)` | Offer a function (or an object of them) to other modules, and use one another module offers, without either importing the other. `offer("order-reader", reader)` in the `ai` module is `offered("ai.order-reader")` elsewhere: undefined while that module is off, so check. Describe the shape in `modules/_shared`. Ask for it when it's needed, not in `setup` (modules set up in turn). The email module reads order confirmations this way |
| `ctx.addOfflinePaths(() => paths)` | Put your pages in offline copies (the copy of Larder a phone keeps to look at with no connection). Return the paths of your GET routes the web module reads, e.g. `['/', '/abc', '/?productId=abc']`; asked each time a copy is saved, only while the module is on. Each is answered as the person saving it, and ones that answer with an error are left out. Then set `offline: true` on the web module. Scenarios and recipes do this |
| `ctx.log.info/warn/error` | Log with the module's name |

### Events

| Event | Data |
|---|---|
| `stock.changed` | `{ productId, name, kind, inStock, expected, unit, low }` (`kind`: add, use, flat, charged, move, return, adjust, remove, expect, arrive, renew, finish) |
| `stock.arrived` | `{ items: [{ productId, name, unit, quantity, source, reference, orderedOn, price }] }`: ordered stock arrived, with its order and (when the order said) its price |
| `stock.low` / `stock.restocked` | Same as above, when a product crosses its minimum |
| `product.created` / `product.updated` / `product.deleted` | `{ id, name }` |
| `place.changed`, `shop.changed`, `category.changed` | `{ id }` |
| `shopping.purchased` | `{ shopId, items: [{ productId, quantity, price? }], evidence }`: `evidence` is how it was bought (`PurchaseEvidence`: receipt photo, source, order number, ordered on, bought on, note) or null |
| `stock.expiring` / `stock.expired` | `{ productId, name, expiresOn, daysToExpiry, category, place }`, once per batch when it enters its warning window and on the day it expires (checked hourly) |
| `product.recounted` | `{ productId, name, from, to, factor }`: the item is now counted in what's inside (`from` box, `to` tea bag, `factor` 20). Core has multiplied its stock, minimum, stock-up amount and usage; rescale your own quantities (×) and prices (÷), as pricing, purchases, online shopping, recipes and the AI module's learnt receipt names do |
| `nfc.scanned` | `{ tagId, device, kind, id, name, path }` |
| `settings.changed` | what changed |
| `<module>.*` | anything a module publishes, e.g. `batteries.low` |

## Web side: `web.tsx` (optional)

```tsx
import { defineWebModule, api, useAction } from '@larder/web-sdk';

export default defineWebModule({
  id: 'my-feature',
  productPanels: [MyPanel],      // shown on product pages: ({ product }) => JSX
  shoppingPanels: [MyListPanel], // shown beside a shop's list: ({ list }) => JSX
  shopPanels: [MyShopPanel],     // inside each shop's card on the Shops page: ({ shop }) => JSX
  panels: [{ slot: 'scenarios.scenario', component: MyScenarioPanel }], // on another module's page: ({ id }) => JSX
  pages: [
    { path: '/', title: 'My feature', icon: 'box', component: MyPage },        // linked from More and the sidebar (Organise)
    { path: '/print', title: 'My sheets', section: 'print', component: Sheets }, // under Print in the sidebar
    { path: '/:id', title: 'One thing', component: Detail },                   // params: useModuleParams().id; not linked
    { path: '/new', title: 'New thing', hidden: true, component: Editor },     // not linked
  ],
  addActions: [{ path: '/photo', title: 'Add by photo', subtitle: 'Snap the pack', icon: 'camera', useShown: () => true }],
  settingsPanels: [MySettings],  // a section in Settings: ({ admin }) => JSX
  wishListPanels: [Waiting],     // at the top of the Wish list: () => JSX
  photoReader: { status, read }, // lets the scanner name things from a photo (the ai module)
  offline: true,                 // still shown in a saved copy (see ctx.addOfflinePaths)
});
```

- `addActions` are more ways to add things, shown beside Add by name: on Home on a phone, in the sidebar on a big screen. `path` is one of your pages; `useShown` is a hook that can hide the action (until the module is set up, say).
- `wishListPanels` are shown at the top of the Wish list (e.g. how many shared links are in Pending).
- A page with `section: 'wishlist'` is linked right after the Wish list, in the sidebar and in More.
- `settingsPanels` are sections in Settings, after Modules, while the module is on. `admin` says whether this person may change settings; make the routes behind them `admin: true` too.
- `useAddItem()` opens the Add item page filled in for the person to check and save: `addItem({ name, aliases, categoryId, unit, shelfLifeDays, preferredShopIds, brand, barcode, photo, source, note })`. On saving, `photo` (a `Blob`) becomes the item's photo, and `brand` and `barcode` its first brand. The draft stays on the phone until then. `photoFileId` uses a photo already in Larder's files instead (a shared page's picture); `links`, `notes` and `defaultPlaceId` fill in more of the form; `onSaved(productId)` runs once the item is made (e.g. to take it out of Pending).
- `photoReader` lets the scanner name things from a photo of the pack: `status()` says whether it's set up and who reads (`{ ready, by: 'Claude' }`); `read(photo)` answers a `PhotoReading` (name, brand, unit, categoryId, shelfLifeDays, aliases, shop, by, notes, and the smaller `photo` it sent, to keep). The scanner shows **Take photo** in Add mode while one is ready; `usePhotoReader()` gets it from any page. The ai module offers one.
- `offline: true` keeps the module's pages and panels while a saved copy is open (no connection). Without it they're hidden then. Set it only when everything they read is saved with `ctx.addOfflinePaths`, or they hide themselves when a read fails (a read that isn't in the copy fails with a 404, `not_saved`). Changes always fail in a copy (`read_only`), with a message saying so.
- `readBarcode(photo)` reads a product barcode from a photo on the phone (null if there isn't one).
- `useCamera(videoRef, active)` shows the back camera in a `<video>` (`state`: off, starting, on, error, with a message to show); `grabFrame(video)` takes what it sees as a JPEG; `rotatePhoto(photo)` turns a photo a quarter turn.

Every `modules/*/web.tsx` is picked up at build time and shown only while the module is on. Pages live at `/m/<module id><path>`. The SDK gives you the API client (`api.modules.call(id, method, path, body)`), `useAction` (runs a change, shows errors, refreshes data), UI pieces (`Header`, `Empty`, `Stepper`, `Sheet`, `Seg`, `Switch`, `Pill`, `Icon`, `PlaceSelect`, `Link`…), formatting (`money`, `qty`, `plural`, dates), and for printables `QrCode` (a crisp SVG QR code) and `PrintSetup` (A4 with your margins; only the element with class `print-area` prints, across as many pages as it needs). 

**Panels on another module's page.** A module page can offer a slot by rendering `<ModulePanels slot="<its module id>.<page>" id={…} />`; any switched-on module adds to it with `panels`, getting the id of what the page shows. Neither module imports the other, and nothing shows when the other is off. `useModuleEnabled(id)` says whether a module is on, e.g. to offer a choice that needs it. Slots offered now: `scenarios.scenario` (a scenario's page, with its id; recipes uses it) and `sharing.pending` (the Pending page, with an empty id; online shopping shows shop favourites there).

Use the app's CSS classes (`card pad`, `list`, `item`, `btn`, `chip`, `label`, `field`, `input`, `stats`/`stat`, `cols-2` for two columns on wide screens, `paper` and `paper-wrap` for a print preview).

## Example data

`demo(ctx, seed)` on the module definition adds the module's part of the example household (`LARDER_DEMO`), after the core's. `seed.products` and `seed.places` map names (and place codes) to ids, so `seed.products['Head torch']` is the head torch. Scenarios and recipes use it.

## Packages

Modules use `@larder/core`, `@larder/web-sdk`, zod and React. If a module really needs a third-party package (a protocol client, say), add it to `package.json`, list it for that module in `MODULE_PACKAGES` in `tests/architecture.test.ts`, and say so in the module's SPEC.md. The MQTT module uses `mqtt` this way.

## Tests

Put `*.test.ts` next to the module. `makeCore({ modules: [myModule] })` from `tests/helpers.ts` gives you a full core on in-memory storage. Call routes through `core.modules.routes()` or test through the HTTP API with `tests/api/helpers.ts`.

## Existing modules

| Module | What it does |
|---|---|
| `lookup-openfoodfacts`, `lookup-openbeautyfacts`, `lookup-openproductsfacts` | Name, brand and photo for unknown barcodes (Open Food Facts also finds a photo for a brand added by name) |
| `pricing` | Usual price per unit (shown per its pack or by weight too), "is this pack cheaper?", prices paid at the till, and the weight or volume of one |
| `purchases` | Every purchase with its price, shop and evidence (the receipt's photo, or the online order), and what was spent by shop, item and month |
| `batteries` | Links battery products to Home Assistant devices; says swap, charge or buy when one is low |
| `scenarios` | Lists for situations (Power cut, Christmas): every item, how many and where, printable |
| `printing` | QR label sheets for places and items (Avery L7160, L7163, L7651, plain A4) |
| `recipes` | Saved recipes, what's missing, scaling by ingredient ratios and named presets, and taking ingredients out of stock after cooking once confirmed |
| `mqtt` | Publishes stock, sensors and events to an MQTT broker (off by default) |
| `ai` | Add by photo: Claude or Gemini, with the household's own key, reads the pack and fills in Add item |
| `sharing` | Links shared to the Home Assistant app from a phone wait in Pending, named from the page with its picture and price, to go on the wish list or into Larder |
| `online-shopping` | Fills an online basket (Tesco first) from what's low or on offer through a shopping provider on the network, books delivery slots, and brings shop favourites into Pending |
| `email` | Reads shops' order emails from Gmail (read-only, the household's own Google Cloud client, signed in through Home Assistant): order confirmations, read by the AI module, put what's coming on its way; delivered emails mark it arrived. Checks often after an order and around a delivery |
| `_template` | Example to copy (off by default) |
