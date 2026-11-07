---
name: live-view
owner: larder-automations
consumers: [home-inventory, larder-cloud, larder-app]
version: 0.1
status: draft
---

# Contract: live-view

Seeing a provider's browser from Larder, and using it when needed.

## Agreed so far

- **What's shown:** only the provider's tab, never the device's desktop. A Pi may later optionally show its whole virtual screen.
- **Frames:**
  - JPEGs from Chrome's screencast, with the page size and address.
  - Sent only when the page changes.
  - The device sends the next frame only once the last one has arrived.
- **Input:** taps and drags (as mouse events at page coordinates), scrolling, typed text and special keys.
- **Control:**
  - It opens just watching.
  - **Take control** pauses the run where it is; **Hand back** resumes it.
  - The session ends after a few minutes with nothing happening.
- **Who:**
  - admins only
  - each session recorded in Larder's history
  - shown on the device while it's open
- **How it travels:**
  - At home: app → Larder → device, over a connection that stays open.
  - Away: app → Larder Cloud's relay → Larder → device.
  - Either way, encrypted end to end between the phone and the device.
- **Run trail:**
  - a line and a small screenshot for each step
  - a full screenshot where the run stopped
  - the last 10 runs, kept on the device

## To write in M1

- message formats and encryption
- limits on frame size and rate
- errors
- tests

## Changes

- 0.1 (2026-11-07): first draft.
