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
| `ctx.core` | Call the public core API: `products`, `stock`, `places`, `shops`, `categories`, `shopping`, `search`, `lookup`, `home`, `resolve` (find things by name or code), `automation`, `nfc`, `settings`, `history`, `today()`, `now()` |
| `ctx.addRoute({ method, path, summary, body?, query?, params?, response?, handler })` | Add an HTTP route at `/api/v1/modules/<id><path>`. Zod schemas validate it and it appears in the OpenAPI spec. Returns 404 while the module is off |
| `ctx.on(type, handler)` | React to events. `type` can end in `*` (`'stock.*'`). Only runs while the module is on. Errors are logged, never thrown at the core |
| `ctx.collection<T>(name)` | Your own JSON documents: `get`, `list`, `put`, `remove`. Stored as `<id>:<name>` by whichever storage adapter is in use |
| `ctx.addLookupProvider({ id, name, lookup })` | Answer unknown barcodes (asked in `modules/index.ts` order, 4 second timeout each, results cached). Return `imageUrl` as an https address: when the barcode is saved, Larder downloads that photo into its own files |
| `ctx.addSearchSection({ id, title, order, documents?, results })` | Add a section to search everywhere. `documents()` feeds the shared fuzzy index (types must start with your section id); `results()` turns hits into rows. Core orders: stock 10, shopping 20, places 30, wish list 50, shops 60. Scenarios will use 40 and recipes 70 |
| `ctx.config` | Settings from `LARDER_MODULE_<ID>_<KEY>` environment variables (keys lower-cased) |
| `ctx.isEnabled()` | Whether the module is on right now |
| `ctx.addSensor({ id, name, description, icon?, unit?, read })` | A sensor for Home Assistant (and MQTT). `id` is snake_case and starts with your module id (`batteries_low` for `batteries`). `read()` returns `{ state, attributes? }`; keep attributes small. The integration creates the entity without any change on its side. Hidden while the module is off |
| `ctx.addAction({ id, name, description, input, run })` | An action for Home Assistant and Node-RED (`larder.<id>`). `input` is a `z.object` with snake_case fields and `.describe()`d fields (shown in Home Assistant). `run(input, { userId })` returns `{ message, ... }`. Use `ctx.core.resolve.product(name)` to accept names. Same id rule as sensors; run `npm run ha:services` afterwards |
| `ctx.addTool({ name, title, description, input, readOnly?, destructive?, run })` | A tool for AI assistants over MCP. Name it plainly (`check_price`): names are shared with the core and must be unique. Describe when to use it in a sentence (small models rely on it), take names via `ctx.core.resolve`, and return `{ text, data? }` with short readable text. Set `destructive` when it takes away or overwrites (clients may ask first). Hidden while the module is off |
| `ctx.core.resolve.among(what, ref, list)` | Find one of your own things (`{ name }`) by name with the core's strict rules: exact, or every word; anything looser is a "did you mean" error, never a guess |
| `ctx.core.products.updateField(id, key, change)` | Change your field on a product (`product.fields[key]`) from its current value. Use it rather than reading then `update`-ing, so two changes at once both count. `change` must not call Larder |
| `ctx.publish(type, data)` | Publish your own event, e.g. `batteries.low`. The type must start with your module id and a dot. It reaches the web app, other modules and Home Assistant (as `larder_batteries_low`) |
| `ctx.log.info/warn/error` | Log with the module's name |

### Events

| Event | Data |
|---|---|
| `stock.changed` | `{ productId, name, kind, inStock, expected, unit, low }` (`kind`: add, use, flat, charged, move, return, adjust, remove, expect, arrive, renew) |
| `stock.low` / `stock.restocked` | Same as above, when a product crosses its minimum |
| `product.created` / `product.updated` / `product.deleted` | `{ id, name }` |
| `place.changed`, `shop.changed`, `category.changed` | `{ id }` |
| `shopping.purchased` | `{ shopId, items: [{ productId, quantity, price? }] }` |
| `stock.expiring` / `stock.expired` | `{ productId, name, expiresOn, daysToExpiry, category, place }`, once per batch when it enters its warning window and on the day it expires (checked hourly) |
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
  pages: [
    { path: '/', title: 'My feature', icon: 'box', component: MyPage },        // linked from More and the sidebar (Organise)
    { path: '/print', title: 'My sheets', section: 'print', component: Sheets }, // under Print in the sidebar
    { path: '/:id', title: 'One thing', component: Detail },                   // params: useModuleParams().id; not linked
    { path: '/new', title: 'New thing', hidden: true, component: Editor },     // not linked
  ],
});
```

Every `modules/*/web.tsx` is picked up at build time and shown only while the module is on. Pages live at `/m/<module id><path>`. The SDK gives you the API client (`api.modules.call(id, method, path, body)`), `useAction` (runs a change, shows errors, refreshes data), UI pieces (`Header`, `Empty`, `Stepper`, `Sheet`, `Seg`, `Switch`, `Pill`, `Icon`, `PlaceSelect`, `Link`…), formatting (`money`, `qty`, `plural`, dates), and for printables `QrCode` (a crisp SVG QR code) and `PrintSetup` (A4 with your margins; only the element with class `print-area` prints, across as many pages as it needs). Use the app's CSS classes (`card pad`, `list`, `item`, `btn`, `chip`, `label`, `field`, `input`, `stats`/`stat`, `cols-2` for two columns on wide screens, `paper` and `paper-wrap` for a print preview).

## Example data

`demo(ctx, seed)` on the module definition adds the module's part of the example household (`LARDER_DEMO`), after the core's. `seed.products` and `seed.places` map names (and place codes) to ids, so `seed.products['Head torch']` is the head torch. Scenarios and recipes use it.

## Packages

Modules use `@larder/core`, `@larder/web-sdk`, zod and React. If a module really needs a third-party package (a protocol client, say), add it to `package.json`, list it for that module in `MODULE_PACKAGES` in `tests/architecture.test.ts`, and say so in the module's SPEC.md. The MQTT module uses `mqtt` this way.

## Tests

Put `*.test.ts` next to the module. `makeCore({ modules: [myModule] })` from `tests/helpers.ts` gives you a full core on in-memory storage. Call routes through `core.modules.routes()` or test through the HTTP API with `tests/api/helpers.ts`.

## Existing modules

| Module | What it does |
|---|---|
| `lookup-openfoodfacts`, `lookup-openbeautyfacts`, `lookup-openproductsfacts` | Name, brand and photo for unknown barcodes |
| `pricing` | Usual price per unit, "is this pack cheaper?", prices paid at the till |
| `batteries` | Links battery products to Home Assistant devices; says swap, charge or buy when one is low |
| `scenarios` | Lists for situations (Power cut, Christmas): every item, how many and where, printable |
| `printing` | QR label sheets for places and items (Avery L7160, L7163, L7651, plain A4) |
| `recipes` | Saved recipes, what's missing, and taking ingredients out of stock after cooking once confirmed |
| `mqtt` | Publishes stock, sensors and events to an MQTT broker (off by default) |
| `_template` | Example to copy (off by default) |
