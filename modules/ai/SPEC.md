# AI

Name things from a photo of the pack, in the barcode scanner, and add what's on a receipt to stock (see [Receipts](#receipts)). Claude or Gemini reads it: the generic name, brand and size, what it's counted in, its category, roughly how long it keeps, and the shop for a shop's own brand. The scanner's card shows the name to check, then **Add 1** saves it and adds it, like a new barcode. Nothing is saved from a reading until then.

- **Which AI, in what order:** Settings → AI lists Claude and Gemini in the order they're asked (**Ask first** moves one to the top). Each has its own API key and model. If the first can't read the photo (out of credit, key refused, busy, down), the next one is asked, and the Add item page says why the first couldn't. An AI without a key is skipped.
- **Switching one off:** each AI has its own switch. Off means it isn't asked, but its key and model are kept for when it's switched back on. With every AI that has a key switched off, Add by photo and the scanner's **Take photo** are hidden.
- **Models** are listed from each AI's own service (only ones that can read photos), so new ones appear without a Larder update.
- **Default models:** Claude Haiku 5.5 (`claude-haiku-5-5`). For Gemini, the newest plain Flash model in Google's list when first used. The model actually used is saved and shown in Settings.
- **Keys:** pasted in Settings by an admin, or set on the server with `LARDER_MODULE_AI_CLAUDE_API_KEY` / `LARDER_MODULE_AI_GEMINI_API_KEY` (one saved in Settings wins). A saved key is never sent back to the app: Settings shows its last four characters. It's kept in Larder's data folder, so it's in backups.
- **In the scanner** (once an AI is set up), Add mode has a big **Take photo** button under the camera, for things without a barcode (barcodes still scan by themselves): point the camera at the front of the pack and press it, or a volume button or Space where the phone passes those to the page. The photo stays still in the camera view while it's read ("Reading the photo with Claude…"), and the live camera comes back after Add 1 or Skip. A double tap sends one photo. **Or upload a photo** picks one from the phone's photos or files instead. **Add by photo** (on Home and in the sidebar) opens the scanner ready to do this.
- **A barcode nothing knows:** its card has **Read it with AI**. The AI names it from the camera (or a photo), and Add 1 remembers the barcode against that name, so the next scan knows it.
- **What's sent:** the photo is shrunk on the phone to about 1600 pixels as a JPEG, and sent only to the AIs in Settings, one at a time in their order (the next only if one can't). A barcode in the photo is read on the phone (never by the AI); if it's already an item, that item's card is shown instead (In Larder, Add 1).
- **The card:** "New", the name to check (the generic name; the brand and size are shown above it), how many, and where it goes (the shelf scanned last, or none yet: sort it later under Stock → To tidy). If the AI names a shop Larder doesn't have, the card offers **Add Tesco** (a preset shop comes with what it sells; another shop sells the item's category). **Add 1** saves the item with its type, unit, how long it keeps and other names from the reading; the photo becomes the item's photo, and the brand (and barcode) its first brand. Then it's ready for the next. The item's page has **Rotate photo** for a photo that came out sideways.
- **Couldn't read it:** a blurry or unclear photo says so ("It couldn't make it out: check the name"), with its best guess to correct, or Skip to try again.
- **Assistants (MCP):** an assistant that can see a photo doesn't need this module: `add_item` takes `brand`, and asks before adding a shop Larder doesn't have (`new_shop: true` once the person says yes).

## Receipts

**Add from receipt** (on Home and in the sidebar, once an AI is set up) adds what was bought to stock, for things Larder already has. Nothing new is made from a receipt.

- **Photo:** a tall camera view (Take photo, a volume button or Space), or **Upload a photo**. Shrunk on the phone to about 2400 pixels on the long side. A long receipt can be done in two halves; the second keeps the first's shop when it doesn't show one.
- **Reading:** the AI is sent the photo with the household's items (name, unit, other names, up to three brand names; not the wish list; at most 2000), numbered, and the lines matched before. It lists each thing bought (not totals, VAT, payment, carrier bags, coupons or savings), with how many, the price paid, the item's number or none, how much of the item's unit it adds (two 9-roll packs is 18 rolls), and whether it's sure. It's told never to pick the nearest item just to have one: receipts are vague, and no match is fine.
- **Remembered names:** what a line said at a shop ("ANDREX CLASSIC 9PK" at Tesco) and the item it was added as, with how much one of it adds (9 rolls), is kept when the receipt is added. Next time the same words at that shop are matched that way, whatever the AI says ("as before"). The same words at an unknown shop count when they always meant one item.
- **Review:** each line with its item, the words as printed, the price and how many. Matched before, or sure: ticked. A guess: unticked, marked **Check**. Not in Larder: listed as left out, each with **Match** to pick an item by hand (remembered for that shop). **Change** picks another item, or "Not in Larder". The shop can be changed, or added if Larder doesn't have it (**Add Tesco**).
- **Adding:** the ticked lines go in one go (all or none) through the shopping list's purchase, so they go to each item's usual place, and the prices paid are recorded by the pricing module (the first becomes the usual price). Lines for the same item are added together.
- **The same receipt twice:** a receipt with the same shop, date and total as one added before says so, and nothing is ticked.
- **Assistants (MCP):** `add_receipt` adds a receipt the assistant has read itself, by item names, with prices and each line's text (remembered as above). If any line isn't an item, nothing is added and the error says which, so the assistant can leave them out. A shop Larder doesn't have doesn't stop it.

## Order emails

The email module (Settings → Order emails) finds shops' order confirmations in Gmail; this module reads them. It offers a reader to other modules as `ai.order-reader` (`ctx.offer`; the shape is in `modules/_shared/order-email.ts`), so neither imports the other.

- **Reading:** the AI is sent the email as text (marked off as something to read, never instructions; at most 40,000 characters), with the same numbered household items and remembered names as a receipt. It answers the order number, the delivery day and slot (HH:MM to HH:MM), and each line: its item or none, how much of the item's unit, whether it's sure, whether it's **coming** (a substitute too) or **unavailable**, and the day it comes when that isn't with the rest.
- **Remembered names** are shared with receipts: matching a line by hand on the Order emails page remembers it for that shop, as a receipt does.
- Nothing is changed here: the email module decides what to do with the answer.

## Routes

| Route | |
|---|---|
| `GET /api/v1/modules/ai` | Whether it's ready, the order, the one asked first, and per AI: on or off, key set (last four characters), where from, model. Never the key |
| `PUT /api/v1/modules/ai/settings` | Admins. `{ order?: ["gemini", "claude"], claude?: { apiKey?, model?, enabled? }, gemini?: { … } }`. `order` lists the first to ask (any left out follow); `null` forgets a key or goes back to the default model; `enabled: false` switches one off and keeps the rest |
| `GET /api/v1/modules/ai/models?provider=claude` | Admins. Models that can read photos, and the default. Also shows whether the key works |
| `POST /api/v1/modules/ai/receipt` | `{ image: base64 }`, as for identify. Answers shop, date, total, `lines` (text, count, price, `item` `{ id, name, unit }` or null, quantity, `match`: `learnt`, `sure`, `guess` or `none`), `addedBefore` (when the same receipt was added), `receiptKey`, and who read it. Nothing is added |
| `POST /api/v1/modules/ai/receipt/add` | `{ shopId?, receiptKey?, lines: [{ productId, quantity, price?, text?, count? }] }`. Adds them to stock in one go with the prices paid, remembers each line's text for that shop, and remembers the receipt |
| `POST /api/v1/modules/ai/identify` | `{ image: base64 }` (JPEG, PNG, WebP or GIF, checked from its bytes; under about 1.4 MB). Answers name, brand, unit, categoryId, shelfLifeDays, aliases, shop (`id` null if Larder doesn't have it, `preset` if it's a known UK shop), the provider and model that read it, and `skipped`: those asked first that couldn't, and why. When none can, the error says what each said |

## How it talks to the AIs

- **Claude:** the official Anthropic TypeScript SDK (`@anthropic-ai/sdk`, allowed for this module in `tests/architecture.test.ts`), with structured output (a JSON schema from the module's zod schema) and, on models that offer it, low effort for packs and medium for receipts (matching lines takes more thought).
- **Gemini:** Google's REST API (`generateContent` with a response schema), key in the `x-goog-api-key` header, never in the address.
- A photo goes as an image; an order email as text before the request. Both go through `ctx.fetch`, with a 60 second limit. Errors say what to do: a refused key points to Settings → AI, a busy service says to try again.

## Data

- `ai:settings`: one document: the order, which are switched off, keys and models.
- `ai:receipt-names`: how each shop names items on receipts (`<shop id or "any">:<words>` → item, how much one adds, when).
- `ai:receipts`: receipts added, by shop, date and total, to spot one added twice.
