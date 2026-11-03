# Online shopping

Larder fills an online basket from what's low or on offer, books delivery slots, and brings in the shop's favourites. Each shop's website is driven by a separate **shopping provider** (Tesco first: the `larder-provider-tesco` repository, also the template for other shops), a small service on a computer on the network, behind one fixed contract. Larder holds the stock and the buying rules and makes every decision; the provider does exactly what it's asked and stops at a full basket. Nobody pays automatically.

## Providers

Settings → **Shopping providers** → **Add automated shopping provider**: the type (Tesco, or another shop's provider), the Larder shop it serves (one provider per shop; Tesco is added from the presets if Larder doesn't have it), whether it's the default (used when no shop is named; only one is, and the first one added), its address (`192.168.1.231:8710`; port 8710 unless given), its token (the provider's `AUTH_TOKEN`, never shown again, only its last four characters), and whether to count loyalty prices (Clubcard).

- **Test connection** asks `/health` and `/manifest` and keeps the answer as its status: ready, or what's wrong in words (log in again, wrong token, another contract version), with the provider's version, contract version and capabilities. When waking isn't set up and the manifest gives the computer's MAC address (contract 1.3), Larder fills it in.
- **Waking its computer**, through Home Assistant: a magic packet to its MAC address (`wake_on_lan.send_magic_packet`, with an optional broadcast address; needs Home Assistant's Wake on LAN integration), or a switch, button, script or automation. When the provider doesn't answer, Larder wakes it and asks `/health` every 5 seconds until it answers or the wake timeout (3 minutes unless changed) runs out, then says "Couldn't wake the Tesco provider…". Test connection only wakes it when asked (**Wake and test**).
- **Sleep after** (optional): a switch (turned off), button or script that puts it back to sleep after a shop, only when nothing else is running there.
- Contract versions: Larder reads 1.x (`contract.ts`, kept in step with the provider template's `src/contract`). A provider on 2.0 is refused with a message saying to update whichever is older.

## Assistant tools

| Tool | |
|---|---|
| `provider_status` | Is the shop's provider running and logged in? Wakes its computer if needed |

## Routes

Under `/api/v1/modules/online-shopping`. Changing providers is for household admins.

| Route | |
|---|---|
| `GET /providers` | Providers (never their tokens) and the types that can be added |
| `POST /providers` | `{ type, shopId, address, token, isDefault?, wake?, sleepEntityId?, loyaltyPrices? }` |
| `PATCH /providers/:id` | Any of those. A new address or token clears the status |
| `DELETE /providers/:id` | Items keep their listings |
| `POST /providers/:id/test` | `{ wake? }`. Answers the provider, whether it woke, whether waking was filled in, and a sentence |

## Data

`online-shopping:providers` collection, one document per provider: `{ id, type, shopId, isDefault, url, token, wake: { entityId, mac, broadcastAddress, timeoutSeconds }, sleepEntityId, loyaltyPrices, status, createdAt }`. Tokens are kept in Larder's data folder, so they're in backups.

## Settings

`LARDER_MODULE_ONLINE_SHOPPING_WAKE_POLL_MS` (default 5000) and `_WAKE_TIMEOUT_MS` (overrides every provider's wake timeout) are for tests.

## Hooks used

`addRoute` (`admin` for changes), `addTool`, `collection`, `ctx.fetch` (to reach the providers), `ctx.core.homeAssistant.callService` (waking and sleep), `ctx.core.resolve.shop`, `ctx.core.shops`; on the web, a Settings panel.
