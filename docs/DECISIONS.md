# Decisions

Choices made with the user that aren't in the original brief. Newest last within each phase.

## Phase 0: interface design

- **Name:** the project and add-on are called **Larder**.
- **Look:** its own modern style, not Home Assistant's. Deep cobalt blue accent, cool neutral greys, light and dark themes.
- **Home screen:** a dashboard with a large Scan button, Add by name and Put away; a "Going shopping?" card with every shop and how much to buy there (it first suggested one shop; see "After the owner tried it"); then use soon, running low, away from home and deliveries on the way.
- **"Any shop" items:** each shop has a list of categories it sells (e.g. Tesco: groceries and household; Toolstation: hardware and tools). An item with no preferred shop only appears on the lists of shops that sell its category.
- **Scanning:** always starts in Add mode. Use, move, put away and look up are picked before scanning.
- **Wording:** the app says **Places**, not Locations.
- **Desktop:** the same app adapts to wide screens with a sidebar and multi-column layouts, rather than being a separate design.
- **Search first:** search is the main way in. It runs across the top of every screen on desktop and is the first thing on Home on a phone. Results carry + and − buttons to add or use stock directly; if nothing matches, the first option is to add it as a new item.
- **Search keys:** Enter opens the highlighted result. ↑ and ↓ count up or down on a stock result, then Enter adds or uses that many. Tab moves between results. Esc cancels a count, then closes.
- **Search scope:** search covers everything, with results in sections: stock, shopping lists, places, scenarios, wish list, shops and saved recipes.
- **Out of place:** an item has a usual place and, optionally, a place it is in right now (usually in the Garage, now in the Shed). The app calls these items **Out of place**, not "away from home".

## After the owner tried it

Changes the owner asked for after trying the example household.

- **Going shopping:** every shop gets the same tile, with how many to buy there and its name, in the order set under Shops. No shop is singled out (the headline no longer names one either).
- **Stock by type:** Stock opens on a card per type of thing (Food, Household, Tools & DIY…, from the categories) with how many items and what needs attention; "Everything" is still a card. A type's list is grouped by place, with tabs to switch type and the status filters (low, use soon…) as their own row.
- **Adding at another place:** "Add somewhere else" on an item's "Where it is", and from the stock pane on desktop. It asks for the place rather than assuming the usual one.
- **Something's moved, from Home:** pick the item and where it is now; it shows as out of place until it's put back (the same as the `move_item` tool with `permanent: false`).
- **Prices by weight:** the usual price can be shown per item, per 100 g or per kg (per 100 ml or per litre for liquids), chosen on the price card. Things counted in bags or tins need their size once ("1 bag = 200 g") to be priced by weight. Pack checks take a size and unit, so a shelf label like "£3.50/kg" can be compared. Assistants get `convert_price` and `set_item_size`, and `check_price` and `set_usual_price` take a unit.

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
- **Lookup photos are saved, not linked** (added after Phase 4): when a scanned barcode is named, the photo the lookup found is downloaded once into Larder's files, so it's in backups and works offline. It becomes the item's photo if it has none, and that brand's photo either way. Only the address a lookup provider gave is downloaded (never one sent by a caller), only over https, up to 5 MB, and only if the bytes are a photo; if any of that fails the item is still saved, without a photo.
- **Shopping ticks** are kept on the phone until "Done", then sent in one go.
- **Barcode lookups** ask Open Food Facts, Open Beauty Facts and Open Products Facts in turn (4 seconds each). Answers and misses are cached; misses are retried after 7 days.
- **Licence:** not chosen yet (`UNLICENSED` in package.json). The owner should pick one before the repo is made public.

## Phase 2: how it was built

- **One image:** the add-on runs the same Docker image as the standalone install (`ghcr.io/doonetheprune/home-inventory`, tagged with the version in `addon/config.yaml`). The image starts as root only to give the data folder to the `node` user, then drops to it, so Docker volumes, bind mounts and the add-on's `/data` all work.
- **Ingress login:** people opening the add-on from Home Assistant are signed in as their Home Assistant user, from the headers Home Assistant's Supervisor adds, and only on connections from the Supervisor's address (172.30.32.2). Accounts are keyed by the Home Assistant user id (required). They are admins in Larder unless the add-on's **Larder admins** option lists who is.
- **Zero-setup integration:** the add-on keeps an access token for the integration in its data folder and announces itself to Home Assistant (Supervisor discovery), so the integration only needs confirming.
- **Sensors and actions come from Larder:** the integration builds them from `GET /api/v1/automation` at runtime, so new ones (core or modules) need no Python change. `services.yaml` is generated from the same list for Home Assistant's validator.
- **Names, not ids, and never a guess:** actions take items, places and shops by name, alias, code or barcode. Only an exact name, or a name containing every word given ("drill" → Cordless drill), is acted on; typos and look-alikes ("AA" when there are only AAA batteries, "salt" and Malt vinegar) are offered back as "did you mean", never acted on.
- **Events:** every Larder event is fired in Home Assistant as `larder_<type>`. Expiry is checked hourly, and each batch is announced once when it becomes due and once when it expires.
- **NFC:** the integration forwards every `tag_scanned` event; Larder resolves it and fires `larder_nfc_scanned`. Unknown tags are linked from the product or place page within 15 minutes of scanning. Android Chrome can read tags directly too.
- **Batteries:** a module. The integration sends every device with a battery sensor (and Battery Notes type and count, if installed); low is below 20% (option) or a battery-low binary sensor turning on. Larder answers swap / charge / spare / on the way / buy, and puts batteries on the shopping list when there are none.
- **Own backups off in the add-on:** Home Assistant backups already include `/data`; Larder's daily copies can be turned on in the options.
- **Version 0.2.0:** app, add-on and integration versions move together (a test checks).

## Phase 3: how it was built

- **Tools live in the core** (`core.assistant`), the MCP server only serves them, so the same tools could be offered another way later. Modules add theirs with `ctx.addTool`.
- **Few, plain tools** (13 with pricing): search, get_item, add_item, add_stock, use_stock, move_item, add_expected, mark_arrived, add_to_shopping_list, shopping_list, expiring, check_price, set_usual_price. They answer in short readable text, because small local models handle that better than JSON. Write tools reuse the Home Assistant actions' wording.
- **Stateless Streamable HTTP with JSON answers** at `/mcp` (official MCP SDK 1.32): no sessions or open streams, so it passes through Home Assistant, proxies and tunnels.
- **Three ways in:** a Larder token on `/mcp`; a Home Assistant token on `/api/larder/mcp` (for Nabu Casa); connector sign-in (OAuth with PKCE and dynamic registration) when Larder has a public https address.
- **Connector tokens are ordinary Larder tokens** named after the assistant and where it signed in from ("Claude (via claude.ai)"), revocable in Settings. They don't expire.
- **Guard rails on open registration** (after review): anyone can register a client, so Larder caps registrations per address (30 an hour) and in all (200, making room only by forgetting clients that never signed in), caps sign-ins waiting for approval, shows its own error page instead of redirecting, and the approval page says to check the address.
- **No changes from other websites**, in every sign-in mode: a write that a browser marks as coming from another site (Sec-Fetch-Site, or a foreign Origin) is refused unless it carries an access token or the web app's header. Only `/oauth/token` reads form posts.
- **MCP hints:** tools that take away or overwrite (use_stock, move_item, mark_arrived, set_usual_price) are marked destructive, so clients can ask first.
- **Version 0.3.0.**

## Phase 4: how it was built

- **All four extras are modules**, using only the public core, the web SDK and new general hooks: module pages with parameters and a Print section, `QrCode` and `PrintSetup` in the SDK, a `demo` hook for example data, and `core.stock.useMany` (several uses at once, all or nothing).
- **Scenarios** are tags on products (`product.fields.scenarios`), so deleting an item takes it out of every scenario. No target quantities. A scenario is grouped by where things are now, with out-of-place stock marked.
- **Printing:** label positions use the Avery templates' measurements (L7160, L7163, L7651) plus plain A4 with cut lines; print at 100% with no margins. Only the page's `print-area` prints. Scenario pages print on A4 with 12 mm margins, with place photos if the places have them.
- **Recipes:** ingredients link to items only when the name clearly is one (the same strict matching as actions); quantities to take are in the item's own unit. Cooking is always propose, then confirm (with changes), never automatic.
- **MQTT:** off by default; retained stock and sensor topics, plus every event; no Home Assistant MQTT discovery (the integration is the Home Assistant link). The add-on uses the Mosquitto add-on automatically.
- **Third-party packages in modules** are allowed only when listed for that module in the architecture test (MQTT uses `mqtt`).
- **One change at a time** (after review): stock writes and product updates go through one queue in the core (`ctx.exclusive`), because two changes at the same moment (two automations, a double tap) could both start from the same stock and one would be lost. Modules change their own product field with `core.products.updateField`, and find their own things by name with `core.resolve.among` (the same strict rules as items). The queue is per process, which suits Larder (one process); a storage adapter for several instances would need database transactions instead (noted in ARCHITECTURE.md).
- **Version 0.4.0.**

## For review

Bigger calls made while the owner was away, with the alternative. Say if any should change.

1. **The add-on needs the image to be downloadable.** While the repository is private, Home Assistant can't pull the image without registry credentials (Settings → Add-ons → Registries). *Alternative:* make the repo and package public, which also unlocks HACS.
2. **Everyone who opens the add-on is a Larder admin unless the "Larder admins" option names who is** (Home Assistant doesn't tell add-ons who its own admins are). The Larder panel is in every Home Assistant user's sidebar, at the owner's request, so set "Larder admins" if the children shouldn't change settings. *Alternative:* members by default.
3. **The integration forwards every NFC tag scan to Larder.** Tags used only for other automations are sent too (harmless, but visible in Larder's recent scans). *Alternative:* only forward tags Larder knows, plus a "link next tag" button. It can be turned off in the integration's options.
4. **Sensors and actions are defined by Larder, not the integration.** Easier to extend. The actions of the bundled Larder version ship with the integration too (`actions.json`), so automations load even when Larder is down; a module's extra actions appear once Larder is reachable. *Alternative:* a fixed list in the integration.
5. **Add-on architectures: aarch64 and amd64 only** (Raspberry Pi 4/5 on Home Assistant OS, and x86). *Alternative:* add armv7 for older Pis, which needs a separate build.
6. **Connector tokens never expire** (until revoked in Settings). *Alternative:* expiring access tokens with refresh tokens, which some connectors handle and some don't.
7. **Any Home Assistant user can use Larder's MCP tools through `/api/larder/mcp`**, not just admins. *Alternative:* admins only.
8. **Not yet tried with Claude.ai or ChatGPT connectors, Gemini CLI, Open WebUI or LM Studio.** Tested with Claude Code, both official SDKs and the SDK's OAuth sign-in. The connectors need Larder on a public https address to try.
9. **Label QR codes hold Larder's own codes (`larder:place:…`) unless `LARDER_BASE_URL` is set**, so only Larder's scanner opens them, not a phone's camera app. *Alternative:* always print links, which needs a stable address (an add-on's address through Home Assistant changes).
10. **No Home Assistant MQTT discovery** from the MQTT module. *Alternative:* discovery for people who use MQTT without the integration.
11. **Test tooling has new security advisories** (vitest 3 and its worker pool; development only, nothing shipped). *Alternative:* upgrade to vitest 4 or 5, which changes its configuration.
