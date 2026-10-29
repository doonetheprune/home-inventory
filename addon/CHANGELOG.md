# Changelog

## 0.4.0

- Scenarios (Power cut, Christmas…): every item, how many and where, with a printable page.
- QR label sheets for places and items, on Avery sheets or plain A4.
- Saved recipes: what's missing, and taking ingredients out of stock after cooking once you confirm.
- Optional MQTT feed, using the Mosquitto add-on automatically.
- AI tools for scenarios and recipes.
- Changes made at the same moment (two automations, a double tap) no longer lose one another.
- Photos from barcode lookups are saved in Larder, so they're in backups and work offline.
- Larder is in every Home Assistant user's sidebar, not only admins'.
- Stock opens on the types of thing (Food, Household, Tools & DIY…), each listed by place.
- Every shop gets the same "Going shopping?" tile, with how much to buy there.
- Add stock at another place, and say from Home that something has moved.
- Prices per item, per 100 g or per kg, chosen on each item's price card; shelf prices like "£3.50/kg" can be checked; assistants can convert prices between units.
- Safer AI connections: no changes from other websites, limits on sign-in requests, and tools that take things away are marked so assistants ask first.

## 0.3.0

- MCP server for AI assistants (Claude, ChatGPT, Gemini CLI, Open WebUI, LM Studio) at `/mcp`, and through Home Assistant at `/api/larder/mcp`.
- Connector sign-in (OAuth) for Claude.ai and ChatGPT when Larder has a public https address.
- Pricing tools: "is this pack cheaper than usual?" and setting the usual price.

## 0.2.0

- First Home Assistant add-on: opens from the sidebar, signed in as your Home Assistant user.
- Tells Home Assistant where it is, so the Larder integration sets itself up.
- Sensors, actions and events through the Larder integration; NFC tags; battery linking.
