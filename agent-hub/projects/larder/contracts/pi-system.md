---
name: pi-system
owner: larder-pi
consumers: [home-inventory, larder-automations]
version: 0.1
status: draft
---

# Contract: pi-system

How Larder's settings change things on the Larder Pi box that only root can.

## Agreed so far

- **The helper:** a small program running as root, listening only on a local socket that only Larder's service user can use.
- **What Larder can read:**
  - Wi-Fi: the network and signal
  - Tailscale: signed in or not, and the address
  - updates: version, channel, last check, and whether one is available
  - disk space and temperature
- **What Larder can do:**
  - change Wi-Fi
  - start Tailscale sign-in; the helper answers with the sign-in link, shown as a QR code
  - check for and apply updates, change channel, roll back
  - factory reset and reboot
- **Elsewhere:** the helper doesn't exist on Docker or Home Assistant, and Larder hides these settings there.

## To write in M2

- the exact calls and answers
- errors
- how Larder finds the socket
- tests

## Changes

- 0.1 (2026-11-07): first draft.
