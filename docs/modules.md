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
| `ctx.core` | Call the public core API: `products`, `stock`, `places`, `shops`, `categories`, `shopping`, `search`, `lookup`, `home`, `settings`, `history`, `today()`, `now()` |
| `ctx.addRoute({ method, path, summary, body?, query?, params?, response?, handler })` | Add an HTTP route at `/api/v1/modules/<id><path>`. Zod schemas validate it and it appears in the OpenAPI spec. Returns 404 while the module is off |
| `ctx.on(type, handler)` | React to events. `type` can end in `*` (`'stock.*'`). Only runs while the module is on. Errors are logged, never thrown at the core |
| `ctx.collection<T>(name)` | Your own JSON documents: `get`, `list`, `put`, `remove`. Stored as `<id>:<name>` by whichever storage adapter is in use |
| `ctx.addLookupProvider({ id, name, lookup })` | Answer unknown barcodes (asked in `modules/index.ts` order, 4 second timeout each, results cached) |
| `ctx.addSearchSection({ id, title, order, documents?, results })` | Add a section to search everywhere. `documents()` feeds the shared fuzzy index (types must start with your section id); `results()` turns hits into rows. Core orders: stock 10, shopping 20, places 30, wish list 50, shops 60. Scenarios will use 40 and recipes 70 |
| `ctx.config` | Settings from `LARDER_MODULE_<ID>_<KEY>` environment variables (keys lower-cased) |
| `ctx.isEnabled()` | Whether the module is on right now |
| `ctx.log.info/warn/error` | Log with the module's name |

### Events

| Event | Data |
|---|---|
| `stock.changed` | `{ productId, name, kind, inStock, expected, unit, low }` (`kind`: add, use, flat, charged, move, return, adjust, remove, expect, arrive, renew) |
| `stock.low` / `stock.restocked` | Same as above, when a product crosses its minimum |
| `product.created` / `product.updated` / `product.deleted` | `{ id, name }` |
| `place.changed`, `shop.changed`, `category.changed` | `{ id }` |
| `shopping.purchased` | `{ shopId, items: [{ productId, quantity, price? }] }` |
| `settings.changed` | what changed |

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
| `_template` | Example to copy (off by default) |
