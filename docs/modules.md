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
| `ctx.addLookupProvider({ id, name, lookup })` | Answer unknown barcodes (asked in `modules/index.ts` order, 4 second timeout each, results cached) |
| `ctx.addSearchSection({ id, title, order, documents?, results })` | Add a section to search everywhere. `documents()` feeds the shared fuzzy index (types must start with your section id); `results()` turns hits into rows. Core orders: stock 10, shopping 20, places 30, wish list 50, shops 60. Scenarios will use 40 and recipes 70 |
| `ctx.config` | Settings from `LARDER_MODULE_<ID>_<KEY>` environment variables (keys lower-cased) |
| `ctx.isEnabled()` | Whether the module is on right now |
| `ctx.addSensor({ id, name, description, icon?, unit?, read })` | A sensor for Home Assistant (and MQTT). `id` is snake_case and starts with your module id (`batteries_low` for `batteries`). `read()` returns `{ state, attributes? }`; keep attributes small. The integration creates the entity without any change on its side. Hidden while the module is off |
| `ctx.addAction({ id, name, description, input, run })` | An action for Home Assistant and Node-RED (`larder.<id>`). `input` is a `z.object` with snake_case fields and `.describe()`d fields (shown in Home Assistant). `run(input, { userId })` returns `{ message, ... }`. Use `ctx.core.resolve.product(name)` to accept names. Same id rule as sensors; run `npm run ha:services` afterwards |
| `ctx.addTool({ name, title, description, input, readOnly?, run })` | A tool for AI assistants over MCP. Name it plainly (`check_price`): names are shared with the core and must be unique. Describe when to use it in a sentence (small models rely on it), take names via `ctx.core.resolve`, and return `{ text, data? }` with short readable text. Hidden while the module is off |
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
  pages: [{ path: '/', title: 'My feature', icon: 'box', component: MyPage }], // linked from More and the sidebar
});
```

Every `modules/*/web.tsx` is picked up at build time and shown only while the module is on. The SDK gives you the API client (`api.modules.call(id, method, path, body)`), `useAction` (runs a change, shows errors, refreshes data), UI pieces (`Stepper`, `Sheet`, `Seg`, `Switch`, `Pill`, `Icon`, `PlaceSelect`…) and formatting (`money`, `qty`, `plural`, dates). Use the app's CSS classes (`card pad`, `list`, `item`, `btn`, `chip`, `label`, `field`, `input`).

## Tests

Put `*.test.ts` next to the module. `makeCore({ modules: [myModule] })` from `tests/helpers.ts` gives you a full core on in-memory storage. Call routes through `core.modules.routes()` or test through the HTTP API with `tests/api/helpers.ts`.

## Existing modules

| Module | What it does |
|---|---|
| `lookup-openfoodfacts`, `lookup-openbeautyfacts`, `lookup-openproductsfacts` | Name, brand and photo for unknown barcodes |
| `pricing` | Usual price per unit, "is this pack cheaper?", prices paid at the till |
| `batteries` | Links battery products to Home Assistant devices; says swap, charge or buy when one is low |
| `_template` | Example to copy (off by default) |
