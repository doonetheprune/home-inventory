# Open Beauty Facts lookup

Looks up barcodes that aren't in Larder yet in [Open Beauty Facts](https://world.openbeautyfacts.org), a free, open database of toiletries and cosmetics.

- **Hook used:** `addLookupProvider`.
- **When it runs:** only when a scanned barcode matches nothing in Larder. Answers (and misses) are cached, so each barcode is looked up once.
- **Settings:** `LARDER_MODULE_LOOKUP_OPENBEAUTYFACTS_URL` changes the server (default `https://world.openbeautyfacts.org`).
- **Privacy:** sends only the barcode.
- **Order:** providers are asked in the order they appear in `modules/index.ts`.
