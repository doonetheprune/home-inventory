# Template

A minimal module to copy. It counts stock changes while it's switched on.

- **Hooks used:** `on('stock.changed')`, `collection('counts')`, `addRoute`.
- **Route:** `GET /api/v1/modules/template/count` → `{ count }`.
- **Default:** off.

Every module should have a SPEC.md like this one: what it does, which hooks it uses, its routes, data and settings.
