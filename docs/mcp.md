# Larder for AI assistants (MCP)

Larder has an MCP server, so Claude, ChatGPT, Gemini CLI and local models (Open WebUI, LM Studio) can answer "have we got any AA batteries?", "what should I cook with what's about to go off?", or "I found 24 rolls for £8 at Aldi, is that cheaper?", and update stock when you tell them.

## Addresses

| Where Larder runs | MCP address | Sign in with |
|---|---|---|
| Docker, or the add-on with its port opened | `http://<larder>:8080/mcp` | A Larder access token (Settings → Access tokens) |
| Through Home Assistant, with the Larder integration (Nabu Casa included) | `https://<home-assistant>/api/larder/mcp` | Connector sign-in with your Home Assistant login (the Claude app, ChatGPT), or a Home Assistant long-lived access token (your profile → Security) |
| Larder on a public https address (Cloudflare Tunnel, Tailscale Funnel) | `https://<larder address>/mcp` | Either of the above, or connector sign-in (below) |

Every request needs `Authorization: Bearer <token>`. Make a separate token for each assistant so you can revoke one without the others. Tokens can do everything the person who made them can.

With `LARDER_AUTH=none` (trusted networks only) no token is needed.

## Connecting

Menus move between versions; if one has, the client's own docs say where MCP servers are added.

**Claude Code**

```bash
claude mcp add --transport http larder http://larder.local:8080/mcp --header "Authorization: Bearer lrd_…"
```

**The Claude app: claude.ai, and Claude's desktop and mobile apps (custom connectors).** These connect from Anthropic's servers, so they need an address that's reachable from the internet, and they sign in rather than take a pasted token.

- *Through Home Assistant* (with Nabu Casa, or Home Assistant on its own https address): in Claude, Settings → Connectors → **Add custom connector**, with the address `https://<home-assistant>/api/larder/mcp` and nothing under advanced settings. Claude opens Home Assistant's login: log in, then press **Allow** on Larder's page. Claude gets a Larder token, not a Home Assistant one, so it can use Larder but nothing else in Home Assistant; it acts as the Home Assistant user who allowed it (as the add-on), and appears in Larder under Settings → Access tokens as "Claude (via claude.ai)", where it can be disconnected. Needs the Larder integration set up in Home Assistant.
- *On Larder's own public address* (Cloudflare Tunnel, Tailscale Funnel): set `LARDER_BASE_URL` to it, then add a custom connector with `https://<larder address>/mcp`. Claude opens Larder's approval page: sign in and press **Allow**. (With the add-on, approve with a Larder account from Settings → Accounts, since that address isn't reached through Home Assistant.)

*Stop it asking every time* (voice chat included): pressing **Allow** in a chat doesn't stop it asking next time. In Claude, go to Customize → Connectors (Settings → Connectors in some versions), select Larder, and under **Tool permissions** set the groups (read-only, and write/delete) to **Always allow**. Keep any you'd like asked about, such as `remove_item`, on **Needs approval**. Without that, Claude runs Larder's read-only tools without asking and asks before the ones marked destructive: those that remove something or overwrite what was set. Everyday changes such as using, finishing or moving stock aren't marked destructive. A Larder update that adds tools may add them as **Needs approval**, so look again after one.

**Claude Desktop on the same network, without a public address.** Use `mcp-remote` in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "larder": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://larder.local:8080/mcp", "--header", "Authorization:${LARDER_AUTH}"],
      "env": { "LARDER_AUTH": "Bearer lrd_…" }
    }
  }
}
```

**ChatGPT (connectors, developer mode).** Like the Claude app: a connector for `https://<home-assistant>/api/larder/mcp` (or Larder's own public address), approved after logging in.

**Gemini CLI** (`~/.gemini/settings.json`):

```json
{ "mcpServers": { "larder": { "httpUrl": "http://larder.local:8080/mcp", "headers": { "Authorization": "Bearer lrd_…" } } } }
```

**Open WebUI:** Settings → External Tools (or Admin → Tools) → add a server of type **MCP (Streamable HTTP)** with the address and a Bearer token.

**LM Studio** (`mcp.json`, Program tab → Install → Edit mcp.json):

```json
{ "mcpServers": { "larder": { "url": "http://larder.local:8080/mcp", "headers": { "Authorization": "Bearer lrd_…" } } } }
```

## Tools

Everything you can do in the app, as plainly described tools, apart from accounts, access tokens, household settings, backups, photos, NFC tags and printing. Everything takes names as people say them ("loo roll", "garage racking", "aldi"); ids, barcodes, shop codes and place codes like `G2-4` work too. If a name could mean more than one thing, the tool says which ones rather than guessing.

| Tool | What it does |
|---|---|
| `search` | Find items, places and shops by any words. Typos are fine |
| `get_item` | Everything about one item: how many, each batch's place and expiry, deliveries on the way, when it counts as low, how fast it's used and when it runs out, what it comes in, the open one, shops, brands with their barcodes and shop codes, links, notes |
| `list_items` | Items by status (low, use soon, out of place, on order, wish list, in stock, to sort, to tidy, open), by category and by place |
| `get_place` | What's in a place: what's kept there and how many (and what's run out there), what's out of place from there, what's there from elsewhere, and the places inside it |
| `identify_code` | What a barcode, label, place code or shop code is; for an unknown barcode, what the online product databases say |
| `add_item` | Add something Larder doesn't know yet, with its brand and barcode (and a photo found from them), notes, links, what it comes in (`comes_in`: a box of 20), what one weighs (`weighs`: 1 jar = 400 g), how fast it's used (`uses`: 1 every day, or 4 g a day with `unit`) and whether Larder takes them out by itself, and whether it's rechargeable. From a photo, the assistant reads the pack itself. A shop Larder doesn't have is only added once the person agrees (`new_shop`); a place or category that isn't set up yet is refused (nothing is added) with a suggestion to add it first |
| `change_item` | Change anything about an item afterwards: name, category, unit, what it comes in (with `recount` to turn 2 boxes into 40 tea bags, which still shows as 2 boxes), what one weighs, other names, minimum, shelf life, how fast it's used (in what it's counted in, or by weight: 4 g a day), whether Larder takes them out of stock by itself, and when the current one started, usual place, places it's no longer kept in, shops to buy it from, notes, links, wish list, rechargeable |
| `remove_item` | Remove an item with all its stock |
| `add_brand` / `remove_brand` | A brand or pack of an item, with its barcode or a shop's product code |
| `correct_stock` | Fix one batch: how many there really are (in the item's unit or its pack), its expiry date, or remove it |
| `add_stock` / `use_stock` | Add or take away stock (soonest-expiring first; rechargeables go flat). Adding takes a brand, and a price and shop to keep it in the purchase history; using takes a note, and `opened` for one that's opened and still in use (the butter in the fridge), or, for something Larder takes out by itself, a new one started now; otherwise a use is an extra one. Both take `unit` for amounts in the item's pack ("2 boxes") |
| `finish_item` | The open one is finished (or the one in use stopped: Larder stops taking them out until one is started) |
| `bought` | Several things bought at once, with their prices and the shop: added to stock and kept in the purchase history |
| `move_item` | Move something for now (out of place) or for good, all of it or some (in the item's unit or its pack: "1 box"), optionally only from one place, or from To sort (stock with no place yet) |
| `add_expected` | Record an order that hasn't arrived (it counts towards stock), with its price, where it goes, and whether it's still a pending order. Takes shop codes from order emails. Something in a pending order from the same shop is confirmed instead of added again |
| `mark_arrived` | A delivery (or part of one, in the item's unit or its pack, or only what was due by a day) arrived |
| `confirm_order` / `cancel_order` | A pending order (e.g. a filled online basket) went ahead and is on its way, or didn't and is removed |
| `add_to_shopping_list` / `remove_from_shopping_list` | Put something on the list that isn't low, or take it off again |
| `put_back` | Something out of place is back where it lives (all of it, or only from one place) |
| `mark_charged` / `renew` | Rechargeables charged; a renewal (insurance, MOT) renewed |
| `shopping_list` | What to buy at a shop (in whole packs for things that come in them: "Tea bags ×1 box (80 tea bags)"), which shop to go to, or (`shop: "none"`) what no shop sells |
| `expiring` | What to use soon, and renewals coming up |
| `deliveries` / `recent_changes` | Orders on the way and pending orders; what changed in stock lately (all, or one item) |
| `list_shops` / `add_shop` / `change_shop` / `remove_shop` | Shops and what they sell. Common UK shops (Tesco, Aldi, Screwfix…) come with what they usually sell |
| `list_places` / `add_place` / `add_storage_grid` / `change_place` / `remove_place` | Places, nested, with label codes; shelving with numbered spots in one go; only empty places can be removed |
| `list_categories` / `add_category` / `change_category` / `remove_category` | Categories, and how early their items are flagged before expiry |
| `check_price` / `set_usual_price` | "Is 24 rolls for £8 cheaper than usual?" or "spinach is £4.40/kg here, is that good?", and making it the usual price. Both take the pack's unit (the item's own, g, kg, ml, l) (pricing module) |
| `add_receipt` | Add a till receipt or online order the assistant has read to stock in one go, with the prices paid, by item names. Only items Larder has: if any line isn't one, nothing is added and it says which (ai module) |
| `convert_price` | "£3.50 a kg, what's that per 100 g?" For an item counted in bags or tins, give the item (pricing module) |
| `set_item_size` | "A jar of coffee is 400 g": what one weighs or holds, so how fast it's used can be said in grams and prices compared by weight; with `per: "box"`, the weight of the pack it comes in (a 250 g box of 80 tea bags is 3.125 g a tea bag) |
| `get_price` | An item's usual price in every unit it can be shown in: its own, its pack, and by weight once the item says what one weighs (`set_item_size`) (pricing module) |
| `purchase_history` / `spending` | What was bought, the price, the shop, and the receipt's photo or the order; what was spent by shop, item and month (purchase history module) |
| `change_purchase` / `remove_purchase` | Correct a purchase in the history (how many in the item's unit or its pack), or take one out (purchase history module) |
| `battery_devices` / `batteries_replaced` / `link_battery` | Devices with batteries and what to do about a low one; new batteries went in; which battery a device takes (battery linking module) |
| `check_order_emails` / `order_emails` / `match_order_line` / `skip_order_line` | Order emails: check now, what was read, and the lines waiting to be matched to an item or left out (order emails module) |
| `link_listing` / `unlink_listing` / `set_buying_rules` | An online shop's packs for an item, which pack to always buy and how many one gives, and offers (online shopping module) |
| `list_scenarios` / `get_scenario` | Scenarios (Power cut, Christmas…): every item, how many and where (scenarios module) |
| `make_scenario` / `change_scenario` / `remove_scenario` / `add_to_scenario` / `remove_from_scenario` | Making and changing scenarios (scenarios module) |
| `save_recipe` / `list_recipes` / `get_recipe` | Recipes the household liked, with what's in the house. Ingredients can have ratios, so `get_recipe` works out the amounts from what you have ("only 2 eggs"), a preset, servings or times (recipes module) |
| `save_recipe_preset` / `forget_recipe_preset` | Keep amounts you make often under a name ("Family", "Just me"), and choose the default one (recipes module) |
| `propose_cooking` / `confirm_cooking` | After cooking: what comes out of stock, at the amounts made, applied only once the person agrees (recipes module) |
| `recipe_to_shopping_list` / `forget_recipe` | Put what a recipe is missing on the list, at any amount; forget a recipe (recipes module) |
| `set_recipe_scenarios` | Put a recipe in scenarios (Christmas), and keep it only there if wanted (recipes module) |
| `start_shop` / `list_slots` / `book_slot` | "Do me a shop": is the online shop ready (waking its computer), when, the free delivery (or click and collect, at a branch) slots that day, and booking one once the person agrees; offers click and collect when delivery is full (online shopping module) |
| `plan_basket` / `fill_basket` / `shop_status` | What's low or on offer at its target price, planned or put in the online basket and recorded as on the way; how it's going (online shopping module) |
| `provider_status` / `get_product` / `link_listing` / `set_buying_rules` | The online shop's provider, its products, linking them to items, and the target price, on-offer amount and pack rule (online shopping module) |
| `sync_favourites` / `add_to_favourites` | Shop favourites into Pending; adding one by code or link (online shopping module) |
| `check_order_emails` | Look in Gmail now for shops' order and delivery emails, when Order emails is set up; answers what was found and done (email module) |

Modules add their own tools (`ctx.addTool`, see [modules.md](modules.md)). Switched-off modules' tools disappear.

### Recipes from what's in the house

Ask "what could I cook with what needs using up?" The assistant calls `expiring` and `search`, suggests something, and if you like it, `save_recipe`. After cooking, "I made the traybake for 6" leads to `propose_cooking`; it shows what will come out of stock and asks you before `confirm_cooking`.

### Ratios and presets

When a recipe's ingredients have ratios (2 eggs to 100 g flour to 300 ml milk), say "I've only got 2 eggs" and the assistant calls `get_recipe` with `have`; Larder works out the rest, so small local models don't have to do the maths. Give more than one ("2 eggs and 150 g flour") and whichever runs out first sets the amounts. Weights and volumes convert (kg to g, pints to ml, tbsp to tsp).

The assistant then offers to keep those amounts as a preset (`save_recipe_preset`). One preset can be the default: `get_recipe` and `propose_cooking` use it unless you ask for another ("the family one"). When a recipe has presets but no default, `get_recipe` tells the assistant to ask which you'd like. To add ratios to a recipe saved before, ask the assistant to; it changes the recipe with `save_recipe` and keeps everything else.

When an assistant connects, Larder also tells it how the house works: names not ids, never guess between close matches, quantities are in each item's own unit, search before adding something new.

## Email orders

**Pending orders:** a filled online basket (the online shopping module) is a pending order until it's checked out: it counts towards stock, so it isn't ordered twice, but it isn't on the way. When the order email's automation calls `add_expected` for something in a pending order from the same shop (the same source, or the same first word: "Tesco" confirms "Tesco delivery"), that's confirmed rather than added again. What's left pending afterwards was probably taken out of the basket: confirm or remove it.

Larder can read order emails from Gmail itself (Settings → Order emails, the `email` module); `check_order_emails` checks now. Without that, the brief's separate "read order emails" automation (a Claude scheduled task, say; the Order emails page gives a prompt for one) can call `add_expected` with the shop code from the email, for example Toolstation's item number. When Larder knows that code (on the item's brand, under Brands & barcodes), it finds the item; when it doesn't, the tool says so, and the automation can `search`, then `add_item` with `shop` and `shop_code` so it's matched next time.

## Tested with

- **Claude Code 2.1** as the client, against a Larder with the example household: asked for the toilet rolls and where they are, whether 24 rolls for £8 at Aldi was cheaper, and to record 2 tins of baked beans used. It used `get_item`, `check_price` and `use_stock` correctly, and the beans went from 6 to 4.
- **The official MCP TypeScript SDK** (automated, `tests/api/mcp.test.ts`): tools, descriptions, every core tool, unclear names, errors, no token.
- **The official MCP Python SDK** (automated, `tests/ha/test_mcp_python_client.py`).
- **The SDK's OAuth client** signing in by itself: discovery, registration, PKCE, approval, token (`tests/api/mcp-oauth.test.ts`).
- **Through Home Assistant** at `/api/larder/mcp` (`tests/ha`).

- **The Claude app** through Home Assistant 2026.10 and Nabu Casa: added `https://<home-assistant>/api/larder/mcp` as a custom connector, signed in with Home Assistant, and added items.

Not tried yet: ChatGPT connectors, Gemini CLI, Open WebUI and LM Studio. The set-ups above follow each client's documented format.

## How it works

`src/core/services/assistant.ts` and `assistant-manage.ts` define the tools; `src/server/mcp.ts` serves them with the official MCP SDK over Streamable HTTP. It is stateless and answers every request with plain JSON (no sessions or open streams), so it passes through Home Assistant, reverse proxies and tunnels. `src/server/oauth.ts` adds the connector sign-in from the MCP authorization spec: protected resource and authorization server metadata, dynamic client registration, and the authorization code flow with PKCE. Approved connections get an ordinary Larder access token.
