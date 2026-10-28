# Home Inventory – Claude Code Build Prompt

You are building a self-hosted home inventory system for a UK household (two adults, two children, a dog, rural Suffolk). It replaces the Grocy add-on, which is too dated. It must track everything in the house, not just food: groceries, household consumables, pet supplies, tools, fuel, batteries, emergency supplies, and even renewals like house insurance. Read this whole brief before starting. Ask questions when something is unclear rather than guessing.

## Architecture

- **Home Assistant add-on** as the backend and main web interface, served through HA ingress (so it works inside the HA companion app and remotely via Nabu Casa with HTTPS, which makes camera scanning possible).
- **Storage:** SQLite in the add-on's data folder, so HA backups include it. Images are stored on disk alongside it.
- **Custom Home Assistant integration** (installable via HACS) that exposes sensors, actions and events.
- **Mobile:** no native app. The UI must be mobile-first and work well inside the HA companion app (installable as a PWA is a bonus).
- **REST API:** documented (OpenAPI), underneath everything. The UI, integration and MCP all use it.
- **MCP server** built into the add-on, served over HTTP, reachable on the local network and via Nabu Casa. Must work with Claude, and also with other MCP clients (ChatGPT, Gemini CLI, local LLMs via Open WebUI / LM Studio). Keep the tool set small, simple and clearly described so small local models can use it reliably.
- **MQTT:** optional, off by default. When enabled, publish stock changes to MQTT. SQLite remains the source of truth and the custom integration remains the main HA link.

## Core data model

### Products

- Generic products ("milk is milk") with one or more brand/shop variants underneath, each with its own barcode(s); all variants count towards the same stock.
- Multiple names/aliases per product (e.g. "loo roll", "toilet paper", "bog roll") used by search and voice.
- Category.
- Flexible units (count, litres, kg, etc.).
- Optional shelf life in days (e.g. milk = 7). Expiry date is calculated from the date added and can be edited per stock entry. No use-by/best-before distinction and no tracking of opened items.
- Minimum quantity; below this the product is "low".
- Zero, one or more preferred shops. None means it can come from anywhere.
- Notes field (free text, e.g. provider/policy details, who borrowed it).
- Photos (auto-filled from the lookup source where available).
- Links (general URLs, no fixed types).
- Linked identifiers: barcodes, QR codes, NFC tags, and per-shop product codes (e.g. Toolstation or Screwfix item numbers) on each variant, used for reordering and for matching items in order emails.
- Wish list flag: a wish list item is a normal product with zero stock; buying it clears the flag.
- Rechargeable flag (for batteries): stock is split into charged and flat rather than consumed.
- Linked Home Assistant devices (for batteries and similar consumables).

### Stock

- Stock entries per product per location, with quantity and expiry date.
- Each item has a home location and an optional current (temporary) location for things that have been moved, e.g. a tool taken out of the shed. A view lists everything currently away from home.
- Expected stock: items ordered but not yet arrived count towards stock when deciding what's low. When the delivery arrives (scan or tell Claude), expected stock becomes real stock.

### Locations

- Nested hierarchy (e.g. Garage > Chest freezer > Top drawer).
- A product's stock can be split across several locations.
- A guided setup wizard for grid-style storage: e.g. "garage racking, 4 shelves, 6 boxes each" generates short codes like G1-1 to G4-6.
- Photos per location.
- QR labels and NFC tags per location. Scanning a location shows its contents. Fast put-away flow: scan item, then scan location.

### Shops

- Shop list (Tesco, Aldi, Toolstation, etc.).
- Shopping list is driven by the next shop: "I'm going to Aldi" lists everything low that can come from Aldi (Aldi-preferred items plus items with no preference). Items bought are removed so they don't appear at the next shop.
- Unit pricing: each product stores the usual price per unit (e.g. £ per kg, per sheet, per litre). When a different pack size is bought, calculate its unit price so changes in pack size or value are easy to compare. Via MCP, the user can say "I found 24 rolls for £8 at Aldi, is it cheaper than normal?" and Claude compares it with the usual unit price and offers to update the usual price.

### Scenarios

- Tag products into scenarios such as Christmas, Power cut, Emergency food. No target quantities (stock minimums handle that).
- Selecting a scenario lists every item, quantity and location.
- Wish list products can belong to scenarios.
- Generate a printable scenario page grouped by location, with an option for text only or with location photos.

### Renewals

- Recurring things like house insurance, MOT or boiler service are modelled as ordinary products with a shelf life equal to the renewal period. The expiry sensor warns when renewal is due; "restocking" restarts the clock. Notes hold provider/policy details.

### Recipes

- The app does not invent recipes. Claude generates them via MCP using current stock, ideally using up items close to expiry.
- Recipes the user likes are saved in the app so Claude can bring them up again and check what's missing.
- After cooking, ingredient deduction is proposed and only applied once the user confirms (with the ability to adjust quantities).

## Barcode scanning and product lookup

- Phone-camera scanning in the browser, plus USB/Bluetooth scanner support (keyboard-wedge input).
- Pluggable lookup providers, each its own module: Open Food Facts first; Open Beauty Facts / Open Products Facts as further modules; more can be added later (e.g. for DIY items).
- If no provider recognises a barcode, ask the user to name it once and remember it locally. UK supermarket own-label coverage is patchy, so the local database is expected to fill in over time.
- Adding by name (no barcode) must be as easy as scanning, since many items (tools, fuel, batteries) have none.

## Search

Fuzzy search across names, aliases, categories, notes and locations, tolerant of typos.

## Printing

- QR label sheets: pick a location, a storage area or a batch of products and generate a printable page of labelled QR codes with cut lines, with an option to match standard sticky label sheet layouts.
- Scenario pages as described above.

## Home Assistant integration

- **Sensors:** low stock, items expiring soon (including renewals), items away from home location. Sensors only; notifications are left to the user's own automations.
- **Actions:** add stock, use stock, move item, mark arrived, and similar, easy to call from Node-RED.
- **Events:** fired on stock changes, low stock and upcoming expiry so Node-RED can react.
- **NFC:** use HA companion app tag-scanned events to resolve products and locations.
- **Batteries:** link battery types to HA devices. When a device reports low battery, check stock for the right type; for rechargeables, point to a charged spare or prompt to charge; otherwise add to the shopping list.

## MCP tools (keep minimal)

Roughly: search items; get item (stock, locations, expiry); add/use/move stock; add expected stock (used by a separate Claude automation that reads Tesco/Toolstation order emails, so email parsing is NOT part of this app); mark delivery arrived; get shopping list for a shop; list scenarios / get scenario; list expiring items; save/get/list recipes; propose and confirm recipe deductions.

## Future (design for, don't build in v1)

- Offer tracking: per-product target price; when an item is on offer or below target, notify and temporarily raise the quantity to buy. Offer data might come via Tesco promotional emails through the external Claude automation.
- Usage-rate prediction to flag items before they hit the minimum.

## AI-first repo design

The repo is meant to be picked up and customised by anyone's AI coding assistant, not just installed and run.

- **Stable core:** data model, REST API, HA integration and MCP server. Versioned, documented, changed rarely and carefully.
- **Feature modules on top:** every non-core feature (lookup providers, scenarios, printing, recipes, battery linking, pricing, MQTT, etc.) is a self-contained module that uses only the public core API and extension hooks, can be switched on or off, and has its own short spec file.
- **Extension points:** documented hooks for new lookup providers, new product fields, new sensors/actions, new MCP tools, new UI pages and new printables, so new features can be added without editing the core.
- **AI guidance files:** an AGENTS.md (with CLAUDE.md pointing to it) explaining the architecture, conventions, the core-vs-module boundary, how to add a module step by step, and how to run tests.
- **Template module:** a minimal example module to copy when adding a feature.
- **Tests:** solid tests for the core API and each module, so an AI can change things safely and know when it has broken something.
- **Clean upgrades:** user customisations live in modules, so updates from the main repo merge cleanly.

## Build phases

**Phase 0 – Interface design (hard checkpoint).** Produce clickable HTML mock-ups of the main screens: stock list, product detail, scanning, locations and grid wizard, shopping list by shop, scenarios, wish list, printables. Mobile-first. STOP and wait for the user's sign-off and feedback before writing any real code.

**Phase 1 – Core add-on.** Data model, REST API, UI, scanning, lookup providers, locations, search, shops and shopping list.

**Phase 2 – Home Assistant integration.** Sensors, actions, events, NFC, battery linking.

**Phase 3 – MCP server.** Tools above, tested with Claude and at least one other client.

**Phase 4 – Extras.** Scenarios printing, QR label sheets, recipes, optional MQTT.

At the end of each phase, summarise what was built, how to test it, and wait for the go-ahead before the next phase.
