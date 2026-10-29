# Battery linking

Links battery products (AA, AAA, 9V, CR2032…) to the devices that use them, and says what to do when a device's battery runs low.

- **Data:** links live on the core product field `product.haDeviceIds` (the device ids that take this battery). The module keeps the device list in its `devices` collection: `{ id, name, area, level, low, batteryType, batteryQuantity, updatedAt }`.
- **Where devices come from:** the Home Assistant integration sends every device that has a battery sensor (`PUT /devices`), including the level, whether it's low, and the battery type and count when the Battery Notes integration knows them. Larder itself knows nothing about Home Assistant: any system can send the same list.
- **Routes** (under `/api/v1/modules/batteries`):
  - `PUT /devices` `{ devices: [...] }` replaces the list.
  - `GET /devices` lists devices, low ones first, with the battery products linked to each.
  - `POST /low` `{ deviceId, level? }` marks a device low and answers with advice. Publishes `batteries.low`.
  - `GET /advice/:deviceId` answers with advice without changing anything.
- **Advice** (`kind`): `swap` (a charged rechargeable is ready), `charge` (only flat ones: charge some), `spare` (a new battery is in stock), `on_the_way` (none spare but some are expected), `buy` (none: the battery goes on the shopping list), `unlinked` (no battery type linked to the device yet). Each comes with a `message` to read out or send as a notification. It uses the device's `batteryQuantity` (default 1).
- **Action:** `batteries_replaced` `{ device }` takes the batteries out of stock (rechargeables count as flat until charged) and clears the low flag.
- **Sensor:** `batteries_low`: how many devices are low, with the advice for each.
- **Events:** publishes `batteries.low` (the advice plus `level`). The integration fires it in Home Assistant as `larder_batteries_low`.
- **UI:** a "Used in" panel on battery products to link and unlink devices, suggesting devices whose Battery Notes type matches.
