# Larder

A self-hosted home inventory for Home Assistant. It tracks everything in the house, not just food: groceries, household consumables, pet supplies, tools, fuel, batteries, emergency supplies and renewals such as house insurance.

Larder will be made up of:

- a Home Assistant add-on (SQLite storage, REST API, mobile-first web UI through ingress)
- a custom Home Assistant integration installable via HACS (sensors, actions, events)
- a built-in MCP server so Claude and other AI assistants can read and update stock

## Status

**Phase 0: interface design.** Clickable mock-ups are in [`mockups/index.html`](mockups/index.html). Open the file in a browser; every screen is reachable from the menu on the left (or the drop-down on a phone), and the Phone / Desktop switch shows each screen at either size. No application code has been written yet.

The full requirements are in [`docs/BRIEF.md`](docs/BRIEF.md).

## Build phases

0. Interface design (mock-ups, sign-off before any code)
1. Core add-on: data model, REST API, UI, scanning, lookup providers, places, search, shops and shopping list
2. Home Assistant integration: sensors, actions, events, NFC, battery linking
3. MCP server
4. Extras: scenario printing, QR label sheets, recipes, optional MQTT
