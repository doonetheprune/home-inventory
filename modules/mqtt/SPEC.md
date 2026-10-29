# MQTT

Publishes Larder's changes to an MQTT broker, for things that listen there (Node-RED, dashboards, home automation without the Home Assistant integration). **Off by default.** Larder's own database stays the source of truth, and the Home Assistant integration stays the main link to Home Assistant; this is an extra feed, with no Home Assistant MQTT discovery.

- **Topics** (prefix `larder`, or `LARDER_MODULE_MQTT_TOPIC`):
  - `larder/status`: `online`, or `offline` (retained; offline is also the last will).
  - `larder/stock/<item>`: `{ id, name, in_stock, expected, unit, low }` (retained), e.g. `larder/stock/toilet_roll`. When an item is renamed or removed its old topic is cleared (an empty retained message). Names that differ only in case or punctuation ("AA batteries", "AA-batteries") share a topic; the old topic of an item renamed while Larder was stopped stays until cleared on the broker.
  - `larder/sensor/<id>`: every sensor the Home Assistant integration has (`low_stock`, `expiring_soon`, `out_of_place`, `shopping_list`, `deliveries`, `batteries_low`…) as `{ state, attributes }` (retained).
  - `larder/event/<type>`: every event (`stock.changed`, `stock.low`, `stock.expiring`, `nfc.scanned`…) as `{ type, at, data }` (not retained).
- **Settings:** `LARDER_MODULE_MQTT_URL` (`mqtt://host:1883` or `mqtts://…`), `_USERNAME`, `_PASSWORD`, `_TOPIC`, `_RETAIN` (default `true`). As a Home Assistant add-on, the Mosquitto broker add-on is found by itself.
- **Package:** uses `mqtt` (MQTT.js), allowed for this module in `tests/architecture.test.ts`.
- **Tests:** against an in-process broker (aedes).
