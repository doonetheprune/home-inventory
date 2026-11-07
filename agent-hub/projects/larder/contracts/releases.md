---
name: releases
owner: home-inventory
consumers: [larder-pi, larder-cloud, larder-app, larder-automations]
version: 0.1
status: draft
---

# Contract: releases

What each release publishes, so the Pi image, the updater, Larder Cloud and the app can use it. Larder Automations and the providers publish theirs in the same format.

## Agreed so far

- **Every version tag** gets a GitHub Release with:
  - `larder-<version>-linux-arm64.tar.gz` and `larder-<version>-linux-amd64.tar.gz`: the built server and web app, ready to unpack into `/opt/larder/releases/<version>`
  - `larder-web-<version>.tar.gz`: the web app on its own, for `/v/<version>/`
  - `manifest.json`: the version, each file with its size and SHA-256, and the lowest versions of the other parts it works with (the automations contract, `cloud-link`)
  - a signature for each file (D18)
- **Health:** `/api/health` must answer well enough for the updater to decide whether to roll back.
- **Versions move together** across Larder, the add-on and the integration, as they do today.

## To write

- the signature scheme
- release channels (stable, beta)
- how long old versions are kept
- the exact health check the updater uses

## Changes

- 0.1 (2026-11-07): first draft.
