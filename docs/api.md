# REST API

Everything the web app does goes through the REST API, so integrations can do it too. The full spec is in [openapi.json](openapi.json) and browsable on a running Larder at `/api/docs`.

## Basics

- Base path: `/api/v1`.
- Authentication: `Authorization: Bearer <token>` (Settings → Access tokens). The web app uses a session cookie and must also send `X-Larder-Client`.
- Errors: `{ "error": "<code>", "message": "<sentence for people>" }` with a 4xx status. Validation errors also list `issues`.
- Dates are `YYYY-MM-DD`; timestamps are UTC ISO strings. Quantities are numbers in the product's unit.

## The calls you'll use most

| Call | Does |
|---|---|
| `GET /search?q=loo` | Search everything; results in sections (stock, shopping, places, wish, shops, plus modules) |
| `GET /home` | Use soon, running low, out of place, pending orders, deliveries, which shop to go to |
| `GET /products?status=low` | Products with stock summaries (`all`, `low`, `expiring`, `out_of_place`, `expected`, `wish`, `in_stock`, `to_tidy`: owned items with stock that has no place, or no category) |
| `GET /products/{id}` | One product: stock by place, brands and barcodes, shops, history |
| `POST /products` | New product `{ name, aliases, categoryId, unit, pack, usage, minQuantity, shelfLifeDays, preferredShopIds, defaultPlaceId, wish }`. `unit` is the single thing that's used (`tea bag`); `pack: { name: "box", holds: 20 }` is what it's bought in; `usage: { amount: 1, everyDays: 1, auto }` is how fast it's used, in `unit` (`auto`: Larder takes that many out of stock each period by itself, checked hourly, from `inUseSince`). With a usage, summaries say `inUseUntil`, `runsOutOn` and `daysToRunOut`. Low is below `minQuantity` only (`status.runningOut` is always false since 0.9.0) |
| `POST /stock/add` | `{ productId, quantity, unit?, placeId?, expiresOn? }`. `unit` is the item's own or its pack's name: 1 `box` of 20 adds 20 |
| `POST /stock/use` | `{ productId, quantity, unit?, placeId?, open? }` (soonest-expiring first; rechargeables go flat). `open` sets `inUseSince` to today (one open, or a new one started now); with a usage Larder doesn't take out, every use does. With one Larder takes out, a plain use is an extra and leaves `inUseSince` alone, unless none is started (`inUseSince` null), when it starts one |
| `POST /products/{id}/finished` | The open one is finished (or the one in use stopped): `inUseSince` is cleared |
| `POST /products/{id}/recount` | `{ unit: "tea bag", holds: 20, pack? }` count what's inside: the old unit becomes the pack, and stock, orders' prices, the minimum, stock-up amount and usage are rescaled (2 boxes become 40 tea bags). Modules get `product.recounted` |
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
