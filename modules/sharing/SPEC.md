# Sharing

Links shared from a phone go on the wish list. On Android: the share menu (in a shop's app, Chrome, anywhere), then **Home Assistant**. The Home Assistant app fires `mobile_app.share`; the Larder integration sends it here, and tells the phone what happened.

- **What's added:** a wish list item named from the page (its product data, then its title without the shop's name), with the page's picture as its photo, the link (titled with the shop's name), and the price when the page gives one ("£3.50 at Tesco when it was shared (3 Nov 2026)." in its notes).
- **Shared, to check:** shared items wait at the top of the Wish list until someone looks: **Yes, add** keeps one on the wish list; **Already got** opens the Add item screen filled in from it, and saving turns that same item into stock (how many, where, category…), off the wish list; the bin removes one shared by mistake. Items waiting there aren't in the list below as well.
- **Where it came from** is kept in `product.fields.sharing`: the link, the shop, the app and phone it was shared from, when, the price then, and whether it's been checked. The item's page shows it under **From a shared link**.
- **When the page can't be read** (some shops turn robots away, Amazon among them), the shared text names it: "Check out this deal on Amazon: Oatly Barista 1L https://amzn.eu/…" becomes "Oatly Barista 1L". Short links are followed to the real page, and addresses are tidied (tracking bits removed, Amazon's to `/dp/<item>`), so the same thing shared twice is spotted.
- **Not added twice:** the same link, or an item with the same name, answers "… is already on the wish list" (or "already in Larder") and changes nothing.
- **Shares without a link** aren't for Larder: the integration doesn't send them.
- **The notification** goes to the phone that shared, through its `notify.mobile_app_…` action, as "Added … to the wish list." Tapping it opens the item in Larder (as the add-on; elsewhere Larder doesn't know its address inside Home Assistant, so there's no tap).
- **Turning it off:** this module in Settings → Modules, or **Put links shared to Home Assistant on Larder's wish list** in the integration's options.

## Safety

Larder fetches the shared page and its picture itself, so it only goes to the public web: https addresses with a real domain name, not numbered addresses or names inside the home network (`.local`, `.lan`, `.home.arpa`, `router`, …), checked again at every redirect. Pages are read up to 1.5 MB and pictures up to 5 MB, only if they really are pictures.

## Routes

| Route | |
|---|---|
| `POST /api/v1/modules/sharing/:id/confirm` | Keep a shared item on the wish list: it leaves "Shared, to check" (`confirmed: true`) |
| `POST /api/v1/modules/sharing/link` | `{ url?, text?, subject?, app?, device? }`, as the phone shared it. Answers `{ status: "added" \| "exists", message, productId, name, appLink }`. 400 when there's no link |

## Events

`sharing.added` (`larder_sharing_added` in Home Assistant): `{ productId, name, url, site }`.

## Hooks used

`addRoute`, `productFields` (`sharing`), `ctx.fetch`, `core.lookup.savePhotoFromLink`, `core.products.updateField`, `core.homeAssistant.appPath()`, `publish`, a product panel, and the web SDK's `wishList` panel and `useAddItem` with `productId`.
