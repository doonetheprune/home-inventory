---
name: automations
owner: larder-automations
consumers: [home-inventory, larder-provider-tesco, larder-provider-toolstation, larder-pi]
version: 1.4
status: released
---

# Contract: automations

The contract between Larder, Larder Automations and the shop providers. The full text lives in `larder-automations/CONTRACT.md` (1.x), and Larder reads it in `modules/online-shopping/contract.ts`. This page tracks what's planned for 1.5.

## Planned for 1.5

- **Pairing without tokens:**
  1. The hub announces itself on the home network.
  2. Larder asks to pair.
  3. The person presses **Allow** on the device.
  4. Keys are swapped.

  This replaces copying an address and token; tokens keep working.
- **Device status and actions** for Larder's settings: version, providers, running or not, Linux or Mac.
- **Provider catalogue:** the providers this device has, and can install, from a signed catalogue. Install, update and remove.
- **Shop sign-in details:**
  - write-only, encrypted for the device's key
  - the device reports only who's signed in (masked) and when the details were set
- **"Needs you":** a provider asks for a password, a one-time code or a check. Larder answers, or the person takes over in the live view.
- **Run trail:**
  - a line and a small screenshot for each step
  - a full screenshot where the run stopped
  - the last 10 runs kept, fetched on demand
- **Live view:** see `live-view`.

## Changes

- 1.5 (planned): as above.
