# REST API

Everything the web app does goes through the REST API, so integrations can do it too. The full spec is in [openapi.json](openapi.json) and browsable on a running Larder at `/api/docs`.

## Basics

- Base path: `/api/v1`.
- Authentication: `Authorization: Bearer <token>` (Settings → Access tokens). The web app uses a session cookie and must also send `X-Larder-Client`.
- Errors: `{ "error": "<code>", "message": "<sentence for people>" }` with a 4xx status. Validation errors also list `issues`.
- Dates are `YYYY-MM-DD`; timestamps are UTC ISO strings. Quantities are numbers in what the product is bought in (`unit`).

## The calls you'll use most

| Call | Does |
|---|---|
| `GET /search?q=loo` | Search everything; results in sections (stock, shopping, places, wish, shops, plus modules) |
| `GET /home` | Use soon, running low, out of place, pending orders, deliveries, which shop to go to |
| `GET /products?status=low` | Products with stock summaries (`all`, `low`, `expiring`, `out_of_place`, `expected`, `wish`, `in_stock`, `to_tidy`: owned items with stock that has no place, or no category, and items with `needsCheck`) |
| `GET /products/{id}` | One product: stock by place, brands and barcodes, shops, history |
| `POST /products` | New product `{ name, aliases, categoryId, unit, contents, weight, usage, minQuantity, shelfLifeDays, preferredShopIds, defaultPlaceId, wish }`. `unit` is what it's **bought in**, a key from the unit list (`GET /units`): `box`, `jar`, `each`, or `g` or `ml` for things bought loose (kg and L are turned into g and ml, with the numbers given alongside). Stock, `minQuantity`, `stockUpTo`, orders and history are all in it. `contents: { amount: 20, unit: "tea bag" }` is what one **contains**, a count from the list or an amount (`{ amount: 400, unit: "g" }`); none for things bought loose. `weight: { amount: 30, unit: "g" }` is what one weighs, in g (or holds, in ml), worked out from `contents` when that's an amount, so it can only be given for other things. `usage: { amount: 1, everyDays: 1, auto, unit }` is how fast it's used, kept as said: `unit` null for what it's bought in, what one contains (`"tea bag"`), or a weight or volume once it has a Weight (`{ amount: 4, everyDays: 1, unit: "g" }` for 4 g a day from jars containing 400 g) (`auto`: Larder takes that much out of stock each period by itself, a little at a time, checked hourly, from `inUseSince`). A unit that isn't on the list is refused. `needsCheck` is why Larder wants someone to look at it since the units changed (the item is on `to_tidy`); `PATCH` it to `null` once it looks right. With a usage, summaries say `inUseUntil`, `runsOutOn` and `daysToRunOut`. Low is below `minQuantity` only (`status.runningOut` is always false since 0.9.0) |
| `GET /units` | The unit list: Larder's own and the household's, each `{ key, one, many, kind: "count" \| "weight" \| "volume", factor, builtIn }`. `POST /units` `{ one: "sleeve", many: "sleeves" }` adds a count word; `DELETE /units/{key}` removes one the household added that no item uses |
| `POST /stock/add` | `{ productId, quantity, unit?, placeId?, expiresOn? }`. `quantity` is in what it's bought in, or in `unit`: what one contains (5 `tea bag` of a box containing 20 adds 0.25 box), or a weight or volume through its Weight (100 `g` of a jar containing 400 g) |
| `POST /stock/use` | `{ productId, quantity, unit?, placeId?, open? }` (soonest-expiring first; rechargeables go flat). `open` sets `inUseSince` to today (one open, or a new one started now); with a usage Larder doesn't take out, every use does (except one by weight, where a use is just a use). With one Larder takes out, a plain use is an extra and leaves `inUseSince` alone, unless none is started (`inUseSince` null), when it starts one |
| `POST /products/{id}/finished` | The open one is finished (or the one in use stopped): `inUseSince` is cleared |
| `POST /stock/move` | `{ productId, toPlaceId, mode: "temporary" \| "permanent", quantity? }` |
| `POST /stock/return` | `{ productId }` puts out-of-place stock back |
| `POST /stock/expect` | `{ productId, quantity, unit?, source: "Tesco delivery", eta?, price? }` ordered, not arrived. `price` is the line's, kept with the purchase when it arrives |
| `POST /stock/arrive` | `{ source }` or `{ productId, quantity }` the delivery arrived |
| `GET /shopping` | Count per shop and the suggested shop |
| `GET /shopping/{shopId}` | That shop's list, grouped by category |
| `POST /shopping/purchase` | `{ shopId, items: [{ productId, quantity, price?, placeId?, expiresOn?, variantId? }], evidence? }` bought: adds to stock. `evidence` (a receipt's photo id, source, order number, bought on…) goes to the purchase history |
| `GET /identify?code=…` | What a barcode, QR label, place code or NFC tag is |
| `POST /identify/remember` | Name an unknown barcode once |
| `GET /places/tree`, `GET /places/{id}` | Places with counts; what's in one |
| `POST /places/grid` | `{ parentId, name, prefix: "G", rows: 4, columns: 6 }` → G1-1 … G4-6 |
| `GET /places/to-sort` | Stock with no place yet, by item ("To sort"). Put it away with `POST /stock/move` and `fromPlaceId: null` |
| `POST /modules/pricing/check` | `{ productId, quantity, price }` → is this pack cheaper than usual? |
| `GET /events` | Live change events (Server-Sent Events) |

## Example

```bash
TOKEN=lrd_...
curl -s -H "Authorization: Bearer $TOKEN" "https://larder.example.com/api/v1/search?q=bog%20roll"
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"productId":"<id>","quantity":1}' https://larder.example.com/api/v1/stock/use
```
