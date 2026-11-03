# Open Food Facts lookup

Looks up barcodes that aren't in Larder yet in [Open Food Facts](https://world.openfoodfacts.org), a free, open database of food and drink.

- **Hook used:** `addLookupProvider`.
- **When it runs:** when a barcode matches nothing in Larder (scanned, or given to Claude's `add_item`). Answers (and misses) are cached, so each barcode is looked up once. When Claude adds an item with a brand and there's no barcode photo, it also searches [Open Food Facts' search](https://search.openfoodfacts.org) for a photo of that brand's product.
- **Settings:** `LARDER_MODULE_LOOKUP_OPENFOODFACTS_URL` changes the server (default `https://world.openfoodfacts.org`); `LARDER_MODULE_LOOKUP_OPENFOODFACTS_SEARCH_URL` the search server (default `https://search.openfoodfacts.org`).
- **Privacy:** sends only the barcode, or for a search the item's name and brand.
- **Order:** providers are asked in the order they appear in `modules/index.ts`.
