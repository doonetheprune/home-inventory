# Decisions

Choices made with the user that aren't in the original brief. Newest last within each phase.

## Phase 0: interface design

- **Name:** the project and add-on are called **Larder**.
- **Look:** its own modern style, not Home Assistant's. Deep cobalt blue accent, cool neutral greys, light and dark themes.
- **Home screen:** a dashboard with a large Scan button, Add by name and Put away; a "Going shopping?" card that suggests the shop with the most items on the list; then use soon, running low, away from home and deliveries on the way.
- **"Any shop" items:** each shop has a list of categories it sells (e.g. Tesco: groceries and household; Toolstation: hardware and tools). An item with no preferred shop only appears on the lists of shops that sell its category.
- **Scanning:** always starts in Add mode. Use, move, put away and look up are picked before scanning.
- **Wording:** the app says **Places**, not Locations.
- **Desktop:** the same app adapts to wide screens with a sidebar and multi-column layouts, rather than being a separate design.
- **Search first:** search is the main way in. It runs across the top of every screen on desktop and is the first thing on Home on a phone. Results carry + and − buttons to add or use stock directly; if nothing matches, the first option is to add it as a new item.
- **Search keys:** Enter opens the highlighted result. ↑ and ↓ count up or down on a stock result, then Enter adds or uses that many. Tab moves between results. Esc cancels a count, then closes.
- **Search scope:** search covers everything, with results in sections: stock, shopping lists, places, scenarios, wish list, shops and saved recipes.
- **Out of place:** an item has a usual place and, optionally, a place it is in right now (usually in the Garage, now in the Shed). The app calls these items **Out of place**, not "away from home".

## Architecture (agreed before Phase 1)

- **Runs on its own first:** Larder is fully supported outside Home Assistant from Phase 1. It ships as one Docker image with a Docker Compose example, its own household login and access tokens (for MCP and the integration), settings through environment variables, and a setup guide. HTTPS is provided by the person running it (reverse proxy, Tailscale or Cloudflare Tunnel).
- **Home Assistant follows:** the add-on is a thin wrapper around the same image, and the custom integration talks to Larder only through the REST API, so it works whether Larder runs as an add-on or elsewhere.
- **One data folder:** SQLite database, photos and scheduled backups all live in one folder, so a backup is a copy of that folder.
- **Swappable back end (ports and adapters):** core services never touch the database directly. Storage, files, search, events and login are each behind a small documented interface, with SQLite, local disk and in-app search as the defaults and an in-memory storage adapter for tests. Every storage adapter must pass one shared contract test suite. The core avoids SQL-only features: IDs are app-generated strings, queries are named store methods rather than joins, and multi-step changes are single storage operations. The UI, integration and MCP use only the REST API, so a whole replacement back end that implements the OpenAPI spec (and passes the API test suite) would also work.
- **Testing Home Assistant parts:** the integration gets unit tests with `pytest-homeassistant-custom-component`, end-to-end tests against a real Home Assistant running in Docker, and `hassfest` and HACS validation in CI.
- **Language:** TypeScript throughout (server, web app, MCP server). Python only for the Home Assistant integration.

## Phase 1: how it was built

These follow from the decisions above; the owner can change any of them.

- **Runtime:** Node.js 22.13 or newer (Docker image uses Node 24). SQLite comes from Node's built-in `node:sqlite`, so there are no native add-ons and the same image runs on ARM (Raspberry Pi) and x86.
- **Storage format:** each SQLite table holds whole JSON documents plus a few indexed columns, mirroring a document database so a Firestore adapter is a straight swap.
- **Server:** Fastify with zod schemas; the OpenAPI spec is generated from them and committed as `docs/openapi.json` (a test fails if it's stale).
- **Login:** `LARDER_AUTH=local` (default) gives household accounts with cookie sessions and hashed bearer tokens for integrations; `none` is for trusted networks. Home Assistant ingress login is Phase 2.
- **Web app:** React with hash routing and relative paths so it works behind Home Assistant ingress and reverse proxies. Fonts are bundled, so nothing loads from the internet.
- **Reverse proxies:** Larder ignores `X-Forwarded-*` headers unless `LARDER_TRUST_PROXY` names the proxy, so nobody can fake their address to dodge the sign-in limit (10 tries per address, 30 per account, in a few minutes).
- **Photos:** only JPEG, PNG, WebP, GIF, HEIC and AVIF, checked from the file itself, and served so they can't run scripts.
- **Shopping ticks** are kept on the phone until "Done", then sent in one go.
- **Barcode lookups** ask Open Food Facts, Open Beauty Facts and Open Products Facts in turn (4 seconds each). Answers and misses are cached; misses are retried after 7 days.
- **Licence:** not chosen yet (`UNLICENSED` in package.json). The owner should pick one before the repo is made public.
