---
name: web-transport
owner: home-inventory
consumers: [larder-app, larder-cloud]
version: 0.2
status: draft
---

# Contract: web-transport

How Larder's web app reaches Larder when Larder itself isn't serving it: in the app, or in Larder Cloud in a browser.

## Agreed so far

- **Three sources.** The web app makes every request through one function (`src/web/src/api.ts`). Today that function can go straight to Larder or answer from a saved copy. It gains a third source, the phone's copy:
  - Larder's core runs in the page over the household's records.
  - Changes are sent as API requests.
- **The sync channel.** Before the web app starts, the shell (the app, or Larder Cloud's page) gives it a sync channel. Through it the web app can:
  - load the records, and follow new ones
  - send a change, or a live request
  - see home's status: connected or not, and its version
  - get photos
  - see the route in use: at home, through Larder Cloud, or no connection
- **Versions.** Each Larder release's web app is published at `/v/<version>/`. Shells load the version home reports, and keep it. When home's version changes, the shell switches after sending what's waiting.
- **Live updates** come from the sync channel instead of server events. The web app refreshes its pages the same way as today.
- **Where requests go** is the shell's choice. Straight to Larder for Docker and the Pi box. For the Home Assistant add-on, through Home Assistant at `/api/larder/v1/…` with a Larder token, the way the integration already passes MCP on. The web app sees the same API either way.

## To write in M1 and M3

- the channel's exact TypeScript interface, and how the shell hands it over
- errors: "needs home", "couldn't do"
- photo addresses
- tests both sides run

## Changes

- 0.2 (2026-11-07): requests for the Home Assistant add-on go through Home Assistant.
- 0.1 (2026-11-07): first draft.
