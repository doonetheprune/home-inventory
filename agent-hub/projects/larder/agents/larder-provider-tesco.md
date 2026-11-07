# larder-provider-tesco: brief

**Repo:** `doonetheprune/larder-provider-tesco` · **Project:** larder · **Track B:** runs alongside the main track whenever there's time.

## Mission

Keep the Tesco provider working wherever Larder Automations runs, including Chromium on Linux (the add-on, Docker and the Pi box). Support contract 1.5: signing in by itself, asking for what it can't do, and reporting each step.

## Read first

- In the hub, `PLAN.md`: Automations.
- In `home-inventory`: `modules/online-shopping/SPEC.md`.
- `larder-automations`' `CONTRACT.md`.

## Contracts

- **Uses:** `automations` (1.5), `live-view`.

## Tasks

Tick tasks as you finish them; that's the only change you make to this file.

### B0 — Try

- [ ] Spike S1, with `larder-automations` and `larder-pi`: read favourites from Chromium on a Pi 4 without being blocked. Note any bot checks, and how often they appear (board 21).

### B1 — Automations on any device

- [ ] Sign in by itself with the stored details when Tesco asks again.
- [ ] Ask through "Needs you" for one-time codes and challenges, and wait for the answer.
- [ ] Report each step for the run trail.
- [ ] Run under Chromium on Linux (arm64 and amd64) as well as Chrome on the Mac, and package the provider for the signed catalogue.

## Boundaries

- Use the sign-in details only to sign in to Tesco, and never write them anywhere.

## Who to ask

- `larder-automations`: the contract and the hub.
- `owner`: D19, the shops' terms.
