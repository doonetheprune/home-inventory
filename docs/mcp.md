# Larder for AI assistants (MCP)

Larder has an MCP server, so Claude, ChatGPT, Gemini CLI and local models (Open WebUI, LM Studio) can answer "have we got any AA batteries?", "what should I cook with what's about to go off?", or "I found 24 rolls for £8 at Aldi, is that cheaper?", and update stock when you tell them.

## Addresses

| Where Larder runs | MCP address | Sign in with |
|---|---|---|
| Docker, or the add-on with its port opened | `http://<larder>:8080/mcp` | A Larder access token (Settings → Access tokens) |
| Home Assistant add-on, through Home Assistant (Nabu Casa included) | `https://<home-assistant>/api/larder/mcp` | A Home Assistant long-lived access token (your profile → Security) |
| Larder on a public https address (Cloudflare Tunnel, Tailscale Funnel) | `https://<larder address>/mcp` | Either of the above, or connector sign-in (below) |

Every request needs `Authorization: Bearer <token>`. Make a separate token for each assistant so you can revoke one without the others. Tokens can do everything the person who made them can.

With `LARDER_AUTH=none` (trusted networks only) no token is needed.

## Connecting

Menus move between versions; if one has, the client's own docs say where MCP servers are added.

**Claude Code**

```bash
claude mcp add --transport http larder http://larder.local:8080/mcp --header "Authorization: Bearer lrd_…"
```

**Claude.ai, and Claude's desktop and mobile apps (custom connectors).** These connect from Anthropic's servers, so Larder needs a public https address. Set `LARDER_BASE_URL` to it, then add a custom connector with `https://<larder address>/mcp`. Claude opens Larder's approval page: sign in and press **Allow**. The connection appears in Larder under Settings → Access tokens as "Claude (connected)". (With the add-on, approve with a Larder account from Settings → Accounts, since the public address isn't reached through Home Assistant.)

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

**ChatGPT (connectors, developer mode).** Like Claude.ai: a public https address, then a connector for `https://<larder address>/mcp`, approved on Larder's page.

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

A small set, described plainly, so small local models pick the right one. Everything takes names as people say them ("loo roll", "garage racking", "aldi"); ids, barcodes, shop codes and place codes like `G2-4` work too. If a name could mean more than one thing, the tool says which ones rather than guessing.

| Tool | What it does |
|---|---|
| `search` | Find items, places and shops by any words. Typos are fine |
| `get_item` | Everything about one item: how many, each batch's place and expiry, deliveries on the way, when it counts as low, shops, notes |
| `add_item` | Add something Larder doesn't know yet |
| `add_stock` / `use_stock` | Add or take away stock (soonest-expiring first; rechargeables go flat) |
| `move_item` | Move something for now (out of place) or for good |
| `add_expected` | Record an order that hasn't arrived (it counts towards stock). Takes shop codes from order emails |
| `mark_arrived` | A delivery (or part of one) arrived |
| `add_to_shopping_list` | Put something on the list that isn't low |
| `shopping_list` | What to buy at a shop, or which shop to go to |
| `expiring` | What to use soon, and renewals coming up |
| `check_price` / `set_usual_price` | "Is 24 rolls for £8 cheaper than usual?", and making it the usual price (pricing module) |
| `list_scenarios` / `get_scenario` | Scenarios (Power cut, Christmas…): every item, how many and where (scenarios module) |
| `save_recipe` / `list_recipes` / `get_recipe` | Recipes the household liked, with what's in the house (recipes module) |
| `propose_cooking` / `confirm_cooking` | After cooking: what comes out of stock, applied only once the person agrees (recipes module) |

Modules add their own tools (`ctx.addTool`, see [modules.md](modules.md)). Switched-off modules' tools disappear.

### Recipes from what's in the house

Ask "what could I cook with what needs using up?" The assistant calls `expiring` and `search`, suggests something, and if you like it, `save_recipe`. After cooking, "I made the traybake for 6" leads to `propose_cooking`; it shows what will come out of stock and asks you before `confirm_cooking`.

When an assistant connects, Larder also tells it how the house works: names not ids, never guess between close matches, quantities are in each item's own unit, search before adding something new.

## Email orders

The brief's separate "read order emails" automation (not part of Larder) can call `add_expected` with the shop code from the email, for example Toolstation's item number. When Larder knows that code (on the item's brand, under Brands & barcodes), it finds the item; when it doesn't, the tool says so, and the automation can `search`, then `add_item` with `shop` and `shop_code` so it's matched next time.

## Tested with

- **Claude Code 2.1** as the client, against a Larder with the example household: asked for the toilet rolls and where they are, whether 24 rolls for £8 at Aldi was cheaper, and to record 2 tins of baked beans used. It used `get_item`, `check_price` and `use_stock` correctly, and the beans went from 6 to 4.
- **The official MCP TypeScript SDK** (automated, `tests/api/mcp.test.ts`): tools, descriptions, every core tool, unclear names, errors, no token.
- **The official MCP Python SDK** (automated, `tests/ha/test_mcp_python_client.py`).
- **The SDK's OAuth client** signing in by itself: discovery, registration, PKCE, approval, token (`tests/api/mcp-oauth.test.ts`).
- **Through Home Assistant** at `/api/larder/mcp` (`tests/ha`).

Not tried yet, because they need Larder on a public https address or aren't installed here: Claude.ai and ChatGPT connectors, Gemini CLI, Open WebUI and LM Studio. The set-ups above follow each client's documented format.

## How it works

`src/core/services/assistant.ts` defines the tools; `src/server/mcp.ts` serves them with the official MCP SDK over Streamable HTTP. It is stateless and answers every request with plain JSON (no sessions or open streams), so it passes through Home Assistant, reverse proxies and tunnels. `src/server/oauth.ts` adds the connector sign-in from the MCP authorization spec: protected resource and authorization server metadata, dynamic client registration, and the authorization code flow with PKCE. Approved connections get an ordinary Larder access token.
