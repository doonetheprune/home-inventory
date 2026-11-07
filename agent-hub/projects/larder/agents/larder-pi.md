# larder-pi: brief

**Repo:** `doonetheprune/larder-pi` (new; can wait) · **Project:** larder · **Track B:** runs alongside the main track whenever there's time.

## Mission

The Larder Pi box is an optional way to run Larder, alongside the Home Assistant add-on and Docker. It's an image you flash with Raspberry Pi Imager. It joins the Wi-Fi, runs Larder and the shopping automations, and keeps itself up to date safely. No monitor is needed. Nothing in the main track depends on it.

## Read first

- In the hub, `PLAN.md`: The Larder Pi box.
- In `home-inventory`: `docs/running.md`.

## Contracts

- **Owns:** `pi-system`.
- **Uses:** `releases`, for both Larder's and the automations' releases.

## Tasks

Tick tasks as you finish them; that's the only change you make to this file.

### B0 — Try

- [ ] Spike S1, with `larder-automations` and `larder-provider-tesco` (board 21).
- [ ] Measure a 4 GB Pi 4 and a Pi 5 running Larder plus one shop, so the owner can choose the main hardware (D12).

### B2 — The Larder Pi box

- [ ] pi-gen with a Larder stage, built by GitHub Actions on each version tag, with the `.img.xz` attached to the release.
- [ ] Raspberry Pi OS 64-bit, with a light desktop session that logs in by itself so Chromium can run.
- [ ] Node 24, and Larder in `/opt/larder/releases/<version>` with a `current` link, running as a systemd service with its data in `/var/lib/larder`.
- [ ] Larder Automations and the providers as systemd services, and Chromium with a persistent profile and the extension, started with the desktop session.
- [ ] avahi, so the box is `larder.local`. Tailscale installed but not signed in.
- [ ] Wi-Fi set-up (D13):
  1. With Ethernet plugged in, go straight on.
  2. Otherwise scan for networks first, then start the hotspot `Larder-XXXX`, with its password on a card in the box.
  3. A captive portal asks for the network, its password and the country (GB by default).
  4. Connect without a reboot, then show "Connected: open http://larder.local" with a QR code.
  5. With a wrong password, bring the hotspot back with an error.
  6. If the saved network isn't seen for a few minutes after boot, bring the hotspot back.
- [ ] A factory reset that clears Wi-Fi and data, from a button or a file on the boot partition.
- [ ] The updater, running as root:
  - checks GitHub Releases daily
  - verifies signatures (D18)
  - rolls back if Larder doesn't come back healthy
- [ ] The system helper (`pi-system` 0.x): runs as root, listens only on a local socket, and serves Larder's settings for Wi-Fi, Tailscale sign-in and status, updates, factory reset and reboot.
- [ ] Where the key to shop sign-in details lives (D11), including a TPM board if that's chosen.

### Later

- [ ] The whole virtual screen through noVNC (board 26), with `larder-automations`.
- [ ] A "Larder only" image for a Zero 2 W.

## Boundaries

- Larder and Larder Automations run as their own unprivileged users. Only the updater and the helper run as root.
- Nothing listens on the internet. Tailscale stays off until someone signs in.

## Who to ask

- `home-inventory`: releases, and Larder's settings pages.
- `larder-automations`: packaging, Chromium and the extension.
- `owner`: D11, D12, D13, D18.
