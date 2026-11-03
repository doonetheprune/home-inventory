# Changelog

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
