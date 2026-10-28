# Unit pricing

Keeps each item's **usual price per unit** (per roll, per kg, per litre) and checks whether a different pack is better value.

- **Data:** `product.fields.pricing` → `{ usualUnitPrice, priceUnit, basedOn, updatedAt }`. `priceUnit` defaults to the product's unit.
- **Routes** (under `/api/v1/modules/pricing`):
  - `POST /check` `{ productId, quantity, price }` → unit price, usual price, verdict (`cheaper`, `dearer`, `same`, `no_usual_price`) and a sentence to read out. Within 2% counts as the same.
  - `PUT /usual` `{ productId, unitPrice }` or `{ productId, quantity, price }` sets the usual price.
  - `GET /history/:productId` lists prices paid.
- **Events:** listens to `shopping.purchased`. When a price is given at the till it is recorded, and the first one becomes the usual price.
- **Collections:** `prices` (one document per price paid).
- **UI:** a price panel on the product page and a "Spotted a different pack?" checker on the shopping list.
- **Example:** "I found 24 rolls for £8 at Aldi, is it cheaper than normal?" → `POST /check { quantity: 24, price: 8 }` → "That's £0.333 a roll against the usual £0.361: 8% cheaper, saving about £0.67 on this pack."
