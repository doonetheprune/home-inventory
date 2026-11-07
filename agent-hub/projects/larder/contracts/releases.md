---
name: releases
owner: home-inventory
consumers: [larder-cloud, larder-app, larder-pi, larder-automations]
version: 0.2
status: draft
---

# Contract: releases

What each release publishes, so Larder Cloud, the app and (in track B) the Pi box can use it. Larder Automations and the providers publish theirs in the same format.

## Agreed so far

- **From M2:** every version tag gets a GitHub Release with:
  - `larder-web-<version>.tar.gz`: the web app on its own, for Larder Cloud to host at `/v/<version>/` and for the app to load
  - `manifest.json`: the version, each file with its size and SHA-256, and the lowest versions of the other parts it works with (`cloud-link`, and the automations contract)
  - a signature for each file (D18)
- **From B2** (the Pi box): `larder-<version>-linux-arm64.tar.gz` and `larder-<version>-linux-amd64.tar.gz` are added. These are the built server and web app, ready to unpack into `/opt/larder/releases/<version>`.
- **Health:** `/api/health` must answer well enough for the Pi box's updater to decide whether to roll back.
- **Versions move together** across Larder, the add-on and the integration, as they do today. The add-on's version is the version the app loads.

## To write

- the signature scheme
- release channels (stable, beta)
- how long old versions are kept
- the exact health check the updater uses

## Changes

- 0.2 (2026-11-07): the web app bundle comes first (M2); the server tarballs wait for the Pi box (B2).
- 0.1 (2026-11-07): first draft.
