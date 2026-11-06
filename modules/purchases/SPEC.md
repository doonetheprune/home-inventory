# Purchase history

Keeps every purchase: what was bought, how many, what it cost, at which shop, and the evidence. The evidence is the receipt's photo, or the online order (its number and the day it was ordered). It reports what was spent, in all, by shop, by item and by month.

- **Where purchases come from:** the core's events, so every way of buying is covered, whichever module or screen it came through.
  - `shopping.purchased`: ticked off a shopping list, added from a receipt (the `ai` module, with the photo and the receipt's date), or added on an item's page with a price, shop or receipt photo. The event's `evidence` (`PurchaseEvidence` in the core: `receiptFileId`, `source`, `reference`, `orderedOn`, `boughtOn`, `note`) is kept as it is.
  - `stock.arrived`: an order arrived (marked arrived by hand, or by the `email` module's delivered emails). Each line has the order's source, number, the day it was ordered and, when the order said, its price (`stock.expect` takes `price` for the line and keeps it per one, so part-deliveries get their share).
- **Data:** the `purchases` collection, one `PurchaseRecord` per item per purchase:
  - `productId`, and `name` and `unit` as they were then.
  - `quantity` in the item's unit.
  - `price` for the line, or null; `currency`.
  - `shopId` and `shop`. An order's shop is matched from its source: "Tesco delivery" is Tesco.
  - `how`: `shop`, `receipt` or `order`.
  - `on`: the day bought (a receipt's date, or the day it arrived), and `at`: when it was recorded.
  - `evidence`.
- **Routes** (under `/api/v1/modules/purchases`):
  - `GET /item/:productId`: one item's purchases, newest first.
  - `GET /list?from&to&productId&shopId`: purchases, newest first.
  - `GET /report?from&to&productId&shopId`: `{ total, count, unpriced, byShop, byItem, byMonth }`. Only purchases with a price count towards totals.
  - `PATCH /:id`: correct `price`, `quantity`, `shopId`, `on`, or add to `evidence` (e.g. the receipt's photo, taken later).
  - `DELETE /:id`: remove a purchase recorded by mistake. Neither changes stock.
- **Sensor:** `purchases_this_month`, what was spent since the 1st, with the shops.
- **AI tools:**
  - `purchase_history`: an item's, a shop's or a period's purchases, with the evidence.
  - `spending`: totals for a period (default this month) by shop, item and month.
  - `change_purchase`: correct an item's latest purchase, or the one on a day.
  - `remove_purchase`: take one out of the history.
  - The core's `add_stock` takes `price` and `shop`, and `add_expected` takes `price`, so assistants' purchases are kept too. `add_receipt` (ai) takes the receipt's `date`.
- **UI:**
  - **Bought** on each item's page: the last five purchases, with the receipt's photo or the order. Tap one to correct it, add the receipt's photo, or remove it.
  - The **Purchases** page (More, and the sidebar): what was spent this month, last month, this year or ever, by shop, by item and by month, and every purchase.
- **Demo:** a few purchases of the example household's things: at a shop, from a receipt, and from Tesco and Amazon orders.
