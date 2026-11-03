# Sharing

Links shared from a phone wait in **Pending**, next to the Wish list, until someone decides: on the wish list, or into Larder as something already got. On Android: the share menu (in a shop's app, Chrome, anywhere), then **Home Assistant**. The Home Assistant app fires `mobile_app.share`; the Larder integration sends it here, and tells the phone what happened.

- **In Pending:** named from the page (its product data, then its title without the shop's name), with the page's picture saved as a Larder photo, the link and shop, and the price when the page gives one. A Pending entry isn't an item: it isn't on the wish list, in stock, in sensors or known to assistants until it's decided.
- **Add to wish list** makes a wish list item with the name, photo, link (titled with the shop) and price ("£3.50 at Tesco when it was shared (2026-11-03)." in its notes).
- **Add to Larder** (got it already) opens the Add item page filled in from it (name, link, photo, price note), to say how many, where, its category and so on. Saving makes the item and takes it out of Pending.
- **The bin** forgets one shared by mistake, and deletes its picture.
- **Where it came from** is kept on the item either way, in `product.fields.sharing`: the link, the shop, the app and phone it was shared from, when, and the price then. The item's page shows it under **From a shared link**.
- **Finding Pending:** next to the Wish list in the sidebar and in More, and the Wish list says "2 shared links in Pending" when there are some.
- **When the page can't be read** (some shops turn robots away, Amazon among them), the shared text names it: "Check out this deal on Amazon: Oatly Barista 1L https://amzn.eu/…" becomes "Oatly Barista 1L". Short links are followed to the real page, and addresses are tidied (tracking bits removed, Amazon's to `/dp/<item>`), so the same thing shared twice is spotted.
- **Not added twice:** the same link (before or after following it), or the same name, answers "… is already in Pending", "… is already on the wish list" or "… is already in Larder" and changes nothing.
- **Shares without a link** aren't for Larder: the integration doesn't send them.
- **The notification** goes to the phone that shared, through its `notify.mobile_app_…` action: "Added … to Pending." Tapping it opens Pending in Larder (as the add-on; elsewhere Larder doesn't know its address inside Home Assistant, so there's no tap).
- **Turning it off:** this module in Settings → Modules, or **Send links shared to Home Assistant to Larder's Pending list** in the integration's options.

## Safety

Larder fetches the shared page and its picture itself, so it only goes to the public web: https addresses with a real domain name, not numbered addresses or names inside the home network (`.local`, `.lan`, `.home.arpa`, `router`, …), checked again at every redirect. Pages are read up to 1.5 MB and pictures up to 5 MB, only if they really are pictures. Forgetting something from Pending deletes its picture too (unless an item, brand or place has come to use it).

## Routes

| Route | |
|---|---|
| `POST /api/v1/modules/sharing/link` | `{ url?, text?, subject?, app?, device? }`, as the phone shared it. Answers `{ status: "pending" \| "exists", message, name, pendingId, productId, appLink }`. 400 when there's no link |
| `GET /api/v1/modules/sharing/pending` | What's waiting, newest first |
| `POST /api/v1/modules/sharing/pending/:id/wish` | Put it on the wish list. Answers `{ productId, name }` |
| `POST /api/v1/modules/sharing/pending/:id/added` | `{ productId }`: it went into Larder as that item (the Add item page calls this after saving). The item keeps where it came from |
| `DELETE /api/v1/modules/sharing/pending/:id` | Forget it |

## Data

`sharing:pending` collection: one document per link waiting. `product.fields.sharing` on items that came from a share.

## Events

`sharing.pending` (`larder_sharing_pending` in Home Assistant): `{ id, name, url, site }`. `sharing.decided`: `{ id, productId, to: "wish" | "larder" }`.

## Hooks used

`addRoute`, `collection`, `productFields` (`sharing`), `ctx.fetch`, `core.lookup.savePhotoFromLink` / `forgetPhoto`, `core.products.create` / `updateField`, `core.homeAssistant.appPath()`, `publish`; on the web, a page next to the Wish list (`section: 'wishlist'`), `wishListPanels`, a product panel, and `useAddItem` with `photoFileId` and `onSaved`.
