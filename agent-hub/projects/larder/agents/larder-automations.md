# larder-automations: brief

**Repo:** `doonetheprune/larder-automations` · **Project:** larder

## Mission

Run the shopping providers on any device (the Larder Pi itself, a Mac, or another computer), controlled entirely from Larder:
- paired without copying tokens
- with shop sign-in details that only the device can read
- asking the person when it needs something
- with a screenshot trail of every run and a live view of the browser

## Read first

- In the hub, `PLAN.md`: Automations.
- In `home-inventory`, `modules/online-shopping/SPEC.md`: Larder's side as it is today.
- This repo's `CONTRACT.md` (1.x).

## Contracts

- **Owns:** `automations` (this repo's `CONTRACT.md`, moving to 1.5) and `live-view`.
- **Uses:**
  - `releases` (you publish the hub and providers in the same format)
  - `pi-system`, for where a Pi keeps the key to sign-in details (D11)

## Tasks

Tick tasks as you finish them; that's the only change you make to this file.

### M0 — Decide and try

- [ ] Spike S1, with `larder-pi` and `larder-provider-tesco`: check that Chromium on a Pi 4, with the extension, reads Tesco favourites without being blocked (board 21). The answer decides the Pi image's desktop session.

### M1 — Foundations

- [ ] Linux: a systemd service in place of the menu bar app, with its status and actions available to Larder.
- [ ] Pairing without tokens (board 13):
  - announce the device on the home network
  - Larder asks to pair
  - the person presses **Allow** on the device
  - keys are swapped
- [ ] Shop sign-in details (boards 19, 20):
  - a write-only call that takes details encrypted for this device
  - kept encrypted, and never returned
  - in the Keychain on a Mac; on a Pi, wherever D11 decides
- [ ] "Needs you": a provider asks for a password or a one-time code, Larder asks the person, and the answer comes back.
- [ ] Run trail: a line and a small screenshot per step, and a full screenshot where it stopped. Keep the last 10 runs on the device (board 22).
- [ ] Live view (board 23):
  - stream the provider's tab with Chrome DevTools' screencast, and send taps and typing back
  - **Take control** pauses the run; **Hand back** resumes it
  - send each frame only once the last one has arrived
  - on a Mac, start Chrome so it keeps drawing when the screen is locked
- [ ] Contract 1.5 covering all of the above, with conformance tests, plus `live-view` 0.x.

### M2 — The Larder Pi box

- [ ] A signed provider catalogue: the device installs and updates providers itself (board 18).
- [ ] Packaging (board 17):
  - arm64 builds and systemd units for the Pi image
  - a Home Assistant add-on and a Docker Compose service, for "Run automations on this device" on other installs

### Later

- [ ] The whole virtual screen through noVNC on a Pi (board 26).

## Boundaries

- Sign-in details never leave the device in readable form, and nothing about them is logged.
- The hub only talks to Larders it's paired with, and is never reachable from the internet.
- Screenshots stay on the device; Larder fetches them when someone looks.

## Who to ask

- `home-inventory`: Larder's side of `automations` and `live-view`.
- `larder-provider-tesco`, `larder-provider-toolstation`: what the providers need.
- `larder-pi`: packaging, the system helper, TPM.
- `owner`: D11.
