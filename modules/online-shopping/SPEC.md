# Online shopping

Larder fills an online basket from what's low or on offer, books delivery slots, and brings in the shop's favourites. Each shop's website is driven by a separate **shopping provider** (Tesco first: the `larder-provider-tesco` repository, also the template for other shops), a small service on a computer on the network, behind one fixed contract. Larder holds the stock and the buying rules and makes every decision; the provider does exactly what it's asked and stops at a full basket. Nobody pays automatically.

## Providers

Settings → **Shopping providers** → **Add automated shopping provider**: the type (Tesco, or another shop's provider), the Larder shop it serves (one provider per shop; Tesco is added from the presets if Larder doesn't have it), whether it's the default (used when no shop is named; only one is, and the first one added), its address (`192.168.1.231:8710`; port 8710 unless given), its token (the provider's `AUTH_TOKEN`, never shown again, only its last four characters), and whether to count loyalty prices (Clubcard).

- **Test connection** asks `/health` and `/manifest` and keeps the answer as its status: ready, or what's wrong in words (log in again, wrong token, another contract version), with the provider's version, contract version and capabilities. When waking isn't set up and the manifest gives the computer's MAC address (contract 1.3), Larder fills it in.
- **Waking its computer**, through Home Assistant: a magic packet to its MAC address (`wake_on_lan.send_magic_packet`, with an optional broadcast address; needs Home Assistant's Wake on LAN integration), or a switch, button, script or automation. When the provider doesn't answer, Larder wakes it and asks `/health` every 5 seconds until it answers or the wake timeout (3 minutes unless changed) runs out, then says "Couldn't wake the Tesco provider…". Test connection only wakes it when asked (**Wake and test**).
- **Sleep after** (optional): a switch (turned off), button or script that puts it back to sleep after a shop, only when nothing else is running there.
- Contract versions: Larder reads 1.x (`contract.ts`, kept in step with the provider template's `src/contract`). A provider on 2.0 is refused with a message saying to update whichever is older.

## Item settings

On an item's page, **Online shopping** (shown once a provider is set up):

- **Listings**, per shop: the shop's products to buy for this item, linked by pasting a code or link (looked up with the provider; an unknown one is refused, never guessed), optionally adding it to the shop's favourites at the same time. Each says how many of the item one pack gives ("1 pack = 9 rolls"): sure for weights and volumes the item is counted in, and when the name says what's counted ("9 Rolls"); otherwise a guess marked **check this** until someone sets it. A listing belongs to one item. A listing the shop says has gone is marked **Gone from Tesco: link the new one** (Tesco often gives a changed product a new code).
- **Pack rule**, per shop: the **cheapest mix** of listings that covers what's needed (default), or **always the first** (a fixed pack).
- **On offer at**: the target price per one of the item's unit (per kg for things counted in g, per litre for ml). At or below it counts as on offer. Each shop can have its own, which wins.
- **Stock up to, on offer**: how many to have after buying when it's on offer.
- **Stock up to** (the normal amount) is the item's own setting, beside **Running low below** on Edit: Larder's shopping lists suggest topping up to it at every shop, not just back to the minimum. Example: loo roll, minimum 4, stock up to 12, on offer 36.
- **Use picture** makes a listing's picture the item's photo.

## Assistant tools

| Tool | |
|---|---|
| `provider_status` | Is the shop's provider running and logged in? Wakes its computer if needed |
| `get_product` | A shop's product by code or link: name, pack, prices, link, picture, and the item it's linked to |
| `link_listing` | Link a shop's product to an item (and add it to favourites), with `pack_quantity` when the pack size isn't clear |
| `set_buying_rules` | Target price, on-offer stock-up amount, pack rule and a shop's own target price. The minimum and normal stock-up amount are `change_item`'s (`stock_up_to`) |

## Routes

Under `/api/v1/modules/online-shopping`. Changing providers is for household admins.

| Route | |
|---|---|
| `GET /providers` | Providers (never their tokens) and the types that can be added |
| `POST /providers` | `{ type, shopId, address, token, isDefault?, wake?, sleepEntityId?, loyaltyPrices? }` |
| `PATCH /providers/:id` | Any of those. A new address or token clears the status |
| `DELETE /providers/:id` | Items keep their listings |
| `POST /providers/:id/test` | `{ wake? }`. Answers the provider, whether it woke, whether waking was filled in, and a sentence |
| `POST /items/:productId/listings` | `{ shopId, idOrLink, addToFavourites?, packQuantity? }` |
| `PATCH /items/:productId/listings/:listingId` | `{ shopId, packQuantity }` |
| `DELETE /items/:productId/listings/:listingId?shopId=` | Unlink |
| `PUT /items/:productId/shops/:shopId` | `{ packRule?, fixedListingId?, targetPrice? }` |
| `PUT /items/:productId/rules` | `{ targetPrice?, offerStockUpTo? }` |
| `POST /items/:productId/shop-image` | `{ shopId, listingId }`: the listing's picture becomes the item's photo |

## Data

`product.fields['online-shopping']`: `{ shops: { <shopId>: { listings: [{ listingId, name, packQuantity, guessed, packSize, link, imageUrl, deadSince, addedAt }], packRule, fixedListingId, targetPrice } }, offerStockUpTo, targetPrice }`. Prices are per one of the item's unit. The item's own `stockUpTo` (core) is the normal stock-up amount.

`online-shopping:providers` collection, one document per provider: `{ id, type, shopId, isDefault, url, token, wake: { entityId, mac, broadcastAddress, timeoutSeconds }, sleepEntityId, loyaltyPrices, status, createdAt }`. Tokens are kept in Larder's data folder, so they're in backups.

## Settings

`LARDER_MODULE_ONLINE_SHOPPING_WAKE_POLL_MS` (default 5000) and `_WAKE_TIMEOUT_MS` (overrides every provider's wake timeout) are for tests.

## Hooks used

`addRoute` (`admin` for changes), `addTool`, `collection`, `productFields`, `core.products.updateField`, `core.lookup.savePhotoFromLink`, `ctx.fetch` (to reach the providers), `ctx.core.homeAssistant.callService` (waking and sleep), `ctx.core.resolve.shop` / `.product`, `ctx.core.shops`; on the web, a Settings panel and a product panel.
