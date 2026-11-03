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

## Order logic

`plan.ts`, on its own so it's tested on its own. For each item with a listing at the shop:

1. **Candidate** when it's low (stock plus on order below the minimum), on the list by hand, or has a target price and stock plus on order is below its on-offer amount. Only candidates are quoted, to keep traffic to the shop low.
2. **Quote** all its listings.
3. **Level**: on offer (the best price per unit, using the loyalty price and a multibuy's per-unit price, at or below the target) → the on-offer amount. Not on offer but low or on the list → the normal amount (stock up to, else the minimum). Otherwise it's skipped. Loyalty prices and offers only count when valid on the delivery day (the booked slot's, else today) and, for loyalty ones, when the provider's **Loyalty prices** is on. "Other" deals are ignored but listed in the summary.
4. **Needed** = level − stock − on order. Something on the list by hand gets at least one pack.
5. **Packs**: a fixed pack buys enough of that listing; the cheapest mix tries every mix of the six cheapest listings (up to 99 packs each) and takes the cheapest that covers it, then the one least over, then the fewest packs. Unavailable listings are left out; gone ones (`listing_dead`) are marked on the item for relinking.
6. **Multibuys** (3 for £2, buy 2 get 1 free, 25% off 6 or more) are rounded up to complete the deal when that keeps stock within the household's allowance over the level (**Multibuys may go over by**, 25% unless changed).
7. **Perishables** (items with a shelf life) are capped at what gets used before it goes off: daily use (stock used over the last 90 days, or since the oldest movement if sooner; at least a week of history) × shelf life, never below the minimum. With no usage history, something keeping under 90 days only tops up to the normal amount, never the on-offer one.
8. One basket line per listing goes to the provider's `/basket/add`.

Worked examples (the tests): loo roll, minimum 4, stock up to 12, 36 on offer, target £0.32 a roll, 3 in stock; Tesco has 9 rolls at £4.50 and 24 rolls at £9.00 (£7.50 Clubcard). On offer (£0.3125 a roll), so up to 36: 33 needed, one 24-pack and one 9-pack, £12. With 15 in stock: on offer, 21 needed, one 24-pack; not on offer, skipped.

## A shop

**Plan basket** works the basket out without adding anything; **Fill basket** also adds it. Both run in the background, one at a time per provider: wake and check the provider (stopping with what to do when it's logged out), quote, plan, then (filling) add and wait for the provider's job. Everything added is recorded as expected stock from "Tesco delivery", with the booked slot's date and reference when there is one, so it counts towards stock straight away and the order confirmation email or a scan marks it arrived. Then, with **Sleep after** set and nothing else running there, the computer is put back to sleep.

The **summary** (the tool's answer, the app, and the event) lists what was added and why (low, on offer at what price against the target, held back by shelf life, rounded up for a deal), what's on offer, what the shop wouldn't add, what's unavailable, listings to relink, items low at that shop but not linked to anything there, other offers seen, and the slot booked. Runs are kept (the last 30); one left running when Larder stopped is marked as stopped.

In the app, beside a shop's shopping list: **Plan basket**, **Fill basket**, and how the latest went (followed every 3 seconds while it runs).

## Assistant tools

| Tool | |
|---|---|
| `provider_status` | Is the shop's provider running and logged in? Wakes its computer if needed |
| `get_product` | A shop's product by code or link: name, pack, prices, link, picture, and the item it's linked to |
| `link_listing` | Link a shop's product to an item (and add it to favourites), with `pack_quantity` when the pack size isn't clear |
| `set_buying_rules` | Target price, on-offer stock-up amount, pack rule and a shop's own target price. The minimum and normal stock-up amount are `change_item`'s (`stock_up_to`) |
| `plan_basket` | What would go in the basket, without adding anything |
| `fill_basket` | Plan and add it, recording it as on the way |
| `shop_status` | How a plan or fill is going, by `job_id` or the shop's latest |

Tools wait up to 50 seconds for a shop, then answer "Still working…" with a `job_id` for `shop_status`.

## Events

`online-shopping.basket_filled` (`larder_online_shopping_basket_filled` in Home Assistant): `{ shop, run_id, items, total, failed, relink, slot, summary }`, for a notification. `online-shopping.failed`: `{ shop, run_id, code, message, needs_you }`; `needs_you` is true for `login_expired` and `bot_challenge` (log in again, or solve the shop's challenge in the provider's browser).

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
| `GET /options`, `PUT /options` | `{ multibuyOverPercent }` (changing it is for admins) |
| `POST /shops/:shopId/plan`, `POST /shops/:shopId/fill` | Start one; answers the run at once |
| `GET /runs/:id`, `GET /shops/:shopId/latest` | How it's going: `{ status, step, plan, added, failed, summary, error }` |

## Data

`product.fields['online-shopping']`: `{ shops: { <shopId>: { listings: [{ listingId, name, packQuantity, guessed, packSize, link, imageUrl, deadSince, addedAt }], packRule, fixedListingId, targetPrice } }, offerStockUpTo, targetPrice }`. Prices are per one of the item's unit. The item's own `stockUpTo` (core) is the normal stock-up amount.

`online-shopping:runs` (each plan or fill), `online-shopping:bookings` (each provider's booked slot), `online-shopping:settings` (`options`). `online-shopping:providers` collection, one document per provider: `{ id, type, shopId, isDefault, url, token, wake: { entityId, mac, broadcastAddress, timeoutSeconds }, sleepEntityId, loyaltyPrices, status, createdAt }`. Tokens are kept in Larder's data folder, so they're in backups.

## Settings

`LARDER_MODULE_ONLINE_SHOPPING_TOOL_WAIT_MS` (default 50000): how long tools wait for a shop. For tests: `_WAKE_POLL_MS` (default 5000), `_WAKE_TIMEOUT_MS` (overrides every provider's wake timeout) and `_JOB_POLL_MS` (default 3000, how often the provider's job is checked).

## Hooks used

`addRoute` (`admin` for changes), `addTool`, `collection`, `productFields`, `publish`, `core.products.updateField`, `core.lookup.savePhotoFromLink`, `core.stock.expect`, `core.shopping.forShop`, `core.history.product`, `ctx.fetch` (to reach the providers), `ctx.core.homeAssistant.callService` (waking and sleep), `ctx.core.resolve.shop` / `.product`, `ctx.core.shops`; on the web, a Settings panel, a product panel and a shopping panel.
