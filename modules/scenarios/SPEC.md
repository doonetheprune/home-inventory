# Scenarios

Lists for situations: **Power cut**, **Christmas**, **Snowed in**, **Dog sitter**. A scenario is a tag on products, wish list items included, with no target quantities: each item's own minimum already says when it's low.

- **Data:** scenarios in the `scenarios` collection: `{ id, name, icon, notes, createdAt, updatedAt }`. Membership is on each product: `product.fields.scenarios` (an array of scenario ids), so deleting an item takes it out of every scenario.
- **Routes** (under `/api/v1/modules/scenarios`):
  - `GET /` lists scenarios with counts (items, places, low, wish).
  - `POST /` `{ name, icon?, notes? }` makes one. Names are unique (renaming too). Tagging an item changes only its `scenarios` field, through `core.products.updateField`, so taps at the same moment both count.
  - `GET /:id` returns the detail: items grouped by **where they are now** (out-of-place stock shows where it is, marked as visiting), with quantities. Rechargeables say "6 charged, 4 flat"; low items say "Min 3 canisters". Items with none in the house are under `missing`, and wish list items under `wish`.
  - `PATCH /:id`, `DELETE /:id` (untags its items), `PUT /:id/items` `{ productId, included }`.
- **Search:** a "Scenarios" section (order 40) matching names, notes and the items in them.
- **AI tools:** `list_scenarios`, `get_scenario` `{ scenario }` (plain text by place).
- **Demo:** "Power cut" and "Snowed in" in the example household.
- **UI:** the scenario list; a scenario page like the mock-up (stats, places in two columns on wide screens, wish list); a printable page (A4, grouped by place, tick boxes, optional place photos); and a Scenarios panel on product pages to tick which scenarios an item is in.
