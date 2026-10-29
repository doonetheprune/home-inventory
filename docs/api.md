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
| `GET /home` | Use soon, running low, out of place, deliveries, which shop to go to |
| `GET /products?status=low` | Products with stock summaries (`all`, `low`, `expiring`, `out_of_place`, `expected`, `wish`, `in_stock`) |
| `GET /products/{id}` | One product: stock by place, brands and barcodes, shops, history |
| `POST /products` | New product `{ name, aliases, categoryId, unit, minQuantity, shelfLifeDays, preferredShopIds, defaultPlaceId, wish }` |
| `POST /stock/add` | `{ productId, quantity, placeId?, expiresOn? }` |
| `POST /stock/use` | `{ productId, quantity, placeId? }` (soonest-expiring first; rechargeables go flat) |
| `POST /stock/move` | `{ productId, toPlaceId, mode: "temporary" \| "permanent", quantity? }` |
| `POST /stock/return` | `{ productId }` puts out-of-place stock back |
| `POST /stock/expect` | `{ productId, quantity, source: "Tesco delivery", eta? }` ordered, not arrived |
| `POST /stock/arrive` | `{ source }` or `{ productId, quantity }` the delivery arrived |
| `GET /shopping` | Count per shop and the suggested shop |
| `GET /shopping/{shopId}` | That shop's list, grouped by category |
| `POST /shopping/purchase` | `{ shopId, items: [{ productId, quantity, price? }] }` bought: adds to stock |
| `GET /identify?code=…` | What a barcode, QR label, place code or NFC tag is |
| `POST /identify/remember` | Name an unknown barcode once |
| `GET /places/tree`, `GET /places/{id}` | Places with counts; what's in one |
| `POST /places/grid` | `{ parentId, name, prefix: "G", rows: 4, columns: 6 }` → G1-1 … G4-6 |
| `POST /modules/pricing/check` | `{ productId, quantity, price }` → is this pack cheaper than usual? |
| `GET /events` | Live change events (Server-Sent Events) |

## Example

```bash
TOKEN=lrd_...
curl -s -H "Authorization: Bearer $TOKEN" "https://larder.example.com/api/v1/search?q=bog%20roll"
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"productId":"<id>","quantity":1}' https://larder.example.com/api/v1/stock/use
```
