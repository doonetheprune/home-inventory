# Larder and Home Assistant

Two parts, used together or separately:

- **The Larder add-on** runs Larder inside Home Assistant. It opens from the sidebar (and in the companion app, and through Nabu Casa), signed in as your Home Assistant user. Home Assistant backups include its data.
- **The Larder integration** connects Home Assistant to a Larder, wherever it runs, for sensors, actions, events, NFC tags and battery linking.

If you run Home Assistant Container (no add-ons), run Larder with Docker ([running.md](running.md)) and add the integration by hand.

## Install the add-on

1. Settings → Add-ons → Add-on store → ⋮ → **Repositories**, and add `https://github.com/doonetheprune/home-inventory`.
2. Find **Larder**, install it, and start it. Turn on **Show in sidebar**.
3. Open Larder from the sidebar. Home Assistant offers to set up the Larder integration (Settings → Devices & services → Discovered): click **Configure**, then **Submit**. No address or token needed: the add-on hands them over.

While the GitHub repository is private, Home Assistant can't download the add-on's image. Either make the repository (and its package on GitHub) public, or add the registry in Home Assistant: Settings → Add-ons → Add-on store → ⋮ → **Registries**, server `ghcr.io`, your GitHub username, and a GitHub token that can read packages.

### Add-on options

| Option | What it does |
|---|---|
| Log level | How much goes in the add-on log. `debug` logs every request. |
| Larder's own backups | Off by default, because Home Assistant backups already include Larder's data. Turn on to also keep seven daily copies inside the add-on. |
| Address for QR labels | Optional https address that reaches Larder directly, printed on QR labels. |
| Load the example household | Fills an empty Larder with example items to try it with. |
| Larder admins | Home Assistant usernames who can change Larder's settings, accounts and modules. Empty means everyone. Others can still use and change stock. |
| Modules that stay off | Module ids that can't be switched on in the app. |
| Extra settings | Advanced: any other `LARDER_` setting, such as a module's. |

The **Network** section can open port 8080 on your network, for MCP clients, scripts and Node-RED outside Home Assistant. Leave it empty unless you need it; callers need an access token from Larder (Settings → Access tokens).

### Who's signed in

People who open Larder from Home Assistant are signed in as their Home Assistant user (Larder trusts this only for connections that come from Home Assistant's Supervisor). They're Larder admins unless the **Larder admins** option lists who is. They can make access tokens in Larder's Settings. Anyone reaching the add-on's port directly needs a token, or a Larder account an admin made.

## Add the integration by hand

For Larder running outside Home Assistant (Docker, another machine):

1. In Larder, Settings → Access tokens → make one called "Home Assistant".
2. Install the integration: with HACS (add this repository as a custom repository, category Integration) or by copying `custom_components/larder` into your Home Assistant `config/custom_components/` folder. Restart Home Assistant.
3. Settings → Devices & services → Add integration → **Larder**. Enter Larder's address (for example `http://192.168.1.20:8080`) and the token.

## Sensors

All on one **Larder** device. Each number comes with the items behind it as attributes (up to 25).

| Sensor | Number | Attributes |
|---|---|---|
| `sensor.larder_running_low` | Items below their minimum (deliveries on the way count) | `items`: item, in_stock, expected, minimum, unit |
| `sensor.larder_use_soon` | Items expiring soon, already expired, or due for renewal | `items`: item, expires_on, days, category, place |
| `sensor.larder_out_of_place` | Things somewhere other than their usual place | `items`: item, usually, now |
| `sensor.larder_shopping_list` | Everything to buy | `suggested_shop`, `shops` (how many each can supply), `no_shop` |
| `sensor.larder_deliveries_on_the_way` | Orders not arrived yet | `deliveries`: source, eta, items |
| `sensor.larder_batteries_low` | Devices with a low battery (battery linking module) | `devices`: device, battery, advice, message |

Modules can add more; they appear without updating the integration. Larder doesn't send notifications itself: use these sensors and the events below in your own automations.

## Actions

Every action takes names the way you'd say them: an item by name, alias, barcode or id (`loo roll`), a place by name or code (`G2-4`, `Garage › Racking`), a shop by name (`aldi`). Only an exact name, or one that contains every word you gave ("drill" for Cordless drill), is acted on. If a name could mean more than one thing, or is only close (a typo, "AA" when there are only AAA batteries), the action fails and says which ones it could be, rather than guessing.

Every action can return Larder's answer, including a `message` for a notification or a voice reply.

| Action | Fields |
|---|---|
| `larder.add_stock` | item, quantity (1), place, expires_on, note |
| `larder.use_stock` | item, quantity (1), place |
| `larder.move_item` | item, to, quantity (all), permanent (false) |
| `larder.put_back` | item |
| `larder.add_expected` | item, quantity (1), source, reference, eta |
| `larder.mark_arrived` | source, or item and quantity |
| `larder.add_to_shopping_list` / `larder.remove_from_shopping_list` | item |
| `larder.mark_charged` | item, quantity (1) |
| `larder.renew` | item |
| `larder.find_item` | item |
| `larder.shopping_list_for` | shop |
| `larder.batteries_replaced` | device (battery linking module) |

```yaml
# Say what's in the house when someone asks
action: larder.find_item
data:
  item: kerosene
response_variable: larder
# then: {{ larder.message }} → "Heating oil: 400 L in stock. In Garden › Oil tank."
```

From Node-RED, use an **action** node with the action `larder.use_stock` and data `{"item": "dog food", "quantity": 1}`. Tick "return response" to get Larder's answer.

## Events

Larder's changes are fired in Home Assistant as `larder_<type>`:

| Event | When | Data |
|---|---|---|
| `larder_stock_changed` | Any stock change | productId, name, kind (add, use, move…), inStock, expected, unit, low |
| `larder_stock_low` | An item has just dropped below its minimum | same as above |
| `larder_stock_restocked` | It's back above its minimum | same as above |
| `larder_stock_expiring` | An item has just come within its warning window (once per batch) | productId, name, expiresOn, daysToExpiry, category, place |
| `larder_stock_expired` | An item expires today (once per batch) | same as above |
| `larder_shopping_purchased` | A shopping trip was ticked off | shopId, items |
| `larder_nfc_scanned` | A tag was scanned | tagId, device, kind (product, place, unknown), id, name, path |
| `larder_batteries_low` | A linked device's battery is low | deviceId, device, kind, battery, place, message, level |
| `larder_product_created`, `larder_product_updated`, `larder_place_changed`, … | Catalogue changes | ids and names |

```yaml
# Tell the family phone when something runs low
triggers:
  - trigger: event
    event_type: larder_stock_low
actions:
  - action: notify.family
    data:
      message: "{{ trigger.event.data.name }} is running low ({{ trigger.event.data.inStock }} left)."
```

Expiry is checked every hour, so `larder_stock_expiring` arrives within an hour of an item becoming due.

## NFC tags

Tags scanned with the Home Assistant companion app are sent to Larder (turn this off in the integration's options).

- **A known tag** fires `larder_nfc_scanned` with the product or place it belongs to, so an automation can act on it (open the place, use one, announce what's in the box).
- **A new tag** is offered in Larder for 15 minutes: open the product or place, **NFC tags → Link a tag**, scan it, then **Link**. On Android, Chrome can also read the tag itself ("Read it with this phone").

Tags written by the Home Assistant app keep the same id in both, so a tag works for Larder and for Home Assistant's own tag automations.

## Battery linking

With the battery linking module on (it is by default), the integration sends Larder every device that has a battery sensor, with its level.

1. In Larder, open a battery product (AA batteries, CR2032…) and under **Used in**, link the devices that take it. Devices that the Battery Notes integration says take that type are marked **Matches**.
2. When a device drops below 20% (or a "battery low" sensor turns on), Larder works out what to do and fires `larder_batteries_low`:
   - rechargeable with charged spares: swap them in;
   - rechargeable but all flat: charge some;
   - spares in stock: where they are;
   - none, but some on the way: say so;
   - none at all: they go on the shopping list.
3. After swapping batteries, call `larder.batteries_replaced` with the device, or use stock in Larder as usual.

Change the threshold in the integration's options.

```yaml
triggers:
  - trigger: event
    event_type: larder_batteries_low
actions:
  - action: notify.mobile_app_phone
    data:
      title: Battery low
      message: "{{ trigger.event.data.message }}"
```

## Troubleshooting

- **Sensors unavailable:** Larder can't be reached. Check the add-on (or container) is running and the address is right (Settings → Devices & services → Larder → ⋮ → Reconfigure).
- **"Larder no longer accepts the access token":** the token was revoked. Make a new one in Larder and enter it when Home Assistant asks.
- **An action says an item "could be" several things:** use a fuller name, or the item's id from its page in Larder.
- **No `larder_batteries_low` events:** check the battery product is linked to the device under **Used in**, and that the device has a battery sensor in Home Assistant.

## For developers

- The integration only uses Larder's REST API: `GET /api/v1/automation` (sensors and actions), `GET /api/v1/automation/state`, `POST /api/v1/automation/actions/<id>`, the live events at `GET /api/v1/events`, `POST /api/v1/nfc/scanned` and the battery module's routes. See [api.md](api.md).
- Sensors and actions come from Larder at runtime, so a module adds them with `ctx.addSensor` and `ctx.addAction` ([modules.md](modules.md)) and the integration picks them up. `custom_components/larder/services.yaml` is generated from the same list (`npm run ha:services`; a test fails if it's stale).
- Tests: `tests/ha` runs Home Assistant's test harness against a real Larder server (`pip install -r requirements-test.txt`, then `python -m pytest`). CI also runs Home Assistant's `hassfest`, HACS validation and the add-on linter.
