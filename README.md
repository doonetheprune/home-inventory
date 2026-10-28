# Larder

What you've got, and where. A self-hosted home inventory for everything in the house, not just food: groceries, household stuff, pet supplies, tools, fuel, batteries, emergency supplies, and renewals like house insurance.

- **Search first.** One search bar for everything, typo-tolerant ("bog rol" finds toilet roll), with + and − right in the results. On a laptop: type, press ↑ three times, Enter, and three are added.
- **Scan.** Phone camera, USB or Bluetooth scanners, QR shelf labels. Unknown barcodes are looked up in Open Food Facts (and friends), or named once and remembered.
- **Places.** Rooms, cupboards, shelves and boxes, with short codes (G2-4). Set up racking in one go. Things can be out of place: usually in the shed, now in the kitchen.
- **Shopping by shop.** "I'm going to Aldi" lists everything low that Aldi can supply. Deliveries on the way count, so you don't buy twice. Tick items off and they go into stock.
- **Unit prices.** "24 rolls for £8, is that cheaper than usual?"
- **Runs on its own** (Docker, one data folder, SQLite) and will run as a Home Assistant add-on. A documented REST API underneath everything.

## Status

| Phase | | |
|---|---|---|
| 0 | Interface design | Done: [`mockups/index.html`](mockups/index.html) |
| 1 | Core: data model, REST API, web app, scanning, lookups, places, search, shops and shopping lists, running on its own | **Done** |
| 2 | Home Assistant add-on and HACS integration: sensors, actions, events, NFC, battery linking | Next |
| 3 | MCP server for Claude and other AI assistants | |
| 4 | Scenarios and printing, QR label sheets, recipes, MQTT | |

## Try it

```bash
npm ci
npm run build
LARDER_DEMO=true LARDER_AUTH=none npm start
```

Open http://localhost:8080. `LARDER_DEMO` loads an example household; `LARDER_AUTH=none` skips the login (only on a trusted network).

With Docker: `docker compose up -d` (see [docs/running.md](docs/running.md) for settings, HTTPS and backups).

## For developers and AI assistants

Start with [AGENTS.md](AGENTS.md). Then:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pieces fit
- [docs/modules.md](docs/modules.md): adding features as modules
- [docs/adapters.md](docs/adapters.md): swapping SQLite for another back end
- [docs/api.md](docs/api.md) and [docs/openapi.json](docs/openapi.json): the REST API
- [docs/DECISIONS.md](docs/DECISIONS.md): what's been agreed, and [docs/BRIEF.md](docs/BRIEF.md): the original brief

```bash
npm run dev        # API :8080 + web app :5173
npm test           # unit, contract, API and module tests
npm run test:e2e   # browser tests, phone and desktop
```
