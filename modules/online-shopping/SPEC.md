# Online shopping

Larder fills an online basket from what's low or on offer, books delivery and click and collect slots, and brings in the shop's favourites. Each shop's website is driven by a **shopping provider** behind one fixed contract (`CONTRACT.md` in `larder-automations`). Usually that's an automation (Tesco first: `larder-provider-tesco`) run by **Larder Automations**, the hub app on a Mac, which Larder reaches at one address with one token. Larder holds the stock and the buying rules and makes every decision; the provider does exactly what it's asked and stops at a full basket. Nobody pays automatically.

## Larder Automations

Settings → **Larder Automations** → **Set up Larder Automations**: the Mac's address (`192.168.1.40`; port 8700 unless given; the menu's Copy address), its token (the menu's Copy token; never shown again, only its last four characters), and how Home Assistant wakes the Mac and puts it back to sleep (as for a provider, below). **Save and test** checks it straight away.

- **Test connection** asks the hub's `/health`, `/automations` and `/status`: its version, the automations it runs (and whether each is running), and whether its Chrome extension is connected. Not ready says why in words (wrong token, no automations yet, the extension isn't connected). When waking isn't set up, it's filled in from the Mac's network card (a magic packet to its MAC address, with its broadcast address). **Wake and test** wakes the Mac first.
- Each automation is listed with the shop it shops for. **Link to a shop** picks the Larder shop (Tesco is offered from the presets if Larder doesn't have it), whether it's the default, and loyalty prices. One shop per automation, and one automation per shop. That makes it a provider at `http://<hub>/automations/<id>`, with the hub's token, waking and sleep.
- Waking the Mac belongs to the hub: every automation shares it, and the Mac is put back to sleep only when none of them is working. A linked automation's Test connection that finds the Mac's MAC address fills in the hub's waking.
- **Forget** removes the hub and unlinks its shops; items keep their listings.

## Providers

Settings → **Online shops** lists every shop Larder can shop online at, linked automations included. **Add a provider at its own address** is for a provider not run by Larder Automations: the type (Tesco, or another shop's provider), the Larder shop it serves (one provider per shop; Tesco is added from the presets if Larder doesn't have it), whether it's the default (used when no shop is named; only one is, and the first one added), its address (`192.168.1.231:8710`; port 8710 unless given), its token (the provider's `AUTH_TOKEN`, never shown again, only its last four characters), and whether to count loyalty prices (Clubcard).

- **Test connection** asks `/health` and `/manifest` and keeps the answer as its status: ready, or what's wrong in words (log in again, wrong token, another contract version), with the provider's version, contract version and capabilities. When waking isn't set up and the manifest gives the computer's MAC address (contract 1.3), Larder fills it in.
- **Waking its computer**, through Home Assistant: a magic packet to its MAC address (`wake_on_lan.send_magic_packet`, with an optional broadcast address; needs Home Assistant's Wake on LAN integration), or a switch, button, script or automation. When the provider doesn't answer, Larder wakes it and asks `/health` every 5 seconds until it answers or the wake timeout (3 minutes unless changed) runs out, then says "Couldn't wake the Tesco provider…". Test connection only wakes it when asked (**Wake and test**).
- **Sleep after** (optional): a switch (turned off), button or script that puts it back to sleep after a shop, only when nothing else is running there.
- Contract versions: Larder reads 1.x (`contract.ts`, kept in step with the provider template's `src/contract`). A provider on 2.0 is refused with a message saying to update whichever is older.

## Item settings

On an item's page, **Online shopping** (shown once a provider is set up):

- **Listings**, per shop: the shop's products to buy for this item, linked by pasting a code or link (looked up with the provider; an unknown one is refused, never guessed), optionally adding it to the shop's favourites at the same time. Each says how many of the item one pack gives ("1 pack = 9 rolls"): sure for weights and volumes the item is counted in, and when the name says what's counted ("9 Rolls"); otherwise a guess marked **check this** until someone sets it. A listing belongs to one item. Linking one to an item with no shop makes that shop its shop ("It's bought from Tesco now."); an item already set to other shops keeps them, so a link alone never decides where it's bought. A listing the shop says has gone is marked **Gone from Tesco: link the new one** (Tesco often gives a changed product a new code).
- **Pack rule**, per shop: the **cheapest mix** of listings that covers what's needed (default), or **always the first** (a fixed pack).
- **On offer at**: the target price per one of the item's unit (per kg for things counted in g, per litre for ml). At or below it counts as on offer. Each shop can have its own, which wins.
- **Stock up to, on offer**: how many to have after buying when it's on offer.
- **Stock up to** (the normal amount) is the item's own setting, beside **Running low below** on Edit: Larder's shopping lists suggest topping up to it at every shop, not just back to the minimum. Example: loo roll, minimum 4, stock up to 12, on offer 36.
- **Use picture** makes a listing's picture the item's photo.

## Favourites into Pending

- **Bring in favourites** (`sync_favourites`, a button on the Pending page, or the Home Assistant action `larder.online_shopping_sync_favourites` on a schedule) reads the provider's favourites, fresh from the shop. If the shop can't be reached, the provider's older copy is used and the answer says so.
- A favourite already linked to an item is left out. Any other waits in **Pending**, the Sharing module's list next to the Wish list (or its own **Shop favourites** page, linked from the Wish list, when Sharing is off), with its name, pack size, price, picture and link. The Wish list says how many are waiting.
- From Pending: **New item** opens Add item filled in: a plain name ("Closed Cup Mushrooms" from "Tesco Closed Cup Mushrooms 300G"), the full name as its brand, g or ml for weights and volumes, the shop, the link and the shop's picture as its photo. Saving links it and takes it out of Pending. **Link to an item** links it to one Larder has. **Dismiss** (×) forgets it for good, by shop and code; dismissals are listed in Settings → Online shops with **Undo**, which puts it back in Pending.
- A favourite taken out of the shop's favourites since leaves Pending at the next fresh sync.
- When the shop gives a product a new code it shows up as a new favourite. Linking it to the item replaces the item's gone listing (the only one, or the gone one with the same pack size).
- **Add to favourites** from Larder: pasting a code or link onto an item can also add it to the shop's favourites (Online shopping on the item's page, or `link_listing`), and `add_to_favourites` adds one by code or link, linking it to an item if named, else leaving it in Pending. A provider without `add_favourites` says so.

## Delivery and click and collect slots, and "do me a shop"

1. The person asks an assistant for a shop. `start_shop` uses the default online shop unless one is named, checks it's ready (waking its computer), and says to ask when they'd like it delivered.
2. With `when` ("tomorrow evening", "friday", "12 Nov", a date), it lists the free slots that day, in the shop's own words for the day ("Friday 6 November, evening (17:00 onwards)") so a misread shows. `list_slots` does the same on its own.
3. The assistant suggests one and books it with `book_slot` once the person agrees. Only a slot from the last list can be booked (Larder needs to know when it is). The booking is kept for that provider until its day has passed; plans and fills check offers for that day and record deliveries as expected then, with the booking reference.
4. `fill_basket` runs the order logic, fills the basket, records it as a pending order and answers the summary; then the computer goes back to sleep when set up. The person checks out on the shop's website; the order email (or Confirm) makes the pending order on its way.

The person says when they're free; Larder doesn't look at calendars. A provider without `slot_booking` says to book on the shop's website.

**Shops with no slots** (the manifest's `uses_slots: false`, contract 1.4): some shops have no delivery or collection slots at all; the order just comes, or is ready to collect, once it's checked out. Then `start_shop` says there's no slot to pick and goes straight to `fill_basket`, `list_slots` and `book_slot` say the same, offers are checked for today, and summaries don't mention a slot. In the app there's no slot row: **Start a shop** opens the basket step. This is kept to what the provider says on **Test connection**; a provider that hasn't said is treated as having slots.

**Click and collect** (providers with `click_and_collect`, contract 1.4): `start_shop` and `list_slots` take `method: "collection"` for collection slots instead, at the shop's usual branch or the one named in `branch` ("southport", or a branch id). The answer names the branch the slots are at, with its address, and the other branches that can be asked for, so "check Formby instead" is another `list_slots` with `branch: "formby"`; a name that could be more than one branch, or none, comes back with the branches to choose from. When a day has no delivery slots free and the provider can collect, the answer tells the assistant to offer click and collect. Booking is the same `book_slot`, and the booking remembers the branch: summaries say "for collection from Southport Extra on Friday 6 November, 17:00–18:00". What goes in the basket is still a pending "Tesco delivery" order (the order email confirms it the same way).

In the app, beside a shop's shopping list: **Start a shop** opens the day picker: **Tomorrow** and the six days after (or another day in words), each day's free slots by morning, afternoon and evening, with their price, and **Book**. Each day is asked once while it's open (the shop's website is slow, and the first ask may wake the Mac). After booking (or straight away with a slot booked, when the button says **Fill basket**): **Fill basket** or **Just plan it**. **Change slot** goes back to the days. Slots listed in the last hour can be booked, whichever day (or branch) was looked at last. With a provider that can collect, **Delivery** and **Click and collect** switch between the two; collection shows **Collect from** with the nearby branches to choose from, and a day with no delivery slots free offers **Try click and collect**.

## Order logic

`plan.ts`, on its own so it's tested on its own. For each item with a listing at the shop that belongs on that shop's list (one of its shops, or "any shop" and the shop sells its category, the same as the shopping list):

1. **Candidate** when it's low (stock plus on order below the minimum), on the list by hand, or has a target price and stock plus on order is below its on-offer amount. Only candidates are quoted, to keep traffic to the shop low.
2. **Quote** all its listings.
3. **Level**: on offer (the best price per unit, using the loyalty price and a multibuy's per-unit price, at or below the target) → the on-offer amount. Not on offer but low or on the list → the normal amount (stock up to, else the minimum). Otherwise it's skipped. Loyalty prices and offers only count when valid on the delivery day (the booked slot's, else today) and, for loyalty ones, when the provider's **Loyalty prices** is on. "Other" deals are ignored but listed in the summary.
4. **Needed** = level − stock − on order. Something on the list by hand gets at least one pack, and once it's in the basket it comes off the list (as when ticked off in a shop), so it isn't bought again.
5. **Packs**: a fixed pack buys enough of that listing; the cheapest mix tries every mix of the six cheapest listings (up to 99 packs each) and takes the cheapest that covers it, then the one least over, then the fewest packs. Unavailable listings are left out; gone ones (`listing_dead`) are marked on the item for relinking.
6. **Multibuys** (3 for £2, buy 2 get 1 free, 25% off 6 or more) are rounded up to complete the deal when that keeps stock within the household's allowance over the level (**Multibuys may go over by**, 25% unless changed).
7. **Perishables** (items with a shelf life) are capped at what gets used before it goes off: daily use (stock used over the last 90 days, or since the oldest movement if sooner; at least a week of history) × shelf life, never below the minimum. With no usage history, something keeping under 90 days only tops up to the normal amount, never the on-offer one.
8. One basket line per listing goes to the provider's `/basket/add`.

Before that, an item low at the shop with no listing there (milk from any shop) is matched to the shop's favourites waiting in Pending (the provider's copy, brought in first): when every word of its name, or else of one of its aliases, is in exactly one favourite's name ("Whole milk" in "Tesco British Whole Milk 4 Pints"), that favourite is linked to it (as **Link to an item** would, so it's remembered) and it's planned like any other. Several matching are listed for the person to link one, never guessed between; none matching, it's listed as not linked. Plan basket links them too.

Worked examples (the tests): loo roll, minimum 4, stock up to 12, 36 on offer, target £0.32 a roll, 3 in stock; Tesco has 9 rolls at £4.50 and 24 rolls at £9.00 (£7.50 Clubcard). On offer (£0.3125 a roll), so up to 36: 33 needed, one 24-pack and one 9-pack, £12. With 15 in stock: on offer, 21 needed, one 24-pack; not on offer, skipped.

## A shop

**Plan basket** works the basket out without adding anything; **Fill basket** also adds it. Both run in the background, one at a time per provider: wake and check the provider (stopping with what to do when it's logged out), quote, plan, then (filling) add and wait for the provider's job. Everything added becomes a **pending order** from "Tesco delivery" (a core stock state), with the booked slot's date and reference when there is one: it counts towards stock straight away, so nothing is ordered twice, online or in a shop, but it isn't on the way until it's confirmed. Once checked out, **Confirm** it (Home, the item's page, `confirm_order`, or the order email's automation calling `add_expected`, which confirms rather than adds); if the basket wasn't checked out, **Remove** it (`cancel_order`) and anything still low is bought next time. Then, with **Sleep after** set and nothing else running there, the computer is put back to sleep.

The **summary** (the tool's answer, the app, and the event) lists what was added and why (low, on offer at what price against the target, held back by shelf life, rounded up for a deal), what's on offer, what the shop wouldn't add, what's unavailable, listings to relink, items linked from the shop's favourites, items low at that shop but not linked to anything there (with the favourites that match, when several do), low items linked there but bought at another shop, other offers seen, and the slot booked. Runs are kept (the last 30); one left running when Larder stopped is marked as stopped.

In the app, beside a shop's shopping list: **Start a shop** (or **Fill basket** once a slot is booked), **Plan basket**, and how the latest went (followed every 3 seconds while it runs).

## Assistant tools

| Tool | |
|---|---|
| `provider_status` | Is the shop's provider running and logged in? Wakes its computer if needed |
| `get_product` | A shop's product by code or link: name, pack, prices, link, picture, and the item it's linked to |
| `link_listing` | Link a shop's product to an item (and add it to favourites), with `pack_quantity` when the pack size isn't clear |
| `set_buying_rules` | Target price, on-offer stock-up amount, pack rule and a shop's own target price. The minimum and normal stock-up amount are `change_item`'s (`stock_up_to`) |
| `start_shop` | Begin "do me a shop": ready?, then when, then the free slots |
| `list_slots` | Free delivery slots for a day, in everyday words or YYYY-MM-DD; with `method: "collection"`, click and collect slots at the usual branch or `branch` |
| `book_slot` | Book one (delivery or collection) from the last list, once the person agrees |
| `sync_favourites` | Bring the shop's favourites into Pending |
| `add_to_favourites` | Add a product to the shop's favourites by code or link, linking it to an item or leaving it in Pending |
| `plan_basket` | What would go in the basket, without adding anything |
| `fill_basket` | Plan and add it, recording it as on the way |
| `shop_status` | How a plan or fill is going, by `job_id` or the shop's latest |

Tools wait up to 50 seconds for a shop, then answer "Still working…" with a `job_id` for `shop_status`.

## Home Assistant

Action `larder.online_shopping_sync_favourites` (`shop`, optional): for a weekly automation.

## Events

`online-shopping.basket_filled` (`larder_online_shopping_basket_filled` in Home Assistant): `{ pending_order, shop, run_id, items, total, failed, relink, slot, summary }`, for a notification (with `sensor.larder_pending_orders` for a reminder to confirm it). `online-shopping.slot_booked`: `{ shop, slot, start, end, reference, reserved_until, method, store }` (`method` is `delivery` or `collection`, `store` the branch for collection; `slot` in words, `start` and `end` as the shop gives them, e.g. `2026-11-06T09:30`); the email module watches for that delivery's email. `online-shopping.favourites_pending`: `{ shop, added, pending }` when new favourites are waiting. `online-shopping.failed`: `{ shop, run_id, code, message, needs_you }`; `needs_you` is true for `login_expired` and `bot_challenge` (log in again, or solve the shop's challenge in the provider's browser).

## Routes

Under `/api/v1/modules/online-shopping`. Changing providers is for household admins.

| Route | |
|---|---|
| `GET /hub` | Larder Automations (never its token) and its automations, with the shop each is linked to |
| `PUT /hub` | `{ address, token?, wake?, sleepEntityId? }`. A new address or token clears the status |
| `DELETE /hub` | Forget it, unlinking its shops |
| `POST /hub/test` | `{ wake? }`. Answers the hub and its automations, whether it woke, whether waking was filled in, and a sentence |
| `GET /providers` | Providers (never their tokens) and the types that can be added |
| `POST /providers` | `{ type, shopId, automation }` for an automation, or `{ type, shopId, address, token, wake?, sleepEntityId? }`; both with `isDefault?`, `loyaltyPrices?` |
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
| `GET /shops/:shopId/slots?when=&method=&branch=` | Free and taken slots for a day: delivery, or click and collect at a branch (with the branch, the others nearby, and `offerCollection` when delivery is full) |
| `POST /shops/:shopId/book` | `{ slotId }` from the last list |
| `GET /shops/:shopId/booking` | The booked slot, while it's to come |
| `GET /pending` | Shop favourites waiting in Pending |
| `POST /shops/:shopId/favourites/sync` | `{ refresh? }`: bring them in |
| `POST /pending/:id/link` | `{ productId }`: link it to an item |
| `POST /pending/:id/photo`, `POST /pending/:id/added` | Save its picture for Add item; then `{ productId }` of the item made |
| `POST /pending/:id/dismiss` | Never suggest it again |
| `GET /dismissed`, `DELETE /dismissed/:id` | Dismissed ones, and undoing one |
| `GET /runs/:id`, `GET /shops/:shopId/latest` | How it's going: `{ status, step, plan, added, failed, summary, error }` |

## Data

`product.fields['online-shopping']`: `{ shops: { <shopId>: { listings: [{ listingId, name, packQuantity, guessed, packSize, link, imageUrl, deadSince, addedAt }], packRule, fixedListingId, targetPrice } }, offerStockUpTo, targetPrice }`. Prices are per one of the item's unit. The item's own `stockUpTo` (core) is the normal stock-up amount.

`online-shopping:pending` and `online-shopping:dismissed` (favourites, by `<shopId>:<code>`), `online-shopping:runs` (each plan or fill), `online-shopping:bookings` (each provider's booked slot), `online-shopping:slots` (each provider's slots listed in the last hour), `online-shopping:settings` (`options`, and `hub`: `{ url, token, wake, sleepEntityId, status }`). `online-shopping:providers` collection, one document per provider: `{ id, type, shopId, isDefault, automation, url, token, wake: { entityId, mac, broadcastAddress, timeoutSeconds }, sleepEntityId, loyaltyPrices, status, createdAt }`; an automation's `url` and `token` are empty and its waking unused (the hub's are). Tokens are kept in Larder's data folder, so they're in backups.

## Settings

`LARDER_MODULE_ONLINE_SHOPPING_TOOL_WAIT_MS` (default 50000): how long tools wait for a shop. For tests: `_WAKE_POLL_MS` (default 5000), `_WAKE_TIMEOUT_MS` (overrides every provider's wake timeout) and `_JOB_POLL_MS` (default 3000, how often the provider's job is checked).

## Hooks used

`addRoute` (`admin` for changes), `addTool`, `collection`, `productFields`, `publish`, `core.products.updateField`, `core.lookup.savePhotoFromLink`, `core.stock.expect` (`pending`), `core.shopping.forShop`, `core.history.product`, `ctx.fetch` (to reach the providers), `ctx.core.homeAssistant.callService` (waking and sleep), `ctx.core.resolve.shop` / `.product`, `ctx.core.shops`; `addAction`; on the web, a Settings panel, a product panel, a shopping panel, a panel in the `sharing.pending` slot, a hidden page and a Wish list panel.
