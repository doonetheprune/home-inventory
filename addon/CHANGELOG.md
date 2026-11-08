# Changelog

## 0.9.2

Assistants keep the boxes. Asked to say how many tea bags are in a box, an assistant counted them as 80 tea bags but didn't say Larder still shows 4 boxes, so when you asked for boxes back it undid it and wrote "20 tea bags per box" in the notes.

- **Assistants are told how packs work** when they connect: count what's inside, say what it comes in, and Larder still shows the boxes, takes amounts in boxes and buys whole boxes. So "keep it in boxes, but there are 20 in one" is a pack, not a note.
- **Changing what something comes in says the boxes are kept** ("80 tea bags in stock (4 boxes of 20)"), and when there's no usage yet the assistant is prompted to ask how many you use a day or week, and whether Larder should take them out for you.
- **"Counted in boxes, 20 to a box"** gets an answer that says how to do it (count the tea bags, comes in a box of 20, recount), instead of a bare refusal.
- **Renaming what something is counted in says what the numbers now read as** ("80 boxes in stock"), so a slip shows straight away.
- **Item lists show packs too:** "Twinings Sleep Tea: 80 tea bags (4 boxes)" in search and list results, as on the item itself.

## 0.9.1

Assistants ask less. The Claude app asks before every use of a tool marked as destructive, which made voice chat stop at nearly everything.

- **Everyday changes aren't marked destructive any more:** using, finishing and moving stock, deliveries arriving, taking something off the shopping list, new batteries going in, and taking a cooked recipe's ingredients out (which you've already agreed to in the chat). Each can be undone by doing the opposite, and stock history keeps them. Removing something or overwriting what was set (removing an item, changing a price, correcting a count) still asks.
- **Working out a recipe's ingredients to take out** (`propose_cooking`) is marked read-only, since it changes nothing.
- **To stop the asking altogether:** in Claude, Customize → Connectors → Larder → Tool permissions, set the groups to **Always allow**. Pressing Allow in a chat doesn't stop it asking next time. See the MCP guide.

## 0.9.0

One way to say how fast things go, for tea bags, sensors and everything else. It replaces 0.8.2's **Each one lasts** and pricing's **measures**, so read **Changed or gone** below.

- **Counted in, Comes in:** count the single thing you use (a tea bag, a roll, a sensor), and say what it **comes in** on the item's Edit page: "a box of 20". Adding 1 box adds 20 tea bags, the item shows "37 tea bags · about 2 boxes", and the shopping list buys whole boxes ("1 box (20 tea bags)"). The scanner's Add, search's + and the quick Add buttons add a box; Use takes one tea bag. Assistants and Home Assistant can say "2 boxes" too (adding, using, moving, ordering, arriving, correcting a count or a purchase), the shopping list they get says "1 box (80 tea bags)", and reading a receipt or order email knows a box of 80 is 80 tea bags.
- **We use:** "We use 1 tea bag every 1 day", or "1 sensor every 2 weeks". It's always in what the item's counted in, so "1 box a day" can't be said by mistake, and the form says what that means: "A box of 20 lasts 20 days." The item says "Enough until 14 Dec", and Running low below shows how long the minimum lasts ("a week's worth").
- **Take them out of stock for me:** switch it on and Larder takes them out by itself each day or period (checked hourly, catching up if Larder was off), so you don't press Use. Use is then only for an extra one. When none are left it stops, and the item is out and on the list; it starts again the day more are added. **Counting from** on Edit says which day it counts from (today when it's switched on). With none started, the next Use starts one and Larder carries on from there.
- **Sensors:** "We use 1 every 14 days" with Larder taking them out shows "One in use until 20 Nov". If one comes off early, **Came off early: start the next one now** takes the next out today. Without Larder taking them out, Use starts one, as before.
- **Counting what's inside:** if something's been counted in boxes, change **Counted in** to tea bags and set **Comes in** a box of 20, then Save: Larder offers "Count them as 40 tea bags", which multiplies the stock, deliveries, minimum, stock-up amount and usage, and the usual price, prices paid, purchase history, online shop packs, recipe amounts and the names learnt from receipts follow. **Keep the numbers, just rename** is the other choice.
- **Barcodes go through your AI too:** with an AI key set up, a barcode Larder doesn't know but Open Food Facts does is read by your AI (Settings → AI → **Read barcode results with AI**, on unless you switch it off). It works out the name, type, how long it keeps, what it's counted in and what it comes in, so scanning a box of PG Tips makes "PG Tips tea bags", counted in tea bags, in boxes of 80, and **Add 1 box (80 tea bags)** adds 80. A fraction of a penny a scan. If the AI can't answer, you get what Open Food Facts said, as before.
- **Add by photo counts what's inside** in the same way: a photo of a box of tea bags makes an item counted in tea bags that comes in boxes, not one counted in boxes.
- The example household has breakfast tea in boxes of 80, two tea bags a day, taken out by Larder.

**Changed or gone**

- **Each one lasts N days** is now **We use 1 every N days**, and **Use the next one automatically** is **Take them out of stock for me**. Your items are changed over when 0.9.0 first starts; nothing to re-enter.
- **Low means below Running low below, only.** Things used one after another used to be low when they'd run out within the warning days. Those items now get a minimum that warns at least as early (a 14-day sensor: low below 1; 30-day contact lenses in Medicine: low below 2). Check those minimums on the items' Edit pages.
- **Home Assistant's `larder_stock_running_out` event is gone.** An automation using it should use `larder_stock_low` instead. **Running low** no longer says "Runs out Fri 18 Dec"; the item page still says when it runs out.
- **Measures are gone from the price card.** "1 pack = 5 items" is now the item's **Comes in** (count the items, comes in packs of 5); Larder's log names each item that had one. A price kept for a measure becomes the usual price if the item had none (£1.20 an item, 5 to a pack, is £6 a pack); otherwise the usual price stays and the measure's own price goes. The weight of one ("1 bag = 200 g") stays. The assistant tools `set_measure` and `remove_measure` are gone (use `change_item` with `comes_in`, and `set_item_size`), as is `list_items` with `running_out`.
- When Larder takes something out by itself, a Use from Home Assistant, an assistant, the scanner or search is an extra one; to start a new one now, say it's opened (`opened: true`).
- The API's `POST /automation/check-expiry` answers `{ expiring, expired, taken }`.
- Going back to 0.8.2 after starting 0.9.0 loses those items' "Each one lasts".

**What to re-enter**

- Anything counted in boxes or packs that you use one at a time (tea bags, capsules, nappies): change **Counted in** to what's inside, set **Comes in**, and choose **Count them as…**. Then set **We use** and, if you like, **Take them out of stock for me**.
- Anything that had measures on its price card: set **Comes in** for "1 pack = 5 items" (with the recount), and a usual price again if you had one per measure.

## 0.8.2

- **Things used one after another:** for a glucose sensor, contact lenses or a water filter, set **Each one lasts** on the item (e.g. 14 days). Using one starts it, and the item says how long the one in use has left and when the rest run out: "One in use until 20 Nov. With 3 more, enough until 1 Jan." The day the one in use was started can be changed on Edit.
- **Use the next one automatically:** switch it on for an item and, when the one in use runs out, Larder takes the next out of stock and starts it that day, so you only press Use for the first. If Larder was off, it catches up; if you'd run out, the next starts the day you add more.
- **They go on the list in time:** when they'll run out within the warning days (Medicine warns 30 days ahead, everything else 7 unless you change it in Settings), counting what's on order, they're low, so they're on the shopping list and under Running low with "Runs out Fri 18 Dec". Home Assistant gets `larder_stock_running_out` once when that happens, and Running low lists the date.
- **Mark one as open:** **Use** has **Opened, still using it** (the butter in the fridge). It comes out of the count and shows "One open since 3 Nov" until **Finished the open one**. With none left but one open, the item is **Last one open** and on the shopping list; only when nothing's open is it **Out**.
- **Purchase history:** every purchase is kept with what it cost, the shop, and the evidence: the receipt's photo (Add from receipt keeps it now), or the online order with its number and the day it was ordered, and its price when the order email or the basket said. Add on an item's page takes a price, shop and receipt photo too. Each item shows what it was bought for, and the new **Purchases** page shows what was spent this month, last month, this year or ever, by shop, item and month. Tap a purchase to correct it or add the receipt's photo later. Home Assistant gets **Spent this month**.
- **Several measures of an item:** on the price card, "1 pack = 1 kg" and "1 pack = 5 items", each with its own price for buying it that way (loose by the kg, singles), or worked out from the usual price. Packs can be checked in any of them ("3 breasts for £3.30").
- **Assistants can do everything the app does:** new tools for opening and finishing, measures and prices, purchase history and spending, lists of items (low, out of place, to sort, open…), what's in a place, what a code is, several things bought at once, batteries, order email lines and online shopping packs, and the missing options on the others (prices, brands, notes, links, moving from To sort…). Home Assistant's actions gain them too: **Finished the open one**, and price, shop and brand on **Add stock**.
- Assistants say when they run out (`get_item`, `search`), and `add_item` and `change_item` can set how long each one lasts.
- The example household has water filter cartridges that last 28 days each, the next starting automatically.
- On a phone, the − + steppers on an item's Edit page no longer push their Clear link off the edge.

## 0.8.1

- **Click and collect:** a shop whose automation can collect (Tesco now) offers **Delivery** or **Click and collect** when you start a shop. For click and collect, the slots say which branch they're for, with its address, and **Collect from** picks another branch. Assistants do the same: "click and collect at the Martlesham one on Saturday". When a day has no delivery slots free, Larder offers click and collect instead. A booked collection slot says where to collect from.
- **Shops with no slots:** a shop that has no delivery or collection slots at all skips choosing a slot and goes straight to filling the basket.
- **Low items with no listing at a shop:** when something low (milk, say) has no listing at the shop, Larder looks in that shop's favourites. If exactly one favourite matches its name, it's linked and bought like any other; if several match, they're listed for you to pick, never guessed between.

## 0.8.0

- **Larder with no connection:** when the Wi-Fi or internet is down, a phone can still open Larder and **Load data from** a copy saved on it. Pick one (newest first) and search, look at items, places, shopping lists, scenarios and recipes as they were when it was saved. A bar at the top says which copy it is; **Change** goes back to the live Larder once it can be reached. Copies are read only.
- **A copy each day:** Larder saves a copy on the phone when you open it and the newest is over a day old, and keeps the newest 10. **Settings → Offline copies** saves one now, opens or removes them, and turns the daily copy off. Signing out removes them.
- **Needs Larder's own https address on the phone,** added to the home screen: the Home Assistant app has to reach Home Assistant before it shows Larder. For the add-on, open its port behind Tailscale, a Cloudflare Tunnel or your reverse proxy and make a Larder account for each person (see the add-on's documentation). Settings → Offline copies says whether a phone can use Larder with no connection.

## 0.7.5

- **Add by photo names the actual product:** a box of Twinings Sleep is "Twinings Sleep tea bags", not "Herbal tea". The name always says the variety or flavour ("Peppermint tea bags", "Semi-skimmed milk"), and keeps the brand when the product is that brand's own blend or range. Everyday things you'd buy any brand of keep a plain name ("Baked beans"), with the brand underneath as before.
- **The plain kind still finds it:** "Herbal tea" becomes one of the item's other names, so searching for it finds the item, and the card offers an item you already keep for that kind ("Is it a brand of something you already have?").
- **It can look things up online:** when the photo doesn't show exactly which product it is or its size, Claude or Gemini searches the web (at most twice a photo, about a penny a search), and the card says where it looked, e.g. "looked up on twinings.co.uk". Switch it off under **Settings → AI → Look things up online**.

## 0.7.4

- **How many in each place:** ask an assistant "where's the green pesto?" and it says "1 jar in Kitchen and 1 jar in Larder", not just the places. Home Assistant's **Find item** does the same.
- **Running out somewhere doesn't forget it:** an item stays in a place at 0 when the last one there is used, ready for more, and the place's page lists it as "None here now". The ✕ beside it takes it off. Moving stock somewhere else for good moves it; something only out of place for now doesn't join where it is.
- **Adding stock to a place is quicker:** the search comes first, and each item found shows how many are here and in total, with − and + for how many should be here and a tick to save. No second step, and you can do several in a row. To sort is under the search until you type.
- A place's page says how many of each thing are here and how many in total when some are elsewhere.

## 0.7.3

- **Safer Home Assistant backups:** Home Assistant now stops Larder while it copies Larder's data (usually a few seconds), then starts it again, so the database can't be copied halfway through a change and every backup restores cleanly. Larder's sensors show as unavailable for those seconds. Backups still include everything: items, stock, places, settings (AI keys and the Gmail sign-in too) and photos, as long as your backups include add-ons.

## 0.7.2

- **Add by photo has a shutter again:** in the scanner's Add mode, a big **Take photo** button sits under the camera, as on Add from receipt, instead of the small **Read with AI** button that was easy to miss. Barcodes still scan by themselves. A volume button or Space takes the photo too.
- **You can see it's been taken:** the photo stays still in the camera view while Claude or Gemini reads it, and the camera and the card both say "Reading the photo with Claude…" instead of "Paused: finish this one first" and "Looking it up…". The live camera comes back after **Add 1** or **Skip**.
- **A double tap sends one photo**, not two.

## 0.7.1

- **Larder Automations:** online shopping now goes through Larder Automations, the hub app on your Mac that runs each shop's automation (Tesco first). Set it up once in Settings → **Larder Automations**: the Mac's address and the hub's token (both from its menu), and how Home Assistant wakes the Mac and puts it back to sleep. **Test connection** shows the automations it runs and whether its Chrome extension is connected, and fills in waking from the Mac's network card. Then **Link to a shop** for each automation (Tesco to your Tesco). A provider not run by Larder Automations can still be added at its own address under **Online shops**.
- **Start a shop** beside a shop's shopping list: pick tomorrow or one of the six days after (or another day in words), see that day's free delivery slots by morning, afternoon and evening, book one, then fill the basket or just plan it. A slot from a day you looked at earlier can still be booked.
- Sheets opened from a side panel (beside a shopping list) no longer sit under the page's own buttons.

## 0.7.0

- **Order emails from Gmail:** Larder can read your shops' order emails. An order confirmation puts what's coming on its way, for the right day and slot, confirming a basket filled through online shopping. What's unavailable comes off the order, so it's bought next time. A delivered or "order complete" email moves the delivery into stock. Set up in **Settings → Order emails**.
- **Step by step:** the page walks through making your own Google Cloud project (free), with links and Copy buttons. Gmail access is read-only, and Larder only opens emails whose subject you name: "this is Tesco's order confirmation", "this is Toolstation's delivered email". After you allow it, Google sends you back through Home Assistant (your Nabu Casa address works) and the Larder integration passes the sign-in on.
- **Only order confirmations go to the AI**, which works out what's coming, what isn't and when. Lines it isn't sure of wait for you to **Match** them, and Larder remembers each shop's names for next time, as with receipts. Delivered emails don't need the AI.
- **Checked when it matters:** every 5 minutes for 2 hours after a basket is filled, and every 5 minutes from 3 hours before a delivery slot to 2 hours after it. The rest of the time it checks every 3 hours. All of these can be changed, and **Check now** checks straight away.
- **Rather not set up Google?** The same page explains how to have Claude do it on a schedule instead, with a prompt to copy.
- Home Assistant gets `larder_email_order_read`, `larder_email_delivered` and `larder_email_failed` events; assistants get `check_order_emails`.
- **Settings → AI:** the switch that turns Claude or Gemini on and off is greyed out while a change is saving, instead of quietly ignoring a second tap.

## 0.6.1

- **Set up a room from inside it:** adding a place opens it, ready for its first spot. Type a spot's name, press Enter, type the next. Each spot's code follows the room's (Loft L: L1, L2…) and can be changed. The pencil beside a spot renames it or changes its code without leaving the page.
- **Stock in a spot:** − and + beside everything that lives there change how many are there. **Add stock here** puts away what's waiting in To sort with one press, or adds more of something you already have. **Scan here** opens the scanner with the spot filled in, so new things go straight onto it; **Put away here** does the same for things moving in for good.
- **To sort:** things added without a place (scanned in a hurry, say) wait in a **To sort** pile at the top of Places until you put them away.
- **A tidier Home on a big screen:** Scan, Add by name, Put away and the other ways to add (Add by photo, Add from receipt) are no longer repeated on Home, since they're at the top of the sidebar (Put away is one of Scan's modes). Home now starts with Going shopping. Phones are unchanged.

## 0.6.0

- **Online shopping:** Larder can fill your online basket, Tesco first, through a shopping provider running on a computer on your network (the `larder-provider-tesco` service with its Chrome extension). Add it in Settings → **Shopping providers**: where it runs, its token, and how Home Assistant wakes that computer (a magic packet to its MAC address, filled in for you by **Test connection**, or a switch or script) and, optionally, puts it back to sleep afterwards.
- **"Do me a shop"** with Claude: it checks the shop is ready (waking the computer if it's asleep), asks when you'd like it delivered, lists the free slots that day in plain words, books the one you agree, then fills the basket with what's low and anything on offer at your target price. It stops at the basket: you check it and pay on the shop's website.
- **Buying rules** on an item's page (Online shopping): paste a Tesco code or link to link the products to buy (a small and a large pack, say), optionally adding them to your Tesco favourites too; choose the cheapest mix of packs or always one; set the price that counts as an offer and how many to stock up to when it's on offer. Clubcard prices, multibuys (3 for £2, buy 2 get 1 free, 25% off 6 or more) and offer dates count. Things that go off are never bought faster than you use them. **Use picture** makes the shop's picture the item's photo.
- **Pending orders:** what goes into the basket becomes a pending order: it counts as bought, so nothing is ordered twice (online or in a shop), but it isn't "on the way" until you confirm it. Home lists pending orders with **Confirm** and **Remove** (the item's page too). The order email confirms it for you: an expected delivery from the same shop confirms what's pending instead of adding it again. Home Assistant gets a **Pending orders** sensor and **Confirm order** and **Remove pending order** actions.
- **Stock up to:** every item can say how many to have after buying more (minimum 4, stock up to 12), next to "Running low below". Shopping lists at every shop now suggest topping up to it, not just back to the minimum.
- **Plan basket** and **Fill basket** beside a shop's shopping list, with **Book a delivery slot**, and a summary of what was bought and why, what was unavailable, and products that have gone from the shop and need linking again.
- **Shop favourites in Pending:** bring in your Tesco favourites (a button, Claude, or a Home Assistant automation on a schedule) and any not linked to an item wait in Pending, to become a new item (with the shop's picture), be linked to one, or be dismissed for good (undo in Settings).
- Home Assistant gets `larder_online_shopping_basket_filled`, `_slot_booked`, `_favourites_pending` and `_failed` events (the last says when you need to log in to the shop again), and the action **Bring in shop favourites**.

## 0.5.3

- **Add from receipt:** take a photo of a till receipt (or an online order) and Claude or Gemini matches each line to the things you already keep, then adds what you tick to stock in one go, with the prices paid. Receipts are vague, so anything it can't place is shown as "Not in Larder" and left out; **Match** picks the item by hand. Nothing new is added from a receipt.
- **It learns your shops' names:** once "ANDREX CLASSIC 9PK" at Tesco has been added as 9 toilet rolls, the next Tesco receipt matches it straight away ("as before"). Guesses are marked **Check** and left unticked.
- Two packs of 9 rolls count as 18 rolls, weighed things by weight, and the same receipt added twice is spotted.
- Assistants can add a receipt they've read with the new `add_receipt` tool.

## 0.5.2

- **Read with AI in the scanner:** a barcode Larder and Open Food Facts don't know has **Read it with AI** on its card. Point the camera at the front of the pack and Claude or Gemini names it; **Add 1** adds it and remembers the barcode, so next time it's known straight away.
- **Add by photo is simpler:** it's now part of the scanner, with the same one-press card as a new barcode (check the name, how many, Add 1, next) instead of a separate camera and the Add item page. In Add mode, **Read with AI** sits under the camera for things without a barcode, with **Or upload a photo** for one you already have. A volume button or Space still takes it. Tidy places and types later under Stock → To tidy, as with scans.
- A shop's own brand from a shop Larder doesn't have yet can be added from the card (**Add Tesco**).

## 0.5.1

- **Quicker scanning:** scan, Add, next. A barcode that's new to Larder is named (from Open Food Facts when it knows it), remembered and added in one press, instead of Save and then Add. The card says plainly whether it's **In Larder** or **New**, where it goes is one line (the shelf you scanned, or its usual place) with **Change** for the odd one, and on a phone it sits at the bottom of the screen so Add is always in reach.
- **To tidy:** a filter on Stock for things added in a hurry: stock with no place, or no type yet.
- **The camera holds still while a card is open**, so a second read, or a misread as the phone moves, can't replace what you're entering ("Paused: finish this one first"). A barcode has to read the same way twice before it counts, the camera only looks for the kinds of code Larder uses, and after Add or Skip the same barcode is left alone for a few seconds while it's still in view. Typed codes and USB or Bluetooth scanners still go straight through.
- **Add by photo opens the camera straight away**, like the barcode scanner, instead of the phone's photo picker (which the Home Assistant app opened for both buttons). **Upload a photo** is its own button for a photo you already have.
- A volume button takes the photo too, like a phone's camera app, where the phone passes the button to the page. Space does on a keyboard.
- **Rotate photo:** turn a photo that came out sideways, on the Add item page before saving, or on the item's page afterwards.
- **Share to Larder:** on Android, share a page from anywhere (a shop's app, Chrome) to **Home Assistant**, and it waits in Larder's new **Pending** list (next to the Wish list), named from the page, with its picture and price. Your phone gets a notification. From Pending, add it to the wish list, or add it to Larder if you've got it (the Add item page, filled in). Either way the item keeps the link and where it came from. Something already in Larder isn't added twice. Turn it off in the integration's options.

## 0.5.0

- **Add by photo:** take a photo of the pack and Claude or Gemini reads it: the name, brand and size, what it's counted in, its category, roughly how long it keeps, and the shop for a shop's own brand. You check it on the Add item page before saving, and the photo becomes the item's photo. If it's a shop you haven't got, Larder asks whether to add it. A barcode in the photo is read on the phone, and if it's something you already have, Larder offers that instead.
- Settings → AI: Claude and Gemini, each with its own API key and model, asked in the order you set. If the first can't (out of credit, say), the next reads the photo, and Larder tells you why. Switch either off for a while without losing its key or model. Larder lists the models each one offers; Claude starts on Haiku 5.5, Gemini on its newest Flash model. Keys are never shown again once saved.
- Assistants can add an item's brand, and ask before adding a shop Larder doesn't have.
- Claude (and other assistants) can do what the app does: add and change shops, places and categories; change anything about an item after adding it (its shop, usual place, minimum…); remove items; brands and barcodes; correct stock; see deliveries and recent changes; make and change scenarios; shop for a recipe.
- Adding an item with a place or category that isn't set up yet no longer leaves it out: Claude is told to offer to add it first.
- Items Claude adds get a photo: from the barcode, like a scan, or, given the brand ("Flahavan's porridge"), from that brand's product in Open Food Facts. With no barcode or brand there's no photo, rather than some other brand's.
- An item's page lists the saved recipes that use it, and a recipe's ingredients open their items.
- Recipes can belong to scenarios, and be kept for them only, so a Halloween recipe isn't on the Recipes list at Christmas. A scenario's page lists its recipes and can add one.

## 0.4.2

- Recipes can have ratios: how much of each ingredient goes in (2 eggs, 100 g flour, 300 ml milk). Tell your assistant "I've only got 2 eggs" and Larder works out the rest, converting between g and kg, ml and pints, tsp and tbsp. In the app, **I've got…** does the same.
- Keep amounts you make often as presets ("Just me", "Family"), and pick one as the default: it's shown, cooked and used by assistants unless you ask for another. Assistants offer to save a preset after working amounts out, and ask which one when there's no default.
- Assistants can change a saved recipe, for example to add ratios to one saved before.

## 0.4.1

- The Claude app (and other assistants that sign in rather than take a pasted token) can connect to Larder through your Home Assistant address, Nabu Casa included: add `https://<your Home Assistant>/api/larder/mcp` as a connector, log in to Home Assistant, and allow it. Claude gets a Larder-only token, not access to the rest of Home Assistant.
- Finding shops' branches tries five free map servers, keeps trying in the background when they're busy, and looks up to 20 miles away.

## 0.4.0

- Scenarios (Power cut, Christmas…): every item, how many and where, with a printable page.
- QR label sheets for places and items, on Avery sheets or plain A4.
- Saved recipes: what's missing, and taking ingredients out of stock after cooking once you confirm.
- Optional MQTT feed, using the Mosquitto add-on automatically.
- AI tools for scenarios and recipes.
- Changes made at the same moment (two automations, a double tap) no longer lose one another.
- Photos from barcode lookups are saved in Larder, so they're in backups and work offline.
- Larder is in every Home Assistant user's sidebar, not only admins'.
- The add-on installs and updates the Larder integration itself, so you don't need HACS. Home Assistant asks for one restart after it changes.
- Stock opens on the types of thing (Food, Household, Tools & DIY…), each listed by place.
- Every shop gets the same "Going shopping?" tile, with how much to buy there.
- Add stock at another place, and say from Home that something has moved.
- Prices per item, per 100 g or per kg, chosen on each item's price card; shelf prices like "£3.50/kg" can be checked; assistants can convert prices between units.
- Shop locations: find a shop's branches near home, make them zones in Home Assistant with one tap, and get that shop's list on your phone when you arrive. Larder makes the automation for you, or gives you the YAML.
- Safer AI connections: no changes from other websites, limits on sign-in requests, and tools that take things away are marked so assistants ask first.

## 0.3.0

- MCP server for AI assistants (Claude, ChatGPT, Gemini CLI, Open WebUI, LM Studio) at `/mcp`, and through Home Assistant at `/api/larder/mcp`.
- Connector sign-in (OAuth) for Claude.ai and ChatGPT when Larder has a public https address.
- Pricing tools: "is this pack cheaper than usual?" and setting the usual price.

## 0.2.0

- First Home Assistant add-on: opens from the sidebar, signed in as your Home Assistant user.
- Tells Home Assistant where it is, so the Larder integration sets itself up.
- Sensors, actions and events through the Larder integration; NFC tags; battery linking.
